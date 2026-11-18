//! flux-host: shares one of this PC's screens with Flux Control clients.
//! Config arrives as ONE json line on stdin; events leave as json lines on stdout; closing stdin stops everything.
mod apps;
mod capture;
mod gpu;
mod input;
mod mp4;
mod net;
mod server;

use capture::{fit, Cap, Cfg, Flags, Shared};
use windows_capture::capture::CaptureControl;
use serde_json::{json, Value};
use std::io::BufRead;
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use windows_capture::capture::GraphicsCaptureApiHandler;
use windows_capture::monitor::Monitor;
use windows_capture::settings::*;

pub fn emit(v: Value) {
    println!("{v}");
}

/// (box width, box height, fps, bitrate)
fn preset(q: &str) -> (u32, u32, u32, u32) {
    match q {
        "1080p60" => (1920, 1080, 60, 9_000_000),
        "1080p30" => (1920, 1080, 30, 6_000_000),
        "720p60" => (1280, 720, 60, 5_000_000),
        _ => (1280, 720, 30, 3_000_000),
    }
}

struct Ctx {
    port: u16,
    lan: Option<std::net::Ipv4Addr>,
    ngrok_token: String,
    kids: Arc<Mutex<Vec<std::process::Child>>>,
    upnp: Arc<Mutex<Option<(igd_next::Gateway, u16)>>>,
}

/// Starts one way of being reached and reports `ready` or `error` (with a `fix` hint the UI can offer).
fn start_method(m: &str, c: &Arc<Ctx>) {
    let port = c.port;
    match m {
        "lan" => match c.lan {
            Some(ip) => emit(json!({"t": "ready", "method": "lan", "host": ip.to_string(), "port": port, "url": format!("http://{ip}:{port}")})),
            None => emit(json!({"t": "error", "method": "lan", "err": "no local network address found", "fix": "retry"})),
        },
        "upnp" => {
            let upnp = c.upnp.clone();
            let local = c.lan.unwrap_or(std::net::Ipv4Addr::LOCALHOST);
            std::thread::spawn(move || match net::upnp_open(port, local) {
                Ok((gw, ip)) => {
                    *upnp.lock().unwrap() = Some((gw, port));
                    emit(json!({"t": "ready", "method": "upnp", "host": ip, "port": port, "url": format!("http://{ip}:{port}")}));
                }
                Err(e) => emit(json!({"t": "error", "method": "upnp", "err": e, "fix": "retry"})),
            });
        }
        other => match net::tunnel_spec(other) {
            Some(t) => net::start_tunnel(t, port, c.ngrok_token.clone(), c.kids.clone()),
            None => emit(json!({"t": "error", "method": other, "err": "unknown method"})),
        },
    }
}

fn die_fix(msg: &str, fix: &str) -> ! {
    emit(json!({"t": "fatal", "err": msg, "fix": fix}));
    std::process::exit(1);
}

fn die(msg: &str) -> ! {
    emit(json!({"t": "fatal", "err": msg}));
    std::process::exit(1);
}

/// Caps CPU use: a percentage of the whole PC (Windows job object, hard cap) or a number of cores (affinity).
fn limit_cpu(percent: Option<u64>, cores: Option<u64>) {
    use windows::Win32::System::JobObjects::*;
    use windows::Win32::System::Threading::{GetCurrentProcess, SetProcessAffinityMask};
    unsafe {
        if let Some(pct) = percent.filter(|p| (5..100).contains(p)) {
            if let Ok(job) = CreateJobObjectW(None, None) {
                let info = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
                    ControlFlags: JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
                    Anonymous: JOBOBJECT_CPU_RATE_CONTROL_INFORMATION_0 { CpuRate: (pct * 100) as u32 },
                };
                let _ = SetInformationJobObject(job, JobObjectCpuRateControlInformation, &info as *const _ as *const _, std::mem::size_of_val(&info) as u32);
                let _ = AssignProcessToJobObject(job, GetCurrentProcess());
            }
        }
        if let Some(n) = cores.filter(|n| *n >= 1) {
            let total = std::thread::available_parallelism().map(|t| t.get()).unwrap_or(1).min(64) as u64;
            let n = n.min(total);
            if n < total {
                let mask = ((1u64 << n) - 1) << (total - n); // the last n cores
                let _ = SetProcessAffinityMask(GetCurrentProcess(), mask as usize);
            }
        }
    }
}

type Ctl = CaptureControl<Cap, Box<dyn std::error::Error + Send + Sync>>;

/// Encoder settings that stay the same whichever monitor is shared.
struct Enc {
    bw: u32,
    bh: u32,
    fps: u32,
    bps: u32,
    threads: u16,
    complexity: u8,
    skip: bool,
    gpu: Option<(std::path::PathBuf, &'static str)>,
}

/// Where a monitor sits on the desktop: left, top, width, height (pixels).
fn mon_rect(m: &Monitor) -> (i32, i32, i32, i32) {
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITORINFO};
    let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    let _ = unsafe { GetMonitorInfoW(HMONITOR(m.as_raw_hmonitor()), &mut mi) };
    let r = mi.rcMonitor;
    (r.left, r.top, r.right - r.left, r.bottom - r.top)
}

/// Starts capturing one monitor as a new generation (the previous capture must already be stopped).
fn capture(mon: Monitor, i: usize, e: &Enc, shared: &Arc<Shared>) -> Result<(Ctl, Arc<AtomicBool>), String> {
    let (mw, mh) = (mon.width().unwrap_or(1920), mon.height().unwrap_or(1080));
    let (w, h) = fit(mw, mh, e.bw, e.bh);
    let (l, t, rw, rh) = mon_rect(&mon);
    input::set_screen(l, t, if rw > 0 { rw } else { mw as i32 }, if rh > 0 { rh } else { mh as i32 });
    let gen = {
        let mut g = shared.st.lock().unwrap();
        g.gen += 1;
        g.init = None;
        g.frags.clear();
        (g.w, g.h, g.mon) = (w, h, i);
        g.gen
    };
    shared.has_init.store(false, Relaxed);
    let quit = Arc::new(AtomicBool::new(false));
    let settings = Settings::new(
        mon,
        CursorCaptureSettings::WithoutCursor, // the viewer's own pointer is the cursor
        DrawBorderSettings::WithoutBorder,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Rgba8,
        Flags { shared: shared.clone(), cfg: Cfg { w, h, fps: e.fps, bps: e.bps, threads: e.threads, complexity: e.complexity, skip: e.skip }, gpu: e.gpu.clone(), quit: quit.clone(), gen },
    );
    let ctl = Cap::start_free_threaded(settings).map_err(|e| format!("capture failed: {e}"))?;
    Ok((ctl, quit))
}

fn main() {
    // real pixels everywhere: monitor positions, sizes and mouse coordinates must agree on mixed-DPI setups
    unsafe {
        use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let mut line = String::new();
    if std::io::stdin().lock().read_line(&mut line).unwrap_or(0) == 0 {
        die("no config on stdin");
    }
    let c: Value = serde_json::from_str(&line).unwrap_or_else(|_| die("bad config"));
    let password = c["password"].as_str().unwrap_or("").to_string();
    if password.is_empty() {
        die("a password is required"); // never share a PC without one
    }
    let port = c["port"].as_u64().unwrap_or(8080) as u16;
    let ngrok_token = c["ngrokToken"].as_str().unwrap_or("").to_string();
    let methods: Vec<String> = c["methods"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
    let (bw, bh, fps, bps) = preset(c["quality"].as_str().unwrap_or("720p30"));
    // encoder usage (all optional): more threads and a slower setting spend more CPU for a smoother, cleaner picture
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) as u16;
    let threads = c["threads"].as_u64().map(|t| t.clamp(1, 16) as u16).unwrap_or(4);
    let complexity = match c["complexity"].as_str() { Some("medium") => 1, Some("high") => 2, _ => 0 };
    let bps = (bps as f64 * c["bitrateMult"].as_f64().unwrap_or(1.0).clamp(0.25, 6.0)) as u32;
    let skip = c["skip"].as_bool().unwrap_or(false);

    let primary = Monitor::primary().unwrap_or_else(|e| die(&format!("no monitor: {e}")));
    let mons = Monitor::enumerate().ok().filter(|v| !v.is_empty()).unwrap_or_else(|| vec![primary]);
    let mon_list: Vec<Value> = mons
        .iter()
        .enumerate()
        .map(|(i, m)| json!({"i": i, "name": match m.name().ok().filter(|n| n.chars().any(|c| c.is_ascii_alphabetic())) { Some(n) => format!("Display {} · {}", i + 1, n.trim()), None => format!("Display {}", i + 1) }, "w": m.width().unwrap_or(0), "h": m.height().unwrap_or(0), "primary": *m == primary}))
        .collect();
    let first = c["monitor"].as_u64().map(|i| i as usize).filter(|i| *i < mons.len()).or_else(|| mons.iter().position(|m| *m == primary)).unwrap_or(0);
    let rects: Vec<(i32, i32, i32, i32)> = mons.iter().map(mon_rect).collect();
    // a game on this PC should not starve the encoder
    unsafe {
        use windows::Win32::System::Threading::{GetCurrentProcess, SetPriorityClass, ABOVE_NORMAL_PRIORITY_CLASS};
        let _ = SetPriorityClass(GetCurrentProcess(), ABOVE_NORMAL_PRIORITY_CLASS);
    }

    let shared = Arc::new(Shared::default());
    let run = Arc::new(AtomicBool::new(true));
    let listener = TcpListener::bind(("0.0.0.0", port)).unwrap_or_else(|e| die(&format!("port {port} is busy ({e})")));

    // ---- how much of this PC the encoder may use (set before ffmpeg starts, so it is covered too)
    limit_cpu(c["cpuPercent"].as_u64(), c["cpuCores"].as_u64());

    // ---- CPU (openh264), GPU (ffmpeg + NVENC/AMF/QSV), or GPU first with the CPU as backup
    let (want_gpu, want_cpu) = (c["gpu"].as_bool().unwrap_or(false), c["cpu"].as_bool().unwrap_or(true));
    let mut gpu_choice = None;
    if want_gpu {
        match gpu::find_ffmpeg() {
            None if !want_cpu => die_fix("GPU encoding needs ffmpeg", "ffmpeg"),
            None => emit(json!({"t": "notice", "msg": "ffmpeg not found, using the CPU encoder"})),
            Some(ff) => match gpu::pick_encoder(&ff) {
                Some(enc) => gpu_choice = Some((ff, enc)),
                None if !want_cpu => die("no GPU H.264 encoder (NVENC, AMF or Quick Sync) works on this PC"),
                None => emit(json!({"t": "notice", "msg": "no GPU encoder found, using the CPU encoder"})),
            },
        }
    } else if !want_cpu {
        die("turn on the GPU or the CPU encoder");
    }
    let encoder_name = gpu_choice.as_ref().map(|(_, e)| e.to_string()).unwrap_or_else(|| "openh264 (CPU)".into());

    let enc = Enc { bw, bh, fps, bps, threads, complexity, skip, gpu: gpu_choice };
    let (ctl, quit) = capture(mons[first], first, &enc, &shared).unwrap_or_else(|e| die(&e));
    let (w, h) = {
        let g = shared.st.lock().unwrap();
        (g.w, g.h)
    };

    // a viewer picked another monitor: stop this capture, start that one (viewers get the new picture's init segment)
    let (switch, wanted) = std::sync::mpsc::channel::<usize>();
    {
        let shared = shared.clone();
        std::thread::spawn(move || {
            let (mut ctl, mut quit, mut cur) = (Some(ctl), quit, first);
            for i in wanted {
                if i == cur || i >= mons.len() {
                    continue;
                }
                quit.store(true, Relaxed);
                if let Some(c) = ctl.take() {
                    let _ = c.stop();
                }
                std::thread::sleep(Duration::from_millis(200)); // the encoder threads see `quit` within a frame
                let next = match capture(mons[i], i, &enc, &shared) {
                    Ok(x) => {
                        cur = i;
                        emit(json!({"t": "monitor", "i": i}));
                        x
                    }
                    Err(e) => {
                        emit(json!({"t": "notice", "msg": e}));
                        capture(mons[cur], cur, &enc, &shared).unwrap_or_else(|e| die(&e))
                    }
                };
                (ctl, quit) = (Some(next.0), next.1);
            }
        });
    }

    server::serve(listener, shared.clone(), Arc::new(server::Cfg { password, mons: json!(mon_list), switch }), run.clone());

    // host cursor shape -> viewers
    {
        let (shared, run) = (shared.clone(), run.clone());
        std::thread::spawn(move || {
            while run.load(Relaxed) {
                shared.set_cursor(input::cursor_shape());
                std::thread::sleep(Duration::from_millis(40));
            }
        });
    }

    // optional timing report: {"perf": true} in the config
    if c["perf"].as_bool().unwrap_or(false) {
        let (shared, run) = (shared.clone(), run.clone());
        std::thread::spawn(move || {
            let mut prev = [0u64; 7];
            while run.load(Relaxed) {
                std::thread::sleep(Duration::from_secs(3));
                let cur: Vec<u64> = shared.perf.iter().map(|a| a.load(Relaxed)).collect();
                let d = |i: usize| cur[i] - prev[i];
                let avg = |us: u64, n: u64| if n == 0 { 0.0 } else { (us as f64 / n as f64 / 100.0).round() / 10.0 };
                emit(json!({"t": "perf", "scaled": d(1) / 3, "encoded": d(4) / 3, "dropped": d(6) / 3, "scale_ms": avg(d(0), d(1)), "convert_ms": avg(d(2), d(4)), "encode_ms": avg(d(3), d(4))}));
                prev.copy_from_slice(&cur);
            }
        });
    }

    {
        let (shared, run) = (shared.clone(), run.clone());
        std::thread::spawn(move || {
            let mut prev = shared.st.lock().unwrap().seq;
            while run.load(Relaxed) {
                std::thread::sleep(Duration::from_secs(2));
                let cur = shared.st.lock().unwrap().seq;
                let fps = ((cur - prev) / 2) as u32;
                prev = cur;
                shared.sent_fps.store(fps, Relaxed);
                emit(json!({"t": "stats", "fps": fps}));
            }
        });
    }

    // the app the viewer is focusing is elevated: Windows blocks input into it until Flux Control itself runs as admin
    if std::env::var("FLUX_NO_ELEVWATCH").is_err() && !apps::host_elevated() {
        let run = run.clone();
        std::thread::spawn(move || {
            let mut prev = apps::fg_elevated();
            if prev {
                emit(json!({"t": "elev", "on": true}));
            }
            while run.load(Relaxed) {
                std::thread::sleep(Duration::from_millis(700));
                let on = apps::fg_elevated();
                if on != prev {
                    prev = on;
                    emit(json!({"t": "elev", "on": on}));
                }
            }
        });
    }

    emit(json!({"t": "started", "w": w, "h": h, "fps": fps, "port": port, "cores": cores, "threads": threads, "encoder": encoder_name, "mbps": (bps as f64 / 1e5).round() / 10.0}));

    let ctx = Arc::new(Ctx {
        port,
        lan: net::lan_ip(),
        ngrok_token,
        kids: Default::default(),
        upnp: Default::default(),
    });
    for m in &methods {
        start_method(m, &ctx);
    }

    // wait for "stop" (or for the parent to close stdin); "retry <method>" starts one method again after a fix
    for l in std::io::stdin().lock().lines() {
        let Ok(l) = l else { break };
        let l = l.trim();
        if l == "stop" {
            break;
        }
        if let Some(m) = l.strip_prefix("retry ") {
            start_method(m.trim(), &ctx);
        }
        // one json line: {"t":"apps","id":N,"act":"list"|"close"|"front",...} -> one {"t":"apps-res","id":N,...} back
        if l.starts_with('{') {
            if let Ok(m) = serde_json::from_str::<Value>(l) {
                if m["t"] == "apps" {
                    let id = m["id"].clone();
                    let rep = |list: Value, ok: bool| emit(json!({"t": "apps-res", "id": id, "list": list, "ok": ok}));
                    match m["act"].as_str() {
                        Some("list") => rep(apps::list(&rects), true),
                        Some("close") => rep(Value::Null, apps::close(m["hwnd"].as_i64().unwrap_or(0) as isize)),
                        Some("front") => rep(Value::Null, apps::front(m["hwnd"].as_i64().unwrap_or(0) as isize, &rects, m["mon"].as_u64().unwrap_or(0) as usize)),
                        _ => rep(Value::Null, false),
                    }
                }
            }
            continue;
        }
        // "to <conn> <json>": the app's answer or event for one web client (conn 0 = all of them)
        if let Some((c, j)) = l.strip_prefix("to ").and_then(|r| r.split_once(' ')) {
            if let Ok(c) = c.parse() {
                server::send_to(c, j);
            }
        }
    }
    let (kids, upnp) = (ctx.kids.clone(), ctx.upnp.clone());
    run.store(false, Relaxed);
    shared.stop.store(true, Relaxed);
    shared.cv.notify_all();
    for k in kids.lock().unwrap().iter_mut() {
        let _ = k.kill();
    }
    if let Some((gw, p)) = upnp.lock().unwrap().take() {
        let _ = gw.remove_port(igd_next::PortMappingProtocol::TCP, p);
    }
    std::process::exit(0);
}
