#![windows_subsystem = "windows"]
//! Flux Control setup. Tiny Rust shell: shows the HTML wizard in WebView2 and installs Node.js + Electron on demand.

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};
use std::{fs, io};
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::platform::windows::WindowBuilderExtWindows;
use tao::window::{Window, WindowBuilder};
use wry::{WebViewBuilder, WebViewBuilderExtWindows};

mod update;

const NODE_VER: &str = "22.11.0";
const ELECTRON_VER: &str = "33.2.0";
const NO_WINDOW: u32 = 0x0800_0000;
const DETACHED: u32 = 0x0000_0008;

enum Ev {
    Js(String),
    Msg(String),
}
type Proxy = EventLoopProxy<Ev>;

fn home() -> PathBuf {
    std::env::var_os("FLUX_HOME").map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_else(|| ".".into())).join("FluxControl")
    })
}

/// `--simulate` fakes the check results and installs (no downloads) so the UI can be demoed anywhere.
fn simulate() -> bool {
    std::env::args().any(|a| a == "--simulate")
}

fn send(p: &Proxy, v: Value) {
    let _ = p.send_event(Ev::Js(format!("window.__flux({v})")));
}

fn page() -> String {
    include_str!("../ui/index.html")
        .replace(r#"<link rel="stylesheet" href="../../shared/style.css">"#, &format!("<style>{}</style>", include_str!("../../shared/style.css")))
        .replace(r#"<script src="../../shared/controls.js"></script>"#, &format!("<script>{}</script>", include_str!("../../shared/controls.js")))
        .replace(r#"<script src="app.js"></script>"#, &format!("<script>{}</script>", include_str!("../ui/app.js")))
}

// ------------------------------------------------------------------ dependency checks
fn node_status() -> Option<String> {
    if home().join("node").join("node.exe").exists() {
        return Some(format!("v{NODE_VER} (bundled)"));
    }
    let out = Command::new("node").arg("--version").creation_flags(NO_WINDOW).output().ok()?;
    out.status.success().then(|| format!("{} (system)", String::from_utf8_lossy(&out.stdout).trim()))
}

/// A real electron.exe we can host our app with: our own copy, then global npm, then dev copies in
/// project folders (Desktop/Documents, one level deep). Apps like Discord ship locked copies that can't host ours.
fn find_electron() -> Option<(PathBuf, String)> {
    let ver = |exe: &Path| -> String {
        exe.parent()
            .and_then(|d| d.parent())
            .and_then(|d| fs::read_to_string(d.join("package.json")).ok())
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v["version"].as_str().map(|s| format!("v{s}")))
            .unwrap_or_default()
    };
    let own = home().join("electron").join("electron.exe");
    if own.exists() {
        return Some((own, format!("v{ELECTRON_VER}")));
    }
    let rel = Path::new("node_modules").join("electron").join("dist").join("electron.exe");
    if let Some(app) = std::env::var_os("APPDATA") {
        let g = PathBuf::from(app).join("npm").join(&rel);
        if g.exists() {
            let v = ver(&g);
            return Some((g, format!("{v} (global)")));
        }
    }
    let user = PathBuf::from(std::env::var_os("USERPROFILE")?);
    for base in ["Desktop", "Documents"] {
        for e in fs::read_dir(user.join(base)).into_iter().flatten().flatten() {
            let exe = e.path().join(&rel);
            if exe.exists() {
                let v = ver(&exe);
                return Some((exe, format!("{v} ({})", e.file_name().to_string_lossy())));
            }
        }
    }
    None
}

/// ffmpeg is optional (it only powers GPU encoding): in the Flux folder or anywhere on PATH.
fn ffmpeg_found() -> Option<String> {
    if home().join("bin").join("ffmpeg.exe").exists() {
        return Some("Installed".into());
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).any(|d| d.join("ffmpeg.exe").exists()).then(|| "Found on this PC".into())
}

/// Optional dependencies the user chose to skip are not asked about again.
fn skipped(id: &str) -> bool {
    fs::read_to_string(home().join("skip.txt")).is_ok_and(|t| t.lines().any(|l| l.trim() == id))
}

fn install_ffmpeg(p: &Proxy) -> Result<(), String> {
    let h = home();
    fs::create_dir_all(h.join("bin")).map_err(|e| e.to_string())?;
    let zip_path = h.join("ffmpeg.zip");
    download("https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip", &zip_path, "ffmpeg", p)?;
    progress(p, "ffmpeg", 88, "Unpacking…".into());
    let r = (|| -> Result<(), String> {
        let mut ar = zip::ZipArchive::new(fs::File::open(&zip_path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let idx = (0..ar.len()).find(|i| ar.by_index(*i).is_ok_and(|f| f.name().ends_with("/bin/ffmpeg.exe"))).ok_or("ffmpeg.exe not found in the download")?;
        let mut f = ar.by_index(idx).map_err(|e| e.to_string())?;
        let part = h.join("bin").join("ffmpeg.exe.part");
        io::copy(&mut f, &mut fs::File::create(&part).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        fs::rename(&part, h.join("bin").join("ffmpeg.exe")).map_err(|e| e.to_string())
    })();
    let _ = fs::remove_file(&zip_path);
    r
}

fn check(p: Proxy) {
    let dep = |id: &str, found: Option<String>, missing: &str| {
        let (state, detail) = match found {
            Some(d) => ("found", d),
            None => ("missing", missing.to_string()),
        };
        send(&p, json!({"t": "dep", "id": id, "state": state, "detail": detail}));
    };
    if simulate() {
        dep("webview2", Some("Ready".into()), "");
        dep("node", Some(format!("v{NODE_VER}")), "");
        dep("electron", None, "~110 MB");
        dep("ffmpeg", None, "~115 MB");
        dep("app", None, "~1 MB");
    } else {
        let h = home();
        dep("webview2", Some("Ready".into()), "");
        dep("node", node_status(), "~30 MB");
        dep("electron", find_electron().map(|(_, d)| d), "~110 MB");
        dep("ffmpeg", ffmpeg_found().or_else(|| skipped("ffmpeg").then(|| "Skipped".into())), "~115 MB");
        dep("app", h.join("app").join("main.js").exists().then(|| format!("v{}", update::installed_version().unwrap_or_default())), "~1 MB");
    }
    send(&p, json!({"t": "checked"}));
}

// ------------------------------------------------------------------ installers
fn progress(p: &Proxy, id: &str, pct: u64, label: String) {
    send(p, json!({"t": "progress", "id": id, "pct": pct, "label": label}));
}

fn download(url: &str, dest: &Path, id: &str, p: &Proxy) -> Result<(), String> {
    let resp = ureq::get(url).call().map_err(|e| format!("download failed: {e}"))?;
    let total: u64 = resp.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut r = resp.into_reader();
    let mut f = fs::File::create(dest).map_err(|e| e.to_string())?;
    let (mut buf, mut done, mut last) = (vec![0u8; 64 * 1024], 0u64, Instant::now());
    loop {
        let n = r.read(&mut buf).map_err(|e| format!("download interrupted: {e}"))?;
        if n == 0 {
            break;
        }
        f.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if last.elapsed() > Duration::from_millis(100) {
            last = Instant::now();
            let pct = if total > 0 { done * 85 / total } else { 0 }; // download is 0-85%, unpack 85-100%
            progress(p, id, pct, format!("Downloading {} / {} MB", done >> 20, total >> 20));
        }
    }
    Ok(())
}

/// Unpack into `dest.part`, then rename, so a half-finished install is never reported as found.
fn unpack(zip_path: &Path, dest: &Path, strip_top: bool) -> Result<(), String> {
    let part = dest.with_extension("part");
    let _ = fs::remove_dir_all(&part);
    let mut ar = zip::ZipArchive::new(fs::File::open(zip_path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    for i in 0..ar.len() {
        let mut f = ar.by_index(i).map_err(|e| e.to_string())?;
        let Some(name) = f.enclosed_name() else { continue }; // rejects zip-slip paths
        let rel: PathBuf = if strip_top { name.components().skip(1).collect() } else { name };
        if rel.as_os_str().is_empty() {
            continue;
        }
        let out = part.join(rel);
        if f.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        } else {
            if let Some(par) = out.parent() {
                fs::create_dir_all(par).map_err(|e| e.to_string())?;
            }
            io::copy(&mut f, &mut fs::File::create(&out).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        }
    }
    let _ = fs::remove_dir_all(dest);
    fs::rename(&part, dest).map_err(|e| e.to_string())
}

fn install_zip(id: &str, url: &str, dest: PathBuf, strip_top: bool, p: &Proxy) -> Result<(), String> {
    let h = home();
    fs::create_dir_all(&h).map_err(|e| e.to_string())?;
    let zip_path = h.join(format!("{id}.zip"));
    download(url, &zip_path, id, p)?;
    progress(p, id, 88, "Unpacking…".into());
    let r = unpack(&zip_path, &dest, strip_top);
    let _ = fs::remove_file(&zip_path);
    r
}

/// Writes the Electron client and the shared design files (the client loads ../shared/*).
fn write_app() -> Result<(), String> {
    for (rel, body) in [
        ("app/package.json", include_str!("../../app/package.json")),
        ("app/main.js", include_str!("../../app/main.js")),
        ("app/preload.js", include_str!("../../app/preload.js")),
        ("app/index.html", include_str!("../../app/index.html")),
        ("app/client.css", include_str!("../../app/client.css")),
        ("app/client.js", include_str!("../../app/client.js")),
        ("app/viewer.js", include_str!("../../app/viewer.js")),
        ("app/executor.js", include_str!("../../app/executor.js")),
        ("app/luau.js", include_str!("../../app/luau.js")),
        ("app/executor.css", include_str!("../../app/executor.css")),
        ("app/hubrunner.lua", include_str!("../../app/hubrunner.lua")),
        ("app/claude.js", include_str!("../../app/claude.js")),
        ("app/claude.css", include_str!("../../app/claude.css")),
        ("app/claude-main.js", include_str!("../../app/claude-main.js")),
        ("app/mcp.js", include_str!("../../app/mcp.js")),
        ("shared/style.css", include_str!("../../shared/style.css")),
        ("shared/session.css", include_str!("../../shared/session.css")),
        ("shared/controls.js", include_str!("../../shared/controls.js")),
        ("shared/features.js", include_str!("../../shared/features.js")),
        ("shared/hud.js", include_str!("../../shared/hud.js")),
        ("shared/code.js", include_str!("../../shared/code.js")),
    ] {
        let path = home().join(rel);
        fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(path, body).map_err(|e| e.to_string())?;
    }
    for (rel, body) in [
        ("shared/assets/geist-medium.ttf", &include_bytes!("../../shared/assets/geist-medium.ttf")[..]),
        ("shared/assets/icon.ico", &include_bytes!("../../shared/assets/icon.ico")[..]),
        ("shared/assets/geist-semibold.ttf", &include_bytes!("../../shared/assets/geist-semibold.ttf")[..]),
    ] {
        let path = home().join(rel);
        fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(path, body).map_err(|e| e.to_string())?;
    }
    // the Rust sharing host; skipped when an identical copy is already there (it cannot be replaced while running)
    let host = include_bytes!("../../host/target/release/flux-host.exe");
    let path = home().join("bin").join("flux-host.exe");
    if fs::metadata(&path).map(|m| m.len() as usize).ok() != Some(host.len()) {
        fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(path, host).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn install(ids: Vec<String>, p: Proxy) {
    for id in ids {
        progress(&p, &id, 0, "Starting…".into());
        let res = if simulate() {
            (0..=100).step_by(5).for_each(|i| {
                progress(&p, &id, i, format!("Downloading… {i}%"));
                std::thread::sleep(Duration::from_millis(60));
            });
            Ok(())
        } else {
            match id.as_str() {
                "node" => install_zip(
                    "node",
                    &format!("https://nodejs.org/dist/v{NODE_VER}/node-v{NODE_VER}-win-x64.zip"),
                    home().join("node"),
                    true,
                    &p,
                ),
                "electron" => install_zip(
                    "electron",
                    &format!("https://github.com/electron/electron/releases/download/v{ELECTRON_VER}/electron-v{ELECTRON_VER}-win32-x64.zip"),
                    home().join("electron"),
                    false,
                    &p,
                ),
                "ffmpeg" => install_ffmpeg(&p),
                "app" => update::install_embedded(),
                other => Err(format!("unknown dependency {other}")),
            }
        };
        match res {
            Ok(()) => send(&p, json!({"t": "installed", "id": id, "ok": true})),
            Err(e) => {
                let _ = fs::write(home().join("install.log"), format!("{id}: {e}
")); // kept for support
                send(&p, json!({"t": "installed", "id": id, "ok": false, "err": e}));
            }
        }
    }
    send(&p, json!({"t": "install_done"}));
}

// ------------------------------------------------------------------ launch
/// Saves the wizard choices and starts the Electron app. Returns true when the setup should exit.
fn launch(config: &Value, p: &Proxy) -> bool {
    let h = home();
    if simulate() {
        send(p, json!({"t": "error", "err": "Preview mode: launch skipped"}));
        return false;
    }
    let Some((exe, _)) = find_electron() else {
        send(p, json!({"t": "error", "err": "Electron is not installed yet"}));
        return false;
    };
    let _ = fs::create_dir_all(&h);
    if config.as_object().is_some_and(|o| !o.is_empty()) {
        let _ = fs::write(h.join("config.json"), serde_json::to_vec_pretty(config).unwrap_or_default());
    }
    // a finished install is never rewritten here (that would undo a downloaded update); setup only fills in a missing one
    if update::installed_version().is_none() {
        if let Err(e) = update::install_embedded() {
            send(p, json!({"t": "error", "err": e}));
            return false;
        }
    }
    let _ = update::write_launcher();
    let _ = update::ensure_path(); // idempotent: the folder is added to PATH once
    let _ = update::ensure_shortcut(); // and the Start Menu entry is refreshed, never duplicated
    match Command::new(exe).arg(h.join("app")).creation_flags(DETACHED).spawn() {
        Ok(_) => true,
        Err(e) => {
            send(p, json!({"t": "error", "err": format!("Could not launch: {e}")}));
            false
        }
    }
}

// ------------------------------------------------------------------ app
/// Returns true to quit.
fn handle(msg: &str, window: &Window, p: &Proxy) -> bool {
    let Ok(m) = serde_json::from_str::<Value>(msg) else { return false };
    match m["t"].as_str().unwrap_or("") {
        "drag" => {
            let _ = window.drag_window();
        }
        "min" => window.set_minimized(true),
        "close" => return true,
        "status" => {
            let p = p.clone();
            std::thread::spawn(move || update::status(p));
        }
        "update" => {
            let p = p.clone();
            std::thread::spawn(move || update::run_update(p));
        }
        "skip" => {
            // optional pieces the user said "later" to: remember it, so they are not asked on every launch
            let ids: Vec<String> = m["ids"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().filter(|i| *i == "ffmpeg").map(String::from)).collect()).unwrap_or_default();
            if !ids.is_empty() {
                let _ = fs::create_dir_all(home());
                let _ = fs::write(home().join("skip.txt"), ids.join("\n"));
            }
        }
        "check" => {
            let p = p.clone();
            std::thread::spawn(move || check(p));
        }
        "install" => {
            let ids = m["ids"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
            let p = p.clone();
            std::thread::spawn(move || install(ids, p));
        }
        "launch" => return launch(&m["config"], p),
        _ => {}
    }
    false
}

fn main() -> wry::Result<()> {
    let event_loop = EventLoopBuilder::<Ev>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    if std::env::args().any(|a| a == "--shortcut") {
        // test hook: creates the Start Menu shortcut (FLUX_LNK redirects it) and records the result
        let r = update::ensure_shortcut();
        let _ = fs::create_dir_all(home());
        let _ = fs::write(home().join("shortcut.txt"), format!("{r:?}"));
        return Ok(());
    }
    if std::env::args().any(|a| a == "--install-ffmpeg") {
        // test hook: runs just the ffmpeg install into FLUX_HOME
        install(vec!["ffmpeg".into()], proxy);
        let _ = fs::write(home().join("ffmpeg-test.txt"), format!("{:?}", fs::metadata(home().join("bin").join("ffmpeg.exe")).map(|m| m.len())));
        return Ok(());
    }
    if std::env::args().any(|a| a == "--detect") {
        let _ = fs::create_dir_all(home());
        let r = format!("electron={:?}
node={:?}
ffmpeg={:?}
missing={:?}
", find_electron(), node_status(), ffmpeg_found(), update::missing_now());
        let _ = fs::write(home().join("detect.txt"), r);
        return Ok(());
    }
    if let Some(i) = std::env::args().position(|a| a == "--apply-payload") {
        // test hook: --apply-payload <zip> <sha256> <version> applies a payload exactly like an update would
        let a: Vec<String> = std::env::args().collect();
        let r = update::install_payload(Path::new(&a[i + 1]), &a[i + 2], &a[i + 3]);
        let _ = fs::create_dir_all(home());
        let _ = fs::write(home().join("apply.txt"), format!("{r:?}"));
        return Ok(());
    }
    if std::env::args().any(|a| a == "--selftest") {
        // headless run of the real installers, result goes to <FLUX_HOME>/selftest.txt
        install(vec!["node".into(), "electron".into(), "app".into()], proxy);
        let h = home();
        let ok = |p: PathBuf| p.exists();
        let _ = fs::write(
            h.join("selftest.txt"),
            format!("node={} electron={} app={}", ok(h.join("node/node.exe")), ok(h.join("electron/electron.exe")), ok(h.join("app/main.js"))),
        );
        return Ok(());
    }
    let window = WindowBuilder::new()
        .with_title("Flux Control Setup")
        .with_inner_size(LogicalSize::new(920.0, 600.0))
        .with_resizable(false)
        .with_decorations(false)
        .with_transparent(true)
        .with_undecorated_shadow(false)
        .build(&event_loop)
        .expect("window");

    let ipc = proxy.clone();
    let webview = WebViewBuilder::new()
        .with_transparent(true)
        .with_background_color((0, 0, 0, 0))
        .with_html(page())
        .with_devtools(false)
        .with_default_context_menus(false)
        .with_browser_accelerator_keys(false)
        .with_ipc_handler(move |req| {
            let _ = ipc.send_event(Ev::Msg(req.body().clone()));
        })
        .build(&window)?;

    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(Ev::Js(js)) => {
                let _ = webview.evaluate_script(&js);
            }
            Event::UserEvent(Ev::Msg(m)) => {
                if handle(&m, &window, &proxy) {
                    *flow = ControlFlow::Exit;
                }
            }
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => *flow = ControlFlow::Exit,
            _ => {}
        }
    });
}
