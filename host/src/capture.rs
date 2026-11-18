//! Monitor capture -> H.264 -> fragmented MP4 fragments, shared with every viewer.
use crate::mp4;
use openh264::encoder::{BitRate, Complexity, Encoder, EncoderConfig, FrameRate, FrameType, IntraFramePeriod, RateControlMode};
use openh264::formats::{RgbSliceU8, YUVBuffer};
use openh264::OpenH264API;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering::Relaxed};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;

#[derive(Default)]
pub struct State {
    pub init: Option<Arc<Vec<u8>>>,
    pub seq: u64,
    /// fragments since the latest keyframe; the front is always a keyframe so a late joiner can start there
    pub frags: VecDeque<(u64, Arc<Vec<u8>>)>,
    pub cursor: String,
    pub cursor_seq: u64,
    /// bumped on every monitor switch: viewers resend the init segment, frames from an older capture are dropped
    pub gen: u64,
    pub w: u32,
    pub h: u32,
    pub mon: usize,
}

#[derive(Default)]
pub struct Shared {
    pub st: Mutex<State>,
    pub cv: Condvar,
    pub viewers: AtomicUsize,
    pub want_key: AtomicBool,
    pub stop: AtomicBool,
    /// set once the first keyframe exists; until then frames are encoded even with nobody watching
    pub has_init: AtomicBool,
    /// frames come from the GPU encoder (ffmpeg): its keyframes can't be forced, so a late joiner keeps the existing group of pictures
    pub gpu: AtomicBool,
    /// fragments sent per second over the last 2 s (what the host really produces, whatever the viewer shows)
    pub sent_fps: AtomicU32,
    /// microseconds spent and counts, for the optional perf report: scale, convert, encode, frames dropped before encoding
    pub perf: [AtomicU64; 7],
}

impl Shared {
    /// First viewer after an idle period: drop stale fragments and ask for a fresh keyframe.
    pub fn request_key(&self) {
        if self.gpu.load(Relaxed) {
            return; // the encoder keeps one keyframe a second; the stored group of pictures is still a valid chain
        }
        self.st.lock().unwrap().frags.clear();
        self.want_key.store(true, Relaxed);
    }

    pub fn set_cursor(&self, name: &str) {
        let mut g = self.st.lock().unwrap();
        if g.cursor != name {
            g.cursor = name.to_string();
            g.cursor_seq += 1;
            self.cv.notify_all();
        }
    }
}

#[derive(Clone, Copy)]
pub struct Cfg {
    pub w: u32,
    pub h: u32,
    pub fps: u32,
    pub bps: u32,
    pub threads: u16,
    /// 0 low, 1 medium, 2 high
    pub complexity: u8,
    /// let the encoder drop frames to hold the bitrate (off: smoother, but bursts above the target)
    pub skip: bool,
}

pub struct Flags {
    pub shared: Arc<Shared>,
    pub cfg: Cfg,
    /// Some((ffmpeg.exe, encoder name)) = encode on the GPU
    pub gpu: Option<(std::path::PathBuf, &'static str)>,
    /// set when this capture is replaced by another monitor
    pub quit: Arc<AtomicBool>,
    pub gen: u64,
}

struct Pending {
    sample: Vec<u8>,
    key: bool,
    ts: u64,
}

/// A scaled RGB frame handed from the capture thread to the encoder thread. Only the newest one is kept,
/// so a slow encode drops frames instead of building up delay.
struct Slot {
    frame: Mutex<Option<(Vec<u8>, u64)>>,
    cv: Condvar,
    spare: Mutex<Vec<Vec<u8>>>,
}

pub struct Cap {
    shared: Arc<Shared>,
    cfg: Cfg,
    slot: Arc<Slot>,
    start: Instant,
    next_tick: Instant,
    quit: Arc<AtomicBool>,
}

struct Worker {
    shared: Arc<Shared>,
    cfg: Cfg,
    enc: Encoder,
    pending: Option<Pending>,
    frag_seq: u32,
    quit: Arc<AtomicBool>,
    gen: u64,
}

/// Output size: fit inside the preset box, never upscale, even dimensions.
pub fn fit(sw: u32, sh: u32, bw: u32, bh: u32) -> (u32, u32) {
    let s = (bw as f64 / sw as f64).min(bh as f64 / sh as f64).min(1.0);
    ((((sw as f64 * s) as u32) & !1).max(2), (((sh as f64 * s) as u32) & !1).max(2))
}

/// Splits an Annex-B stream into NAL units (start codes stripped).
fn nals(b: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= b.len() {
        if b[i] == 0 && b[i + 1] == 0 && b[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    (0..starts.len())
        .map(|k| {
            let mut e = starts.get(k + 1).map_or(b.len(), |n| n - 3);
            while e > starts[k] && b[e - 1] == 0 {
                e -= 1;
            }
            &b[starts[k]..e]
        })
        .collect()
}

impl Worker {
    fn publish(&mut self, p: Pending, next_ts: u64) {
        let dur = (next_ts - p.ts).clamp(1, 90000) as u32;
        self.frag_seq += 1;
        let frag = Arc::new(mp4::fragment(self.frag_seq, p.ts, dur, p.key, &p.sample));
        let mut g = self.shared.st.lock().unwrap();
        if g.gen != self.gen {
            return;
        }
        g.seq += 1;
        if p.key {
            g.frags.clear();
        }
        let s = g.seq;
        g.frags.push_back((s, frag));
        self.shared.cv.notify_all();
    }

    /// Nothing new arrived for a frame interval: send the held frame now so a still screen is never one frame behind.
    fn flush(&mut self) {
        if let Some(p) = self.pending.take() {
            let end = p.ts + 90000 / self.cfg.fps as u64;
            self.publish(p, end);
        }
    }

    fn encode(&mut self, rgb: &[u8], ts: u64) {
        let (dw, dh) = (self.cfg.w as usize, self.cfg.h as usize);
        if self.shared.want_key.swap(false, Relaxed) {
            self.enc.force_intra_frame();
        }
        let t0 = Instant::now();
        let yuv = YUVBuffer::from_rgb8_source(RgbSliceU8::new(rgb, (dw, dh)));
        let t1 = Instant::now();
        let Ok(bs) = self.enc.encode(&yuv) else { return };
        self.shared.perf[2].fetch_add((t1 - t0).as_micros() as u64, Relaxed);
        self.shared.perf[3].fetch_add(t1.elapsed().as_micros() as u64, Relaxed);
        self.shared.perf[4].fetch_add(1, Relaxed);
        let ft = bs.frame_type();
        if matches!(ft, FrameType::Skip | FrameType::Invalid) {
            return;
        }
        let key = matches!(ft, FrameType::IDR | FrameType::I);
        let data = bs.to_vec();

        let (mut sps, mut pps, mut sample) = (None, None, Vec::new());
        for n in nals(&data) {
            match n.first().map(|b| b & 0x1f) {
                Some(7) => sps = Some(n),
                Some(8) => pps = Some(n),
                Some(1 | 5) => {
                    sample.extend_from_slice(&(n.len() as u32).to_be_bytes());
                    sample.extend_from_slice(n);
                }
                _ => {}
            }
        }
        if !self.shared.has_init.load(Relaxed) {
            let (Some(s), Some(p)) = (sps, pps) else { return };
            let mut g = self.shared.st.lock().unwrap();
            if g.gen != self.gen {
                return;
            }
            g.init = Some(Arc::new(mp4::init_segment(s, p, dw as u16, dh as u16)));
            drop(g);
            self.shared.has_init.store(true, Relaxed);
            self.shared.cv.notify_all();
        }
        if sample.is_empty() {
            return;
        }
        if let Some(prev) = self.pending.replace(Pending { sample, key, ts }) {
            self.publish(prev, ts);
        }
    }
}

fn worker(mut w: Worker, slot: Arc<Slot>) {
    let interval = Duration::from_millis(1000 / w.cfg.fps as u64);
    loop {
        let got = {
            let mut g = slot.frame.lock().unwrap();
            loop {
                if w.shared.stop.load(Relaxed) || w.quit.load(Relaxed) {
                    return;
                }
                if let Some(f) = g.take() {
                    break Some(f);
                }
                let (ng, t) = slot.cv.wait_timeout(g, interval).unwrap();
                g = ng;
                if t.timed_out() {
                    break None;
                }
            }
        };
        match got {
            Some((rgb, ts)) => {
                w.encode(&rgb, ts);
                let mut sp = slot.spare.lock().unwrap();
                if sp.len() < 3 {
                    sp.push(rgb);
                }
            }
            None => w.flush(),
        }
    }
}

/// Feeds frames to ffmpeg. The last frame is repeated while the screen is still so the muxer can finish the frame it holds.
fn gpu_worker(mut gpu: crate::gpu::Gpu, slot: Arc<Slot>, shared: Arc<Shared>, fps: u32, quit: Arc<AtomicBool>) {
    use std::io::Write;
    let interval = Duration::from_millis(1000 / fps as u64);
    let mut last: Vec<u8> = Vec::new();
    loop {
        let got = {
            let mut g = slot.frame.lock().unwrap();
            loop {
                if shared.stop.load(Relaxed) || quit.load(Relaxed) {
                    let _ = gpu.child.kill();
                    return;
                }
                if let Some(f) = g.take() {
                    break Some(f);
                }
                let (ng, t) = slot.cv.wait_timeout(g, interval).unwrap();
                g = ng;
                if t.timed_out() {
                    break None;
                }
            }
        };
        let ok = match got {
            Some((rgb, _)) => {
                let r = gpu.stdin.write_all(&rgb).is_ok();
                last = rgb;
                r
            }
            None if !last.is_empty() && shared.viewers.load(Relaxed) > 0 => gpu.stdin.write_all(&last).is_ok(),
            None => true,
        };
        if !ok {
            let _ = gpu.child.kill();
            crate::emit(serde_json::json!({"t": "error", "method": "encoder", "err": "the GPU encoder stopped"}));
            return;
        }
    }
}

impl GraphicsCaptureApiHandler for Cap {
    type Flags = Flags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let c = ctx.flags.cfg;
        let conf = EncoderConfig::new()
            .bitrate(BitRate::from_bps(c.bps))
            .max_frame_rate(FrameRate::from_hz(c.fps as f32))
            .rate_control_mode(RateControlMode::Bitrate)
            .complexity(match c.complexity { 0 => Complexity::Low, 1 => Complexity::Medium, _ => Complexity::High })
            .skip_frames(c.skip)
            .intra_frame_period(IntraFramePeriod::from_num_frames(c.fps * 2))
            .num_threads(c.threads);
        let slot = Arc::new(Slot { frame: Mutex::new(None), cv: Condvar::new(), spare: Mutex::new(Vec::new()) });
        if let Some((ff, enc)) = &ctx.flags.gpu {
            let gpu = crate::gpu::start(ff, enc, &c, ctx.flags.shared.clone(), ctx.flags.gen)?;
            let (s2, sh, q) = (slot.clone(), ctx.flags.shared.clone(), ctx.flags.quit.clone());
            std::thread::spawn(move || gpu_worker(gpu, s2, sh, c.fps, q));
            return Ok(Self { shared: ctx.flags.shared, cfg: c, slot, start: Instant::now(), next_tick: Instant::now(), quit: ctx.flags.quit });
        }
        let w = Worker {
            shared: ctx.flags.shared.clone(),
            cfg: c,
            enc: Encoder::with_api_config(OpenH264API::from_source(), conf)?,
            pending: None,
            frag_seq: 0,
            quit: ctx.flags.quit.clone(),
            gen: ctx.flags.gen,
        };
        let s2 = slot.clone();
        std::thread::spawn(move || worker(w, s2));
        Ok(Self { shared: ctx.flags.shared, cfg: c, slot, start: Instant::now(), next_tick: Instant::now(), quit: ctx.flags.quit })
    }

    fn on_frame_arrived(&mut self, frame: &mut Frame, control: InternalCaptureControl) -> Result<(), Self::Error> {
        if self.shared.stop.load(Relaxed) || self.quit.load(Relaxed) {
            self.slot.cv.notify_all();
            control.stop();
            return Ok(());
        }
        // nobody watching: skip the work, but make sure the init segment exists once
        if self.shared.has_init.load(Relaxed) && self.shared.viewers.load(Relaxed) == 0 {
            return Ok(());
        }
        // an even cadence: take the first frame after each tick (a 144 Hz screen at 30 fps would otherwise give uneven gaps)
        let now = Instant::now();
        if now < self.next_tick {
            return Ok(());
        }
        let iv = Duration::from_secs_f64(1.0 / self.cfg.fps as f64);
        self.next_tick = if now - self.next_tick > iv * 2 { now + iv } else { self.next_tick + iv };
        // snap to the frame grid: evenly spaced timestamps play smoothly, jittery capture times make players drop frames
        let ts = ((self.start.elapsed().as_secs_f64() * self.cfg.fps as f64).round() * 90000.0 / self.cfg.fps as f64) as u64;

        let (sw, sh) = (frame.width() as usize, frame.height() as usize);
        let (dw, dh) = (self.cfg.w as usize, self.cfg.h as usize);
        let mut buf = frame.buffer()?;
        let pitch = buf.row_pitch() as usize;
        let raw = buf.as_raw_buffer();

        let t_scale = Instant::now();
        let mut rgb = self.slot.spare.lock().unwrap().pop().unwrap_or_default();
        rgb.clear();
        rgb.reserve(dw * dh * 3);
        // shortcut: nearest-neighbour scaling
        let xs: Vec<usize> = (0..dw).map(|x| (x * sw / dw) * 4).collect();
        for y in 0..dh {
            let row = &raw[(y * sh / dh) * pitch..];
            for &x in &xs {
                rgb.extend_from_slice(&row[x..x + 3]);
            }
        }
        self.shared.perf[0].fetch_add(t_scale.elapsed().as_micros() as u64, Relaxed);
        self.shared.perf[1].fetch_add(1, Relaxed);
        let mut slot = self.slot.frame.lock().unwrap();
        if slot.is_some() {
            self.shared.perf[6].fetch_add(1, Relaxed); // the encoder never got to the previous frame
        }
        *slot = Some((rgb, ts));
        drop(slot);
        self.slot.cv.notify_one();
        Ok(())
    }
}
