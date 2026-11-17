//! Security boundary for user MCP servers: URL/SSRF validation, tool
//! allow/deny filtering, response size caps and log redaction.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use serde_json::Value;

pub const MAX_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_LOG_LINE: usize = 8 * 1024;

/// Rejects non-TLS URLs, credential-bearing URLs and addresses that reach the
/// local machine, private networks or cloud metadata.
///
/// `allow_localhost` only relaxes loopback; RFC1918 and link-local stay blocked.
pub async fn validate_url(raw: &str, allow_localhost: bool) -> Result<(), String> {
    let url = reqwest::Url::parse(raw).map_err(|e| format!("invalid MCP URL: {e}"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("MCP URL must not contain credentials; use secret headers".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "MCP URL needs a host".to_string())?;
    let host_ip = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
        .ok();
    let loopback_host = host_ip.is_some_and(|ip| ip.is_loopback())
        || host.eq_ignore_ascii_case("localhost")
        || host.eq_ignore_ascii_case("localhost.");
    match url.scheme() {
        "https" => {}
        "http" if allow_localhost && loopback_host => {}
        "http" => {
            return Err(
                "MCP URL must use https://; plain http:// is only allowed for localhost"
                    .to_string(),
            )
        }
        scheme => return Err(format!("MCP URL scheme `{scheme}` is not allowed")),
    }
    let hostname = host.trim_start_matches('[').trim_end_matches(']');
    let port = url.port_or_known_default().unwrap_or(443);
    let addresses: Vec<IpAddr> = if let Some(ip) = host_ip {
        vec![ip]
    } else {
        match tokio::net::lookup_host((hostname, port)).await {
            Ok(addresses) => addresses.map(|address| address.ip()).collect(),
            Err(error) => return Err(format!("cannot resolve MCP host `{host}`: {error}")),
        }
    };
    if addresses.is_empty() {
        return Err(format!("MCP host `{host}` resolved to no addresses"));
    }
    for address in addresses {
        if blocked_ip(address, allow_localhost) {
            return Err(format!(
                "MCP host `{host}` points at a blocked address ({address})"
            ));
        }
    }
    // shortcut: DNS is checked once before connecting, not pinned; a rebinding
    // attacker could race the second lookup. Pin resolved IPs if that threat
    // enters the model.
    Ok(())
}

fn blocked_ip(ip: IpAddr, allow_localhost: bool) -> bool {
    match ip {
        IpAddr::V4(ip) => blocked_v4(ip, allow_localhost),
        IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4_mapped() {
                return blocked_v4(mapped, allow_localhost);
            }
            blocked_v6(ip, allow_localhost)
        }
    }
}

fn blocked_v4(ip: Ipv4Addr, allow_localhost: bool) -> bool {
    if ip.is_loopback() {
        return !allow_localhost;
    }
    ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_documentation()
}

fn blocked_v6(ip: Ipv6Addr, allow_localhost: bool) -> bool {
    if ip.is_loopback() {
        return !allow_localhost;
    }
    // unique-local (fc00::/7), link-local (fe80::/10) and unspecified
    (ip.segments()[0] & 0xfe00) == 0xfc00
        || (ip.segments()[0] & 0xffc0) == 0xfe80
        || ip.is_unspecified()
}

/// `denyTools` wins; an empty allow-list means "everything not denied".
pub fn tool_allowed(name: &str, allow: &[String], deny: &[String]) -> bool {
    if deny.iter().any(|pattern| glob_match(pattern, name)) {
        return false;
    }
    allow.is_empty() || allow.iter().any(|pattern| glob_match(pattern, name))
}

/// Removes denied tools from a `tools/list` result in place.
pub fn filter_tool_list(reply: &mut Value, allow: &[String], deny: &[String]) {
    let Some(tools) = reply
        .get_mut("result")
        .and_then(|result| result.get_mut("tools"))
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    tools.retain(|tool| {
        tool.get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| tool_allowed(name, allow, deny))
    });
}

/// Marks proxied third-party output as untrusted without changing its content.
pub fn mark_untrusted(reply: &mut Value) {
    let Some(result) = reply.get_mut("result").filter(|result| result.is_object()) else {
        return;
    };
    match result.get_mut("_meta") {
        Some(Value::Object(meta)) => {
            meta.insert("pult/untrusted".to_string(), Value::Bool(true));
        }
        _ => {
            result["_meta"] = serde_json::json!({ "pult/untrusted": true });
        }
    }
}

/// Masks values after credential-looking markers in diagnostic lines.
pub fn redact(line: &str) -> String {
    const MARKERS: [&str; 7] = [
        "authorization:",
        "authorization=",
        "bearer ",
        "x-api-key:",
        "api_key=",
        "api-key:",
        "token=",
    ];
    let lower = line.to_ascii_lowercase();
    for marker in MARKERS {
        if let Some(index) = lower.find(marker) {
            let after_marker = index + marker.len();
            let rest = &line[after_marker..];
            // Keep the separator space, mask the whole credential that follows.
            let keep = after_marker + (rest.len() - rest.trim_start().len());
            return format!("{}••••", &line[..keep]);
        }
    }
    line.to_string()
}

/// Simple `*` glob for tool names; no other metacharacters are special.
fn glob_match(pattern: &str, text: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let text: Vec<char> = text.chars().collect();
    let (mut p, mut t) = (0usize, 0usize);
    let mut star: Option<usize> = None;
    let mut star_text = 0usize;
    while t < text.len() {
        if p < pattern.len() && pattern[p] == text[t] {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some(p);
            p += 1;
            star_text = t;
        } else if let Some(star_index) = star {
            p = star_index + 1;
            star_text += 1;
            t = star_text;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == '*' {
        p += 1;
    }
    p == pattern.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn blocks_metadata_private_and_plain_http() {
        for url in [
            "https://169.254.169.254/latest/meta-data",
            "http://169.254.169.254",
            "https://10.0.0.5/mcp",
            "https://172.16.4.2/mcp",
            "https://192.168.1.10/mcp",
            "https://127.0.0.1/mcp",
            "https://[::1]/mcp",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "http://example.com/mcp",
            "https://user:pass@example.com/mcp",
        ] {
            assert!(
                validate_url(url, false).await.is_err(),
                "{url} must be blocked"
            );
        }
    }

    #[tokio::test]
    async fn allows_localhost_only_when_explicitly_enabled() {
        validate_url("http://127.0.0.1:8787/mcp", true)
            .await
            .unwrap();
        validate_url("http://localhost:8787/mcp", true)
            .await
            .unwrap();
        // Loopback relaxation never opens private networks.
        assert!(validate_url("http://10.0.0.5/mcp", true).await.is_err());
        assert!(validate_url("http://127.0.0.1/mcp", false).await.is_err());
    }

    #[test]
    fn deny_wins_and_glob_patterns_work() {
        assert!(tool_allowed("fs.read", &[], &[]));
        assert!(!tool_allowed("fs.delete", &[], &["fs.delete".into()]));
        assert!(tool_allowed("fs.read_file", &["fs.read_*".into()], &[]));
        assert!(!tool_allowed("fs.write_file", &["fs.read_*".into()], &[]));
        assert!(!tool_allowed(
            "fs.read_file",
            &["fs.read_*".into()],
            &["*read*".into()]
        ));
        assert!(glob_match("*", "anything"));
        assert!(glob_match("a*b*c", "a-x-b-y-c"));
        assert!(!glob_match("a*b*c", "a-x-c-y-b"));
    }

    #[test]
    fn filters_tools_and_marks_output_untrusted() {
        let mut reply = json!({
            "jsonrpc": "2.0", "id": 1,
            "result": { "tools": [
                { "name": "read" },
                { "name": "delete" },
                { "name": "read_secret" }
            ]}
        });
        filter_tool_list(&mut reply, &[], &["delete".into()]);
        let names: Vec<&str> = reply["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["read", "read_secret"]);

        let mut call = json!({ "jsonrpc": "2.0", "id": 2, "result": { "content": [] } });
        mark_untrusted(&mut call);
        assert_eq!(call["result"]["_meta"]["pult/untrusted"], true);
    }

    #[test]
    fn redacts_credentials_in_logs() {
        assert_eq!(
            redact("Authorization: Bearer abc123 rest"),
            "Authorization: ••••"
        );
        assert_eq!(redact("plain line"), "plain line");
    }
}
