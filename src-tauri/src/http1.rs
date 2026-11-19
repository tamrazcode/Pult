//! Minimal HTTP/1.1 request reader/writer shared by Pult's loopback MCP
//! servers. One request per connection, no keep-alive: both endpoints only
//! serve small JSON-RPC calls.

use std::io;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const MAX_HEADERS: usize = 16 * 1024;

#[derive(Debug)]
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

    let content_length = match headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
    {
        Some((_, value)) => Some(value.trim().parse::<usize>().map_err(|_| {
            HttpReadError::Io(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid Content-Length header",
            ))
        })?),
        None => None,
    };
    if content_length.is_some_and(|length| length > max_body) {
        return Err(HttpReadError::TooLarge);
    }
    let chunked = headers.iter().any(|(name, value)| {
        name.eq_ignore_ascii_case("transfer-encoding")
            && value
                .split(',')
                .any(|token| token.trim().eq_ignore_ascii_case("chunked"))
    });

    let mut body = buffer[(header_end + 4)..].to_vec();
    if chunked {
        body = read_chunked(stream, body, max_body).await?;
    } else {
        let content_length = content_length.unwrap_or(0);
        while body.len() < content_length {
            read_body_more(stream, &mut body).await?;
        }
        body.truncate(content_length);
    }

    Ok(Some(HttpRequest {
        method,
        path,
        headers,
        body,
    }))
}

/// Reads once more into `body`; EOF mid-body is a truncated request, not a
/// request with fewer bytes.
async fn read_body_more(stream: &mut TcpStream, body: &mut Vec<u8>) -> Result<(), HttpReadError> {
    let mut chunk = [0u8; 8192];
    let read = stream.read(&mut chunk).await?;
    if read == 0 {
        return Err(HttpReadError::Io(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "connection closed before the request body was complete",
        )));
    }
    body.extend_from_slice(&chunk[..read]);
    Ok(())
}

/// Decodes a `Transfer-Encoding: chunked` body, capped at `max_body` decoded
/// bytes. Truncated or malformed framing is an error, never a short body.
async fn read_chunked(
    stream: &mut TcpStream,
    mut buffer: Vec<u8>,
    max_body: usize,
) -> Result<Vec<u8>, HttpReadError> {
    let mut body = Vec::new();
    loop {
        let line_end = loop {
            if let Some(index) = find_bytes(&buffer, b"\r\n") {
                break index;
            }
            if buffer.len() > 1024 {
                return Err(HttpReadError::Io(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "chunk size line is too long",
                )));
            }
            read_body_more(stream, &mut buffer).await?;
        };
        let line = String::from_utf8_lossy(&buffer[..line_end]).into_owned();
        let size_text = line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_text, 16).map_err(|_| {
            HttpReadError::Io(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid chunk size",
            ))
        })?;
        buffer.drain(..line_end + 2);
        if size == 0 {
            return Ok(body);
        }
        if body.len() + size > max_body {
            return Err(HttpReadError::TooLarge);
        }
        while buffer.len() < size + 2 {
            read_body_more(stream, &mut buffer).await?;
        }
        if &buffer[size..size + 2] != b"\r\n" {
            return Err(HttpReadError::Io(io::Error::new(
                io::ErrorKind::InvalidData,
                "chunk is not terminated by CRLF",
            )));
        }
        body.extend_from_slice(&buffer[..size]);
        buffer.drain(..size + 2);
    }
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

    /// Serves one raw request and returns what `read_request` made of it.
    async fn read_raw(raw: &'static [u8], max_body: usize) -> Result<HttpRequest, HttpReadError> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let mut stream = TcpStream::connect(addr).await.unwrap();
            stream.write_all(raw).await.unwrap();
            // Keep the socket open: EOF must be explicit in the failing tests.
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        });
        let (mut stream, _) = listener.accept().await.unwrap();
        read_request(&mut stream, max_body)
            .await?
            .ok_or(HttpReadError::Io(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "missing request",
            )))
    }

    #[tokio::test]
    async fn reads_a_chunked_body() {
        let request = read_raw(
            b"POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n",
            1024,
        )
        .await
        .unwrap();
        assert_eq!(request.body, b"hello world");
    }

    #[tokio::test]
    async fn rejects_a_truncated_chunked_body() {
        let error = read_raw(
            b"POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhel",
            1024,
        )
        .await
        .expect_err("truncated chunk must fail");
        assert!(
            matches!(error, HttpReadError::Io(ref error) if error.kind() == io::ErrorKind::UnexpectedEof),
            "{error:?}"
        );
    }

    #[tokio::test]
    async fn rejects_a_malformed_chunk_size() {
        let error = read_raw(
            b"POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\nabc\r\n0\r\n\r\n",
            1024,
        )
        .await
        .expect_err("malformed chunk size must fail");
        assert!(
            matches!(error, HttpReadError::Io(ref error) if error.kind() == io::ErrorKind::InvalidData),
            "{error:?}"
        );
    }

    #[tokio::test]
    async fn rejects_an_oversized_chunked_body() {
        let error = read_raw(
            b"POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\na\r\n0123456789\r\n0\r\n\r\n",
            8,
        )
        .await
        .expect_err("oversized chunked body must fail");
        assert!(matches!(error, HttpReadError::TooLarge), "{error:?}");
    }

    #[tokio::test]
    async fn rejects_eof_and_bad_content_length() {
        let error = read_raw(
            b"POST /mcp HTTP/1.1\r\nContent-Length: 10\r\n\r\nabc",
            1024,
        )
        .await
        .expect_err("premature EOF must fail");
        assert!(
            matches!(error, HttpReadError::Io(ref error) if error.kind() == io::ErrorKind::UnexpectedEof),
            "{error:?}"
        );

        let error = read_raw(
            b"POST /mcp HTTP/1.1\r\nContent-Length: abc\r\n\r\n{}",
            1024,
        )
        .await
        .expect_err("non-numeric Content-Length must fail");
        assert!(
            matches!(error, HttpReadError::Io(ref error) if error.kind() == io::ErrorKind::InvalidData),
            "{error:?}"
        );
    }
}
