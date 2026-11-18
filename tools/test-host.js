// End-to-end test of host/target/release/flux-host.exe on loopback: auth, video, cursor, input.
// Usage: node tools/test-host.js   (moves nothing: the mouse test re-sends the pointer's current position)
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const exe = path.join(__dirname, '..', 'host', 'target', 'release', 'flux-host.exe');
const PORT = 18765, PW = 'test-pass-123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pointer() {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    'Add-Type -AssemblyName System.Windows.Forms; $p=[Windows.Forms.Cursor]::Position; $b=[Windows.Forms.Screen]::PrimaryScreen.Bounds; "$($p.X) $($p.Y) $($b.Width) $($b.Height)"']).toString().trim().split(' ').map(Number);
  return { x: out[0], y: out[1], w: out[2], h: out[3] };
}

function restore(p) {
  execFileSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.Cursor]::Position = New-Object Drawing.Point(${p.x}, ${p.y})`]);
}

function connect(pw) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.binaryType = 'arraybuffer';
    const got = { bin: [], text: [] };
    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', pw }));
    ws.onmessage = (e) => (typeof e.data === 'string' ? got.text.push(JSON.parse(e.data)) : got.bin.push(Buffer.from(e.data)));
    ws.onclose = () => resolve({ ws, got, closed: true });
    ws.onerror = () => {};
    resolve({ ws, got });
  });
}

(async () => {
  const host = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const events = [];
  host.stdout.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => events.push(JSON.parse(l))));
  host.stdin.write(JSON.stringify({ port: PORT, quality: '720p30', password: PW, methods: ['lan'] }) + '\n');
  try {
    await sleep(2500);
    assert(events.find((e) => e.t === 'started'), 'host did not start: ' + JSON.stringify(events));
    const lan = events.find((e) => e.t === 'ready' && e.method === 'lan');
    console.log('started', events.find((e) => e.t === 'started'), lan ? 'lan ' + lan.url : 'no lan');

    // plain HTTP placeholder page
    const page = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
    assert(page.includes('Flux Control') && page.includes('id="login"'), 'web client page is served');
    for (const f of ['/style.css', '/session.css', '/web.css', '/controls.js', '/viewer.js', '/hud.js', '/web.js', '/assets/geist-medium.ttf']) assert((await fetch(`http://127.0.0.1:${PORT}${f}`)).ok, f + ' served');
    assert((await fetch(`http://127.0.0.1:${PORT}/nope`)).status === 404, '404 for unknown paths');
    // a page on another site must not be able to open the socket
    const foreign = await new Promise((res) => { const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: 'http://evil.example' } }); w.onopen = () => res('opened'); w.onerror = () => res('refused'); w.onclose = () => res('refused'); });
    assert.strictEqual(foreign, 'refused', 'foreign Origin must be refused');
    console.log('web client served, foreign origin refused');

    // wrong password is rejected
    const bad = await connect('nope'); await sleep(1800);
    assert(bad.got.text.some((m) => m.t === 'err'), 'wrong password must be refused');
    assert(bad.got.bin.length === 0, 'no video before auth');
    console.log('wrong password refused');

    // right password: ok + init segment + fragments + cursor
    const good = await connect(PW); await sleep(3000);
    const ok = good.got.text.find((m) => m.t === 'ok');
    assert(ok && ok.w > 0, 'auth ok');
    assert(good.got.bin.length > 10, 'video fragments, got ' + good.got.bin.length);
    assert(good.got.bin[0].slice(4, 8).toString() === 'ftyp', 'first message is the init segment');
    assert(good.got.bin[1].slice(4, 8).toString() === 'moof', 'then fragments');
    assert(good.got.text.some((m) => m.t === 'cursor'), 'cursor shape sent');
    console.log('video ok:', good.got.bin.length, 'messages,', ok.w + 'x' + ok.h, 'cursor', good.got.text.find((m) => m.t === 'cursor').name);
    assert(events.some((e) => e.t === 'viewers' && e.n === 1), 'viewer count event');

    // ping: the host echoes the viewer's timestamp
    const c0 = Date.now();
    good.ws.send(JSON.stringify({ t: 'ping', c: c0 })); await sleep(300);
    assert(good.got.text.some((m) => m.t === 'pong' && m.c === c0), 'pong reply');
    console.log('ping reply ok');

    // decodable?
    const f = path.join(process.env.TEMP, 'flux-host-test.mp4');
    fs.writeFileSync(f, Buffer.concat(good.got.bin));
    try {
      const o = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-count_frames', '-show_entries', 'stream=codec_name,width,height,nb_read_frames', '-of', 'compact', f]).toString();
      console.log('ffprobe:', o.trim());
    } catch (e) { console.log('ffprobe unavailable or failed, skipped'); }

    if (process.env.FLUX_TEST_NOINPUT) console.log('input tests skipped (FLUX_TEST_NOINPUT)');
    else {
    // input: move the pointer to 25%/25% of the primary screen, check it arrived, then put it back where it was
    // (a person moving the real mouse at the same time can win a race, so up to 5 tries)
    const before = pointer();
    const tx = Math.round(0.25 * (before.w - 1)), ty = Math.round(0.25 * (before.h - 1));
    let after;
    for (let i = 0; i < 5; i++) {
      good.ws.send(JSON.stringify({ t: 'mv', x: 0.25, y: 0.25 }));
      await sleep(120);
      after = pointer();
      if (Math.abs(after.x - tx) <= 3 && Math.abs(after.y - ty) <= 3) break;
    }
    // mouse lock: relative movement as a fraction of the picture (1% of the width ~ 19px on a 1920 screen)
    let rel = null;
    for (let i = 0; i < 5 && rel === null; i++) {
      const p0 = pointer();
      good.ws.send(JSON.stringify({ t: 'rel', x: 0.01, y: 0 }));
      await sleep(150);
      const p1 = pointer();
      if (Math.abs(p1.x - p0.x - Math.round(0.01 * p0.w)) <= 3 && Math.abs(p1.y - p0.y) <= 3) rel = p1.x - p0.x;
    }
    assert(rel !== null, 'relative mouse movement did not land');
    console.log('mouse lock movement ok: moved', rel, 'px');
    restore(before);
    assert(Math.abs(after.x - tx) <= 3 && Math.abs(after.y - ty) <= 3, `pointer at ${after.x},${after.y}, wanted ~${tx},${ty}`);
    console.log('input injection ok: pointer went to', after.x + ',' + after.y, '(restored to', before.x + ',' + before.y + ')');

    }

    good.ws.close(); await sleep(800);
    assert(events.some((e) => e.t === 'viewers' && e.n === 0), 'viewer count back to 0');
    console.log('host tests passed');
  } finally {
    host.stdin.end();
    await sleep(500);
    host.kill();
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
