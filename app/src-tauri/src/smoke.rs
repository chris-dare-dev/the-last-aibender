//! `--smoke-test` mode + bootstrap-file reading (the Rust half of the
//! bootstrap contract's READER side, docs/contracts/bootstrap-file.md §4).
//!
//! The smoke test is the HEADLESS BOOT PROOF for milestone gates (plan
//! SI↔FE #1 precursor): it boots with no window, no event loop, no WebView;
//! reads the bootstrap file if present; always exits 0 — absent, unreadable
//! and malformed all mean the same thing ("no broker advertised"), never a
//! failure.
//!
//! [X2]: the bootstrap token is a per-boot secret. This module validates its
//! PRESENCE only; the value is never printed, logged, or summarized.

use std::path::PathBuf;

/// `AIBENDER_HOME` env var if set and non-empty, else `~/.aibender` —
/// mirrors `resolveAibenderHome` in the contract.
pub fn resolve_aibender_home() -> Option<PathBuf> {
    if let Ok(v) = std::env::var("AIBENDER_HOME") {
        if !v.is_empty() {
            return Some(PathBuf::from(v));
        }
    }
    std::env::var("HOME")
        .ok()
        .filter(|h| !h.is_empty())
        .map(|h| PathBuf::from(h).join(".aibender"))
}

pub fn bootstrap_path() -> Option<PathBuf> {
    resolve_aibender_home().map(|home| home.join("bootstrap").join("gateway.json"))
}

/// Raw file body, or None when nothing is advertised. Clients never write,
/// touch, or delete the file — the broker is the sole writer (§4.5).
pub fn read_bootstrap_raw() -> Option<String> {
    std::fs::read_to_string(bootstrap_path()?).ok()
}

/// Identifier-free summary of a structurally valid bootstrap body.
#[derive(Debug, PartialEq, Eq)]
pub struct BootstrapSummary {
    pub port: u16,
    pub pid: i64,
}

/// Structural validation mirroring `isGatewayBootstrap`: total over any
/// input — a torn/foreign file never panics.
pub fn validate_bootstrap(raw: &str) -> Option<BootstrapSummary> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let obj = value.as_object()?;
    let port = obj.get("port")?.as_u64()?;
    if !(1..=65535).contains(&port) {
        return None;
    }
    let token = obj.get("token")?.as_str()?;
    if token.is_empty() {
        return None;
    }
    let pid = obj.get("pid")?.as_i64()?;
    if pid < 1 {
        return None;
    }
    let started_at = obj.get("startedAt")?.as_str()?;
    if started_at.is_empty() {
        return None;
    }
    Some(BootstrapSummary {
        port: port as u16,
        pid,
    })
}

/// The headless boot proof. Exit code is ALWAYS 0 on the smoke path; the
/// output line states which of the three reader states was observed.
pub fn run_smoke_test() -> i32 {
    match read_bootstrap_raw() {
        None => {
            println!("smoke-test: ok — headless boot, no broker advertised");
        }
        Some(raw) => match validate_bootstrap(&raw) {
            Some(summary) => {
                println!(
                    "smoke-test: ok — headless boot, broker advertised on 127.0.0.1:{} (pid {})",
                    summary.port, summary.pid
                );
            }
            None => {
                // Malformed ⇒ same as absent (§4.1) — still a clean boot.
                println!("smoke-test: ok — headless boot, bootstrap malformed (no broker advertised)");
            }
        },
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Synthesized fixture token assembled at RUNTIME so no contiguous
    /// key-shaped literal exists in the tree (plan §9.1 fixture policy;
    /// gitleaks Tier-1 sees only the parts) [X2].
    fn fake_token() -> String {
        ["synth", "fake", "token"].join("-")
    }

    fn valid_body() -> String {
        // Synthesized fixture — placeholder values only [X2].
        format!(
            r#"{{"port":49152,"token":"{}","pid":12345,"startedAt":"2026-07-04T00:00:00.000Z"}}"#,
            fake_token()
        )
    }

    #[test]
    fn accepts_a_valid_bootstrap_body() {
        let summary = validate_bootstrap(&valid_body()).expect("valid body accepted");
        assert_eq!(summary, BootstrapSummary { port: 49152, pid: 12345 });
    }

    #[test]
    fn rejects_out_of_range_ports() {
        for port in ["0", "65536", "-1"] {
            let body = valid_body().replace("49152", port);
            assert!(validate_bootstrap(&body).is_none(), "port {port} must be rejected");
        }
    }

    #[test]
    fn rejects_missing_or_empty_fields() {
        assert!(validate_bootstrap(r#"{"port":49152}"#).is_none());
        assert!(validate_bootstrap(&valid_body().replace(&fake_token(), "")).is_none());
        assert!(validate_bootstrap(&valid_body().replace("12345", "0")).is_none());
    }

    #[test]
    fn torn_or_foreign_bodies_never_panic() {
        for body in ["", "not json", "[]", "42", r#"{"port":"49152"}"#] {
            assert!(validate_bootstrap(body).is_none());
        }
    }

    #[test]
    fn smoke_test_is_zero_even_without_a_home() {
        // With AIBENDER_HOME pointed at a non-existent dir the reader sees
        // "absent" — and the smoke test still succeeds.
        std::env::set_var("AIBENDER_HOME", "/nonexistent/synthetic/aibender-home");
        assert_eq!(run_smoke_test(), 0);
        std::env::remove_var("AIBENDER_HOME");
    }
}
