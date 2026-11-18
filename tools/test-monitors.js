// Monitor switching end to end (needs a PC with 2+ screens): the host lists its screens, a viewer switches,
// gets a 'screen' message plus a new init segment and video, and an absolute move lands on the new screen.
// Usage: node tools/test-monitors.js
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const assert = require('assert');

const exe = path.join(__dirname, '..', 'host', 'target', 'release', 'flux-host.exe');
const PORT = 18766, PW = 'test-pass-123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (cmd) => execFileSync('powershell', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; ' + cmd]).toString().trim();
const pointer = () => ps('$p=[Windows.Forms.Cursor]::Position; "$($p.X) $($p.Y)"').split(' ').map(Number);
const isInit = (b) => b.slice(4, 8).toString() === 'ftyp';

(async () => {
  const host = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  host.stdin.write(JSON.stringify({ port: PORT, quality: '720p30', password: PW, methods: [] }) + '\n');
  const [px, py] = pointer();
  try {
    await sleep(1500);
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.binaryType = 'arraybuffer';
    const text = [], bin = [];
    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', pw: PW }));
    ws.onmessage = (e) => (typeof e.data === 'string' ? text.push(JSON.parse(e.data)) : bin.push({ at: text.length, b: Buffer.from(e.data) }));
    await sleep(2000);
    const ok = text.find((m) => m.t === 'ok');
    assert(ok && Array.isArray(ok.mons), 'no monitor list in the hello');
    console.log('screens:', ok.mons.map((m) => `${m.i}:${m.name} ${m.w}x${m.h}${m.primary ? ' (main)' : ''}`).join(', '), '| showing', ok.mon);
    if (ok.mons.length < 2) { console.log('only one screen: switch not tested'); return; }
    assert(isInit(bin[0].b), 'first binary message is not the init segment');

    const to = ok.mons.find((m) => m.i !== ok.mon).i;
    ws.send(JSON.stringify({ t: 'mon', i: to }));
    await sleep(2500);
    const sc = text.findIndex((m) => m.t === 'screen');
    assert(sc >= 0 && text[sc].mon === to, 'no screen message after the switch');
    const after = bin.filter((x) => x.at > sc);
    assert(after.length > 5 && isInit(after[0].b), 'no new init segment + video after the switch');
    console.log(`switched to ${to}: screen message, new init, ${after.length - 1} video fragments`);

    // a move to the middle of the picture must land in the middle of the new screen
    const b = ps(`$s=[Windows.Forms.Screen]::AllScreens; $o=@($s | ? { -not $_.Primary })[0].Bounds; $m=[Windows.Forms.Screen]::PrimaryScreen.Bounds; "$($o.X) $($o.Y) $($o.Width) $($o.Height) $($m.X) $($m.Y) $($m.Width) $($m.Height)"`).split(' ').map(Number);
    const r = ok.mons[to].primary ? b.slice(4) : b.slice(0, 4);
    let p;
    for (let i = 0; i < 5; i++) { ws.send(JSON.stringify({ t: 'mv', x: 0.5, y: 0.5 })); await sleep(150); p = pointer(); if (Math.abs(p[0] - (r[0] + r[2] / 2)) <= 3) break; }
    assert(Math.abs(p[0] - (r[0] + r[2] / 2)) <= 3 && Math.abs(p[1] - (r[1] + r[3] / 2)) <= 3, `pointer at ${p}, expected the middle of ${r}`);
    console.log('input lands on the new screen:', p.join(','));
    ws.close();
    console.log('monitor tests passed');
  } catch (e) { console.error('FAILED:', e.message); process.exitCode = 1; }
  finally {
    ps(`[Windows.Forms.Cursor]::Position = New-Object Drawing.Point(${px}, ${py})`);
    host.stdin.end(); setTimeout(() => host.kill(), 500);
  }
})();
