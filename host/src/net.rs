//! How people reach this PC: LAN address, UPnP port mapping, and free tunnels (Cloudflare, localhost.run, ngrok).
use crate::emit;
use igd_next::{search_gateway, Gateway, PortMappingProtocol};
use serde_json::json;
use std::io::{BufRead, BufReader, Read};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const NO_WINDOW: u32 = 0x0800_0000;

pub fn lan_ip() -> Option<Ipv4Addr> {
    // connect() on UDP sends nothing; it only picks the outbound interface
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    match s.local_addr().ok()? {
        SocketAddr::V4(a) => Some(*a.ip()),
        _ => None,
    }
}

pub fn upnp_open(port: u16, local: Ipv4Addr) -> Result<(Gateway, String), String> {
    let gw = search_gateway(Default::default()).map_err(|e| format!("no UPnP router found ({e})"))?;
    gw.add_port(PortMappingProtocol::TCP, port, SocketAddr::V4(SocketAddrV4::new(local, port)), 0, "Flux Control")
        .map_err(|e| format!("router refused the port ({e})"))?;
    let ip = gw.get_external_ip().map_err(|e| e.to_string())?;
    Ok((gw, ip.to_string()))
}

/// First `https://<host>` in `line` whose host ends with one of `suffixes`; returns the host.
pub fn find_host(line: &str, suffixes: &[&str]) -> Option<String> {
    let mut rest = line;
    while let Some(i) = rest.find("https://") {
        let tail = &rest[i + 8..];
        let end = tail.find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '.')).unwrap_or(tail.len());
        let host = tail[..end].to_ascii_lowercase();
        if suffixes.iter().any(|s| host.ends_with(s) && host.len() > s.len()) && !host.starts_with("api.") {
            return Some(host);
        }
        rest = &tail[end..];
    }
    None
}

fn find_bin(names: &[&str], extra: &[&str]) -> Option<PathBuf> {
    for e in extra {
        let p = PathBuf::from(e);
        if p.exists() {
            return Some(p);
        }
    }
    let flux_bin = std::env::var_os("FLUX_HOME").map(PathBuf::from).or_else(|| std::env::var_os("LOCALAPPDATA").map(|l| PathBuf::from(l).join("FluxControl")));
    for n in names {
        if let Some(b) = flux_bin.as_ref().map(|h| h.join("bin").join(n)).filter(|p| p.exists()) {
            return Some(b);
        }
        if let Some(path) = std::env::var_os("PATH") {
            for d in std::env::split_paths(&path) {
                let p = d.join(n);
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }
    None
}

pub struct Tunnel {
    pub method: &'static str,
    bin_names: &'static [&'static str],
    extra: &'static [&'static str],
    suffixes: &'static [&'static str],
    install_hint: &'static str,
    /// what the UI can offer when the program is missing: cloudflared | openssh | ngrok
    fix: &'static str,
}

pub fn tunnel_spec(method: &str) -> Option<Tunnel> {
    Some(match method {
        "cloudflare" => Tunnel {
            method: "cloudflare",
            bin_names: &["cloudflared.exe"],
            extra: &["C:\\Program Files (x86)\\cloudflared\\cloudflared.exe", "C:\\Program Files\\cloudflared\\cloudflared.exe"],
            suffixes: &[".trycloudflare.com"],
            install_hint: "cloudflared is not installed",
            fix: "cloudflared",
        },
        "localhostrun" => Tunnel {
            method: "localhostrun",
            bin_names: &["ssh.exe"],
            extra: &[
                "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
                "C:\\Program Files\\Git\\usr\\bin\\ssh.exe",
                "C:\\Program Files (x86)\\Git\\usr\\bin\\ssh.exe",
            ],
            suffixes: &[".lhr.life"], // not .localhost.run: that is the admin/docs host in its banner
            install_hint: "the OpenSSH client is not installed",
            fix: "openssh",
        },
        "ngrok" => Tunnel {
            method: "ngrok",
            bin_names: &["ngrok.exe"],
            extra: &[],
            suffixes: &[".ngrok-free.app", ".ngrok-free.dev", ".ngrok.app", ".ngrok.io"],
            install_hint: "ngrok is not installed",
            fix: "ngrok",
        },
        _ => return None,
    })
}

/// Starts the tunnel process and reports the public host once it prints it. The child is kept in `kids` so it is killed on exit.
pub fn start_tunnel(t: Tunnel, port: u16, ngrok_token: String, kids: Arc<Mutex<Vec<Child>>>) {
    std::thread::spawn(move || {
        let fail = |e: &str, fix: &str| emit(json!({"t": "error", "method": t.method, "err": e, "fix": fix}));
        let Some(bin) = find_bin(t.bin_names, t.extra) else { return fail(t.install_hint, t.fix) };
        let mut cmd = Command::new(bin);
        match t.method {
            "cloudflare" => cmd.args(["tunnel", "--no-autoupdate", "--url", &format!("http://127.0.0.1:{port}")]),
            "localhostrun" => cmd.args([
                "-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=30", "-o", "ExitOnForwardFailure=yes",
                "-R", &format!("80:127.0.0.1:{port}"), "nokey@localhost.run",
            ]),
            _ => {
                if ngrok_token.is_empty() {
                    return fail("ngrok needs a token", "");
                }
                cmd.env("NGROK_AUTHTOKEN", ngrok_token).args(["http", &port.to_string(), "--log", "stdout", "--log-format", "logfmt"])
            }
        };
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).creation_flags(NO_WINDOW);
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return fail(&format!("could not start: {e}"), "retry"),
        };
        let out = child.stdout.take();
        let err = child.stderr.take();
        kids.lock().unwrap().push(child);

        let (tx, rx) = std::sync::mpsc::channel::<String>();
        for r in [out.map(|o| Box::new(o) as Box<dyn Read + Send>), err.map(|e| Box::new(e) as Box<dyn Read + Send>)].into_iter().flatten() {
            let tx = tx.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(r).lines().map_while(Result::ok) {
                    let _ = tx.send(line);
                }
            });
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(45);
        let mut last = String::new();
        while std::time::Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(line) => {
                    if let Some(host) = find_host(&line, t.suffixes) {
                        let label = host.split('.').next().unwrap_or("").to_string();
                        return emit(json!({"t": "ready", "method": t.method, "host": host, "label": label, "url": format!("https://{host}")}));
                    }
                    if line.to_ascii_lowercase().contains("err") || line.to_ascii_lowercase().contains("denied") {
                        last = line;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => break,
            }
        }
        fail(&if last.is_empty() { "no link after 45 seconds".to_string() } else { last.chars().take(160).collect() }, "retry");
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_tunnel_output() {
        let cf = &[".trycloudflare.com"];
        assert_eq!(find_host("2026 INF |  https://quiet-river-4821.trycloudflare.com  |", cf).as_deref(), Some("quiet-river-4821.trycloudflare.com"));
        assert_eq!(find_host("POST https://api.trycloudflare.com/tunnel failed", cf), None); // cloudflared logs its API host too
        assert_eq!(find_host("see https://example.com now", cf), None);
        let lhr = &[".lhr.life"];
        assert_eq!(
            find_host("b05d89fbd124ac.app.lhr.life tunneled with tls termination, https://b05d89fbd124ac.app.lhr.life", lhr).as_deref(),
            Some("b05d89fbd124ac.app.lhr.life") // real banner line from localhost.run
        );
        assert_eq!(find_host("Follow https://admin.localhost.run/ to learn more about localhost.run", lhr), None);
        assert_eq!(find_host("Open your tunnel at https://admin.localhost.run/ or https://abc123def.lhr.life now", lhr).as_deref(), Some("abc123def.lhr.life"));
        assert_eq!(find_host("abc123 tunneled with tls termination, https://abc123def.lhr.life", lhr).as_deref(), Some("abc123def.lhr.life"));
        let ng = &[".ngrok-free.app", ".ngrok-free.dev"];
        assert_eq!(find_host("t=2026 lvl=info msg=\"started tunnel\" url=https://x-y-z.ngrok-free.dev", ng).as_deref(), Some("x-y-z.ngrok-free.dev"));
        assert_eq!(find_host("no url here", ng), None);
    }
}
