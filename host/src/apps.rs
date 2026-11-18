//! The PC's open apps for the web client's window picker: list, close, bring-to-front,
//! and telling elevated apps apart (Windows blocks input into them while Flux Control runs as a normal user).
use serde_json::{json, Value};
use std::collections::HashMap;
use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;

type Rect = (i32, i32, i32, i32);

struct Row {
    pid: u32,
    hwnd: isize,
    area: i64,
    rect: Rect,
    title: String,
}

static ROWS: std::sync::Mutex<Vec<Row>> = std::sync::Mutex::new(Vec::new());

unsafe fn exe_of(pid: u32) -> String {
    let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
    let mut buf = [0u16; 512];
    let mut len = buf.len() as u32;
    let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
    let _ = CloseHandle(h);
    if ok.is_ok() {
        let full = String::from_utf16_lossy(&buf[..len as usize]);
        return full.rsplit(['\\', '/']).next().unwrap_or("").to_lowercase();
    }
    String::new()
}

unsafe fn token_elevated(h: HANDLE) -> bool {
    let mut tok = HANDLE::default();
    if OpenProcessToken(h, TOKEN_QUERY, &mut tok).is_err() {
        return false;
    }
    let mut el = TOKEN_ELEVATION { TokenIsElevated: 0 };
    let mut ret = 0u32;
    let ok = GetTokenInformation(tok, TokenElevation, Some(&mut el as *mut _ as *mut _), std::mem::size_of::<TOKEN_ELEVATION>() as u32, &mut ret);
    let _ = CloseHandle(tok);
    ok.is_ok() && el.TokenIsElevated != 0
}

unsafe fn pid_elevated(pid: u32) -> bool {
    let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return false };
    let r = token_elevated(h);
    let _ = CloseHandle(h);
    r
}

/// Does Flux Control itself run as administrator? Then Windows lets its input into every app.
pub fn host_elevated() -> bool {
    unsafe { token_elevated(GetCurrentProcess()) }
}

/// Is the app the user is currently focusing elevated? That is the app the viewer cannot control.
pub fn fg_elevated() -> bool {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.is_invalid() {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(fg, Some(&mut pid));
        pid != 0 && pid_elevated(pid)
    }
}

unsafe extern "system" fn collect(h: HWND, _: LPARAM) -> BOOL {
    if !IsWindowVisible(h).as_bool() || GetWindowTextLengthW(h) == 0 {
        return BOOL(1);
    }
    // a hidden UWP window (any of the many background "apps") does not belong in the list
    let mut cloak: u32 = 0;
    if DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut cloak as *mut u32 as *mut _, 4).is_ok() && cloak != 0 {
        return BOOL(1);
    }
    if GetWindow(h, GW_OWNER).map(|o| !o.is_invalid()).unwrap_or(false) {
        return BOOL(1); // a dialog or tool window of another window
    }
    let mut r = RECT::default();
    if GetWindowRect(h, &mut r).is_err() {
        return BOOL(1);
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(h, Some(&mut pid));
    if pid == 0 {
        return BOOL(1);
    }
    let mut title = [0u16; 256];
    let n = GetWindowTextW(h, &mut title).max(0) as usize;
    let area = ((r.right - r.left) as i64) * ((r.bottom - r.top) as i64);
    if let Ok(mut v) = ROWS.lock() {
        v.push(Row { pid, hwnd: h.0 as isize, area, rect: (r.left, r.top, r.right - r.left, r.bottom - r.top), title: String::from_utf16_lossy(&title[..n.min(255)]) });
    }
    BOOL(1)
}

/// Which monitor a window sits on: the one holding its centre point (or -1 when none does).
fn mon_of(rect: &Rect, rects: &[Rect]) -> i32 {
    let (l, t, w, h) = *rect;
    let (cx, cy) = (l + w / 2, t + h / 2);
    for (i, &(rl, rt, rw, rh)) in rects.iter().enumerate() {
        if rw > 0 && rh > 0 && cx >= rl && cx < rl + rw && cy >= rt && cy < rt + rh {
            return i as i32;
        }
    }
    -1
}

const SKIP_EXE: [&str; 3] = ["flux control.exe", "flux-host.exe", "electron.exe"];

/// The apps that are open right now, one entry per process (its biggest visible window).
pub fn list(rects: &[Rect]) -> Value {
    ROWS.lock().unwrap().clear();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(0));
    }
    let rows: Vec<Row> = std::mem::take(&mut *ROWS.lock().unwrap());
    let mut best: HashMap<u32, &Row> = HashMap::new();
    for r in &rows {
        match best.get(&r.pid) {
            Some(b) if b.area >= r.area => {}
            _ => { best.insert(r.pid, r); }
        }
    }
    let mut out: Vec<(String, Value)> = best
        .values()
        .map(|r| {
            let exe = unsafe { exe_of(r.pid) };
            (exe.clone(), json!({"exe": exe, "title": r.title, "hwnd": r.hwnd, "mon": mon_of(&r.rect, rects)}))
        })
        .filter(|(exe, _)| !exe.is_empty() && !SKIP_EXE.contains(&exe.as_str()))
        .map(|(_, v)| (v["exe"].as_str().unwrap_or("").to_string(), v))
        .collect();
    out.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()).then_with(|| {
        a.1["title"].as_str().unwrap_or("").to_lowercase().cmp(&b.1["title"].as_str().unwrap_or("").to_lowercase())
    }));
    out.truncate(60);
    Value::Array(out.into_iter().map(|(_, v)| v).collect())
}

unsafe fn valid(hwnd: isize) -> Option<HWND> {
    let h = HWND(hwnd as *mut _);
    (!h.is_invalid() && IsWindow(Some(h)).as_bool()).then_some(h)
}

/// Politely asks an app to close (the same as clicking its X; unsaved work still asks the user).
pub fn close(hwnd: isize) -> bool {
    unsafe {
        match valid(hwnd) {
            Some(h) => PostMessageW(Some(h), WM_CLOSE, WPARAM(0), LPARAM(0)).is_ok(),
            None => false,
        }
    }
}

/// Puts an app on the monitor the viewer is watching and focuses it.
pub fn front(hwnd: isize, rects: &[Rect], mon: usize) -> bool {
    unsafe {
        let Some(h) = valid(hwnd) else { return false };
        let zoomed = IsZoomed(h).as_bool();
        if IsIconic(h).as_bool() || zoomed {
            let _ = ShowWindow(h, SW_RESTORE);
        }
        // centre it on the target monitor; Windows then maximizes it onto that monitor too
        if let Some(&(l, t, w, hgt)) = rects.get(mon) {
            if w > 0 && hgt > 0 {
                let mut r = RECT::default();
                if GetWindowRect(h, &mut r).is_ok() {
                    let ww = (r.right - r.left).clamp(200, w);
                    let wh = (r.bottom - r.top).clamp(150, hgt);
                    let _ = SetWindowPos(h, None, l + (w - ww) / 2, t + (hgt - wh) / 2, 0, 0, SWP_NOZORDER | SWP_NOSIZE | SWP_NOACTIVATE);
                }
            }
        }
        if zoomed {
            let _ = ShowWindow(h, SW_MAXIMIZE);
        }
        // a background process may not take the foreground: tapping Alt makes Windows accept it
        let key = |v: VIRTUAL_KEY, up: bool| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: v, wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }, time: 0, dwExtraInfo: 0 } },
        };
        SendInput(&[key(VK_MENU, false), key(VK_MENU, true)], std::mem::size_of::<INPUT>() as i32);
        let _ = SetForegroundWindow(h);
        true
    }
}
