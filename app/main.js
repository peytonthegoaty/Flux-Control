// Flux Control PC client (Electron shell). The renderer is plain HTML in this folder.
const { app, BrowserWindow, ipcMain, shell, screen, clipboard, dialog } = require('electron');
const os = require('os');
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
// every IPC handler is also kept here, so web clients' calls (relayed by the host) can reach the allowed ones
const handlers = new Map();
{ const h = ipcMain.handle.bind(ipcMain); ipcMain.handle = (ch, fn) => { handlers.set(ch, fn); return h(ch, fn); }; }
const claudeMain = require('./claude-main');

// a window covered by a game must not be slowed down: it is a live video
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
let win, closing = false;

function create() {
  win = new BrowserWindow({
    width: 1100, height: 700, minWidth: 780, minHeight: 500,
    // Windows' own minimize / maximize / close buttons over a dark top bar the page draws; square window corners
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#050505', symbolColor: '#e6e6e6', height: 34 }, roundedCorners: false,
    show: false, backgroundColor: '#050505', title: 'Flux Control', icon: path.join(__dirname, '..', 'shared', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false,
      devTools: !!process.env.FLUX_DEV,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => { win.show(); if (process.env.FLUX_TEST_TOP) { win.setAlwaysOnTop(true, 'screen-saver'); win.focus(); } });
  win.on('enter-full-screen', () => win.webContents.send('fullscreen', true));
  win.on('leave-full-screen', () => win.webContents.send('fullscreen', false));
  // the close button asks first (the page shows "Are you sure?" and then calls win:quit)
  win.on('close', (e) => { if (!closing) { e.preventDefault(); win.webContents.send('win:closeRequest'); } });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // dev hook: FLUX_SHOT=<png> [FLUX_JS=<code to run first>] saves a screenshot and quits
  if (process.env.FLUX_SHOT) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      if (process.env.FLUX_JS) await win.webContents.executeJavaScript(process.env.FLUX_JS, true);
      await new Promise((r) => setTimeout(r, +(process.env.FLUX_WAIT || 1500)));
      if (process.env.FLUX_JS2 && process.env.FLUX_OUT) fs.writeFileSync(process.env.FLUX_OUT, JSON.stringify(await win.webContents.executeJavaScript(process.env.FLUX_JS2)));
      if (process.env.FLUX_CLIP && process.env.FLUX_OUT) fs.writeFileSync(process.env.FLUX_OUT + '.clip', String(await clipboard.readText()));
      if (process.env.FLUX_SHOT !== 'none') fs.writeFileSync(process.env.FLUX_SHOT, (await win.webContents.capturePage()).toPNG());
      closing = true; app.quit();
    }, 800));
  }
}

// a relaunch as administrator (--elev) starts while the old instance is still quitting: wait for its lock instead of quitting
let locked = false;
for (let i = 0; i < 80 && !(locked = app.requestSingleInstanceLock()); i++) { const t = Date.now() + 250; while (Date.now() < t); }
if (!locked) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(create);
}

// the window grows for the Executor and eases back afterwards (size = {w,h}, or null to go back)
let baseSize = null, animTimer = null;
ipcMain.handle('clipboard:write', async (_e, t) => {
  if (typeof t !== 'string' || t.length > 2_000_000) return false;
  await clipboard.writeText(t);
  const nl = (x) => x.split('\r\n').join('\n');   // Windows stores line breaks as CR LF
  return nl(await clipboard.readText()) === nl(t);
});
ipcMain.on('win:fit', (_e, size) => {
  if (!win || win.isMaximized() || win.isFullScreen()) return;
  const cur = win.getBounds();
  if (size && !baseSize) baseSize = { w: cur.width, h: cur.height };
  const want = size || baseSize;
  if (!want) return;
  if (!size) baseSize = null;
  const wa = screen.getDisplayMatching(cur).workArea;
  const w = Math.min(Math.max(+want.w | 0, 780), wa.width - 20), h = Math.min(Math.max(+want.h | 0, 500), wa.height - 20);
  const to = { x: Math.min(Math.max(Math.round(cur.x + (cur.width - w) / 2), wa.x + 10), wa.x + wa.width - w - 10), y: Math.min(Math.max(Math.round(cur.y + (cur.height - h) / 2), wa.y + 10), wa.y + wa.height - h - 10), width: w, height: h };
  const t0 = Date.now(), DUR = 380;
  clearInterval(animTimer);
  animTimer = setInterval(() => {
    const k = Math.min(1, (Date.now() - t0) / DUR), e = 1 - Math.pow(1 - k, 3);
    const L = (a, b) => Math.round(a + (b - a) * e);
    if (win.isDestroyed()) return clearInterval(animTimer);
    win.setBounds({ x: L(cur.x, to.x), y: L(cur.y, to.y), width: L(cur.width, to.width), height: L(cur.height, to.height) });
    if (k === 1) clearInterval(animTimer);
  }, 8);
});
ipcMain.on('win:min', () => win && win.minimize());
ipcMain.on('win:fullscreen', () => win && win.setFullScreen(!win.isFullScreen()));
ipcMain.on('win:quit', () => { closing = true; app.quit(); });
// ---- web clients: the Executor page (and its AI mode) works in the browser too, through the host
let features = [];
ipcMain.on('app:features', (_e, f) => { if (Array.isArray(f)) features = f.filter((x) => typeof x === 'string'); });
const WEB_OK = new Set(['claude:chats', 'claude:history', 'claude:send', 'claude:stop', 'claude:auth', 'claude:home', 'claude:usage', 'ai:list', 'ai:add', 'ai:remove',
  'scripts:list', 'scripts:read', 'scripts:write', 'scripts:delete', 'bridge:loader', 'bridge:state', 'bridge:send', 'workspace:get',
  'apps:list', 'apps:close', 'apps:front', 'apps:elev', 'apps:elev-state']);
const toWeb = (child, conn, msg) => { try { child.stdin.write(`to ${conn} ${JSON.stringify(msg)}
`); } catch {} };
async function webRpc(child, m) {
  const sender = { isDestroyed: () => child.exitCode !== null, send: (ch, ...a) => toWeb(child, m.c, { t: 'push', ch, a }) };
  let r, err;
  try {
    if (m.m === 'app:features') r = features;
    else if (m.m === 'monaco:ensure') r = await handlers.get('monaco:ensure')({ sender }).then((x) => (x && x.error ? x : { base: '/monaco/vs' }));
    else if (WEB_OK.has(m.m) && handlers.has(m.m)) r = await handlers.get(m.m)({ sender }, ...(Array.isArray(m.a) ? m.a : []));
    else err = 'not allowed';
  } catch (e) { err = e.message; }
  toWeb(child, m.c, { t: 'rpc', id: m.id, r, err });
}
claudeMain.addSink((ch, ...a) => { if (host && (ch === 'claude:changed' || ch === 'claude:usage')) toWeb(host, 0, { t: 'push', ch, a }); });
// ---- window list / elevation: questions for the Rust host (it owns the real windows) and the one-click admin restart
let elevOn = false;
ipcMain.handle('apps:elev-state', () => elevOn);
let appReq = 0; const appPending = new Map();
function askHost(msg, ms = 4000) {
  const h = host; if (!h) return Promise.resolve(null);
  const id = ++appReq;
  return new Promise((res) => {
    appPending.set(id, { res, t: setTimeout(() => { if (appPending.delete(id)) res(null); }, ms) });
    try { h.stdin.write(JSON.stringify({ t: 'apps', id, ...msg }) + '\n'); } catch { if (appPending.delete(id)) res(null); }
  });
}
ipcMain.handle('apps:list', () => askHost({ act: 'list' }));
ipcMain.handle('apps:close', (_e, hwnd) => askHost({ act: 'close', hwnd: +hwnd }));
ipcMain.handle('apps:front', (_e, hwnd, mon) => askHost({ act: 'front', hwnd: +hwnd, mon: Math.max(0, +mon || 0) }));
// relaunches Flux Control as administrator (fixes controlling admin apps) and quits this instance once the new one is up
ipcMain.handle('apps:elev', () => {
  if (process.argv.includes('--elev')) return { ok: false, err: 'Already running as administrator' };
  const parts = [...process.argv.slice(1), '--elev'].map((a) => `'${a.replace(/'/g, "''")}'`).join(',');
  spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath '${process.execPath.replace(/'/g, "''")}' -ArgumentList ${parts} -Verb RunAs`], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => { closing = true; app.quit(); }, 2500);
  return { ok: true };
});
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:cores', () => os.cpus().length);
ipcMain.handle('win:isFullscreen', () => !!win && win.isFullScreen());
// first private IPv4 of this PC, used for the Same Wi-Fi code
ipcMain.handle('net:lanIp', () => {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)) return i.address;
  }
  return null;
});
// only these pages can be opened from the UI
ipcMain.on('open', (_e, url) => { if (url === 'https://dashboard.ngrok.com/get-started/your-authtoken') shell.openExternal(url); });

// ---- sharing: the Rust host process (flux-host.exe) does capture, encoding and input
let host = null;
const hostExe = () => [process.env.FLUX_HOST, path.join(__dirname, '..', 'bin', 'flux-host.exe'), path.join(__dirname, '..', 'host', 'target', 'release', 'flux-host.exe')]
  .filter(Boolean).find((p) => fs.existsSync(p));
const METHODS = ['lan', 'upnp', 'cloudflare', 'localhostrun', 'ngrok'];

ipcMain.handle('host:start', (_e, cfg) => {
  if (host) return { ok: false, err: 'Already sharing' };
  const exe = hostExe();
  if (!exe) return { ok: false, err: 'The sharing component is missing. Run the Flux Control setup again.' };
  const clean = {
    port: Number.isInteger(cfg.port) && cfg.port > 1023 && cfg.port < 65536 ? cfg.port : 8080,
    quality: ['1080p60', '1080p30', '720p60', '720p30'].includes(cfg.quality) ? cfg.quality : '720p30',
    password: String(cfg.password || ''),
    ngrokToken: String(cfg.ngrokToken || ''),
    methods: (Array.isArray(cfg.methods) ? cfg.methods : []).filter((m) => METHODS.includes(m)),
    gpu: cfg.gpu !== false,
    cpu: cfg.cpu !== false,
    cpuPercent: Number.isInteger(cfg.cpuPercent) && cfg.cpuPercent >= 5 && cfg.cpuPercent <= 99 ? cfg.cpuPercent : null,
    cpuCores: Number.isInteger(cfg.cpuCores) && cfg.cpuCores >= 1 && cfg.cpuCores <= 64 ? cfg.cpuCores : null,
  };
  if (!clean.gpu && !clean.cpu) return { ok: false, err: 'Turn on the GPU or the CPU encoder' };
  if (!clean.password) return { ok: false, err: 'A password is required' };
  const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  host = child;
  child.stdin.write(JSON.stringify(clean) + '\n');
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    let m; try { m = JSON.parse(l); } catch { return; }
    if (m.t === 'rpc') return webRpc(child, m);
    // the host's answers to the window list / close / front commands, and the elevation warning push
    if (m.t === 'apps-res') {
      const p = appPending.get(m.id);
      if (p) { appPending.delete(m.id); clearTimeout(p.t); p.res(m); }
      return;
    }
    if (m.t === 'elev') { elevOn = !!m.on; toWeb(child, 0, { t: 'push', ch: 'apps:elev', a: [elevOn] }); }
    try { win && win.webContents.send('host:event', m); } catch {}
  });
  child.on('exit', () => { if (host === child) host = null; elevOn = false; win && !win.isDestroyed() && win.webContents.send('host:event', { t: 'exit' }); });
  return { ok: true };
});
ipcMain.handle('host:stop', () => {
  const h = host;
  if (h) { try { h.stdin.write('stop\n'); } catch {} setTimeout(() => h.kill(), 2000); }
  return true;
});
// ---- one-click fixes for a method that failed because a program is missing
const fluxHome = () => process.env.FLUX_HOME || path.join(process.env.LOCALAPPDATA || os.homedir(), 'FluxControl');
const FIXES = {
  cloudflared: { url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe', file: 'cloudflared.exe' },
  ngrok: { url: 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip', zip: true, file: 'ngrok.exe' },
  ffmpeg: { url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip', zip: true, nested: true, file: 'ffmpeg.exe' },
};
const emitFix = (m) => win && !win.isDestroyed() && win.webContents.send('host:event', { t: 'fix', ...m });

async function download(url, dest, onPct) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`download failed (${r.status})`);
  const total = +r.headers.get('content-length') || 0;
  const out = fs.createWriteStream(dest);
  let got = 0;
  for await (const chunk of r.body) { got += chunk.length; if (!out.write(chunk)) await new Promise((ok) => out.once('drain', ok)); if (total) onPct(Math.round((got / total) * 100)); }
  await new Promise((ok, bad) => out.end((e) => (e ? bad(e) : ok())));
}
const ps = (script, opts = {}) => new Promise((ok, bad) => {
  const c = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, ...opts });
  c.on('error', bad); c.on('exit', (code) => (code === 0 ? ok() : bad(new Error('exit ' + code))));
});

ipcMain.handle('host:fix', async (_e, { kind, method }) => {
  if (!['cloudflared', 'ngrok', 'openssh', 'ffmpeg'].includes(kind) || !(kind === 'ffmpeg' ? method === 'encoder' : METHODS.includes(method))) return { ok: false, err: 'unknown fix' };
  try {
    if (kind === 'openssh') {
      // Windows optional feature: needs administrator, so Windows shows its own permission prompt
      emitFix({ method, state: 'progress', label: 'Waiting for Windows permission…' });
      await ps("Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-Command','Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0'");
      if (!fs.existsSync('C:\\Windows\\System32\\OpenSSH\\ssh.exe')) throw new Error('OpenSSH was not installed');
    } else {
      const f = FIXES[kind], bin = path.join(fluxHome(), 'bin');
      fs.mkdirSync(bin, { recursive: true });
      const tmp = path.join(bin, f.zip ? kind + '.zip' : f.file + '.part');
      await download(f.url, tmp, (pct) => emitFix({ method, state: 'progress', label: `Downloading… ${pct}%` }));
      if (f.zip) {
        emitFix({ method, state: 'progress', label: 'Unpacking…' });
        if (f.nested) {   // the zip holds a versioned folder: keep only ffmpeg.exe
          const tmpDir = path.join(bin, 'unpack');
          await ps(`Expand-Archive -LiteralPath '${tmp}' -DestinationPath '${tmpDir}' -Force; Get-ChildItem '${tmpDir}' -Recurse -Filter ${f.file} | Select-Object -First 1 | Copy-Item -Destination '${path.join(bin, f.file)}' -Force`);
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } else await ps(`Expand-Archive -LiteralPath '${tmp}' -DestinationPath '${bin}' -Force`);
        fs.rmSync(tmp, { force: true });
      } else fs.renameSync(tmp, path.join(bin, f.file));
      if (!fs.existsSync(path.join(bin, f.file))) throw new Error('install did not produce ' + f.file);
    }
    emitFix({ method, state: 'done' });
    if (host && METHODS.includes(method)) host.stdin.write(`retry ${method}\n`);
    return { ok: true };
  } catch (e) {
    emitFix({ method, state: 'error', err: String(e.message || e), kind });
    return { ok: false, err: String(e.message || e) };
  }
});
ipcMain.handle('host:retry', (_e, method) => { if (host && METHODS.includes(method)) host.stdin.write(`retry ${method}\n`); return true; });
ipcMain.handle('host:running', () => !!host);
app.on('before-quit', () => { if (host) { try { host.stdin.end(); } catch {} host.kill(); } });

// ---- Executor page: scripts live as .lua files in the Flux folder; the editor (Monaco) is downloaded once and kept there
// the Executor works inside a folder the user chooses; it is remembered here
const wsFile = () => path.join(fluxHome(), 'workspace.txt');
const readWs = () => { try { const p = fs.readFileSync(wsFile(), 'utf8').trim(); return p && fs.statSync(p).isDirectory() ? p : null; } catch { return null; } };
ipcMain.handle('workspace:get', () => readWs());
ipcMain.handle('workspace:pick', async () => {
  let dir = process.env.FLUX_WS_TEST;   // test hook: skips the dialog
  if (!dir) { const r = await dialog.showOpenDialog(win, { title: 'Choose your workspace folder', properties: ['openDirectory', 'createDirectory'] }); dir = r.canceled ? null : r.filePaths[0]; }
  if (!dir) return null;
  fs.mkdirSync(fluxHome(), { recursive: true }); fs.writeFileSync(wsFile(), dir);
  return dir;
});
// ---- bridge to the user's executor: HubRunner.lua (run once inside the executor) watches <workspace>/HubRunner for run.lua + run.id
const bridgeDir = () => { const w = readWs(); return w ? path.join(w, 'HubRunner') : null; };
require('./mcp').init(bridgeDir);   // Executor AI mode tools use the same bridge
const readIn = (n) => { try { return fs.readFileSync(path.join(bridgeDir(), n), 'utf8'); } catch { return null; } };
ipcMain.handle('bridge:loader', () => fs.readFileSync(path.join(__dirname, 'hubrunner.lua'), 'utf8'));
ipcMain.handle('bridge:state', () => {
  if (!bridgeDir()) return { connected: false };
  const alive = +readIn('alive.txt') || 0;
  let status = null; try { status = JSON.parse(readIn('status.json')); } catch {}
  return { connected: Date.now() / 1000 - alive < 5, status };   // alive.txt is rewritten every second by HubRunner
});
ipcMain.handle('bridge:send', (_e, code) => {
  const d = bridgeDir();
  if (!d || typeof code !== 'string' || !code.trim() || code.length > 2_000_000) return null;
  fs.mkdirSync(d, { recursive: true });
  const id = String(Date.now());
  const put = (n, t) => { fs.writeFileSync(path.join(d, n + '.tmp'), t); fs.renameSync(path.join(d, n + '.tmp'), path.join(d, n)); };   // never a half-written file
  put('run.lua', code); put('run.id', id);                                                                                        // run.id last: it is the trigger
  return id;
});
const scriptsDir = () => readWs() || path.join(fluxHome(), 'scripts');
const okName = (n) => typeof n === 'string' && /^[\w][\w .-]{0,58}\.lua$/.test(n);
ipcMain.handle('scripts:list', () => { fs.mkdirSync(scriptsDir(), { recursive: true }); return fs.readdirSync(scriptsDir()).filter(okName).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })); });
ipcMain.handle('scripts:read', (_e, n) => (okName(n) ? fs.readFileSync(path.join(scriptsDir(), n), 'utf8') : null));
ipcMain.handle('scripts:write', (_e, n, t) => {
  if (!okName(n) || typeof t !== 'string' || t.length > 2_000_000) return false;
  fs.mkdirSync(scriptsDir(), { recursive: true }); fs.writeFileSync(path.join(scriptsDir(), n), t); return true;
});
ipcMain.handle('scripts:delete', (_e, n) => { if (okName(n)) fs.rmSync(path.join(scriptsDir(), n), { force: true }); return true; });

const MONACO = { url: 'https://registry.npmjs.org/monaco-editor/-/monaco-editor-0.52.2.tgz', sha1: '53c75a6fcc6802684e99fd1b2700299857002205' };
ipcMain.handle('monaco:ensure', async () => {
  const vendor = path.join(fluxHome(), 'vendor', 'monaco'), vs = path.join(vendor, 'vs');
  const done = () => ({ base: require('url').pathToFileURL(vs).href });
  if (fs.existsSync(path.join(vs, 'loader.js'))) return done();
  try {
    fs.mkdirSync(vendor, { recursive: true });
    const tgz = path.join(vendor, 'monaco.tgz'), tmp = path.join(vendor, 'unpack');
    await download(MONACO.url, tgz, () => {});
    if (require('crypto').createHash('sha1').update(fs.readFileSync(tgz)).digest('hex') !== MONACO.sha1) throw new Error('the editor download did not match its checksum');
    fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp);
    await new Promise((ok, bad) => require('child_process').execFile('C:\\Windows\\System32\\tar.exe', ['-xzf', tgz, '-C', tmp, 'package/min/vs'], (e) => (e ? bad(e) : ok())));
    fs.rmSync(vs, { recursive: true, force: true });
    fs.renameSync(path.join(tmp, 'package', 'min', 'vs'), vs);
    // keep only what a Lua editor needs
    fs.rmSync(path.join(vs, 'language'), { recursive: true, force: true });
    const bl = path.join(vs, 'basic-languages');
    for (const d of fs.readdirSync(bl)) if (d !== 'lua' && fs.statSync(path.join(bl, d)).isDirectory()) fs.rmSync(path.join(bl, d), { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(tgz, { force: true });
    return done();
  } catch (e) { return { error: 'Could not get the editor: ' + (e.message || e) }; }
});

app.on('window-all-closed', () => app.quit());
