// Flux Control setup wizard. Talks to the Rust shell through window.ipc; falls back to a mock in a plain browser.
const $ = (s, r = document) => r.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- bridge
const bridge = (() => {
  const subs = [];
  window.__flux = (m) => subs.forEach((f) => f(m));
  const emit = (m) => window.__flux(m);
  const real = !!window.ipc;

  async function mock(t, p) {
    if (t === 'check') {
      await sleep(500);
      emit({ t: 'dep', id: 'webview2', state: 'found', detail: 'Evergreen 131' });
      emit({ t: 'dep', id: 'node', state: 'found', detail: 'v22.11.0' });
      emit({ t: 'dep', id: 'electron', state: 'missing', detail: '~110 MB download' });
      emit({ t: 'dep', id: 'ffmpeg', state: 'missing', detail: '~115 MB' });
      emit({ t: 'dep', id: 'app', state: 'missing', detail: '~1 MB' });
      emit({ t: 'checked' });
    } else if (t === 'install') {
      for (const id of p.ids) {
        for (let i = 0; i <= 100; i += 4) { emit({ t: 'progress', id, pct: i, label: `Downloading… ${i}%` }); await sleep(45); }
        emit({ t: 'installed', id, ok: true });
      }
      emit({ t: 'install_done' });
    } else if (t === 'status') {
      const st = new URLSearchParams(location.search).get('state'); // ?state=ready | update | (none = first install)
      await sleep(900);
      emit({ t: 'status', hasInstall: !!st, missing: st === 'missing' ? ['ffmpeg'] : [], version: st ? '0.2.0' : null, latest: st === 'update' ? '0.3.0' : null, update: st === 'update', offline: false, embedded: '0.3.0', autolaunch: false });
    } else if (t === 'update') {
      for (let i = 0; i <= 100; i += 5) { emit({ t: 'progress', id: 'update', pct: i, label: `Downloading… ${i}%` }); await sleep(60); }
      emit({ t: 'updated', ok: true, version: '0.3.0' });
    } else if (t === 'launch') fx.toast('Launch (preview mode)');
  }

  return {
    on: (f) => subs.push(f),
    send: (t, p = {}) => (real ? window.ipc.postMessage(JSON.stringify({ t, ...p })) : mock(t, p)),
  };
})();

// ---------------------------------------------------------------- state
const DEPS = {
  webview2: { name: 'WebView2 Runtime', sub: 'Draws the setup window' },
  node: { name: 'Node.js', sub: 'Runs the Flux Control tooling' },
  electron: { name: 'Electron', sub: 'The desktop shell for the app' },
  ffmpeg: { name: 'ffmpeg', sub: 'GPU video encoding (optional)' },
  app: { name: 'Flux Control core', sub: 'App files and services' },
};
let missing = [];
let deferred = false;
let current = null;
const stack = [];

const GROUP = { start: -1, ready: -1, update: -1, updating: -1, welcome: 0, deps: 1, missing: 1, install: 1, done: 2 };

// ---------------------------------------------------------------- controls
document.querySelectorAll('[data-scroll]').forEach(fx.scroll);
document.querySelectorAll('.fx-field').forEach(fx.field);
document.addEventListener('contextmenu', (e) => e.preventDefault());

// welcome: letters cascade in, then the description follows once the title is done
(function hero() {
  const h = $('#hero'); let i = 0;
  const walk = (n) => [...n.childNodes].forEach((c) => {
    if (c.nodeType === 3) {
      const f = document.createDocumentFragment();
      for (const ch of c.textContent) {
        const sp = fx.el('span', 'ch', ch === ' ' ? '&nbsp;' : ch);
        sp.style.transitionDelay = 0.25 + i++ * 0.05 + 's';
        f.appendChild(sp);
      }
      c.replaceWith(f);
    }
  });
  walk(h);
  $('#heroSub').style.transitionDelay = 0.25 + i * 0.05 + 0.5 + 's';
})();

// ---------------------------------------------------------------- window chrome
$('#bclose').onclick = () => bridge.send('close');
$('#bmin').onclick = () => bridge.send('min');
$('#drag').addEventListener('mousedown', (e) => { if (!e.target.closest('.wbtn')) bridge.send('drag'); });

// ---------------------------------------------------------------- navigation
const stepsEl = $('#steps');
for (let i = 0; i < 3; i++) stepsEl.appendChild(fx.el('i'));

const nextBtn = $('#next'), backBtn = $('#back'), laterBtn = $('#later');
const setBtn = (b, { text, hide, off } = {}) => {
  if (text) b.textContent = text;
  b.classList.toggle('hide', !!hide);
  b.classList.toggle('off', !!off);
};

function syncNav() {
  setBtn(laterBtn, { hide: true });
  setBtn(backBtn, { hide: !stack.length || ['start', 'ready', 'update', 'updating', 'deps', 'install', 'done'].includes(current) });
  switch (current) {
    case 'start': setBtn(nextBtn, { hide: true }); break;
    case 'ready': setBtn(nextBtn, { text: 'Launch Flux Control' }); break;
    case 'update': setBtn(nextBtn, { text: 'Update now' }); setBtn(laterBtn, { text: 'Not now' }); break;
    case 'updating': setBtn(nextBtn, { hide: true }); break;
    case 'welcome': setBtn(nextBtn, { text: 'Get started' }); break;
    case 'deps': setBtn(nextBtn, { hide: true }); break;
    case 'missing': setBtn(nextBtn, { text: 'Install now' }); setBtn(laterBtn, { text: 'Later' }); break;
    case 'install': setBtn(nextBtn, { hide: true }); break;
    case 'done': setBtn(nextBtn, { text: 'Launch Flux Control' }); break;
  }
}

function show(id, back = false) {
  const prev = current && $('#' + current);
  const nxt = $('#' + id);
  if (prev) { prev.classList.remove('active'); prev.classList.toggle('back', !back); prev.classList.toggle('out', true); }
  nxt.classList.toggle('back', back);
  nxt.classList.remove('out');
  requestAnimationFrame(() => requestAnimationFrame(() => current === id && nxt.classList.add('active')));
  current = id;
  [...stepsEl.children].forEach((d, i) => d.classList.toggle('on', i <= GROUP[id]));
  stepsEl.style.opacity = GROUP[id] < 0 ? 0 : 1;
  if (id === 'updating') runUpdate();
  syncNav();
  if (id === 'deps') runCheck();
  if (id === 'done') buildDone();
  if (id === 'install') runInstall();
}

function go(id, { push = true } = {}) { if (push && current) stack.push(current); show(id); }
function back() { const p = stack.pop(); if (p) show(p, true); }

nextBtn.onclick = () => {
  switch (current) {
    case 'ready': return bridge.send('launch', { config: {} });
    case 'update': return go('updating', { push: false });
    case 'welcome': return go('deps');
    case 'missing': return go('install', { push: false });
    case 'done': return bridge.send('launch', { config: {} });
  }
};
laterBtn.onclick = () => { if (current === 'update') return status && status.autolaunch ? bridge.send('launch', { config: {} }) : show('ready');  if (current === 'missing' || current === 'install') { deferred = true; bridge.send('skip', { ids: missing.filter((i) => i === 'ffmpeg') }); afterDeps(); } };
backBtn.onclick = back;

// ---------------------------------------------------------------- dependency check
const icoHtml = '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>';
const noHtml = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
let checkRun = 0;

function depRow(id, withBar) {
  const m = DEPS[id];
  const r = fx.el('div', 'dep',
    `<div class="ico spin">${icoHtml}</div><div class="grow"><div class="nm">${m.name}</div><div class="dt">${m.sub}</div>${withBar ? '<div class="bar2"><i></i></div>' : ''}</div><div class="tag"></div>`);
  r.dataset.id = id;
  return r;
}

function runCheck() {
  const run = ++checkRun;
  const list = $('#depList'); list.innerHTML = '';
  const title = $('#depsTitle'); title.className = 'shimmer'; title.textContent = 'Checking dependencies…';
  $('#depsSub').textContent = 'Looking for what Flux Control needs on this computer.';
  missing = [];
  const q = []; let finished = false;
  const onMsg = (m) => { if (m.t === 'dep') q.push(m); if (m.t === 'checked') finished = true; };
  bridge.on((m) => run === checkRun && onMsg(m));
  bridge.send('check');

  (async () => {
    await sleep(700);
    while (run === checkRun && (q.length || !finished)) {
      if (!q.length) { await sleep(60); continue; }
      const m = q.shift();
      const row = depRow(m.id); list.appendChild(row);
      await sleep(30); row.classList.add('show');           // fade in
      await sleep(650);                                      // "looking"
      const ico = $('.ico', row), tag = $('.tag', row);
      ico.classList.remove('spin');
      if (m.state === 'found') { ico.classList.add('ok'); tag.textContent = m.detail || 'Found'; }
      else { ico.classList.add('no'); ico.innerHTML = noHtml; row.classList.add('miss'); tag.textContent = m.detail || 'Missing'; missing.push(m.id); }
      await sleep(350);
    }
    if (run !== checkRun) return;
    title.className = ''; await sleep(200);
    if (missing.length) { title.textContent = `${missing.length} thing${missing.length > 1 ? 's' : ''} missing`; $('#depsSub').textContent = 'Nothing to worry about, we can fix that.'; }
    else { title.textContent = 'Everything is here'; $('#depsSub').textContent = 'Your computer is ready for Flux Control.'; }
    await sleep(1300);
    if (run !== checkRun) return;
    if (missing.length) { buildMissing(); go('missing', { push: false }); } else afterDeps();
  })();
}

function buildMissing() {
  const list = $('#missList'); list.innerHTML = '';
  missing.forEach((id, i) => {
    const r = depRow(id); $('.ico', r).classList.remove('spin'); $('.ico', r).classList.add('no'); $('.ico', r).innerHTML = noHtml;
    $('.tag', r).textContent = ({ electron: '~110 MB', node: '~30 MB', ffmpeg: '~115 MB', app: '~1 MB', webview2: '~2 MB' })[id];
    list.appendChild(r); setTimeout(() => r.classList.add('show'), 250 + i * 140);
  });
}

// ---------------------------------------------------------------- install
let installRun = 0;
function runInstall() {
  const run = ++installRun;
  $('#instTitle').textContent = 'Installing…'; $('#instTitle').className = 'shimmer';
  $('#instSub').textContent = 'Hang tight, this only happens once.';
  const list = $('#instList'); list.innerHTML = '';
  missing.forEach((id, i) => { const r = depRow(id, true); $('.tag', r).textContent = 'Queued'; list.appendChild(r); setTimeout(() => r.classList.add('show'), 100 + i * 120); });
  const row = (id) => $(`.dep[data-id="${id}"]`, list);
  let failed = false;
  bridge.on(async (m) => {
    if (run !== installRun) return;
    if (m.t === 'progress') { const r = row(m.id); if (r) { $('.bar2 > i', r).style.width = m.pct + '%'; $('.tag', r).textContent = m.label || m.pct + '%'; } }
    if (m.t === 'installed') {
      const r = row(m.id); if (!r) return; const ico = $('.ico', r);
      ico.classList.remove('spin', 'no');
      if (m.ok) { ico.classList.add('ok'); ico.innerHTML = icoHtml; $('.bar2 > i', r).style.width = '100%'; $('.tag', r).textContent = 'Installed'; }
      else { failed = true; ico.classList.add('no'); ico.innerHTML = noHtml; $('.tag', r).textContent = 'Failed'; fx.toast(m.err || 'Install failed'); }
    }
    if (m.t === 'install_done') {
      $('#instTitle').className = '';
      if (failed) {
        $('#instTitle').textContent = 'Something went wrong';
        $('#instSub').textContent = 'You can retry, or continue and install later.';
        setBtn(nextBtn, { text: 'Retry', hide: false }); setBtn(laterBtn, { text: 'Continue anyway', hide: false });
        nextBtn.onclick = () => { nextBtn.onclick = defaultNext; runInstall(); };
      } else {
        $('#instTitle').textContent = 'All installed'; $('#instSub').textContent = 'Nice. One more step.';
        await sleep(1200); if (run === installRun && current === 'install') afterDeps();
      }
    }
  });
  bridge.send('install', { ids: missing });
}
const defaultNext = nextBtn.onclick;

// ---------------------------------------------------------------- done
function buildDone() {
  const chips = deferred ? [['Dependencies', 'Install them later']] : [['Dependencies', 'Ready'], ['Next', 'Share or connect inside the app']];
  const box = $('#chips'); box.innerHTML = '';
  chips.forEach(([k, v], i) => { const c = fx.el('span', 'chip', `${k}: <b>${v}</b>`); c.style.transitionDelay = 0.5 + i * 0.08 + 's'; box.appendChild(c); });
  $('#doneSub').textContent = deferred
    ? 'Install the missing pieces when you are ready, then open Flux Control.'
    : 'Open Flux Control to connect to a PC, or share this one with a browser or another computer.';
}

// ---------------------------------------------------------------- startup routing and updates
let status = null;
const ver = (v) => 'v' + String(v || '').replace(/^v/, '');

function showUpdate() {
  $('#updSub').textContent = `${ver(status.version)} to ${ver(status.latest)}. It downloads from GitHub and takes a moment.`;
  show('update');
}
/** after the dependency step: an installed copy goes on to its update / launch, a fresh install finishes the wizard */
function afterDeps() {
  if (status && status.hasInstall) {
    if (status.update) return showUpdate();
    if (status.autolaunch) return bridge.send('launch', { config: {} });
    return showReady();
  }
  go('done', { push: false });
}
function route(m) {
  if (current !== 'start') return;
  status = m;
  if (!m.hasInstall) return show('welcome');            // first install: the full wizard
  if (m.missing.length) {                                // something this install needs is gone: ask before launching
    missing = m.missing; buildMissing(); setBtn(laterBtn, { text: 'Later' });
    return go('missing', { push: false });
  }
  if (m.autolaunch && !m.update) return bridge.send('launch', { config: {} });   // from the Start Menu: straight in when up to date
  if (m.update) return showUpdate();
  showReady();
}
function showReady(note) {
  const m = status || {};
  $('#readyTitle').textContent = note || 'Flux Control is ready';
  $('#readySub').textContent = m.offline
    ? `Version ${ver(m.version)} is installed. Could not check for updates (offline?).`
    : `Version ${ver(m.version)} is installed and up to date.`;
  show('ready');
}

let updateRun = 0;
function runUpdate() {
  const run = ++updateRun;
  $('#updTitle').textContent = 'Updating…'; $('#updTitle').className = 'shimmer';
  const rows = $('#updRows'); rows.innerHTML = '';
  const r = fx.el('div', 'dep', `<div class="ico spin">${icoHtml}</div><div class="grow"><div class="nm">Flux Control ${ver(status && status.latest)}</div><div class="dt">From GitHub</div><div class="bar2"><i></i></div></div><div class="tag">Starting…</div>`);
  rows.appendChild(r); setTimeout(() => r.classList.add('show'), 80);
  bridge.on(async (m) => {
    if (run !== updateRun) return;
    if (m.t === 'progress' && m.id === 'update') { $('.bar2 > i', r).style.width = m.pct + '%'; $('.tag', r).textContent = m.label || m.pct + '%'; }
    if (m.t === 'updated') {
      const ico = $('.ico', r); ico.classList.remove('spin'); $('#updTitle').className = '';
      if (m.ok) {
        ico.classList.add('ok'); $('.bar2 > i', r).style.width = '100%'; $('.tag', r).textContent = 'Done';
        status = { ...status, version: m.version, update: false };
        await sleep(900);
        if (run === updateRun && current === 'updating') showReady('Updated');
      } else {
        ico.classList.add('no'); ico.innerHTML = noHtml; $('.tag', r).textContent = 'Failed';
        fx.toast(m.err || 'Update failed');
        await sleep(1400);
        if (run === updateRun && current === 'updating') showReady('Update failed, your current version still works');
      }
    }
  });
  bridge.send('update');
}

bridge.on((m) => { if (m.t === 'status') route(m); });
bridge.on((m) => { if (m.t === 'error') fx.toast(m.err); });
show('start');
bridge.send('status');
setTimeout(() => { if (current === 'start') show('welcome'); }, 12000); // no answer: fall back to the normal wizard
