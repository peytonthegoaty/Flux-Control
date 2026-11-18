//! Remote input (SendInput) and the host cursor shape.
use serde_json::Value;
use std::cell::Cell;
use std::collections::HashSet;
use std::sync::atomic::{AtomicI32, Ordering::Relaxed};

static SCREEN_W: AtomicI32 = AtomicI32::new(1920);
static SCREEN_H: AtomicI32 = AtomicI32::new(1080);
static SCREEN_L: AtomicI32 = AtomicI32::new(0);
static SCREEN_T: AtomicI32 = AtomicI32::new(0);
thread_local!(static REM: Cell<(f64, f64)> = const { Cell::new((0.0, 0.0)) });

/// Where the shared monitor sits on the desktop (pixels); mouse positions and deltas arrive as fractions of the picture.
pub fn set_screen(left: i32, top: i32, w: i32, h: i32) {
    SCREEN_L.store(left, Relaxed);
    SCREEN_T.store(top, Relaxed);
    SCREEN_W.store(w.max(2), Relaxed);
    SCREEN_H.store(h.max(2), Relaxed);
}
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;

fn send(inputs: &[INPUT]) {
    unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
}

fn mouse(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: u32) {
    send(&[INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }]);
}

fn key(scan: u16, extended: bool, up: bool) {
    let mut f = KEYEVENTF_SCANCODE;
    if extended {
        f |= KEYEVENTF_EXTENDEDKEY;
    }
    if up {
        f |= KEYEVENTF_KEYUP;
    }
    send(&[INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(0), wScan: scan, dwFlags: f, time: 0, dwExtraInfo: 0 } },
    }]);
}

/// KeyboardEvent.code -> (set-1 scancode, extended)
pub fn scancode(code: &str) -> Option<(u16, bool)> {
    let plain = |s: u16| Some((s, false));
    let ext = |s: u16| Some((s, true));
    if let Some(l) = code.strip_prefix("Key") {
        let c = l.chars().next()?;
        if l.len() == 1 && c.is_ascii_uppercase() {
            const ROW: [u16; 26] = [
                0x1E, 0x30, 0x2E, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32, 0x31, 0x18, 0x19, 0x10, 0x13, 0x1F, 0x14, 0x16, 0x2F,
                0x11, 0x2D, 0x15, 0x2C,
            ];
            return plain(ROW[(c as u8 - b'A') as usize]);
        }
    }
    if let Some(d) = code.strip_prefix("Digit") {
        return match d.parse::<u16>().ok()? {
            0 => plain(0x0B),
            n @ 1..=9 => plain(0x01 + n),
            _ => None,
        };
    }
    if let Some(n) = code.strip_prefix('F').and_then(|n| n.parse::<u16>().ok()) {
        return match n {
            1..=10 => plain(0x3A + n),
            11 => plain(0x57),
            12 => plain(0x58),
            _ => None,
        };
    }
    match code {
        "Minus" => plain(0x0C), "Equal" => plain(0x0D), "Backspace" => plain(0x0E), "Tab" => plain(0x0F),
        "BracketLeft" => plain(0x1A), "BracketRight" => plain(0x1B), "Enter" => plain(0x1C), "ControlLeft" => plain(0x1D),
        "Semicolon" => plain(0x27), "Quote" => plain(0x28), "Backquote" => plain(0x29), "ShiftLeft" => plain(0x2A),
        "Backslash" => plain(0x2B), "Comma" => plain(0x33), "Period" => plain(0x34), "Slash" => plain(0x35),
        "ShiftRight" => plain(0x36), "NumpadMultiply" => plain(0x37), "AltLeft" => plain(0x38), "Space" => plain(0x39),
        "CapsLock" => plain(0x3A), "NumLock" => plain(0x45), "ScrollLock" => plain(0x46), "Numpad7" => plain(0x47),
        "Numpad8" => plain(0x48), "Numpad9" => plain(0x49), "NumpadSubtract" => plain(0x4A), "Numpad4" => plain(0x4B),
        "Numpad5" => plain(0x4C), "Numpad6" => plain(0x4D), "NumpadAdd" => plain(0x4E), "Numpad1" => plain(0x4F),
        "Numpad2" => plain(0x50), "Numpad3" => plain(0x51), "Numpad0" => plain(0x52), "NumpadDecimal" => plain(0x53),
        "IntlBackslash" => plain(0x56), "Escape" => plain(0x01),
        "NumpadEnter" => ext(0x1C), "ControlRight" => ext(0x1D), "NumpadDivide" => ext(0x35), "AltRight" => ext(0x38),
        "PrintScreen" => ext(0x37), "Home" => ext(0x47), "ArrowUp" => ext(0x48), "PageUp" => ext(0x49), "ArrowLeft" => ext(0x4B),
        "ArrowRight" => ext(0x4D), "End" => ext(0x4F), "ArrowDown" => ext(0x50), "PageDown" => ext(0x51), "Insert" => ext(0x52),
        "Delete" => ext(0x53), "MetaLeft" => ext(0x5B), "MetaRight" => ext(0x5C), "ContextMenu" => ext(0x5D),
        _ => None,
    }
}

/// Absolute move to a point of the shared monitor (fractions of the picture), mapped onto the whole virtual desktop.
fn move_to(x: f64, y: f64) {
    let (vx, vy, vw, vh) = unsafe { (GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN), GetSystemMetrics(SM_CXVIRTUALSCREEN).max(2), GetSystemMetrics(SM_CYVIRTUALSCREEN).max(2)) };
    let px = SCREEN_L.load(Relaxed) as f64 + x.clamp(0.0, 1.0) * (SCREEN_W.load(Relaxed) - 1) as f64;
    let py = SCREEN_T.load(Relaxed) as f64 + y.clamp(0.0, 1.0) * (SCREEN_H.load(Relaxed) - 1) as f64;
    let nx = ((px - vx as f64) * 65535.0 / (vw - 1) as f64).round() as i32;
    let ny = ((py - vy as f64) * 65535.0 / (vh - 1) as f64).round() as i32;
    mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny, 0);
}

fn button(b: i64, down: bool) {
    let (f, data) = match (b, down) {
        (0, true) => (MOUSEEVENTF_LEFTDOWN, 0),
        (0, false) => (MOUSEEVENTF_LEFTUP, 0),
        (1, true) => (MOUSEEVENTF_MIDDLEDOWN, 0),
        (1, false) => (MOUSEEVENTF_MIDDLEUP, 0),
        (2, true) => (MOUSEEVENTF_RIGHTDOWN, 0),
        (2, false) => (MOUSEEVENTF_RIGHTUP, 0),
        (3, d) => (if d { MOUSEEVENTF_XDOWN } else { MOUSEEVENTF_XUP }, 1),
        (4, d) => (if d { MOUSEEVENTF_XDOWN } else { MOUSEEVENTF_XUP }, 2),
        _ => return,
    };
    mouse(f, 0, 0, data);
}

/// Applies one input message from an authenticated viewer. `held` tracks pressed keys so they can be released on disconnect.
pub fn apply(m: &Value, held: &mut HashSet<String>) {
    let num = |k: &str| m[k].as_f64().unwrap_or(0.0);
    match m["t"].as_str().unwrap_or("") {
        "mv" => move_to(num("x"), num("y")),
        "rel" => {
            // mouse lock: movement as a fraction of the picture, kept as a remainder so slow moves are not lost
            let (fx, fy) = (num("x").clamp(-1.0, 1.0) * SCREEN_W.load(Relaxed) as f64, num("y").clamp(-1.0, 1.0) * SCREEN_H.load(Relaxed) as f64);
            let (rx, ry) = REM.with(|r| r.get());
            let (tx, ty) = (fx + rx, fy + ry);
            let (ix, iy) = (tx.trunc(), ty.trunc());
            REM.with(|r| r.set((tx - ix, ty - iy)));
            if ix != 0.0 || iy != 0.0 {
                mouse(MOUSEEVENTF_MOVE, ix as i32, iy as i32, 0);
            }
        }
        "md" | "mu" => {
            let down = m["t"] == "md";
            if m.get("x").is_some() {
                // position first so the click lands where the viewer's pointer is (not while the mouse is locked)
                move_to(num("x"), num("y"));
            }
            button(m["b"].as_i64().unwrap_or(0), down);
        }
        "wh" => {
            let (dx, dy) = (num("dx"), num("dy"));
            if dy != 0.0 {
                mouse(MOUSEEVENTF_WHEEL, 0, 0, (-(dy.clamp(-1200.0, 1200.0)) as i32) as u32);
            }
            if dx != 0.0 {
                mouse(MOUSEEVENTF_HWHEEL, 0, 0, ((dx.clamp(-1200.0, 1200.0)) as i32) as u32);
            }
        }
        "kd" | "ku" => {
            let code = m["c"].as_str().unwrap_or("");
            let Some((scan, ext)) = scancode(code) else { return };
            if m["t"] == "kd" {
                held.insert(code.to_string());
                key(scan, ext, false);
            } else {
                held.remove(code);
                key(scan, ext, true);
            }
        }
        _ => {}
    }
}

pub fn release_all(held: &mut HashSet<String>) {
    for code in held.drain() {
        if let Some((s, e)) = scancode(&code) {
            key(s, e, true);
        }
    }
    for b in 0..3 {
        button(b, false); // a stuck mouse button is worse than a spurious release
    }
}

/// CSS cursor name for the host's current cursor.
pub fn cursor_shape() -> &'static str {
    unsafe {
        let mut ci = CURSORINFO { cbSize: std::mem::size_of::<CURSORINFO>() as u32, ..Default::default() };
        if GetCursorInfo(&mut ci).is_err() {
            return "default";
        }
        if ci.flags.0 & 1 == 0 {
            return "none"; // hidden (games, video players)
        }
        let is = |id| LoadCursorW(None, id).map(|c| c == ci.hCursor).unwrap_or(false);
        if is(IDC_IBEAM) { "text" }
        else if is(IDC_HAND) { "pointer" }
        else if is(IDC_WAIT) { "wait" }
        else if is(IDC_APPSTARTING) { "progress" }
        else if is(IDC_CROSS) { "crosshair" }
        else if is(IDC_SIZEWE) { "ew-resize" }
        else if is(IDC_SIZENS) { "ns-resize" }
        else if is(IDC_SIZENWSE) { "nwse-resize" }
        else if is(IDC_SIZENESW) { "nesw-resize" }
        else if is(IDC_SIZEALL) { "move" }
        else if is(IDC_NO) { "not-allowed" }
        else if is(IDC_HELP) { "help" }
        else { "default" }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keymap() {
        assert_eq!(scancode("KeyA"), Some((0x1E, false)));
        assert_eq!(scancode("KeyZ"), Some((0x2C, false)));
        assert_eq!(scancode("Digit1"), Some((0x02, false)));
        assert_eq!(scancode("Digit0"), Some((0x0B, false)));
        assert_eq!(scancode("F1"), Some((0x3B, false)));
        assert_eq!(scancode("F10"), Some((0x44, false)));
        assert_eq!(scancode("F12"), Some((0x58, false)));
        assert_eq!(scancode("ArrowUp"), Some((0x48, true)));
        assert_eq!(scancode("Nope"), None);
    }
}
