//! Minimal HTTP/1.1 request reader/writer shared by Pult's loopback MCP
//! servers. One request per connection, no keep-alive: both endpoints only
//! serve small JSON-RPC calls.

use std::io;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const MAX_HEADERS: usize = 16 * 1024;

pub struct HttpRequest {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

#[derive(Debug)]
pub enum HttpReadError {
    Io(io::Error),
    TooLarge,
}
impl From<io::Error> for HttpReadError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

pub async fn read_request(
    stream: &mut TcpStream,
    max_body: usize,
) -> Result<Option<HttpRequest>, HttpReadError> {
    let mut buffer = Vec::with_capacity(4096);
    let header_end = loop {
        if let Some(index) = find_bytes(&buffer, b"\r\n\r\n") {
            break index;
        }
        if buffer.len() > MAX_HEADERS {
            return Err(HttpReadError::TooLarge);
        }
        let mut chunk = [0u8; 2048];
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Ok(None);
        }
        buffer.extend_from_slice(&chunk[..read]);
    };

    let head = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next().unwrap_or_default().split_whitespace();
    let method = request_line.next().unwrap_or_default().to_string();
    let path = request_line.next().unwrap_or_default().to_string();
    let mut headers = Vec::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_string(), value.trim().to_string()));
        }
    }

    let content_length = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > max_body {
        return Err(HttpReadError::TooLarge);
    }

    let mut body = buffer[(header_end + 4)..].to_vec();
    while body.len() < content_length {
        let mut chunk = [0u8; 8192];
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(content_length);

    Ok(Some(HttpRequest {
        method,
        path,
        headers,
        body,
    }))
}

pub async fn respond(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> io::Result<()> {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.flush().await
}

pub async fn respond_json(stream: &mut TcpStream, value: &serde_json::Value) -> io::Result<()> {
    respond(
        stream,
        200,
        "application/json",
        value.to_string().as_bytes(),
    )
    .await
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn reads_a_post_with_lowercase_headers_and_exact_body() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(addr).await.unwrap();
            stream
                .write_all(
                    b"POST /mcp HTTP/1.1\r\ncontent-length: 7\r\nX-Test: yes\r\n\r\n{\"a\":1}",
                )
                .await
                .unwrap();
            let mut sink = Vec::new();
            stream.read_to_end(&mut sink).await.unwrap();
        });
        let (mut stream, _) = listener.accept().await.unwrap();
        let request = read_request(&mut stream, 1024)
            .await
            .unwrap()
            .expect("request");
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/mcp");
        assert_eq!(request.header("x-test"), Some("yes"));
        assert_eq!(request.body, b"{\"a\":1}");
        drop(stream);
        client.await.unwrap();
    }
}
