// Flux Control viewer: connects to a host, plays its screen (H.264 over MSE) and sends mouse/keyboard input back.
// The host's cursor SHAPE arrives as {t:'cursor'}; the pointer itself is always the viewer's own OS cursor.
const Viewer = (() => {
  let cur = null;
  const calls = new Map(), subs = {};   // app calls relayed by the host (web client's Executor) and events pushed back
  let callSeq = 0;

  const codecOf = (b) => {
    for (let i = 4; i < b.length - 8; i++) {
      if (b[i] === 0x61 && b[i + 1] === 0x76 && b[i + 2] === 0x63 && b[i + 3] === 0x43) {
        return [...b.slice(i + 5, i + 8)].map((x) => x.toString(16).padStart(2, '0')).join('');
      }
    }
    return '42e01f';
  };

  /** open({url, password, stage, video, onCursor, onLive, onClose}) -> Promise<{w,h}>; rejects with a readable Error */
  function open(o) {
    return new Promise((resolve, reject) => {
      let sock;
      try { sock = new WebSocket(o.url.replace(/^http/, 'ws') + '/ws'); } catch { return reject(new Error('That address is not valid')); }
      sock.binaryType = 'arraybuffer';
      let settled = false;
      const fail = (m) => { if (!settled) { settled = true; clearTimeout(timer); try { sock.close(); } catch {} reject(new Error(m)); } };
      const timer = setTimeout(() => fail("Couldn't reach that PC"), 8000);
      sock.onopen = () => sock.send(JSON.stringify({ t: 'auth', pw: o.password || '' }));
      sock.onerror = () => fail("Couldn't reach that PC");
      sock.onclose = () => {
        if (!settled) return fail("Couldn't reach that PC");
        if (cur && cur.sock === sock) { const cb = o.onClose; teardown(); cb && cb(); }
      };
      sock.onmessage = (e) => {
        if (!settled) {
          if (typeof e.data !== 'string') return;
          const m = JSON.parse(e.data);
          if (m.t === 'ok') { settled = true; clearTimeout(timer); begin(sock, o, m); resolve(m); } else fail(m.err || 'Refused');
          return;
        }
        cur && cur.onMsg(e.data);
      };
    });
  }

  function begin(sock, o, info) {
    const { video, stage } = o;
    let ms = null, sb = null, opened = false;
    const q = [], early = [];
    // a fresh player: at the start, and when the host switches to another monitor (new size, new init segment)
    const mse = () => {
      const old = video.src, m = new MediaSource();
      ms = m; sb = null; opened = false; q.length = 0; early.length = 0;
      video.src = URL.createObjectURL(m);
      if (old) URL.revokeObjectURL(old);
      m.addEventListener('sourceopen', () => { if (ms === m) { opened = true; early.splice(0).forEach(bin); } });
    };

    const pump = () => { if (sb && !sb.updating && q.length) { try { sb.appendBuffer(q.shift()); } catch { q.length = 0; } } };
    const live = () => {
      if (!sb || !sb.buffered.length) return;
      const s = sb.buffered.start(0), e = sb.buffered.end(sb.buffered.length - 1);
      const lag = e - video.currentTime;
      // keep about 0.2 s in hand so a late frame does not stall the picture; drift is corrected by speed, a big gap by a jump
      if (video.currentTime < s || lag > 1.5) { video.currentTime = e - 0.2; video.playbackRate = 1; }
      else video.playbackRate = lag > 0.6 ? 1.2 : lag > 0.4 ? 1.08 : lag < 0.08 ? 0.92 : 1;
      if (video.paused) video.play().catch(() => {});
      if (!sb.updating && video.currentTime - s > 6) { try { sb.remove(s, video.currentTime - 3); } catch {} }
    };
    const bin = (b) => {
      if (!opened) return early.push(b);
      if (!sb) {
        sb = ms.addSourceBuffer(`video/mp4;codecs="avc1.${codecOf(b)}"`);
        sb.addEventListener('updateend', () => { pump(); live(); });
      }
      q.push(b); pump();
    };
    mse();
    if (o.onScreen) o.onScreen(info);
    video.addEventListener('playing', () => o.onLive && o.onLive(), { once: true });
    const liveTimer = setInterval(live, 250);

    const send = (m) => { if (sock.readyState === 1) sock.send(JSON.stringify(m)); };
    const rect = () => {
      const r = video.getBoundingClientRect();
      const vw = video.videoWidth || info.w, vh = video.videoHeight || info.h;
      const s = Math.min(r.width / vw, r.height / vh), w = vw * s, h = vh * s;
      return { l: r.left + (r.width - w) / 2, t: r.top + (r.height - h) / 2, w, h };
    };
    const pos = (e) => { const r = rect(); const c = (v) => Math.min(1, Math.max(0, v)); return { x: c((e.clientX - r.l) / r.w), y: c((e.clientY - r.t) / r.h) }; };

    // mouse lock (pointer lock): the pointer is hidden and only movement is sent, as a fraction of the picture
    let locked = false, hidden = false, autoLocked = false;   // hidden: the host's cursor is hidden (a game has captured it)
    const lockNow = (on) => {
      if (on) {
        // unadjustedMovement = raw mouse data, no Windows acceleration (what shooters expect); older engines fall back to the plain lock
        const r = stage.requestPointerLock && stage.requestPointerLock({ unadjustedMovement: true });
        if (r && r.catch) r.catch(() => stage.requestPointerLock());
      } else if (document.pointerLockElement) document.exitPointerLock();
    };
    const lockChange = () => { locked = document.pointerLockElement === stage; o.onLock && o.onLock(locked); };
    const lockError = () => { locked = false; o.onLock && o.onLock(false); };
    document.addEventListener('pointerlockchange', lockChange);
    document.addEventListener('pointerlockerror', lockError);

    let raf = 0, last = null, acc = { x: 0, y: 0 };
    const onMove = (e) => {
      if (locked) { const r = rect(); acc.x += e.movementX / r.w; acc.y += e.movementY / r.h; }
      else last = pos(e);
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0;
        if (locked && (acc.x || acc.y)) { send({ t: 'rel', x: acc.x, y: acc.y }); acc = { x: 0, y: 0 }; }
        else if (!locked && last) send({ t: 'mv', ...last });
      });
    };
    const downs = new Set();
    const onDown = (e) => {
      e.preventDefault();
      if (!locked && hidden && o.autoLock && o.autoLock()) { autoLocked = true; lockNow(true); }   // a click on a game that hides its cursor captures the mouse
      downs.add(e.button); send({ t: 'md', b: e.button, ...(locked ? {} : pos(e)) }); };
    const onUp = (e) => { if (downs.delete(e.button)) send({ t: 'mu', b: e.button, ...(locked ? {} : pos(e)) }); };
    const onWheel = (e) => { e.preventDefault(); send({ t: 'wh', dx: e.deltaX, dy: e.deltaY }); };
    const held = new Set();
    const key = (down) => (e) => {
      if (document.querySelector('.fx-modal.open') || (e.target.closest && e.target.closest('[data-local-keys]'))) return;   // typing into our own dialog or the Executor
      e.preventDefault();
      if (e.code === 'ControlRight') { if (down && !e.repeat) document.dispatchEvent(new Event('flux:topbar')); return; }   // Right Ctrl: top bar on/off, never sent to the PC
      if (e.code === 'AltRight') { if (down && !e.repeat) { autoLocked = false; lockNow(!locked); } return; }   // Right Alt: mouse lock on/off, never sent to the PC
      down ? held.add(e.code) : held.delete(e.code);
      send({ t: down ? 'kd' : 'ku', c: e.code });
    };
    const kd = key(true), ku = key(false);
    const releaseKeys = () => { held.forEach((c) => send({ t: 'ku', c })); held.clear(); downs.forEach((b) => send({ t: 'mu', b })); downs.clear(); };

    stage.addEventListener('mousemove', onMove);
    stage.addEventListener('mousedown', onDown);
    stage.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('mouseup', onUp);
    document.addEventListener('keydown', kd);
    document.addEventListener('keyup', ku);
    window.addEventListener('blur', releaseKeys);
    // round trip time (also the keep-alive: the host drops silent viewers after 30 s) and frames actually shown per second
    const stats = { ping: null, fps: null, hf: null };   // hf: frames per second the host is really sending
    const ping = setInterval(() => send({ t: 'ping', c: performance.now() }), 2000);
    send({ t: 'ping', c: performance.now() });
    // frames really shown per second (decoded minus dropped); requestVideoFrameCallback can merge frames and under-count
    let alive = true, shown = 0, fpsT = performance.now();
    const fpsTimer = setInterval(() => {
      const q = video.getVideoPlaybackQuality(), now = performance.now(), n = q.totalVideoFrames - q.droppedVideoFrames;
      stats.fps = Math.round(((n - shown) * 1000) / (now - fpsT)); shown = n; fpsT = now;
    }, 1000);

    cur = {
      sock, stats,
      lock: (on) => { autoLocked = false; lockNow(on); },
      monitor: (i) => send({ t: 'mon', i }),
      call: (m, a) => new Promise((ok, bad) => { const id = ++callSeq; calls.set(id, { ok, bad }); send({ t: 'rpc', id, m, a }); setTimeout(() => { if (calls.delete(id)) bad(new Error('No answer from the PC')); }, 120000); }),
      locked: () => locked,
      onMsg: (d) => {
        if (typeof d === 'string') {
          const m = JSON.parse(d);
          if (m.t === 'cursor') {
            hidden = m.name === 'none';
            if (!hidden && autoLocked && locked) { autoLocked = false; lockNow(false); }   // the game showed its cursor again (a menu): let go
            if (o.onCursor) o.onCursor(m.name);
          }
          else if (m.t === 'rpc') { const c = calls.get(m.id); if (c) { calls.delete(m.id); m.err ? c.bad(new Error(m.err)) : c.ok(m.r); } }
          else if (m.t === 'push') (subs[m.ch] || []).forEach((f) => f(...(m.a || [])));
          else if (m.t === 'screen') { info.w = m.w; info.h = m.h; info.mon = m.mon; mse(); if (o.onScreen) o.onScreen(m); }
          else if (m.t === 'pong' && typeof m.c === 'number') { stats.hf = m.hf; const rtt = performance.now() - m.c; stats.ping = stats.ping == null ? rtt : stats.ping * 0.6 + rtt * 0.4; }
        }
        else bin(new Uint8Array(d));
      },
      teardown: () => {
        releaseKeys();
        alive = false;
        if (document.pointerLockElement) document.exitPointerLock();
        document.removeEventListener('pointerlockchange', lockChange); document.removeEventListener('pointerlockerror', lockError);
        clearInterval(liveTimer); clearInterval(ping); clearInterval(fpsTimer);
        stage.removeEventListener('mousemove', onMove); stage.removeEventListener('mousedown', onDown); stage.removeEventListener('wheel', onWheel);
        window.removeEventListener('mouseup', onUp); document.removeEventListener('keydown', kd); document.removeEventListener('keyup', ku); window.removeEventListener('blur', releaseKeys);
        try { sock.close(); } catch {}
        const u = video.src; video.removeAttribute('src'); video.load(); if (u) URL.revokeObjectURL(u);
      },
    };
  }

  const SHAPES = new Set(['default', 'pointer', 'text', 'crosshair', 'move', 'wait', 'progress', 'not-allowed', 'help', 'grab', 'grabbing',
    'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize', 'col-resize', 'row-resize', 'zoom-in', 'zoom-out', 'none']);
  const shape = (name) => (SHAPES.has(name) ? name : 'default');

  function teardown() { if (cur) { const c = cur; cur = null; c.teardown(); } }
  return { open, close: teardown, shape, active: () => !!cur, stats: () => (cur ? cur.stats : null), lock: (on) => cur && cur.lock(on), locked: () => !!cur && cur.locked(), monitor: (i) => cur && cur.monitor(i),
    call: (m, ...a) => (cur ? cur.call(m, a) : Promise.reject(new Error('Not connected'))), on: (ch, f) => { (subs[ch] = subs[ch] || []).push(f); } };
})();
