//! Versions, the GitHub update check, the `flux` launcher and the user PATH entry.
use crate::{download, find_electron, home, node_status, progress, send, simulate, unpack, Proxy, NO_WINDOW};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;
use std::time::Duration;
use std::{fs, io::Read};

pub const REPO: &str = "peytonthegoaty/Flux-Control";
const PAYLOAD: &str = "flux-control-payload.zip";

pub fn embedded_version() -> &'static str {
    include_str!("../../VERSION").trim()
}

pub fn installed_version() -> Option<String> {
    fs::read_to_string(home().join("version.txt")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub fn parse_ver(v: &str) -> Option<(u32, u32, u32)> {
    let mut it = v.trim().trim_start_matches('v').split('.');
    let mut n = || it.next()?.parse::<u32>().ok();
    Some((n()?, n()?, n()?))
}

pub fn newer(a: &str, b: &str) -> bool {
    matches!((parse_ver(a), parse_ver(b)), (Some(x), Some(y)) if x > y)
}

/// `--simulate --state=update|ready` fakes an installed copy so those screens can be demoed.
fn sim_state() -> Option<String> {
    std::env::args().find_map(|a| a.strip_prefix("--state=").map(String::from))
}

// ------------------------------------------------------------------ GitHub
pub struct Release {
    pub version: String,
    payload: Option<String>,
    sha: Option<String>,
}

fn latest() -> Result<Option<Release>, String> {
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let resp = match ureq::get(&url).set("User-Agent", "flux-control-setup").set("Accept", "application/vnd.github+json").timeout(Duration::from_secs(6)).call() {
        Ok(r) => r,
        Err(ureq::Error::Status(404, _)) => return Ok(None), // no release published yet
        Err(e) => return Err(e.to_string()),
    };
    let v: Value = serde_json::from_str(&resp.into_string().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let prefix = format!("https://github.com/{REPO}/releases/download/");
    let asset = |name: &str| {
        v["assets"].as_array()?.iter().find(|a| a["name"] == name).and_then(|a| a["browser_download_url"].as_str()).filter(|u| u.starts_with(&prefix)).map(String::from)
    };
    Ok(Some(Release {
        version: v["tag_name"].as_str().unwrap_or("").trim_start_matches('v').to_string(),
        payload: asset(PAYLOAD),
        sha: asset(&format!("{PAYLOAD}.sha256")),
    }))
}

/// Which pieces this PC lacks (only meaningful once Flux Control has been installed).
pub fn missing_now() -> Vec<&'static str> {
    let mut m = Vec::new();
    if node_status().is_none() {
        m.push("node");
    }
    if find_electron().is_none() {
        m.push("electron");
    }
    if !home().join("app").join("main.js").exists() {
        m.push("app");
    }
    if crate::ffmpeg_found().is_none() && !crate::skipped("ffmpeg") {
        m.push("ffmpeg");
    }
    m
}

/// Answers the wizard's start-up question: is it installed, is anything missing, is there something newer on GitHub?
pub fn status(p: Proxy) {
    let (inst, missing, rel) = match (simulate(), sim_state().as_deref()) {
        (true, Some("update")) => (Some("0.2.0".to_string()), vec![], Ok(Some(Release { version: "0.3.0".into(), payload: None, sha: None }))),
        (true, Some("ready")) => (Some(embedded_version().to_string()), vec![], Ok(None)),
        (true, Some("missing")) => (Some(embedded_version().to_string()), vec!["ffmpeg"], Ok(None)),
        (true, _) => (None, vec![], Ok(None)),
        _ => (installed_version(), missing_now(), latest()),
    };
    let offline = rel.is_err();
    let latest_v = rel.as_ref().ok().and_then(|r| r.as_ref()).map(|r| r.version.clone());
    let update = match (&inst, &latest_v) {
        (Some(i), Some(l)) => newer(l, i) && rel.as_ref().ok().and_then(|r| r.as_ref()).is_some_and(|r| r.payload.is_some() && r.sha.is_some()),
        _ => false,
    };
    send(&p, json!({"t": "status", "hasInstall": inst.is_some(), "missing": missing, "version": inst, "latest": latest_v, "update": update, "offline": offline, "embedded": embedded_version(), "autolaunch": std::env::args().any(|a| a == "--launch")}));
}

fn sha256_hex(path: &Path) -> Result<String, String> {
    let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
    let (mut h, mut buf) = (Sha256::new(), vec![0u8; 1 << 16]);
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn swap_dir(new: &Path, cur: &Path) -> Result<(), String> {
    if !new.exists() {
        return Ok(());
    }
    let old = cur.with_extension("old");
    let _ = fs::remove_dir_all(&old);
    if cur.exists() {
        fs::rename(cur, &old).map_err(|e| format!("could not replace {}: {e}", cur.display()))?;
    }
    if let Err(e) = fs::rename(new, cur) {
        let _ = fs::rename(&old, cur); // put the previous version back
        return Err(e.to_string());
    }
    let _ = fs::remove_dir_all(&old);
    Ok(())
}

fn apply(p: &Proxy) -> Result<String, String> {
    if simulate() {
        for i in (0..=100).step_by(5) {
            progress(p, "update", i, format!("Downloading… {i}%"));
            std::thread::sleep(Duration::from_millis(60));
        }
        return Ok("0.3.0".into());
    }
    let rel = latest()?.ok_or("no release found")?;
    let (url, sha_url) = (rel.payload.ok_or("release has no payload")?, rel.sha.ok_or("release has no checksum")?);
    let h = home();
    fs::create_dir_all(&h).map_err(|e| e.to_string())?;
    let (zip, shaf) = (h.join("update.zip"), h.join("update.sha256"));
    download(&sha_url, &shaf, "update-sha", p)?;
    download(&url, &zip, "update", p)?;
    let want = fs::read_to_string(&shaf).map_err(|e| e.to_string())?.split_whitespace().next().unwrap_or("").to_string();
    let _ = fs::remove_file(&shaf);
    progress(p, "update", 90, "Installing…".into());
    install_payload(&zip, &want, &rel.version)?;
    Ok(rel.version)
}

/// Verifies the payload zip against its checksum, then swaps in app/, shared/ and the host exe. The old app is restored on failure.
pub fn install_payload(zip: &Path, want_sha: &str, version: &str) -> Result<(), String> {
    let h = home();
    if want_sha.to_ascii_lowercase() != sha256_hex(zip)? {
        let _ = fs::remove_file(zip);
        return Err("the download did not match its checksum".into());
    }
    let stage = h.join("update");
    let _ = fs::remove_dir_all(&stage);
    unpack(zip, &stage, false)?;
    let _ = fs::remove_file(zip);
    swap_dir(&stage.join("app"), &h.join("app"))?;
    swap_dir(&stage.join("shared"), &h.join("shared"))?;
    let new_host = stage.join("bin").join("flux-host.exe");
    if new_host.exists() {
        let dest = h.join("bin").join("flux-host.exe");
        fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
        if dest.exists() {
            // a running exe can be renamed but not overwritten
            let _ = fs::rename(&dest, dest.with_extension(format!("old{}", std::process::id())));
        }
        fs::copy(&new_host, &dest).map_err(|e| e.to_string())?;
    }
    let _ = fs::remove_dir_all(&stage);
    fs::write(h.join("version.txt"), version).map_err(|e| e.to_string())?;
    let _ = write_launcher();
    let _ = ensure_path();
    Ok(())
}

pub fn run_update(p: Proxy) {
    match apply(&p) {
        Ok(v) => send(&p, json!({"t": "updated", "ok": true, "version": v})),
        Err(e) => send(&p, json!({"t": "updated", "ok": false, "err": e})),
    }
}

// ------------------------------------------------------------------ install bookkeeping
/// Writes the bundled app unless this PC already has the same or a newer version (never downgrades an update).
pub fn install_embedded() -> Result<(), String> {
    if installed_version().is_some_and(|i| !newer(embedded_version(), &i)) && home().join("app").join("main.js").exists() {
        return Ok(());
    }
    crate::write_app()?;
    fs::write(home().join("version.txt"), embedded_version()).map_err(|e| e.to_string())?;
    let _ = write_launcher();
    let _ = ensure_path();
    let _ = ensure_shortcut();
    Ok(())
}

/// `flux.cmd` in the bin folder starts the app from a terminal.
pub fn write_launcher() -> Result<(), String> {
    let Some((exe, _)) = find_electron() else { return Ok(()) };
    let bin = home().join("bin");
    fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    let body = format!("@echo off\r\nrem Flux Control launcher (written by setup)\r\nstart \"\" \"{}\" \"%~dp0..\\app\" %*\r\n", exe.display());
    if fs::read_to_string(bin.join("flux.cmd")).ok().as_deref() != Some(&body) {
        fs::write(bin.join("flux.cmd"), body).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ------------------------------------------------------------------ Start Menu
/// Puts "Flux Control" in the Start Menu. The shortcut runs a copy of this exe kept in the install folder (it checks GitHub, then
/// opens the app), so it keeps working after the download is deleted. Same file every time, so never a second entry.
pub fn ensure_shortcut() -> Result<(), String> {
    let test_lnk = std::env::var_os("FLUX_LNK").map(std::path::PathBuf::from);
    if std::env::var_os("FLUX_HOME").is_some() && test_lnk.is_none() {
        return Ok(()); // dev/testing never touches the real Start Menu unless FLUX_LNK points somewhere else
    }
    let h = home();
    let (me, dest) = (std::env::current_exe().map_err(|e| e.to_string())?, h.join("FluxControl.exe"));
    let size = |p: &Path| fs::metadata(p).map(|m| m.len()).ok();
    if me != dest && (size(&me) != size(&dest) || !dest.exists()) {
        fs::create_dir_all(&h).map_err(|e| e.to_string())?;
        let _ = fs::copy(&me, &dest); // fails harmlessly if that copy is running right now
    }
    if !dest.exists() {
        return Ok(());
    }
    let q = |p: &Path| p.display().to_string().replace('\'', "''");
    let lnk = match test_lnk {
        Some(p) => p,
        None => Path::new(&std::env::var_os("APPDATA").ok_or("no APPDATA")?).join("Microsoft/Windows/Start Menu/Programs/Flux Control.lnk"),
    };
    let script = format!(
        "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{}');$s.TargetPath='{}';$s.Arguments='--launch';$s.WorkingDirectory='{}';$s.IconLocation='{}';$s.Description='Flux Control';$s.Save()",
        q(&lnk), q(&dest), q(&h), q(&h.join("shared/assets/icon.ico"))
    );
    Command::new("powershell").args(["-NoProfile", "-NonInteractive", "-Command", &script]).creation_flags(NO_WINDOW).status().map_err(|e| e.to_string())?;
    Ok(())
}

// ------------------------------------------------------------------ PATH
fn expand(s: &str) -> String {
    let mut out = String::new();
    let mut parts = s.split('%');
    out.push_str(parts.next().unwrap_or(""));
    while let Some(name) = parts.next() {
        match (std::env::var(name), parts.next()) {
            (Ok(v), Some(rest)) => {
                out.push_str(&v);
                out.push_str(rest);
            }
            (_, Some(rest)) => {
                out.push('%');
                out.push_str(name);
                out.push('%');
                out.push_str(rest);
            }
            (_, None) => {
                out.push('%');
                out.push_str(name);
            }
        }
    }
    out
}

/// Returns the new PATH value, or None when `dir` is already in it (so it is never added twice).
pub fn merge_path(existing: &str, dir: &str) -> Option<String> {
    let norm = |s: &str| expand(s.trim()).trim_end_matches('\\').to_ascii_lowercase();
    if existing.split(';').any(|e| !e.trim().is_empty() && norm(e) == norm(dir)) {
        return None;
    }
    let mut v = existing.trim_end_matches(';').to_string();
    if !v.is_empty() {
        v.push(';');
    }
    v.push_str(dir);
    Some(v)
}

fn read_user_path() -> String {
    let Ok(out) = Command::new("reg").args(["query", "HKCU\\Environment", "/v", "Path"]).creation_flags(NO_WINDOW).output() else { return String::new() };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| {
            let t = l.trim_start();
            if !t.to_ascii_lowercase().starts_with("path") {
                return None;
            }
            let after = &t[t.find("REG_")?..];
            Some(after.split_once(char::is_whitespace)?.1.trim().to_string())
        })
        .unwrap_or_default()
}

/// Adds the bin folder to the user PATH once. A custom FLUX_HOME (dev/testing) never touches the real PATH.
pub fn ensure_path() -> Result<bool, String> {
    if std::env::var_os("FLUX_HOME").is_some() {
        return Ok(false);
    }
    let dir = home().join("bin").display().to_string();
    let Some(new) = merge_path(&read_user_path(), &dir) else { return Ok(false) };
    let ok = Command::new("reg")
        .args(["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", &new, "/f"])
        .creation_flags(NO_WINDOW)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        return Err("could not update PATH".into());
    }
    unsafe {
        use windows::Win32::Foundation::{LPARAM, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE};
        let w: Vec<u16> = "Environment\0".encode_utf16().collect();
        let _ = SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, WPARAM(0), LPARAM(w.as_ptr() as isize), SMTO_ABORTIFHUNG, 3000, None);
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert_eq!(parse_ver("v1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_ver("1.2"), None);
        assert!(newer("0.3.0", "0.2.9"));
        assert!(newer("0.10.0", "0.9.0"));
        assert!(!newer("0.3.0", "0.3.0"));
        assert!(!newer("junk", "0.3.0"));
    }

    #[test]
    fn path_is_added_once() {
        let dir = r"C:\Users\x\AppData\Local\FluxControl\bin";
        let once = merge_path(r"C:\Windows;C:\Tools;", dir).unwrap();
        assert_eq!(once, format!(r"C:\Windows;C:\Tools;{dir}"));
        assert_eq!(merge_path(&once, dir), None);
        assert_eq!(merge_path(&once.to_uppercase(), &dir.to_lowercase()), None); // case-insensitive
        assert_eq!(merge_path(&format!("C:\\A;{dir}\\"), dir), None); // trailing slash
        assert_eq!(merge_path("", dir).as_deref(), Some(dir));
    }

    #[test]
    fn expands_variables() {
        std::env::set_var("FLUX_TEST_VAR", r"C:\Zed");
        assert_eq!(merge_path(r"%FLUX_TEST_VAR%\bin", r"C:\zed\BIN"), None);
    }
}
