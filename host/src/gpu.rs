//! GPU H.264 encoding: raw frames go to ffmpeg (h264_nvenc, h264_amf or h264_qsv) and it hands back fragmented MP4,
//! which is forwarded to viewers as it is. Needs ffmpeg.exe (found in the Flux folder or on PATH).
use crate::capture::{Cfg, Shared};
use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::Ordering::Relaxed;
use std::sync::Arc;

const NO_WINDOW: u32 = 0x0800_0000;

pub struct Gpu {
    pub child: Child,
    pub stdin: ChildStdin,
}

pub fn find_ffmpeg() -> Option<PathBuf> {
    let flux = std::env::var_os("FLUX_HOME").map(PathBuf::from).or_else(|| std::env::var_os("LOCALAPPDATA").map(|l| PathBuf::from(l).join("FluxControl")));
    if let Some(p) = flux.map(|h| h.join("bin").join("ffmpeg.exe")).filter(|p| p.exists()) {
        return Some(p);
    }
    std::env::split_paths(&std::env::var_os("PATH")?).map(|d| d.join("ffmpeg.exe")).find(|p| p.exists())
}

/// The first hardware H.264 encoder that really works on this PC (tries a 3-frame test encode).
pub fn pick_encoder(ff: &Path) -> Option<&'static str> {
    ["h264_nvenc", "h264_amf", "h264_qsv"].into_iter().find(|enc| {
        Command::new(ff)
            .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=640x360:r=10", "-frames:v", "3", "-c:v", enc, "-f", "null", "-"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(NO_WINDOW)
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    })
}

pub fn start(ff: &Path, enc: &str, cfg: &Cfg, shared: Arc<Shared>, gen: u64) -> std::io::Result<Gpu> {
    let (bps, fps) = (cfg.bps.to_string(), cfg.fps.to_string());
    let mut a: Vec<String> = ["-hide_banner", "-loglevel", "error", "-fflags", "nobuffer", "-probesize", "32", "-analyzeduration", "0", "-use_wallclock_as_timestamps", "1", "-f", "rawvideo", "-pix_fmt", "rgb24"]
        .map(String::from)
        .into();
    a.extend(["-video_size".into(), format!("{}x{}", cfg.w, cfg.h), "-i".into(), "pipe:0".into(), "-an".into(), "-pix_fmt".into(), "yuv420p".into(), "-c:v".into(), enc.into()]);
    let enc_args: &[&str] = match enc {
        "h264_nvenc" => &["-preset", "p1", "-tune", "ll", "-rc", "vbr", "-multipass", "disabled", "-zerolatency", "1", "-profile:v", "main"],
        "h264_amf" => &["-usage", "ultralowlatency", "-quality", "speed", "-rc", "cbr", "-profile:v", "main"],
        _ => &["-preset", "veryfast", "-look_ahead", "0", "-async_depth", "1", "-profile:v", "main"],
    };
    a.extend(enc_args.iter().map(|s| s.to_string()));
    // a keyframe every second so a viewer who joins late never waits long; no B-frames for low delay
    a.extend(["-b:v", &bps, "-maxrate", &bps, "-bufsize", &(cfg.bps / 2).to_string(), "-g", &fps, "-bf", "0", "-fps_mode", "cfr", "-r", &fps, "-flush_packets", "1"].map(String::from)); // cfr: evenly spaced frames; jittery times make browsers drop frames
    a.extend(["-movflags", "empty_moov+default_base_moof+frag_every_frame", "-f", "mp4", "pipe:1"].map(String::from));

    let mut child = Command::new(ff).args(&a).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).creation_flags(NO_WINDOW).spawn()?;
    let stdin = child.stdin.take().ok_or(std::io::ErrorKind::BrokenPipe)?;
    let out = child.stdout.take().ok_or(std::io::ErrorKind::BrokenPipe)?;
    shared.gpu.store(true, Relaxed);
    std::thread::spawn(move || reader(out, shared, gen));
    Ok(Gpu { child, stdin })
}

fn has_idr(mdat: &[u8]) -> bool {
    let mut i = 0;
    while i + 5 <= mdat.len() {
        let n = u32::from_be_bytes([mdat[i], mdat[i + 1], mdat[i + 2], mdat[i + 3]]) as usize;
        if n == 0 || i + 4 + n > mdat.len() {
            break;
        }
        if mdat[i + 4] & 0x1f == 5 {
            return true;
        }
        i += 4 + n;
    }
    false
}

/// ffmpeg's output is boxes: ftyp+moov (the init segment) once, then a moof+mdat pair per frame.
fn reader(mut out: impl Read, shared: Arc<Shared>, gen: u64) {
    let (mut init, mut moof): (Vec<u8>, Option<Vec<u8>>) = (Vec::new(), None);
    loop {
        let mut hdr = [0u8; 8];
        if out.read_exact(&mut hdr).is_err() {
            break;
        }
        let size = u32::from_be_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]) as usize;
        if !(8..=64 << 20).contains(&size) {
            break;
        }
        let mut b = hdr.to_vec();
        b.resize(size, 0);
        if out.read_exact(&mut b[8..]).is_err() {
            break;
        }
        match &hdr[4..8] {
            b"ftyp" => init.extend_from_slice(&b),
            b"moov" => {
                init.extend_from_slice(&b);
                let mut g = shared.st.lock().unwrap();
                if g.gen != gen {
                    break; // this capture was replaced by another monitor
                }
                g.init = Some(Arc::new(std::mem::take(&mut init)));
                drop(g);
                shared.has_init.store(true, Relaxed);
                shared.cv.notify_all();
            }
            b"moof" => moof = Some(b),
            b"mdat" => {
                if let Some(mut m) = moof.take() {
                    let key = has_idr(&b[8..]);
                    m.extend_from_slice(&b);
                    let mut g = shared.st.lock().unwrap();
                    if g.gen != gen {
                        break;
                    }
                    g.seq += 1;
                    if key {
                        g.frags.clear();
                    }
                    let s = g.seq;
                    g.frags.push_back((s, Arc::new(m)));
                    shared.cv.notify_all();
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn finds_idr() {
        // two length-prefixed NALs: a type-1 slice then a type-5 slice
        let m = [0, 0, 0, 2, 0x41, 0xAA, 0, 0, 0, 2, 0x65, 0xBB];
        assert!(has_idr(&m));
        assert!(!has_idr(&[0, 0, 0, 2, 0x41, 0xAA]));
        assert!(!has_idr(&[0, 0, 0, 9, 0x65])); // length runs past the end
    }
}
