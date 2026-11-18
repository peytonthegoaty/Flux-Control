// Measures what a viewer receives from flux-host.exe: fragments per second and the gaps between them.
//   node tools/bench-host.js [quality] [seconds] ['{"threads":8,"skip":true}']      (the screen content decides the load: run it while a game is open)
const { spawn } = require('child_process');
const path = require('path');

const exe = path.join(__dirname, '..', 'host', 'target', 'release', 'flux-host.exe');
const quality = process.argv[2] || '720p30', secs = +process.argv[3] || 8, PORT = 18790, PW = 'bench-pw';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const host = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  host.stdout.on('data', (d) => d.toString().split(String.fromCharCode(10)).filter((l) => l.includes('"perf"')).forEach((l) => console.log('  host', l)));
  const extra = process.argv[4] ? JSON.parse(process.argv[4]) : {};
  host.stdin.write(JSON.stringify({ port: PORT, quality, password: PW, methods: [], perf: true, ...extra }) + '\n');
  await sleep(2000);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.binaryType = 'arraybuffer';
  const times = [], bytes = [];
  let pings = [];
  ws.onopen = () => { ws.send(JSON.stringify({ t: 'auth', pw: PW })); };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') { const m = JSON.parse(e.data); if (m.t === 'pong') pings.push(performance.now() - m.c); return; }
    const b = Buffer.from(e.data);
    if (b.slice(4, 8).toString() === 'moof') { times.push(performance.now()); bytes.push(b.length); }
  };
  await sleep(1500);
  const t0 = performance.now(), n0 = times.length;
  const ping = setInterval(() => ws.send(JSON.stringify({ t: 'ping', c: performance.now() })), 500);
  await sleep(secs * 1000);
  clearInterval(ping);
  const t = times.slice(n0), dt = t.slice(1).map((x, i) => x - t[i]).sort((a, b) => a - b);
  const q = (p) => dt[Math.min(dt.length - 1, Math.floor(dt.length * p))].toFixed(1);
  console.log(`${quality} ${JSON.stringify(extra)}: ${(t.length / secs).toFixed(1)} fragments/s, gap ms p50 ${q(0.5)} p95 ${q(0.95)} max ${dt[dt.length - 1].toFixed(0)}, ${(bytes.slice(n0).reduce((a, b) => a + b, 0) / secs / 125000).toFixed(1)} Mbit/s`);
  if (pings.length) console.log(`ping: ${pings.length} replies, avg ${(pings.reduce((a, b) => a + b, 0) / pings.length).toFixed(1)} ms`); else console.log('ping: no replies');
  ws.close(); host.stdin.end(); await sleep(400); host.kill();
})().catch((e) => { console.error(e); process.exit(1); });
