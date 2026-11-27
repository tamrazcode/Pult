//! Self-sufficient provider toolchain: a working Node/npm (the system's, or
//! Pult's own portable copy) and a Pult-owned npm prefix, so one-click
//! provider installs never need admin rights or a preconfigured machine.

use std::path::{Path, PathBuf};

use crate::PultError;

/// Pinned LTS used only when the machine has no working Node/npm.
pub const PINNED_NODE_VERSION: &str = "24.22.3";

#[cfg(all(windows, target_arch = "x86_64"))]
const NODE_ARCHIVE: &str = "node-v24.22.3-win-x64.zip";
#[cfg(all(windows, target_arch = "x86_64"))]
const NODE_SHA256: &str = "e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f";
#[cfg(all(windows, target_arch = "aarch64"))]
const NODE_ARCHIVE: &str = "node-v24.22.3-win-arm64.zip";
#[cfg(all(windows, target_arch = "aarch64"))]
const NODE_SHA256: &str = "b3cc74a295b39d4f273271e96f58c06dd2b35757ca12abec64c7d0598b434f14";

/// Per-user data root; the runtime and npm prefix live here, never in
/// Program Files, so installs need no elevation.
#[cfg(windows)]
pub fn data_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|dir| dir.join("pult"))
}

#[cfg(not(windows))]
pub fn data_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|dir| dir.join(".local").join("share").join("pult"))
}

pub fn npm_prefix_dir() -> Option<PathBuf> {
    data_dir().map(|dir| dir.join("npm"))
}

/// Windows puts global `.cmd` shims directly in the prefix; Unix uses `bin/`.
pub fn npm_bin_dir() -> Option<PathBuf> {
    npm_prefix_dir().map(|dir| {
        if cfg!(windows) {
            dir
        } else {
            dir.join("bin")
        }
    })
}

pub fn node_dir() -> Option<PathBuf> {
    data_dir().map(|dir| dir.join("runtime").join("node").join("current"))
}

fn node_bin_dir() -> Option<PathBuf> {
    node_dir().map(|dir| {
        if cfg!(windows) {
            dir
        } else {
            dir.join("bin")
        }
    })
}

pub fn npm_cache_dir() -> Option<PathBuf> {
    data_dir().map(|dir| dir.join("npm-cache"))
}

/// Extra directories searched for agent CLIs and injected into child PATH.
pub fn bin_dirs() -> Vec<PathBuf> {
    [npm_bin_dir(), node_bin_dir()]
        .into_iter()
        .flatten()
        .filter(|dir| dir.is_dir())
        .collect()
}

/// Child PATH with Pult's runtime dirs first, so a Pult-installed shim can
/// always find the Node that Pult installed beside it.
pub fn spawn_path(base: Option<&str>) -> Option<std::ffi::OsString> {
    let extra = bin_dirs();
    if extra.is_empty() && base.is_none() {
        return None;
    }
    let base = base.map(std::ffi::OsString::from).or_else(|| std::env::var_os("PATH"))?;
    let mut all: Vec<PathBuf> = extra;
    all.extend(std::env::split_paths(&base));
    std::env::join_paths(all).ok()
}

/// A verified node/npm pair that provider installs and spawns can use.
#[derive(Debug, Clone)]
pub struct Toolchain {
    pub node: PathBuf,
    pub npm: PathBuf,
    /// PATH for child processes (npm shims, npx bridges).
    pub path: std::ffi::OsString,
}

/// Resolves a usable toolchain, downloading portable Node once if the machine
/// has none. Serialized so two provider installs never race the download.
pub async fn ensure() -> Result<Toolchain, PultError> {
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = LOCK.lock().await;

    if let Some(toolchain) = system_toolchain().await {
        return Ok(toolchain);
    }
    if let Some(toolchain) = managed_toolchain().await {
        return Ok(toolchain);
    }
    install_node().await?;
    managed_toolchain()
        .await
        .ok_or_else(|| runtime_error("portable Node did not start after install"))
}

/// A usable toolchain without downloading one; `None` means installs would
/// need the managed runtime first.
pub async fn cached() -> Option<Toolchain> {
    match system_toolchain().await {
        Some(toolchain) => Some(toolchain),
        None => managed_toolchain().await,
    }
}

async fn system_toolchain() -> Option<Toolchain> {
    let node = find_on_path("node")?;
    let npm = find_on_path("npm")?;
    verify_pair(&node, &npm).await
}

async fn managed_toolchain() -> Option<Toolchain> {
    let dir = node_dir()?;
    let node = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    let npm = dir.join(if cfg!(windows) { "npm.cmd" } else { "npm" });
    verify_pair(&node, &npm).await
}

async fn verify_pair(node: &Path, npm: &Path) -> Option<Toolchain> {
    if !node.is_file() || !npm.is_file() {
        return None;
    }
    if !runs(node, &["--version"]).await || !runs(npm, &["--version"]).await {
        return None;
    }
    Some(Toolchain {
        node: node.to_path_buf(),
        npm: npm.to_path_buf(),
        path: spawn_path(None)?,
    })
}

async fn runs(program: &Path, args: &[&str]) -> bool {
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    matches!(
        tokio::time::timeout(std::time::Duration::from_secs(10), command.status()).await,
        Ok(Ok(status)) if status.success()
    )
}

/// PATH lookup that honors PATHEXT, for Node itself (agent detection goes
/// through `config::which`, which also includes Pult's dirs).
fn find_on_path(binary: &str) -> Option<PathBuf> {
    let extensions: &[&str] = if cfg!(windows) {
        &["exe", "cmd", "bat"]
    } else {
        &[""]
    };
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for ext in extensions {
            let candidate = if ext.is_empty() {
                dir.join(binary)
            } else {
                dir.join(format!("{binary}.{ext}"))
            };
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(windows)]
async fn install_node() -> Result<(), PultError> {
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;

    let root = data_dir().ok_or_else(|| runtime_error("LOCALAPPDATA is not set"))?;
    let node_root = root.join("runtime").join("node");
    std::fs::create_dir_all(&node_root)
        .map_err(|e| runtime_error(format!("create runtime dir: {e}")))?;
    let temp_zip = node_root.join(format!("node-{}.zip", std::process::id()));
    let staging = node_root.join(format!("staging-{}", std::process::id()));
    let _ = std::fs::remove_file(&temp_zip);
    let _ = std::fs::remove_dir_all(&staging);

    let url = format!("https://nodejs.org/dist/v{PINNED_NODE_VERSION}/{NODE_ARCHIVE}");
    let client = crate::ipc::http_client(std::time::Duration::from_secs(900))?;
    let mut response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| runtime_error(format!("Node download failed: {e}")))?;
    if !response.status().is_success() {
        return Err(runtime_error(format!(
            "Node download failed: HTTP {}",
            response.status()
        )));
    }
    let mut file = tokio::fs::File::create(&temp_zip)
        .await
        .map_err(|e| runtime_error(format!("create Node archive: {e}")))?;
    let mut hasher = Sha256::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| runtime_error(format!("Node download interrupted: {e}")))?
    {
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| runtime_error(format!("write Node archive: {e}")))?;
    }
    file.sync_all()
        .await
        .map_err(|e| runtime_error(format!("flush Node archive: {e}")))?;
    drop(file);

    let digest = format!("{:x}", hasher.finalize());
    if digest != NODE_SHA256 {
        let _ = std::fs::remove_file(&temp_zip);
        return Err(runtime_error(format!(
            "Node archive checksum mismatch: expected {NODE_SHA256}, got {digest}"
        )));
    }

    let zip_path = temp_zip.clone();
    let staging_dir = staging.clone();
    tokio::task::spawn_blocking(move || extract_node_zip(&zip_path, &staging_dir))
        .await
        .map_err(|e| runtime_error(format!("Node extraction task failed: {e}")))??;
    let _ = std::fs::remove_file(&temp_zip);

    let node = staging.join("node.exe");
    let npm = staging.join("npm.cmd");
    if !runs(&node, &["--version"]).await || !runs(&npm, &["--version"]).await {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(runtime_error(
            "portable Node was extracted but does not start (antivirus or permissions?)",
        ));
    }

    let target = node_dir().ok_or_else(|| runtime_error("LOCALAPPDATA is not set"))?;
    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(&staging, &target)
        .map_err(|e| runtime_error(format!("activate portable Node: {e}")))?;
    Ok(())
}

#[cfg(not(windows))]
async fn install_node() -> Result<(), PultError> {
    Err(runtime_error(
        "automatic Node install is Windows-only; install Node.js or make node/npm visible on PATH",
    ))
}

#[cfg(windows)]
fn extract_node_zip(zip_path: &Path, dest: &Path) -> Result<(), PultError> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| runtime_error(format!("open Node archive: {e}")))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| runtime_error(format!("read Node archive: {e}")))?;
    std::fs::create_dir_all(dest)
        .map_err(|e| runtime_error(format!("create Node staging dir: {e}")))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| runtime_error(format!("read Node archive entry: {e}")))?;
        // `enclosed_name` rejects `..` and absolute paths (Zip Slip).
        let Some(path) = entry.enclosed_name() else {
            continue;
        };
        // The archive carries one `node-v*-win-*` top-level folder; drop it.
        let relative: PathBuf = path.components().skip(1).collect();
        if relative.as_os_str().is_empty() {
            continue;
        }
        let out = dest.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&out)
                .map_err(|e| runtime_error(format!("create {}: {e}", out.display())))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| runtime_error(format!("create {}: {e}", parent.display())))?;
        }
        let mut sink = std::fs::File::create(&out)
            .map_err(|e| runtime_error(format!("create {}: {e}", out.display())))?;
        std::io::copy(&mut entry, &mut sink)
            .map_err(|e| runtime_error(format!("extract {}: {e}", out.display())))?;
    }
    Ok(())
}

pub fn runtime_error(message: impl Into<String>) -> PultError {
    PultError::with_code("provider.runtime_failed", message)
}

/// npm's console output on Russian Windows is CP866/CP1251; UTF-8 lossy turns
/// it into mojibake. Decode UTF-8 first, then the active Windows code page.
pub fn decode_console(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    #[cfg(windows)]
    {
        let console = unsafe { windows_sys::Win32::System::Console::GetConsoleOutputCP() };
        let oem = unsafe { windows_sys::Win32::Globalization::GetOEMCP() };
        let ansi = unsafe { windows_sys::Win32::Globalization::GetACP() };
        for code_page in [console, oem, ansi] {
            if code_page != 0 {
                if let Some(text) = decode_code_page(bytes, code_page) {
                    return text;
                }
            }
        }
    }
    String::from_utf8_lossy(bytes).into_owned()
}

/// Windows `MultiByteToWideChar` with strict validation; `None` when the bytes
/// do not belong to the code page.
#[cfg(windows)]
fn decode_code_page(bytes: &[u8], code_page: u32) -> Option<String> {
    use windows_sys::Win32::Globalization::{MultiByteToWideChar, MB_ERR_INVALID_CHARS};

    if bytes.is_empty() {
        return Some(String::new());
    }
    let length = unsafe {
        MultiByteToWideChar(
            code_page,
            MB_ERR_INVALID_CHARS,
            bytes.as_ptr(),
            bytes.len() as i32,
            std::ptr::null_mut(),
            0,
        )
    };
    if length <= 0 {
        return None;
    }
    let mut wide = vec![0u16; length as usize];
    let written = unsafe {
        MultiByteToWideChar(
            code_page,
            MB_ERR_INVALID_CHARS,
            bytes.as_ptr(),
            bytes.len() as i32,
            wide.as_mut_ptr(),
            length,
        )
    };
    if written <= 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&wide[..written as usize]))
}

/// One actionable line for the common npm/Node failure classes.
pub fn failure_hint(text: &str) -> Option<&'static str> {
    let lower = text.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|needle| lower.contains(needle));
    if has(&["etimedout", "econnreset", "enotfound", "eai_again", "network", "socket hang up"]) {
        return Some(
            "Hint: the npm registry is unreachable. Check the internet, VPN, or HTTP(S)_PROXY, then retry.",
        );
    }
    if has(&["eacces", "eperm", "ebusy", "operation not permitted", "access is denied"]) {
        return Some(
            "Hint: a file is locked or not writable. Close other Node processes or check antivirus, then retry.",
        );
    }
    if has(&["certificate", "self signed", "unable to verify", "tls"]) {
        return Some(
            "Hint: TLS verification failed. A corporate proxy or antivirus may be intercepting HTTPS.",
        );
    }
    if has(&["e404", "404 not found"]) {
        return Some("Hint: the package or registry path was not found. Check the npm registry setting.");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn decodes_russian_oem_and_ansi_console_bytes() {
        // "Ошибка" in CP866 and CP1251.
        let cp866 = [0x8E, 0xE8, 0xA8, 0xA1, 0xAA, 0xA0];
        let cp1251 = [0xCE, 0xF8, 0xE8, 0xE1, 0xEA, 0xE0];
        assert_eq!(decode_code_page(&cp866, 866).as_deref(), Some("Ошибка"));
        assert_eq!(decode_code_page(&cp1251, 1251).as_deref(), Some("Ошибка"));
    }

    #[test]
    fn utf8_console_output_is_not_mangled() {
        assert_eq!(decode_console("npm error".as_bytes()), "npm error");
    }

    #[test]
    fn failure_hints_cover_network_permissions_and_tls() {
        assert!(failure_hint("npm ERR! code ETIMEDOUT").is_some());
        assert!(failure_hint("EACCES: permission denied").is_some());
        assert!(failure_hint("self signed certificate in certificate chain").is_some());
        assert!(failure_hint("all good").is_none());
    }

    #[test]
    fn npm_bin_dir_is_the_prefix_on_windows() {
        if cfg!(windows) {
            assert_eq!(npm_bin_dir(), npm_prefix_dir());
        } else {
            assert_eq!(npm_bin_dir(), npm_prefix_dir().map(|dir| dir.join("bin")));
        }
    }
}
