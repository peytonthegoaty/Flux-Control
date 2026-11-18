// Flux Control PC client renderer.
const $ = (s, r = document) => r.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = $('#app');

// window API from preload.js; plain-browser fallback so the UI can be previewed
const winApi = window.flux || {
  min() {}, quit() {}, copy: async (t) => { try { await navigator.clipboard.writeText(t); return true; } catch { return false; } }, lanIp: async () => '192.168.1.24', open() {},
  toggleFullscreen() { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); },
  onFullscreen(cb) { document.addEventListener('fullscreenchange', () => cb(!!document.fullscreenElement)); },
};

document.addEventListener('contextmenu', (e) => e.preventDefault());
document.querySelectorAll('.fx-field').forEach(fx.field);

// ---------------------------------------------------------------- icons
const ICON_EXPAND = '<svg class="swap" viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
const ICON_COMPRESS = '<svg class="swap" viewBox="0 0 24 24"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>';
const fsBtn = $('#btnFs');
fsBtn.innerHTML = ICON_EXPAND;

// ---------------------------------------------------------------- screens
let current = null, wasWide = false;
function show(id) {
  const prev = current && $('#' + current);
  const next = $('#' + id);
  if (prev) { prev.classList.remove('active'); prev.classList.add('out'); }
  next.classList.remove('out');
  requestAnimationFrame(() => requestAnimationFrame(() => current === id && next.classList.add('active')));
  current = id;
  app.classList.toggle('in-session', id === 'session');
  if (typeof setNav === 'function') setNav(id);
  if (id === 'executor') Executor.open();
  if (id === 'claude') Claude.open();
  const wide = id === 'executor' || id === 'claude';
  if (wide !== wasWide) { wasWide = wide; winApi.fit && winApi.fit(wide ? { w: id === 'executor' && Executor.wide() ? 1760 : 1340, h: 840 } : null); }
  if (id !== 'session') $('#hostName').textContent = 'Not connected';
  else pillCtl.peek(3200);   // shown for a moment so you know where it is, then it folds into the circle
}
fx.popover($('#chipWrap'), $('#chip'));
const pillCtl = fx.pill($('#top'), $('#pillF'), () => $('#chipWrap').classList.contains('open') || $('#setWrap').classList.contains('open') || $('#monWrap').classList.contains('open'));

// ---------------------------------------------------------------- top bar: fullscreen
winApi.onFullscreen((on) => {
  app.classList.toggle('fs', on);
  fsBtn.innerHTML = on ? ICON_COMPRESS : ICON_EXPAND;   // exit icon while fullscreen
  fsBtn.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen');
});
fsBtn.onclick = () => winApi.toggleFullscreen();
fx.popover($('#setWrap'), $('#btnSettings'));
Hud.init();

// closing always asks first
const closeFlow = async () => {
  const inSession = current === 'session';
  const ok = await fx.ask({
    title: 'Are you sure?',
    text: sharing ? 'This closes Flux Control and stops sharing this PC.' : inSession ? 'This closes Flux Control and ends your session.' : 'This closes Flux Control.',
    ok: 'Close', cancel: 'Stay',
  });
  if (ok) winApi.quit();
};
if (winApi.onCloseRequest) winApi.onCloseRequest(closeFlow);   // Windows' close button
$('#btnDisc').onclick = async () => {
  if (await fx.ask({ title: 'Are you sure?', text: 'You will be disconnected from this PC.', ok: 'Disconnect', cancel: 'Stay' })) endSession();
};

// ---------------------------------------------------------------- sidebar
const NAVMAP = { connect: 'connect', share: 'share', sharing: 'share', settings: 'settings', executor: 'executor', claude: 'claude' };
function setNav(id) {
  const page = NAVMAP[id], ind = $('#sideInd');
  let on = null;
  document.querySelectorAll('.navbtn').forEach((b) => { const a = b.dataset.page === page; b.classList.toggle('active', a); if (a) on = b; });
  if (on) { ind.style.transform = `translateY(${on.offsetTop}px)`; ind.style.opacity = 1; } else ind.style.opacity = 0;
}
function go(id) {
  if (id === 'share') { if (sharing) id = 'sharing'; else initShare(); }
  if (id === 'executor' && !Features.has('roblox-executor')) id = 'connect';
  if (id === 'claude' && !Features.has('claude')) id = 'connect';
  show(id);
}
document.querySelectorAll('.navbtn').forEach((b) => (b.onclick = () => go(b.dataset.page)));
function syncNav() {
  $('#navExecutor').hidden = !Features.has('roblox-executor');
  $('#navClaude').hidden = !Features.has('claude');
  if (winApi.reportFeatures) winApi.reportFeatures(Features.list().map((f) => f.id));   // web clients show the Executor when it is unlocked here
  if ((current === 'executor' && $('#navExecutor').hidden) || (current === 'claude' && $('#navClaude').hidden)) go('connect'); else setNav(current);
}
Features.onChange(syncNav);

// ---------------------------------------------------------------- share setup
const PORT = 8080;
const WHO = [
  { id: 'web', icon: 'globe', title: 'A web browser', desc: 'You get links. Open one on any device to see and control this PC.' },
  { id: 'client', icon: 'monitor', title: 'Another computer', desc: 'People with the Flux Control app connect using a code.' },
];
// which client each way of reaching you works with: 'both' | 'pc' | 'web'
const METHODS = [
  { id: 'lan', icon: 'wifi', title: 'Same Wi-Fi', compat: 'both', desc: 'Free. For devices on your home network.' },
  { id: 'upnp', icon: 'upnp', title: 'Public link (UPnP)', compat: 'both', desc: 'Free. Opens a port on your router. The router must allow it.' },
  { id: 'cloudflare', icon: 'cloud', title: 'Cloudflare tunnel', compat: 'both', desc: 'Free, no account. Works anywhere, no router setup. Needs cloudflared installed.' },
  { id: 'localhostrun', icon: 'terminal', title: 'localhost.run tunnel', compat: 'both', desc: 'Free, no account. Uses the SSH already in Windows.' },
  { id: 'ngrok', icon: 'bolt', title: 'ngrok tunnel', compat: 'pc', desc: 'Free, needs a token. Browsers get an ngrok warning page first, so it suits the PC client.' },
];
const COMPAT = { both: 'PC client + Web', pc: 'PC client only', web: 'Web only' };
const works = (m, who) => who.some((w) => (w === 'client' ? m.compat !== 'web' : m.compat !== 'pc'));

const share = (() => { try { return JSON.parse(localStorage.getItem('fluxShare')) || {}; } catch { return {}; } })();
share.who = share.who || []; share.methods = share.methods || ['lan']; share.token = share.token || ''; share.password = share.password || ''; share.quality = share.quality || '720p30';
const hadLimit = !!share.limitVal;
if (share.gpu === undefined) share.gpu = true;
if (share.cpu === undefined) share.cpu = true;
share.limitMode = share.limitMode || 'percent'; share.limitVal = share.limitVal || 60;
let lanIp = null, sharing = false;
document.querySelectorAll('#share .fx-field').forEach(fx.field);
document.querySelectorAll('[data-scroll]').forEach(fx.scroll);
$('#shareQuality').dataset.value = share.quality;
const qualitySel = fx.select($('#shareQuality'), (v) => { share.quality = v; persist(); });
const persist = () => { try { localStorage.setItem('fluxShare', JSON.stringify({ ...share, password: '', token: share.token })); } catch {} };

const sampleCode = (id) => {
  const pw = true;
  if (id === 'lan') return FluxCode.encode({ method: 'lan', host: lanIp || '192.168.1.24', port: PORT, password: pw });
  if (id === 'upnp') return FluxCode.encode({ method: 'upnp', host: '203.0.113.7', port: PORT, password: pw });
  if (id === 'ngrok') return FluxCode.encode({ method: 'ngrok', host: 'quiet-river-4821.ngrok-free.dev', password: pw });
  if (id === 'localhostrun') return FluxCode.encode({ method: 'localhostrun', host: 'b05d89fbd124ac.app.lhr.life', password: pw });
  return FluxCode.encode({ method: id, host: 'quiet-river-4821', password: pw });
};

const usableMethods = () => (share.who.length ? share.methods.filter((id) => works(METHODS.find((m) => m.id === id), share.who)) : []);
function drawMethods() {
  const usable = usableMethods();
  const wantsCode = share.who.includes('client');
  fx.cards($('#linkCards'), METHODS.map((m) => ({
    id: m.id, icon: m.icon, title: m.title, desc: m.desc,
    badge: COMPAT[m.compat], badgeKind: m.compat === 'both' ? 'both' : '',
    disabled: !works(m, share.who),
    url: wantsCode ? 'e.g. ' + sampleCode(m.id) : '',
  })), { multi: true, selected: usable, onchange: (s) => { share.methods = s; syncShare(); } });
}
// ---- encoder: GPU / CPU toggles and a CPU limit (a percentage of the whole PC, or a number of cores)
let cores = 8;
const recommended = () => ({ gpu: true, cpu: true, limitMode: 'percent', limitVal: cores >= 16 ? 40 : cores >= 8 ? 60 : 75 });
function drawLimit() {
  const pct = share.limitMode === 'percent';
  share.limitVal = Math.min(Math.max(share.limitVal, pct ? 10 : 1), pct ? 100 : cores);
  const el = fx.el('div', 'fx-slider');
  Object.assign(el.dataset, { min: pct ? 10 : 1, max: pct ? 100 : cores, step: pct ? 5 : 1, value: share.limitVal, suffix: pct ? '%' : ' cores', label: pct ? 'Most of the PC the encoder may use' : 'Cores the encoder may use' });
  $('#limitSlot').replaceChildren(el);
  fx.slider(el, (v) => { share.limitVal = v; persist(); });
  document.querySelectorAll('#limitMode button').forEach((b) => b.classList.toggle('on', b.dataset.m === share.limitMode));
  $('#encNote').textContent = `Recommended for this PC (${cores} threads): GPU first with the CPU as backup, CPU limited to ${recommended().limitVal}%.`;
}
function drawEncoder() {
  $('#encGpu').classList.toggle('on', share.gpu); $('#encCpu').classList.toggle('on', share.cpu);
  drawLimit();
}
fx.toggle($('#encGpu'), (v) => { share.gpu = v; persist(); syncShare(); });
fx.toggle($('#encCpu'), (v) => { share.cpu = v; persist(); syncShare(); });
document.querySelectorAll('#limitMode button').forEach((b) => (b.onclick = () => { share.limitMode = b.dataset.m; share.limitVal = b.dataset.m === 'percent' ? recommended().limitVal : Math.max(1, Math.round(cores / 3)); persist(); drawLimit(); }));
$('#encRec').onclick = () => { Object.assign(share, recommended()); persist(); drawEncoder(); syncShare(); fx.toast('Recommended settings applied'); };
winApi.cores && winApi.cores().then((n) => { cores = n; if (!hadLimit) share.limitVal = recommended().limitVal; drawLimit(); });

function syncShare() {
  const any = share.who.length > 0;
  $('#reachBox').classList.toggle('open', any);
  $('#webNote').classList.toggle('open', share.who.includes('web'));
  $('#tokenBox').classList.toggle('open', any && usableMethods().includes('ngrok'));
  const um = usableMethods();
  const ok = any && um.length && share.password && (share.gpu || share.cpu) && (!um.includes('ngrok') || share.token);
  $('#startShare').classList.toggle('off', !ok);
}
async function initShare() {
  try { lanIp = await winApi.lanIp(); } catch { lanIp = null; }
  $('#token').value = share.token; $('#spw').value = share.password;
  fx.cards($('#shareWho'), WHO, { multi: true, selected: share.who, onchange: (s) => { share.who = s; drawMethods(); syncShare(); persist(); } });
  drawMethods(); drawEncoder(); syncShare();
}
$('#token').addEventListener('input', (e) => { share.token = e.target.value.trim(); syncShare(); persist(); });
$('#spw').addEventListener('input', (e) => { share.password = e.target.value; syncShare(); });
$('#getToken').onclick = () => winApi.open('https://dashboard.ngrok.com/get-started/your-authtoken');

// ---------------------------------------------------------------- sharing (talks to flux-host.exe through the main process)
const ICO_OK = '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>';
const ICO_NO = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const rows = $('#shRows');
const row = (id) => rows.querySelector(`[data-m="${id}"]`);

function codeFor(ev) {
  const host = ev.method === 'cloudflare' ? ev.label : ev.host;   // cloudflare stores the label; the other tunnels store the full host
  return FluxCode.encode({ method: ev.method, host, port: ev.port, password: true });
}
function copyBtn(text) {
  const b = fx.el('button', 'btn', 'Copy');
  b.onclick = async () => fx.toast((await winApi.copy(text)) ? 'Copied' : 'Copy failed');
  return b;
}
function line(label, text) {
  const r = fx.el('div', 'coderow', `<span class="lbl2">${label}</span><code></code>`);
  r.querySelector('code').textContent = text;
  r.appendChild(copyBtn(text));
  return r;
}

function buildRows(ids) {
  rows.innerHTML = '';
  ids.forEach((id) => {
    const m = METHODS.find((x) => x.id === id);
    const r = fx.el('div', 'dep show', `<div class="ico spin">${ICO_OK}</div><div class="grow"><div class="nm">${m.title} <span class="badge ${m.compat === 'both' ? 'both' : ''}" style="margin:0 0 0 6px">${COMPAT[m.compat]}</span></div><div class="dt">Starting…</div><div class="out"></div></div>`);
    r.dataset.m = id;
    rows.appendChild(r);
  });
}

const sh = {};
function paintSub() {
  $('#shSub').textContent = `${sh.line}. Encoder: ${String(sh.enc).replace('h264_nvenc', 'NVIDIA GPU').replace('h264_amf', 'AMD GPU').replace('h264_qsv', 'Intel GPU')}. Sending ${sh.sent ?? '-'} fps. ${sh.who}`;
}

function setStarting(r, text) {
  const ico = $('.ico', r); ico.classList.remove('ok', 'no'); ico.classList.add('spin'); ico.innerHTML = ICO_OK;
  $('.dt', r).textContent = text; $('.out', r).innerHTML = '';
}

function onHost(ev) {
  if (ev.t === 'fix') {
    const r = row(ev.method); if (!r) return;
    if (ev.state === 'progress') { if (!$('.ico', r).classList.contains('spin')) setStarting(r, ev.label); else $('.dt', r).textContent = ev.label; }
    if (ev.state === 'done') $('.dt', r).textContent = 'Installed. Starting…';
    if (ev.state === 'error') onHost({ t: 'error', method: ev.method, err: 'Install failed: ' + ev.err, fix: ev.kind || 'retry' });
    return;
  }
  if (ev.t === 'started') {
    $('#shTitle').textContent = 'Sharing this PC';
    sh.enc = ev.encoder; sh.line = `${ev.w}×${ev.h} at up to ${ev.fps} fps`; sh.who = 'Nobody is connected yet.'; paintSub();
  } else if (ev.t === 'stats') {
    sh.sent = ev.fps; paintSub();
  } else if (ev.t === 'viewers') {
    sh.who = ev.n ? `${ev.n} ${ev.n === 1 ? 'person is' : 'people are'} connected.` : 'Nobody is connected yet.'; paintSub();
  } else if (ev.t === 'ready' || ev.t === 'error') {
    const r = row(ev.method); if (!r) return;
    const ico = $('.ico', r); ico.classList.remove('spin');
    if (ev.t === 'error') {
      ico.classList.add('no'); ico.innerHTML = ICO_NO; $('.dt', r).textContent = ev.err;
      const out = $('.out', r); out.innerHTML = '';
      const label = { cloudflared: 'Install cloudflared', openssh: 'Install OpenSSH', ngrok: 'Install ngrok', retry: 'Try again' }[ev.fix];
      if (label) {
        const b = fx.el('button', 'btn', label);
        b.style.marginTop = '10px';
        b.onclick = () => {
          if (ev.fix === 'retry') { setStarting(r, 'Trying again…'); winApi.hostRetry(ev.method); } else winApi.hostFix(ev.fix, ev.method);
        };
        out.appendChild(b);
      }
      return;
    }
    ico.classList.add('ok'); $('.dt', r).textContent = 'Ready';
    const out = $('.out', r); out.innerHTML = '';
    if (share.who.includes('client')) out.appendChild(line('Code', codeFor(ev)));
    if (share.who.includes('web') && ev.method !== 'ngrok') out.appendChild(line('Link', ev.url));
    if (ev.method === 'upnp' && share.who.includes('client')) {
      out.appendChild(fx.el('div', 'shnote', 'The code contains your public IP address in encoded form. Only give it to people you trust.'));
    }
    if (share.who.includes('web')) out.appendChild(fx.el('div', 'shnote', 'Open the link in any browser and enter the password.'));
  } else if (ev.t === 'notice') {
    fx.toast(ev.msg);
  } else if (ev.t === 'elev') {
    if (ev.on) fx.toast('The focused app runs as administrator — Windows blocks control of it. Restart Flux Control as admin to fix it.');
  } else if (ev.t === 'fatal') {
    stopped();
    if (ev.fix === 'ffmpeg') offerFfmpeg(); else fx.toast(ev.err);
  } else if (ev.t === 'exit') {
    if (sharing) { fx.toast('Sharing stopped'); stopped(); }
  }
}
winApi.onHost && winApi.onHost(onHost);

async function offerFfmpeg() {
  if (!(await fx.ask({ title: 'Install ffmpeg?', text: 'GPU encoding uses ffmpeg. It is a one-time download of about 115 MB. Start sharing again once it is installed.', ok: 'Install', cancel: 'Not now' }))) return;
  fx.toast('Installing ffmpeg…');
  const r = await winApi.hostFix('ffmpeg', 'encoder');
  fx.toast(r.ok ? 'ffmpeg installed. Start sharing again.' : 'Install failed: ' + r.err);
}

function stopped() {
  sharing = false;
  go('share');
}

$('#startShare').onclick = async () => {
  if ($('#startShare').classList.contains('off')) return;
  const ids = usableMethods();
  persist();
  buildRows(ids);
  $('#shTitle').textContent = 'Starting…'; $('#shSub').textContent = 'Setting things up.';
  const r = await winApi.hostStart({
    port: PORT, quality: share.quality, password: share.password, ngrokToken: share.token, methods: ids,
    gpu: share.gpu, cpu: share.cpu,
    cpuPercent: share.limitMode === 'percent' && share.limitVal < 100 ? share.limitVal : null,
    cpuCores: share.limitMode === 'cores' ? share.limitVal : null,
  });
  if (!r.ok) { fx.toast(r.err); return; }
  sharing = true;
  show('sharing');
};
$('#stopShare').onclick = async () => {
  if (await fx.ask({ title: 'Stop sharing?', text: 'Everyone connected will be disconnected.', ok: 'Stop sharing', cancel: 'Keep sharing' })) {
    sharing = false;
    await winApi.hostStop();
    go('share');
  }
};
// ---- updates: installed without asking; a session you are watching finishes first
let updateWaiting = false, manualUpdate = false;
const updBtn = $('#checkUpdateBtn'), updStatus = $('#updStatus');
const setUpd = (text, off) => { if (updStatus) updStatus.textContent = text || ''; if (updBtn) updBtn.classList.toggle('off', !!off); };
const applyUpdate = (msg) => { fx.toast(msg || 'Updating Flux Control…'); setTimeout(() => winApi.applyUpdate && winApi.applyUpdate(), 800); };
if (winApi.onUpdate) {
  winApi.onUpdate((v) => {
    if (manualUpdate) { manualUpdate = false; setUpd('Updating to v' + v + '…', true); return applyUpdate('Update found (v' + v + '). Restarting to update…'); }
    if (current === 'session') { if (!updateWaiting) fx.toast(`Version ${v} is ready. It installs when you disconnect.`); updateWaiting = true; }
    else applyUpdate();
  });
  winApi.onUpdateFailed((m) => { manualUpdate = false; setUpd('Update failed', false); fx.toast('Update failed: ' + m); });
  if (winApi.onUpdateStatus) winApi.onUpdateStatus((s) => {
    if (!s) return;
    if (s.state === 'checking') setUpd('Checking for updates…', true);
    else if (s.state === 'downloading') setUpd('Downloading v' + s.version + '…', true);
    else if (s.state === 'ready') setUpd('Update v' + s.version + ' ready', true);
    else if (s.state === 'upToDate') { manualUpdate = false; setUpd('Up to date (v' + s.version + ')', false); fx.toast('Flux Control is up to date'); }
    else if (s.state === 'error') { manualUpdate = false; setUpd('Check failed', false); }
    else if (s.state === 'unavailable') { manualUpdate = false; setUpd('Updates unavailable in this install', false); }
  });
}
if (updBtn) updBtn.onclick = async () => {
  if (updBtn.classList.contains('off') || !winApi.checkUpdate) return;
  manualUpdate = true; setUpd('Checking for updates…', true);
  try {
    const r = await winApi.checkUpdate();
    if (r && r.state === 'ready') { setUpd('Updating to v' + r.version + '…', true); applyUpdate('Update found (v' + r.version + '). Restarting to update…'); }
    else if (r && r.state === 'upToDate') { manualUpdate = false; setUpd('Up to date (v' + r.version + ')', false); fx.toast('Flux Control is up to date'); }
    else if (r && r.state === 'error') { manualUpdate = false; setUpd('Check failed', false); fx.toast('Update check failed: ' + r.err); }
    else if (r && r.state === 'unavailable') { manualUpdate = false; setUpd('Updates unavailable in this install', false); fx.toast('This copy cannot self-update from here'); }
    else if (r && r.state === 'checking') { /* wait for status/ready events */ }
    else { manualUpdate = false; setUpd('', false); }
  } catch (e) { manualUpdate = false; setUpd('Check failed', false); fx.toast('Update check failed: ' + e.message); }
};
// after an update restart: share again with the same settings and password
if (winApi.resume) winApi.resume().then(async (cfg) => {
  if (!cfg) return;
  const r = await winApi.hostStart(cfg);
  if (!r.ok) return fx.toast('Could not share again after the update: ' + r.err);
  buildRows(cfg.methods); sharing = true; show('sharing'); fx.toast('Updated. Sharing again.');
});
// if the app was reloaded while the host kept running
winApi.hostRunning && winApi.hostRunning().then((on) => { if (on) { sharing = true; } });

// ---------------------------------------------------------------- connect screen
const codeIn = $('#code'), pwIn = $('#pw'), btn = $('#btnConnect');
let parsed = null, demo = false;

function updateCode() {
  const raw = codeIn.value.trim();
  demo = raw.toUpperCase() === 'DEMO';
  parsed = demo ? null : FluxCode.decode(raw);
  const chip = $('#dchip');
  const show_ = raw.length > 0;
  $('#decoded').classList.toggle('open', show_);
  chip.classList.toggle('ok', demo || !!(parsed && parsed.ok));
  if (demo) $('#dtext').textContent = 'Preview mode, no PC needed';
  else if (parsed && parsed.ok) $('#dtext').textContent = `${parsed.name} · ${new URL(parsed.url).host}`;
  else if (show_) $('#dtext').textContent = parsed && parsed.error && raw.length > 12 ? parsed.error : 'Keep typing…';
  $('#pwBox').classList.toggle('open', !!(parsed && parsed.ok && parsed.password));
  syncBtn();
}
function syncBtn() {
  const ok = demo || (parsed && parsed.ok && (!parsed.password || pwIn.value.length > 0));
  btn.classList.toggle('off', !ok);
}
codeIn.addEventListener('input', updateCode);
pwIn.addEventListener('input', syncBtn);
[codeIn, pwIn].forEach((i) => i.addEventListener('keydown', (e) => e.key === 'Enter' && btn.onclick()));

btn.onclick = async () => {
  if (btn.classList.contains('off') || btn.dataset.busy) return;
  btn.dataset.busy = '1'; btn.textContent = 'Connecting…'; btn.classList.add('off');
  try {
    if (demo) return startSession({ host: 'Preview PC', via: 'Preview', demo: true });
    await Viewer.open({
      url: parsed.url, password: pwIn.value, stage: $('#stage'), video: $('#remote'),
      onCursor: setRemoteCursor,
      onLock: Hud.setLock,
      onScreen: Hud.setScreen,
      autoLock: Hud.auto,
      onLive: () => $('#stage').classList.add('live'),
      onClose: () => { fx.toast('Connection lost'); endSession(); },
    });
    startSession({ host: new URL(parsed.url).host, via: parsed.name });
  } catch (e) {
    fx.toast(e.message);
  } finally { delete btn.dataset.busy; btn.textContent = 'Connect'; syncBtn(); }
};

// ---------------------------------------------------------------- session
// The local pointer is always the real OS cursor, so movement has zero lag. Only its SHAPE follows the
// remote PC (text caret, hand, resize...), and that update may arrive late. We never draw a fake cursor.
const stage = $('#stage');
let hinted = false;
function setRemoteCursor(name) {
  const n = Viewer.shape(name);
  if (n === 'none' && !hinted && Viewer.active() && !Viewer.locked()) { hinted = true; fx.toast(Hud.auto() ? 'This game hides its cursor. Click the screen to capture the mouse.' : 'This game hides its cursor. Turn on Mouse lock in the gear menu.'); }
  stage.style.cursor = n === 'none' ? 'default' : n;   // the pointer only disappears in mouse lock (pointer lock hides it)
  $('#cursorHint').textContent = demo ? `remote cursor: ${n}` : '';
}
window.FluxClient = { setRemoteCursor };

let demoTimer;
function startSession({ host, via, demo: isDemo }) {
  $('#hostName').textContent = host;
  $('#mhName').textContent = host;
  $('#viaChip').textContent = via;
  stage.classList.remove('live');
  $('#stageTitle').textContent = isDemo ? 'Preview session' : 'Connected. Waiting for the first frame…';
  $('#stageTitle').classList.toggle('shimmer', !isDemo);
  $('#stageSub').textContent = isDemo ? 'Move your pointer over this area. Its shape follows the (simulated) remote cursor.' : '';
  show('session');
  setRemoteCursor('default');
  if (isDemo) {
    const seq = ['default', 'pointer', 'text', 'crosshair', 'ew-resize', 'grab', 'not-allowed', 'wait'];
    let i = 0; clearInterval(demoTimer);
    demoTimer = setInterval(() => setRemoteCursor(seq[++i % seq.length]), 1800);
  }
}
function endSession() {
  clearInterval(demoTimer);
  hinted = false; Hud.setLock(false); Hud.setScreen({ mons: [] });
  Viewer.close();
  stage.classList.remove('live'); stage.style.cursor = '';
  show('connect');
  codeIn.value = ''; pwIn.value = ''; updateCode();
  if (updateWaiting) applyUpdate();
}

syncNav();
show('connect');

// ---------------------------------------------------------------- settings: dev codes
const codeRows = $('#codeRows'), devCode = $('#devCode'), addCode = $('#addCode');
function drawCodes() {
  const list = Features.list();
  codeRows.innerHTML = '';
  $('#codesEmpty').classList.toggle('open', !list.length);
  list.forEach((f) => {
    const r = fx.el('div', 'dep show', `<div class="ico ok"><svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg></div><div class="grow"><div class="nm"></div><div class="dt"></div></div>`);
    $('.nm', r).textContent = f.name; $('.dt', r).textContent = f.desc;
    const rm = fx.el('button', 'btn small', 'Remove');
    rm.style.margin = '0';
    rm.onclick = async () => {
      if (await fx.ask({ title: 'Remove this code?', text: `"${f.name}" will be turned off.`, ok: 'Remove', cancel: 'Keep' })) Features.remove(f.hash);
    };
    r.appendChild(rm);
    codeRows.appendChild(r);
  });
}
Features.onChange(drawCodes);
document.querySelectorAll('#settings .fx-field').forEach(fx.field);
devCode.addEventListener('input', () => addCode.classList.toggle('off', !devCode.value.trim()));
devCode.addEventListener('keydown', (e) => e.key === 'Enter' && addCode.onclick());
addCode.onclick = async () => {
  if (addCode.classList.contains('off')) return;
  const r = await Features.add(devCode.value);
  if (!r.ok) return fx.toast(r.err);
  devCode.value = ''; addCode.classList.add('off');
  fx.toast(`Added: ${r.feature.name}`);
};
drawCodes();
winApi.version && winApi.version().then((v) => { $('#verText').textContent = 'v' + v; });
