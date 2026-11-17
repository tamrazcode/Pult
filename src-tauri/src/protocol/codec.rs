//! NDJSON framing: one JSON value per `\n`-terminated line (§5.1).
//!
//! A malformed line is logged and skipped — never kills the stream (§4.4).

use bytes::BytesMut;
use serde_json::Value;
use tokio_util::codec::{Decoder, Encoder};

#[derive(Debug, thiserror::Error)]
pub enum CodecError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("line exceeds max length ({0} bytes)")]
    LineTooLong(usize),
    #[error("serialize: {0}")]
    Serialize(#[from] serde_json::Error),
}

pub struct NdjsonCodec {
    max_line_len: usize,
}

impl NdjsonCodec {
    pub fn new() -> Self {
        Self {
            max_line_len: 64 * 1024 * 1024,
        }
    }
}

impl Default for NdjsonCodec {
    fn default() -> Self {
        Self::new()
    }
}

impl Decoder for NdjsonCodec {
    type Item = Value;
    type Error = CodecError;

    fn decode(&mut self, src: &mut BytesMut) -> Result<Option<Value>, CodecError> {
        loop {
            let Some(pos) = src.iter().position(|&b| b == b'\n') else {
                if src.len() > self.max_line_len {
                    return Err(CodecError::LineTooLong(src.len()));
                }
                return Ok(None); // need more data
            };
            let mut line = src.split_to(pos + 1);
            line.truncate(pos); // drop '\n'
            if line.last() == Some(&b'\r') {
                line.truncate(line.len() - 1); // tolerate CRLF writers
            }
            if line.is_empty() {
                continue; // blank line
            }
            match serde_json::from_slice::<Value>(&line) {
                Ok(value) => return Ok(Some(value)),
                Err(err) => {
                    tracing::warn!(
                        target: "pult::protocol",
                        error = %err,
                        len = line.len(),
                        head = %String::from_utf8_lossy(&line[..line.len().min(120)]),
                        "malformed NDJSON line skipped"
                    );
                    // keep scanning: one bad line never kills the stream
                }
            }
        }
    }
}

impl Encoder<Value> for NdjsonCodec {
    type Error = CodecError;

    fn encode(&mut self, item: Value, dst: &mut BytesMut) -> Result<(), CodecError> {
        let mut line = serde_json::to_vec(&item)?;
        line.reserve(1);
        line.push(b'\n');
        dst.extend_from_slice(&line);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// xorshift64 — deterministic seeded RNG so failures are reproducible.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    fn arbitrary_value(rng: &mut Rng, depth: u32) -> Value {
        let choice = rng.below(if depth == 0 { 4 } else { 7 });
        match choice {
            0 => Value::Null,
            1 => Value::Bool(rng.below(2) == 0),
            2 => Value::Number((rng.next() % 1_000_000).into()),
            3 => Value::String(format!("s{}", rng.next())),
            4 => {
                let n = rng.below(4);
                Value::Array((0..n).map(|_| arbitrary_value(rng, depth - 1)).collect())
            }
            5 | 6 => {
                let n = rng.below(4);
                Value::Object(
                    (0..n)
                        .map(|_| {
                            (
                                format!("k{}", rng.below(8)),
                                arbitrary_value(rng, depth - 1),
                            )
                        })
                        .collect(),
                )
            }
            _ => unreachable!(),
        }
    }

    /// Property: for any sequence of JSON values, encode → decode round-trips
    /// exactly — regardless of chunk boundaries the bytes arrive in.
    #[test]
    fn encode_decode_roundtrip_randomized() {
        let mut rng = Rng(0x9e3779b97f4a7c15);
        for case in 0..500u32 {
            let items: Vec<Value> = (0..rng.below(6) + 1)
                .map(|_| arbitrary_value(&mut rng, 3))
                .collect();

            let mut encoded = BytesMut::new();
            let mut enc = NdjsonCodec::new();
            for item in &items {
                enc.encode(item.clone(), &mut encoded).unwrap();
            }

            // Feed through the decoder in random chunks against ONE persistent
            // buffer (like a real FramedRead), to exercise partial-line handling.
            // Even cases emulate "no trailing newline yet" on the stream tail.
            let truncated_last = case % 2 == 0;
            let data: &[u8] = if truncated_last {
                &encoded[..encoded.len() - 1]
            } else {
                &encoded[..]
            };
            let mut dec = NdjsonCodec::new();
            let mut buf = BytesMut::new();
            let mut out = Vec::new();
            let mut rest = data;
            while !rest.is_empty() {
                let cut = (rng.below(rest.len()) + 1).min(rest.len());
                let (chunk, tail) = rest.split_at(cut);
                buf.extend_from_slice(chunk);
                while let Some(v) = dec.decode(&mut buf).unwrap() {
                    out.push(v);
                }
                rest = tail;
            }
            if truncated_last {
                buf.extend_from_slice(b"\n"); // flush the buffered partial line
                while let Some(v) = dec.decode(&mut buf).unwrap() {
                    out.push(v);
                }
            }
            assert_eq!(out, items, "round-trip failed for case {case}");
        }
    }

    /// Property: interleaved garbage lines are skipped; valid lines survive.
    #[test]
    fn malformed_lines_are_skipped_randomized() {
        let mut rng = Rng(0xdeadbeef12345678);
        for _ in 0..200 {
            let good: Vec<Value> = (0..rng.below(5) + 1)
                .map(|_| arbitrary_value(&mut rng, 2))
                .collect();
            let mut raw: Vec<u8> = Vec::new();
            let mut expected = Vec::new();
            for v in &good {
                if rng.below(3) == 0 {
                    raw.extend_from_slice(b"this is not json\n");
                }
                if rng.below(4) == 0 {
                    raw.extend_from_slice(b"[1, 2, \n"); // broken partial JSON
                }
                let line = serde_json::to_vec(v).unwrap();
                raw.extend_from_slice(&line);
                raw.push(b'\n');
                expected.push(v.clone());
            }
            let mut dec = NdjsonCodec::new();
            let mut buf = BytesMut::from(&raw[..]);
            let mut out = Vec::new();
            while let Some(v) = dec.decode(&mut buf).unwrap() {
                out.push(v);
            }
            assert_eq!(out, expected);
        }
    }

    #[test]
    fn blank_lines_and_crlf_are_tolerated() {
        let raw = b"{\"a\":1}\r\n\n\n{\"b\":2}\n";
        let mut dec = NdjsonCodec::new();
        let mut buf = BytesMut::from(&raw[..]);
        let mut out = Vec::new();
        while let Some(v) = dec.decode(&mut buf).unwrap() {
            out.push(v);
        }
        assert_eq!(out, vec![json!({"a":1}), json!({"b":2})]);
    }

    #[test]
    fn incomplete_line_waits_for_more_data() {
        let mut dec = NdjsonCodec::new();
        let mut buf = BytesMut::from(&b"{\"a\":"[..]);
        assert!(dec.decode(&mut buf).unwrap().is_none());
        buf.extend_from_slice(b"1}\n");
        assert_eq!(dec.decode(&mut buf).unwrap(), Some(json!({"a":1})));
    }

    #[test]
    fn oversized_line_errors() {
        let mut dec = NdjsonCodec { max_line_len: 8 };
        let mut buf = BytesMut::from(&b"123456789"[..]);
        assert!(matches!(
            dec.decode(&mut buf),
            Err(CodecError::LineTooLong(9))
        ));
    }
}
