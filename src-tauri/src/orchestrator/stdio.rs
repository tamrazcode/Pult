//! `pult mcp-stdio`: the piped bridge used when an ACP agent cannot speak
//! Streamable HTTP. It reads one JSON-RPC message per stdin line and POSTs it
//! to the app-owned loopback server, writing the reply back on stdout.

use std::io::{self, BufRead, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

const IO_TIMEOUT: Duration = Duration::from_secs(30);

/// Returns `Some(exit_code)` when the process was launched as the bridge.
/// Called before Tauri starts so no window or runtime is created.
pub fn handle_cli() -> Option<i32> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("mcp-stdio") {
        return None;
    }
    let rest: Vec<String> = args.collect();
    Some(run(&rest))
}

fn run(args: &[String]) -> i32 {
    if args.first().map(String::as_str) == Some("--custom") {
        // User MCP gateways arrive with T16; refusing loudly beats pretending.
        eprintln!("pult mcp-stdio: custom MCP servers are not available yet");
        return 2;
    }
    let (Some(url), Some(token)) = (
        std::env::var("PULT_MCP_URL").ok(),
        std::env::var("PULT_MCP_TOKEN").ok(),
    ) else {
        eprintln!("pult mcp-stdio: PULT_MCP_URL and PULT_MCP_TOKEN are required");
        return 2;
    };

    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                eprintln!("pult mcp-stdio: read failed: {error}");
                return 1;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        match proxy_line(&url, &token, &line) {
            Ok(Some(response)) => {
                if writeln!(stdout, "{response}").and_then(|_| stdout.flush()).is_err() {
                    return 1;
                }
            }
            Ok(None) => {}
            Err(error) => eprintln!("pult mcp-stdio: {error}"),
        }
    }
    0
}

/// POSTs one JSON-RPC line and returns the reply body, if the server sent one.
/// Notifications produce `202` with an empty body and return `Ok(None)`.
fn proxy_line(url: &str, token: &str, line: &str) -> io::Result<Option<String>> {
    let (host, port, path) = parse_http_url(url)?;
    let mut stream = TcpStream::connect((host.as_str(), port))?;
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{line}",
        line.len()
    );
    stream.write_all(request.as_bytes())?;
    stream.flush()?;

    let mut response = Vec::new();
    stream.read_to_end(&mut response)?;
    let response = String::from_utf8_lossy(&response).into_owned();
    let (head, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "malformed HTTP reply"))?;
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing HTTP status"))?;
    if status == 202 || body.is_empty() {
        return Ok(None);
    }
    if status != 200 {
        return Err(io::Error::other(format!("orchestrator answered HTTP {status}")));
    }
    Ok(Some(body.to_string()))
}

fn parse_http_url(url: &str) -> io::Result<(String, u16, String)> {
    let rest = url.strip_prefix("http://").ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "PULT_MCP_URL must start with http://",
        )
    })?;
    let (authority, path) = match rest.split_once('/') {
        Some((authority, path)) => (authority, format!("/{path}")),
        None => (rest, "/".to_string()),
    };
    let (host, port) = authority.rsplit_once(':').ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "PULT_MCP_URL must include a port",
        )
    })?;
    let port = port.parse::<u16>().map_err(|_| {
        io::Error::new(io::ErrorKind::InvalidInput, "PULT_MCP_URL has a bad port")
    })?;
    if host != "127.0.0.1" && host != "localhost" {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "PULT_MCP_URL must be loopback",
        ));
    }
    Ok((host.to_string(), port, path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    fn serve_once(
        status: &'static str,
        body: &'static str,
        assert: impl Fn(String) + Send + 'static,
    ) -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 2048];
            loop {
                let read = stream.read(&mut chunk).unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let text = String::from_utf8_lossy(&request).into_owned();
                    if let Some((_, sent)) = text.split_once("\r\n\r\n") {
                        let needed = text
                            .lines()
                            .find_map(|line| line.strip_prefix("Content-Length: "))
                            .and_then(|value| value.parse::<usize>().ok())
                            .unwrap_or(0);
                        if sent.len() >= needed {
                            assert(text);
                            break;
                        }
                    }
                }
            }
            let reply = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(reply.as_bytes()).unwrap();
        });
        port
    }

    #[test]
    fn proxy_line_forwards_json_and_returns_the_reply() {
        let port = serve_once("200 OK", r#"{"jsonrpc":"2.0","id":1,"result":{}}"#, |request| {
            assert!(request.starts_with("POST /mcp HTTP/1.1"));
            assert!(request.contains("Authorization: Bearer tok-123"));
            assert!(request.contains(r#""method":"ping""#));
        });
        let reply = proxy_line(
            &format!("http://127.0.0.1:{port}/mcp"),
            "tok-123",
            r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#,
        )
        .unwrap();
        assert_eq!(reply.as_deref(), Some(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#));
    }

    #[test]
    fn proxy_line_drops_the_empty_body_of_a_notification() {
        let port = serve_once("202 Accepted", "", |_| {});
        let reply = proxy_line(
            &format!("http://127.0.0.1:{port}/mcp"),
            "tok-123",
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        )
        .unwrap();
        assert!(reply.is_none());
    }

    #[test]
    fn parse_refuses_non_loopback_and_missing_port() {
        assert!(parse_http_url("http://example.com:80/mcp").is_err());
        assert!(parse_http_url("http://127.0.0.1/mcp").is_err());
        assert!(parse_http_url("https://127.0.0.1:80/mcp").is_err());
        assert_eq!(
            parse_http_url("http://127.0.0.1:4321/mcp").unwrap(),
            ("127.0.0.1".to_string(), 4321, "/mcp".to_string())
        );
    }
}
