//! Tiny HTTP + WebSocket server. /ws is the remote-control channel; any other path is a placeholder page
//! (the web client will be served from here later).
use crate::capture::Shared;
use crate::{emit, input};
use base64::Engine;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub struct Cfg {
    pub password: String,
    /// the monitors viewers can pick from: [{i, name, w, h, primary}]
    pub mons: Value,
    pub switch: std::sync::mpsc::Sender<usize>,
}

const MAX_MSG: usize = 128 * 1024;

// signed-in viewers by connection number, so the app can answer a web client's chat calls (relayed through stdin/stdout)
static CONNS: std::sync::OnceLock<Mutex<HashMap<u64, Arc<Mutex<TcpStream>>>>> = std::sync::OnceLock::new();
static NEXT_CONN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
fn conns() -> &'static Mutex<HashMap<u64, Arc<Mutex<TcpStream>>>> {
    CONNS.get_or_init(Default::default)
}
/** Text message to one viewer (an answer to its call). */
pub fn send_to(conn: u64, text: &str) {
    let outs: Vec<_> = conns().lock().unwrap().iter().filter(|(k, _)| conn == 0 || **k == conn).map(|(_, o)| o.clone()).collect();
    for o in outs {
        let _ = write_frame(&o, 1, text.as_bytes());
    }
}

fn eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn accept_key(key: &str) -> String {
    let mut h = Sha1::new();
    h.update(key.as_bytes());
    h.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    base64::engine::general_purpose::STANDARD.encode(h.finalize())
}

/// Reads the request head (up to the blank line). Returns (path, lowercase headers).
fn read_head(s: &mut TcpStream) -> io::Result<(String, HashMap<String, String>)> {
    let mut buf = Vec::new();
    let mut b = [0u8; 1];
    while !buf.ends_with(b"\r\n\r\n") {
        if buf.len() > 16 * 1024 || s.read(&mut b)? == 0 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        buf.push(b[0]);
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    let mut lines = text.split("\r\n");
    let first = lines.next().unwrap_or("");
    let path = first.split(' ').nth(1).unwrap_or("/").split('?').next().unwrap_or("/").to_string();
    let headers = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())).collect();
    Ok((path, headers))
}

// ---- WebSocket framing (RFC 6455, just what we need) ----------------------------------------
fn read_frame(s: &mut impl Read) -> io::Result<(u8, bool, Vec<u8>)> {
    let mut h = [0u8; 2];
    s.read_exact(&mut h)?;
    let (fin, op, masked) = (h[0] & 0x80 != 0, h[0] & 0x0f, h[1] & 0x80 != 0);
    let mut len = (h[1] & 0x7f) as u64;
    if len == 126 {
        let mut b = [0u8; 2];
        s.read_exact(&mut b)?;
        len = u16::from_be_bytes(b) as u64;
    } else if len == 127 {
        let mut b = [0u8; 8];
        s.read_exact(&mut b)?;
        len = u64::from_be_bytes(b);
    }
    if !masked || len as usize > MAX_MSG {
        return Err(io::ErrorKind::InvalidData.into()); // clients must mask; no huge messages
    }
    let mut mask = [0u8; 4];
    s.read_exact(&mut mask)?;
    let mut p = vec![0u8; len as usize];
    s.read_exact(&mut p)?;
    for (i, b) in p.iter_mut().enumerate() {
        *b ^= mask[i % 4];
    }
    Ok((op, fin, p))
}

fn write_frame(s: &Mutex<TcpStream>, op: u8, payload: &[u8]) -> io::Result<()> {
    let mut f = Vec::with_capacity(payload.len() + 10);
    f.push(0x80 | op);
    match payload.len() {
        n if n < 126 => f.push(n as u8),
        n if n < 65536 => {
            f.push(126);
            f.extend_from_slice(&(n as u16).to_be_bytes());
        }
        n => {
            f.push(127);
            f.extend_from_slice(&(n as u64).to_be_bytes());
        }
    }
    f.extend_from_slice(payload);
    s.lock().unwrap().write_all(&f)
}

fn send_json(s: &Mutex<TcpStream>, v: Value) -> io::Result<()> {
    write_frame(s, 1, v.to_string().as_bytes())
}

/// Reads one complete text message (joins continuation frames). None on close.
fn read_message(s: &mut TcpStream, out: &Mutex<TcpStream>) -> io::Result<Option<String>> {
    let mut acc: Vec<u8> = Vec::new();
    loop {
        let (op, fin, p) = read_frame(s)?;
        match op {
            8 => return Ok(None),
            9 => write_frame(out, 10, &p)?, // ping -> pong
            0 | 1 | 2 => {
                acc.extend_from_slice(&p);
                if acc.len() > MAX_MSG {
                    return Err(io::ErrorKind::InvalidData.into());
                }
                if fin {
                    return Ok(Some(String::from_utf8_lossy(&acc).into_owned()));
                }
            }
            _ => {}
        }
    }
}

fn session(mut s: TcpStream, key: &str, shared: Arc<Shared>, cfg: Arc<Cfg>, run: Arc<AtomicBool>) -> io::Result<()> {
    write!(s, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n", accept_key(key))?;
    let out = Arc::new(Mutex::new(s.try_clone()?));

    // first message must be the password, within 8 seconds
    s.set_read_timeout(Some(Duration::from_secs(8)))?;
    let auth = read_message(&mut s, &out)?.and_then(|t| serde_json::from_str::<Value>(&t).ok());
    let ok = auth.as_ref().is_some_and(|a| a["t"] == "auth" && eq(a["pw"].as_str().unwrap_or(""), &cfg.password));
    if !ok {
        std::thread::sleep(Duration::from_millis(1000)); // slows guessing
        let _ = send_json(&out, json!({"t": "err", "err": "Wrong password"}));
        let _ = write_frame(&out, 8, &[]);
        return Ok(());
    }
    s.set_read_timeout(Some(Duration::from_secs(30)))?; // the client pings every 10 s; silence means it is gone
    let hello = {
        let g = shared.st.lock().unwrap();
        json!({"t": "ok", "w": g.w, "h": g.h, "mon": g.mon, "mons": cfg.mons})
    };
    send_json(&out, hello)?;

    let conn = NEXT_CONN.fetch_add(1, Relaxed);
    conns().lock().unwrap().insert(conn, out.clone());
    let n = shared.viewers.fetch_add(1, Relaxed) + 1;
    if n == 1 {
        shared.request_key();
    }
    emit(json!({"t": "viewers", "n": n}));

    let alive = Arc::new(AtomicBool::new(true));
    let writer = {
        let (shared, out, alive, run) = (shared.clone(), out.clone(), alive.clone(), run.clone());
        std::thread::spawn(move || {
            let (mut gen, mut next, mut cur) = (0u64, 0u64, 0u64); // gen 0: nothing sent yet (captures start at 1)
            while alive.load(Relaxed) && run.load(Relaxed) {
                let mut g = shared.st.lock().unwrap();
                let msg: Option<Vec<(u8, Vec<u8>)>> = loop {
                    if !alive.load(Relaxed) || !run.load(Relaxed) {
                        break None;
                    }
                    if g.gen != gen {
                        // first picture, or the host switched monitors: (screen message +) the new init segment
                        if let Some(i) = g.init.clone() {
                            let mut v = Vec::new();
                            if gen != 0 {
                                v.push((1, json!({"t": "screen", "w": g.w, "h": g.h, "mon": g.mon}).to_string().into_bytes()));
                            }
                            v.push((2, (*i).clone()));
                            gen = g.gen;
                            next = 0;
                            break Some(v);
                        }
                    } else if g.cursor_seq != cur {
                        cur = g.cursor_seq;
                        break Some(vec![(1, json!({"t": "cursor", "name": g.cursor}).to_string().into_bytes())]);
                    } else {
                        // a viewer that fell behind jumps to the oldest kept (keyframe) fragment
                        let want = next.max(g.frags.front().map_or(0, |f| f.0));
                        if let Some(f) = g.frags.iter().find(|f| f.0 >= want) {
                            next = f.0 + 1;
                            break Some(vec![(2, (*f.1).clone())]);
                        }
                    }
                    g = shared.cv.wait_timeout(g, Duration::from_millis(400)).unwrap().0;
                };
                drop(g);
                match msg {
                    Some(v) => {
                        if v.iter().any(|(op, p)| write_frame(&out, *op, p).is_err()) {
                            break;
                        }
                    }
                    None => break,
                }
            }
        })
    };

    let mut held = HashSet::new();
    while run.load(Relaxed) {
        match read_message(&mut s, &out) {
            Ok(Some(t)) => {
                if let Ok(m) = serde_json::from_str::<Value>(&t) {
                    if m["t"] == "rpc" {
                        emit(json!({"t": "rpc", "c": conn, "id": m["id"], "m": m["m"], "a": m["a"]})); // the app answers through send_to
                    } else if m["t"] == "mon" {
                        if let Some(i) = m["i"].as_u64() {
                            let _ = cfg.switch.send(i as usize);
                        }
                    } else if m["t"] == "ping" {
                        let _ = send_json(&out, json!({"t": "pong", "c": m["c"], "hf": shared.sent_fps.load(Relaxed)})); // the viewer measures the round trip
                    } else {
                        input::apply(&m, &mut held);
                    }
                }
            }
            _ => break,
        }
    }
    conns().lock().unwrap().remove(&conn);
    input::release_all(&mut held);
    alive.store(false, Relaxed);
    shared.cv.notify_all();
    let _ = writer.join();
    let n = shared.viewers.fetch_sub(1, Relaxed) - 1;
    emit(json!({"t": "viewers", "n": n}));
    Ok(())
}

/// The web client, embedded in the exe.
fn asset(path: &str) -> Option<(&'static str, &'static [u8])> {
    Some(match path {
        "/" | "/index.html" => ("text/html; charset=utf-8", &include_bytes!("../../web/index.html")[..]),
        "/style.css" => ("text/css; charset=utf-8", &include_bytes!("../../shared/style.css")[..]),
        "/session.css" => ("text/css; charset=utf-8", &include_bytes!("../../shared/session.css")[..]),
        "/web.css" => ("text/css; charset=utf-8", &include_bytes!("../../web/web.css")[..]),
        "/controls.js" => ("text/javascript; charset=utf-8", &include_bytes!("../../shared/controls.js")[..]),
        "/viewer.js" => ("text/javascript; charset=utf-8", &include_bytes!("../../app/viewer.js")[..]),
        "/hud.js" => ("text/javascript; charset=utf-8", &include_bytes!("../../shared/hud.js")[..]),
        "/web.js" => ("text/javascript; charset=utf-8", &include_bytes!("../../web/web.js")[..]),
        "/executor.js" => ("text/javascript; charset=utf-8", &include_bytes!("../../app/executor.js")[..]),
        "/luau.js" => ("text/javascript; charset=utf-8", &include_bytes!("../../app/luau.js")[..]),
        "/claude.js" => ("text/javascript; charset=utf-8", &include_bytes!("../../app/claude.js")[..]),
        "/executor.css" => ("text/css; charset=utf-8", &include_bytes!("../../app/executor.css")[..]),
        "/claude.css" => ("text/css; charset=utf-8", &include_bytes!("../../app/claude.css")[..]),
        "/assets/geist-medium.ttf" => ("font/ttf", &include_bytes!("../../shared/assets/geist-medium.ttf")[..]),
        "/assets/geist-semibold.ttf" => ("font/ttf", &include_bytes!("../../shared/assets/geist-semibold.ttf")[..]),
        _ => return None,
    })
}

/// A browser page on another site must not be able to talk to this PC's socket. The app (file://) and same-origin pages are fine.
fn origin_ok(h: &HashMap<String, String>) -> bool {
    match h.get("origin").map(|o| o.as_str()) {
        None | Some("null") => true,
        Some(o) if o.starts_with("file://") => true,
        Some(o) => {
            let host = h.get("host").map(|x| x.as_str()).unwrap_or("");
            o == format!("http://{host}") || o == format!("https://{host}")
        }
    }
}

fn respond(s: &mut TcpStream, code: &str, ctype: &str, body: &[u8]) {
    let _ = write!(s, "HTTP/1.1 {code}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n", body.len());
    let _ = s.write_all(body);
}

fn handle(mut s: TcpStream, shared: Arc<Shared>, cfg: Arc<Cfg>, run: Arc<AtomicBool>) {
    let _ = s.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = s.set_nodelay(true);
    let Ok((path, h)) = read_head(&mut s) else { return };
    let upgrade = h.get("upgrade").is_some_and(|u| u.eq_ignore_ascii_case("websocket"));
    if path == "/ws" {
        match (upgrade, h.get("sec-websocket-key"), origin_ok(&h)) {
            (true, Some(k), true) => {
                let _ = session(s, k, shared, cfg, run);
            }
            _ => respond(&mut s, "403 Forbidden", "text/plain", b"forbidden"),
        }
        return;
    }
    if let Some(rest) = path.strip_prefix("/monaco/vs/") {
        let ok = !rest.contains("..") && !rest.contains('\\') &&!rest.contains(':') && rest.bytes().all(|b| b.is_ascii_graphic());
        let home = std::env::var_os("FLUX_HOME").map(std::path::PathBuf::from).or_else(|| std::env::var_os("LOCALAPPDATA").map(|l| std::path::PathBuf::from(l).join("FluxControl")));
        let file = home.filter(|_| ok).map(|h| h.join("vendor").join("monaco").join("vs").join(rest));
        match file.and_then(|f| std::fs::read(&f).ok()) {
            Some(body) => {
                let t = match rest.rsplit('.').next() { Some("js") => "text/javascript; charset=utf-8", Some("css") => "text/css; charset=utf-8", Some("ttf") => "font/ttf", Some("json") => "application/json", _ => "application/octet-stream" };
                respond(&mut s, "200 OK", t, &body);
            }
            None => respond(&mut s, "404 Not Found", "text/plain", b"not found"),
        }
        return;
    }
    match asset(&path) {
        Some((t, body)) => respond(&mut s, "200 OK", t, body),
        None => respond(&mut s, "404 Not Found", "text/plain", b"not found"),
    }
}

pub fn serve(listener: TcpListener, shared: Arc<Shared>, cfg: Arc<Cfg>, run: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        for s in listener.incoming().flatten() {
            let (sh, c, r) = (shared.clone(), cfg.clone(), run.clone());
            std::thread::spawn(move || handle(s, sh, c, r));
        }
    });
}
