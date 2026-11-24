//! Native child-webview browser (T3-style preview surface).
//!
//! A sandboxed <iframe> cannot display sites that send `X-Frame-Options` or
//! `frame-ancestors`, and `file://` iframes cannot load ES modules. A native
//! child `Webview` is a real browser context: any http(s) site renders, and
//! local files are served from a token-scoped loopback server so relative
//! scripts/styles/modules work exactly like a dev server.
//!
//! Security: the server binds 127.0.0.1 on a random port, every URL carries a
//! 128-bit random token, and every request is canonicalized and must stay
//! inside the registered root (workspace root for project files, otherwise the
//! file's own directory).

use std::collections::{HashMap, VecDeque};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::webview::Webview;
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};
use tokio::io::AsyncReadExt;

const CHILD_LABEL: &str = "pult-browser";

/// A client that connects and never sends must not pin a preview task.
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
/// Registered preview roots kept for the process lifetime; older tokens are
/// evicted first (the webview reloads through `browser_navigate` anyway).
const MAX_PREVIEW_ROOTS: usize = 64;

#[derive(Debug, Clone, Copy)]
struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
}

impl Default for Bounds {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
            visible: false,
        }
    }
}

#[derive(Default)]
pub struct BrowserState {
    server: tokio::sync::OnceCell<Arc<StaticServer>>,
    webview: Mutex<Option<Webview<tauri::Wry>>>,
    bounds: Mutex<Bounds>,
}

impl BrowserState {
    fn ensure_webview(&self, app: &AppHandle) -> Result<Webview<tauri::Wry>, crate::PultError> {
        if let Some(webview) = self
            .webview
            .lock()
            .map_err(|_| browser_err("browser.state_failed", "browser state poisoned"))?
            .clone()
        {
            return Ok(webview);
        }
        let window = app
            .get_window("main")
            .ok_or_else(|| browser_err("browser.window_missing", "main window is not available"))?;
        let bounds = *self
            .bounds
            .lock()
            .map_err(|_| browser_err("browser.state_failed", "browser state poisoned"))?;
        let blank: Url = "about:blank"
            .parse()
            .map_err(|_| browser_err("browser.navigate_failed", "invalid blank url"))?;
        let webview = window
            .add_child(
                WebviewBuilder::new(CHILD_LABEL, WebviewUrl::External(blank)).on_page_load(
                    |webview, payload| {
                        let event = match payload.event() {
                            PageLoadEvent::Started => "started",
                            PageLoadEvent::Finished => "finished",
                        };
                        let payload = serde_json::json!({
                            "url": payload.url().as_str(),
                            "event": event,
                        });
                        let _ = tauri::Emitter::emit(&webview, "browser:navigated", payload);
                    },
                ),
                LogicalPosition::new(bounds.x, bounds.y),
                LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
            )
            .map_err(|e| browser_err("browser.webview_failed", e.to_string()))?;
        let _ = webview.hide();
        *self
            .webview
            .lock()
            .map_err(|_| browser_err("browser.state_failed", "browser state poisoned"))? =
            Some(webview.clone());
        Ok(webview)
    }

    async fn server(&self) -> Result<Arc<StaticServer>, String> {
        self.server
            .get_or_try_init(|| async {
                StaticServer::start()
                    .await
                    .map_err(|e| format!("local preview server: {e}"))
            })
            .await
            .cloned()
    }
}

fn browser_err(code: &str, message: impl Into<String>) -> crate::PultError {
    crate::PultError::with_code(code, message)
}

/// `<state>` is managed by lib.rs; commands below are registered there.
#[tauri::command]
pub async fn browser_set_bounds(
    app: AppHandle,
    state: tauri::State<'_, BrowserState>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
) -> Result<(), crate::PultError> {
    {
        let mut bounds = state
            .bounds
            .lock()
            .map_err(|_| browser_err("browser.state_failed", "browser state poisoned"))?;
        *bounds = Bounds {
            x,
            y,
            width: width.max(1.0),
            height: height.max(1.0),
            visible,
        };
    }
    // Creating the webview on the first bounds call keeps it out of the way
    // until the Browser surface is actually shown.
    if !visible {
        if let Ok(guard) = state.webview.lock() {
            if let Some(webview) = guard.as_ref() {
                let _ = webview.hide();
            }
        }
        return Ok(());
    }
    let webview = state.ensure_webview(&app)?;
    webview
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| browser_err("browser.bounds_failed", e.to_string()))?;
    webview
        .set_size(LogicalSize::new(width.max(1.0), height.max(1.0)))
        .map_err(|e| browser_err("browser.bounds_failed", e.to_string()))?;
    webview
        .show()
        .map_err(|e| browser_err("browser.bounds_failed", e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub async fn browser_navigate(
    app: AppHandle,
    state: tauri::State<'_, BrowserState>,
    runtime: tauri::State<'_, Arc<crate::runtime::AgentRuntime>>,
    target: String,
    thread_id: Option<String>,
) -> Result<String, crate::PultError> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return Err(browser_err("url.empty", "empty browser target"));
    }
    let url = if let Some(url) = external_url(trimmed) {
        url
    } else {
        let server = state
            .server()
            .await
            .map_err(|e| browser_err("browser.server_failed", e))?;
        let (root, file) = resolve_local(&runtime, trimmed, thread_id.as_deref())
            .map_err(|e| browser_err("browser.local_file", e))?;
        let token = server.register(root);
        server
            .file_url(&token, &file)
            .map_err(|e| browser_err("browser.local_file", e))?
    };
    let webview = state.ensure_webview(&app)?;
    webview
        .navigate(url.clone())
        .map_err(|e| browser_err("browser.navigate_failed", e.to_string()))?;
    let bounds = *state
        .bounds
        .lock()
        .map_err(|_| browser_err("browser.state_failed", "browser state poisoned"))?;
    if bounds.visible {
        let _ = webview.show();
    }
    Ok(url.to_string())
}

#[tauri::command]
pub fn browser_history(
    state: tauri::State<'_, BrowserState>,
    action: String,
) -> Result<(), crate::PultError> {
    let guard = state
        .webview
        .lock()
        .map_err(|_| browser_err("browser.state_failed", "browser state poisoned"))?;
    let Some(webview) = guard.as_ref() else {
        return Ok(());
    };
    let script = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        other => {
            return Err(browser_err(
                "browser.history_failed",
                format!("unknown history action: {other}"),
            ))
        }
    };
    webview
        .eval(script)
        .map_err(|e| browser_err("browser.history_failed", e.to_string()))
}

/// Current page of the persistent child webview (panel remounts restore it).
#[tauri::command]
pub fn browser_state(state: tauri::State<'_, BrowserState>) -> Option<String> {
    let guard = state.webview.lock().ok()?;
    let webview = guard.as_ref()?;
    webview
        .url()
        .ok()
        .map(|url| url.to_string())
        .filter(|url| url != "about:blank")
}

#[tauri::command]
pub fn browser_close(state: tauri::State<'_, BrowserState>) -> Result<(), crate::PultError> {
    let webview = state
        .webview
        .lock()
        .map_err(|_| browser_err("browser.state_failed", "browser state poisoned"))?
        .take();
    if let Some(webview) = webview {
        let _ = webview.close();
    }
    // The preview tokens only exist for the page that is now gone; dropping
    // them keeps the root table from outliving the browser session.
    if let Some(server) = state.server.get() {
        server.clear_roots();
    }
    Ok(())
}

fn external_url(raw: &str) -> Option<Url> {
    let lower = raw.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    if !url.host_str().is_some_and(|host| !host.is_empty()) {
        return None;
    }
    Some(url)
}

/// Resolve a local path (absolute, file:// or workspace-relative) and pick the
/// directory the preview server may read from.
fn resolve_local(
    runtime: &crate::runtime::AgentRuntime,
    raw: &str,
    thread_id: Option<&str>,
) -> Result<(PathBuf, PathBuf), String> {
    let lower = raw.to_ascii_lowercase();
    if lower.starts_with("javascript:")
        || lower.starts_with("data:")
        || lower.starts_with("vbscript:")
        || raw.starts_with("\\\\")
        || raw.starts_with("//")
    {
        return Err("unsupported browser target".to_string());
    }
    let mut candidate = if lower.starts_with("file://") {
        Url::parse(raw)
            .ok()
            .and_then(|url| url.to_file_path().ok())
            .ok_or_else(|| "invalid file URL".to_string())?
    } else {
        let mut path = PathBuf::from(raw);
        if path.is_relative() {
            let thread_id = thread_id.ok_or_else(|| "no thread for a relative path".to_string())?;
            let thread = runtime
                .store()
                .get_thread(thread_id)
                .map_err(|e| format!("thread: {e}"))?;
            path = runtime
                .workspace_root_for(&thread)
                .map_err(|e| format!("workspace: {e}"))?
                .join(path);
        }
        path
    };
    if candidate.components().any(|c| c == Component::ParentDir) {
        return Err("path escapes the preview root".to_string());
    }
    candidate = candidate
        .canonicalize()
        .map_err(|e| format!("file not found: {e}"))?;
    if !candidate.is_file() {
        return Err("target is not a file".to_string());
    }
    let workspace = thread_id
        .and_then(|id| runtime.store().get_thread(id).ok())
        .and_then(|thread| runtime.workspace_root_for(&thread).ok())
        .and_then(|root| root.canonicalize().ok());
    let root = match workspace {
        // Never widen the served area to the file's parent: a path outside the
        // project must be opened explicitly, not silently expose its directory.
        Some(workspace) if candidate.starts_with(&workspace) => workspace,
        Some(_) => return Err("file is outside the project workspace".to_string()),
        None => candidate
            .parent()
            .ok_or_else(|| "file has no parent".to_string())?
            .to_path_buf(),
    };
    Ok((root, candidate))
}

#[derive(Default)]
struct Roots {
    map: HashMap<String, PathBuf>,
    /// Insertion order for FIFO eviction once the cap is reached.
    order: VecDeque<String>,
}

impl Roots {
    fn insert(&mut self, token: String, root: PathBuf) {
        while self.map.len() >= MAX_PREVIEW_ROOTS {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            self.map.remove(&oldest);
        }
        self.order.push_back(token.clone());
        self.map.insert(token, root);
    }

    fn get(&self, token: &str) -> Option<&PathBuf> {
        self.map.get(token)
    }

    fn clear(&mut self) {
        self.map.clear();
        self.order.clear();
    }
}

struct StaticServer {
    base: String,
    roots: Mutex<Roots>,
}

impl StaticServer {
    async fn start() -> io::Result<Arc<Self>> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let server = Arc::new(Self {
            base: format!("http://127.0.0.1:{port}"),
            roots: Mutex::new(Roots::default()),
        });
        let acceptor = Arc::clone(&server);
        tauri::async_runtime::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let server = Arc::clone(&acceptor);
                tauri::async_runtime::spawn(async move {
                    let _ = server.handle(stream).await;
                });
            }
        });
        Ok(server)
    }

    fn register(&self, root: PathBuf) -> String {
        let token = random_token();
        if let Ok(mut roots) = self.roots.lock() {
            roots.insert(token.clone(), root);
        }
        token
    }

    fn clear_roots(&self) {
        if let Ok(mut roots) = self.roots.lock() {
            roots.clear();
        }
    }

    fn file_url(&self, token: &str, file: &Path) -> Result<Url, String> {
        let root = self
            .roots
            .lock()
            .map_err(|_| "preview roots poisoned".to_string())?
            .get(token)
            .cloned()
            .ok_or_else(|| "preview session not found".to_string())?;
        let relative = file
            .strip_prefix(&root)
            .map_err(|_| "file is outside the preview root".to_string())?;
        let encoded = encode_path(&relative.to_string_lossy().replace('\\', "/"));
        Url::parse(&format!("{}/{token}/{encoded}", self.base))
            .map_err(|e| format!("preview url: {e}"))
    }

    async fn handle(&self, mut stream: tokio::net::TcpStream) -> io::Result<()> {
        use tokio::io::AsyncWriteExt;

        let buffer = match read_headers(&mut stream, HEADER_TIMEOUT).await {
            Ok(Some(buffer)) => buffer,
            Ok(None) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::TimedOut => {
                return respond(&mut stream, 408, "text/plain", b"request timed out").await
            }
            Err(error) => return Err(error),
        };
        let request = String::from_utf8_lossy(&buffer);
        let mut parts = request.lines().next().unwrap_or("").split_whitespace();
        let method = parts.next().unwrap_or("");
        let raw_path = parts.next().unwrap_or("");
        if method != "GET" && method != "HEAD" {
            return respond(&mut stream, 405, "text/plain", b"method not allowed").await;
        }
        // Query strings and fragments are for the page, not the file lookup:
        // `./app.js?v=1` must serve `app.js`.
        let raw_path = raw_path
            .split(['?', '#'])
            .next()
            .unwrap_or("")
            .trim_start_matches('/');
        let path = percent_decode(raw_path);
        if path.is_empty() {
            return respond(&mut stream, 404, "text/plain", b"not found").await;
        }
        let mut split = path.splitn(2, '/');
        let token = split.next().unwrap_or("");
        let relative = split.next().unwrap_or("");
        let root = self
            .roots
            .lock()
            .ok()
            .and_then(|roots| roots.get(token).cloned());
        let Some(root) = root else {
            return respond(&mut stream, 404, "text/plain", b"unknown preview session").await;
        };
        let Some(target) = safe_join(&root, relative) else {
            return respond(&mut stream, 403, "text/plain", b"forbidden").await;
        };
        let meta = match tokio::fs::metadata(&target).await {
            Ok(meta) if meta.is_file() => meta,
            _ => return respond(&mut stream, 404, "text/plain", b"not found").await,
        };
        if meta.len() > 64 * 1024 * 1024 {
            return respond(&mut stream, 413, "text/plain", b"file too large").await;
        }
        let body = match tokio::fs::read(&target).await {
            Ok(body) => body,
            Err(_) => return respond(&mut stream, 500, "text/plain", b"read failed").await,
        };
        let mime = mime_for(&target);
        if method == "HEAD" {
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n\r\n",
                body.len()
            );
            stream.write_all(header.as_bytes()).await?;
            return Ok(());
        }
        respond(&mut stream, 200, mime, &body).await
    }
}

/// Reads one request head with a hard deadline. `Ok(None)` means the client
/// closed before sending anything.
async fn read_headers(
    stream: &mut tokio::net::TcpStream,
    timeout: Duration,
) -> io::Result<Option<Vec<u8>>> {
    let read = tokio::time::timeout(timeout, async {
        let mut buffer = Vec::with_capacity(4096);
        let mut chunk = [0u8; 2048];
        loop {
            let read = stream.read(&mut chunk).await?;
            if read == 0 {
                return Ok(None);
            }
            buffer.extend_from_slice(&chunk[..read]);
            if buffer.windows(4).any(|window| window == b"\r\n\r\n") || buffer.len() > 16 * 1024 {
                return Ok(Some(buffer));
            }
        }
    })
    .await;
    match read {
        Ok(result) => result,
        Err(_) => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "preview client sent no request head",
        )),
    }
}

async fn respond(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    mime: &str,
    body: &[u8],
) -> io::Result<()> {
    use tokio::io::AsyncWriteExt;
    let reason = match status {
        200 => "OK",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        _ => "Internal Server Error",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes()).await?;
    stream.write_all(body).await?;
    Ok(())
}

fn safe_join(root: &Path, relative: &str) -> Option<PathBuf> {
    if relative.contains('\0') || relative.contains('\\') {
        return None;
    }
    let mut target = root.to_path_buf();
    for part in relative.split('/') {
        if part.is_empty() || part == ".." {
            return None;
        }
        if part != "." {
            target.push(part);
        }
    }
    let canonical = target.canonicalize().ok()?;
    let root = root.canonicalize().ok()?;
    canonical.starts_with(root).then_some(canonical)
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") | Some("map") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("ico") => "image/x-icon",
        Some("wasm") => "application/wasm",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("txt") | Some("md") | Some("ts") | Some("tsx") | Some("rs") | Some("toml") => {
            "text/plain; charset=utf-8"
        }
        _ => "application/octet-stream",
    }
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3])
                .ok()
                .and_then(|hex| u8::from_str_radix(hex, 16).ok());
            if let Some(byte) = hex {
                if byte != 0 {
                    out.push(byte);
                }
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// 128 bits derived from OS-random hasher seeds: unguessable enough for a
/// process-lifetime loopback token without pulling in a RNG dependency.
fn random_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let state = std::collections::hash_map::RandomState::new();
    let mut first = state.build_hasher();
    first.write_u64(crate::events::now_millis() as u64);
    first.write_u32(std::process::id());
    let mut second = state.build_hasher();
    second.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
    );
    format!("{:016x}{:016x}", first.finish(), second.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_join_rejects_traversal_and_accepts_nested_files() {
        let root = std::env::temp_dir().join("pult-browser-root");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("index.html"), b"ok").unwrap();
        std::fs::write(root.join("sub/app.js"), b"ok").unwrap();
        assert!(safe_join(&root, "index.html").is_some());
        assert!(safe_join(&root, "sub/app.js").is_some());
        assert!(safe_join(&root, "../outside").is_none());
        assert!(safe_join(&root, "sub/../../outside").is_none());
        assert!(safe_join(&root, "sub\\app.js").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn mime_and_encoding_cover_assets() {
        assert_eq!(mime_for(Path::new("a.html")), "text/html; charset=utf-8");
        assert_eq!(
            mime_for(Path::new("a.mjs")),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(mime_for(Path::new("a.woff2")), "font/woff2");
        assert_eq!(encode_path("my file/x.js"), "my%20file/x.js");
        assert_eq!(percent_decode("my%20file/x.js"), "my file/x.js");
    }

    #[tokio::test]
    async fn static_server_serves_assets_and_blocks_traversal() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let root = std::env::temp_dir().join("pult-browser-server-test");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("index.html"), b"<h1>hi</h1>").unwrap();
        std::fs::write(root.join("sub/app.js"), b"export const x = 1;").unwrap();
        std::fs::write(root.join("secret.txt"), b"nope").unwrap();

        let server = StaticServer::start().await.unwrap();
        let token = server.register(root.clone());
        let url = server
            .file_url(&token, &root.join("sub/app.js"))
            .unwrap()
            .to_string();
        let path = url.trim_start_matches(&server.base);

        let fetch = |request_path: String| {
            let port = url
                .trim_start_matches("http://127.0.0.1:")
                .split('/')
                .next()
                .unwrap()
                .to_string();
            async move {
                let mut stream =
                    tokio::net::TcpStream::connect(("127.0.0.1", port.parse::<u16>().unwrap()))
                        .await
                        .unwrap();
                stream
                    .write_all(
                        format!("GET {request_path} HTTP/1.1\r\nHost: localhost\r\n\r\n")
                            .as_bytes(),
                    )
                    .await
                    .unwrap();
                let mut response = Vec::new();
                let _ = stream.read_to_end(&mut response).await;
                String::from_utf8_lossy(&response).into_owned()
            }
        };

        let ok = fetch(path.to_string()).await;
        assert!(ok.starts_with("HTTP/1.1 200"), "{ok}");
        assert!(ok.contains("export const x = 1;"));
        assert!(ok.contains("text/javascript"));

        let with_query = fetch(format!("{path}?v=1")).await;
        assert!(with_query.starts_with("HTTP/1.1 200"), "{with_query}");
        assert!(with_query.contains("export const x = 1;"));

        let forbidden = fetch(format!("/{token}/../secret.txt")).await;
        assert!(forbidden.starts_with("HTTP/1.1 403"), "{forbidden}");

        let unknown = fetch("/not-a-token/index.html".to_string()).await;
        assert!(unknown.starts_with("HTTP/1.1 404"), "{unknown}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn header_read_times_out_when_the_client_stays_silent() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let client = tokio::spawn(async move {
            let stream = tokio::net::TcpStream::connect(addr).await.unwrap();
            tokio::time::sleep(Duration::from_secs(2)).await;
            drop(stream);
        });
        let (mut stream, _) = listener.accept().await.unwrap();
        let error = read_headers(&mut stream, Duration::from_millis(100))
            .await
            .expect_err("a silent client must time out");
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        client.abort();
    }

    #[tokio::test]
    async fn registers_are_bounded_and_evict_the_oldest_root() {
        let server = StaticServer::start().await.unwrap();
        let root = std::env::temp_dir();
        let first = server.register(root.clone());
        let mut last = first.clone();
        for _ in 0..MAX_PREVIEW_ROOTS + 5 {
            last = server.register(root.clone());
        }
        let roots = server.roots.lock().unwrap();
        assert_eq!(roots.map.len(), MAX_PREVIEW_ROOTS);
        assert!(!roots.map.contains_key(&first), "oldest root must be evicted");
        assert!(roots.map.contains_key(&last), "newest root must be kept");
        drop(roots);
        drop(server);
    }

    #[tokio::test]
    async fn clearing_roots_revokes_preview_tokens() {
        let server = StaticServer::start().await.unwrap();
        let root = std::env::temp_dir();
        let token = server.register(root.clone());
        assert!(server.roots.lock().unwrap().get(&token).is_some());
        server.clear_roots();
        assert!(server.roots.lock().unwrap().get(&token).is_none());
    }

    #[test]
    fn external_url_only_accepts_http_and_https() {
        assert!(external_url("https://example.com/a").is_some());
        assert!(external_url("http://localhost:3000").is_some());
        assert!(external_url("file:///C:/x.html").is_none());
        assert!(external_url("javascript:alert(1)").is_none());
        assert!(external_url("https://").is_none());
    }
}
