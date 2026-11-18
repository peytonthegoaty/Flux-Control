// Flux Control web client: password, then the same viewer the PC client uses (Viewer in viewer.js).
const $ = (s, r = document) => r.querySelector(s);
// the Executor page runs here but works on the shared PC: its calls go through the connection to the Flux Control app there
const call = (m) => (...a) => Viewer.call(m, ...a);
const winApi = {
  fit() {}, workspacePick: async () => { fx.toast('Choose the workspace folder in the Flux Control app on that PC'); return null; },
  copy: async (t) => { try { await navigator.clipboard.writeText(t); return true; } catch { return false; } },
  monacoEnsure: call('monaco:ensure'), workspaceGet: call('workspace:get'),
  scriptsList: call('scripts:list'), scriptsRead: call('scripts:read'), scriptsWrite: call('scripts:write'), scriptsDelete: call('scripts:delete'),
  bridgeLoader: call('bridge:loader'), bridgeState: async () => (Viewer.active() ? Viewer.call('bridge:state').catch(() => ({ connected: false })) : { connected: false }), bridgeSend: call('bridge:send'),
  claudeChats: call('claude:chats'), claudeHistory: call('claude:history'), claudeSend: call('claude:send'), claudeStop: call('claude:stop'),
  claudeAuth: call('claude:auth'), claudeHome: call('claude:home'), claudeUsage: call('claude:usage'), claudePickDir: async () => null,
  aiList: call('ai:list'), aiAdd: call('ai:add'), aiRemove: call('ai:remove'),
  appsList: call('apps:list'), appsClose: call('apps:close'), appsFront: call('apps:front'), appsElev: call('apps:elev'), appsElevState: call('apps:elev-state'),
  onAppsElev: (f) => Viewer.on('apps:elev', f),
  onClaude: (f) => Viewer.on('claude:line', f), onClaudeChanged: (f) => Viewer.on('claude:changed', f), onClaudeUsage: (f) => Viewer.on('claude:usage', f),
};
function showExec(on) {
  $('#webExec').classList.toggle('open', on); $('#executor').classList.toggle('active', on); $('#btnExec').classList.toggle('on', on);
  if (on) Executor.open();
}
const app = $('#app');
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.querySelectorAll('.fx-field').forEach(fx.field);

// ---- screens
let current = null;
function show(id) {
  const prev = current && $('#' + current), next = $('#' + id);
  if (prev) { prev.classList.remove('active'); prev.classList.add('out'); }
  next.classList.remove('out');
  requestAnimationFrame(() => requestAnimationFrame(() => current === id && next.classList.add('active')));
  current = id;
  app.classList.toggle('in-session', id === 'session');
  $('#winWrap').hidden = id !== 'session';
  if (id !== 'session') $('#hostName').textContent = 'Not connected';
  else pillCtl.peek(3200);
}
fx.popover($('#chipWrap'), $('#chip'));
const pillCtl = fx.pill($('#top'), $('#pillF'), () => $('#chipWrap').classList.contains('open') || $('#setWrap').classList.contains('open') || $('#monWrap').classList.contains('open') || $('#winWrap').classList.contains('open'));
fx.popover($('#setWrap'), $('#btnSettings'));
Hud.init();

// ---- apps on that PC: the window list, close, and bring-to-front onto the screen you are watching
fx.popover($('#winWrap'), $('#btnWins'));
const winMenu = $('#winMenu');
function drawWins(list) {
  const cur = Hud.cur ? Hud.cur() : 0;
  winMenu.innerHTML = '<div class="menu-head"><div class="mh-name">Apps on that PC</div><div class="mh-sub">Close an app or bring it to the screen you watch</div></div><div class="menu-sep"></div>';
  if (!Array.isArray(list) || !list.length) { winMenu.insertAdjacentHTML('beforeend', '<div class="win-empty">No apps found.</div>'); return; }
  list.forEach((a) => {
    const row = document.createElement('div'); row.className = 'win-item';
    row.innerHTML = '<div class="wi-txt"><span class="wi-title"></span><small class="wi-sub"></small></div><button class="wi-btn" data-a="front">Front</button><button class="wi-btn sq" data-a="x" aria-label="Close app"><svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></button>';
    row.querySelector('.wi-title').textContent = a.title || a.exe || 'App';
    const elsewhere = Number.isInteger(a.mon) && a.mon >= 0 && a.mon !== cur;
    row.querySelector('.wi-sub').textContent = (a.exe || '') + (elsewhere ? ' · screen ' + (a.mon + 1) : '');
    row.querySelector('[data-a="front"]').onclick = () => { winApi.appsFront(a.hwnd, cur); fx.toast('Bringing to front'); };
    row.querySelector('[data-a="x"]').onclick = async () => {
      if (await fx.ask({ title: 'Close app?', text: (a.title || a.exe || 'This app') + ' will be asked to close on the PC.', ok: 'Close' })) {
        winApi.appsClose(a.hwnd); setTimeout(refreshWins, 800);
      }
    };
    winMenu.appendChild(row);
  });
}
async function refreshWins() {
  if (!Viewer.active()) return;
  const r = await winApi.appsList();
  drawWins(r && r.list);
}
$('#btnWins').addEventListener('click', () => { if ($('#winWrap').classList.contains('open')) refreshWins(); });

// ---- elevation warning: the focused app is admin, so Windows blocks control of it
winApi.onAppsElev((on) => { $('#elevBar').hidden = !on; });
$('#btnElev').onclick = async () => {
  const b = $('#btnElev');
  b.disabled = true; b.textContent = 'Restarting…';
  await winApi.appsElev();
  fx.toast('Accept the Windows permission prompt. Flux Control restarts and you can reconnect.');
  setTimeout(() => { b.disabled = false; b.textContent = 'Restart as admin'; }, 8000);
};
$('#elevHide').onclick = () => { $('#elevBar').hidden = true; };

let hinted = false;

// ---- top bar: fullscreen toggle (icon swaps) and auto-hide while fullscreen
const ICON_EXPAND = '<svg class="swap" viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
const ICON_COMPRESS = '<svg class="swap" viewBox="0 0 24 24"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>';
const fsBtn = $('#btnFs');
fsBtn.innerHTML = ICON_EXPAND;
fsBtn.onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => fx.toast('Fullscreen is not allowed here')));
document.addEventListener('fullscreenchange', () => {
  const on = !!document.fullscreenElement;
  app.classList.toggle('fs', on);
  fsBtn.innerHTML = on ? ICON_COMPRESS : ICON_EXPAND;
  fsBtn.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen');
});

// ---- leaving always asks first
async function confirmLeave(text) {
  return fx.ask({ title: 'Are you sure?', text, ok: 'Leave', cancel: 'Stay' });
}
$('#btnDisc').onclick = async () => { if (await confirmLeave('You will be disconnected from this PC.')) endSession(); };
$('#btnClose').onclick = async () => {
  if (await confirmLeave(current === 'session' ? 'This ends your session.' : 'This closes the page.')) {
    endSession();
    window.close(); // only works for tabs a script opened; otherwise the login screen stays
  }
};

// ---- login + session
const pw = $('#pw'), btn = $('#btnConnect');
const sync = () => btn.classList.toggle('off', !pw.value);
pw.addEventListener('input', sync);
pw.addEventListener('keydown', (e) => e.key === 'Enter' && btn.onclick());
const stage = $('#stage');

btn.onclick = async () => {
  if (btn.classList.contains('off') || btn.dataset.busy) return;
  btn.dataset.busy = '1'; btn.textContent = 'Connecting…'; btn.classList.add('off');
  try {
    await Viewer.open({
      url: location.origin, password: pw.value, stage, video: $('#remote'),
      onCursor: (n) => {                                            // only the cursor SHAPE follows the host; the pointer is yours
        const c = Viewer.shape(n); stage.style.cursor = c;
        if (c === 'none' && !hinted && !Viewer.locked()) { hinted = true; fx.toast(Hud.auto() ? 'This game hides its cursor. Click the screen to capture the mouse.' : 'This game hides its cursor. Turn on Mouse lock in the gear menu.'); }
      },
      onLock: Hud.setLock,
      onScreen: Hud.setScreen,
      autoLock: Hud.auto,
      onLive: () => stage.classList.add('live'),
      onClose: () => { fx.toast('Connection lost'); endSession(true); },
    });
    $('#hostName').textContent = location.host;
    Viewer.call('app:features').then((f) => { $('#btnExec').hidden = !(f || []).includes('roblox-executor'); }).catch(() => {});
    Viewer.call('apps:elev-state').then((on) => { $('#elevBar').hidden = !on; }).catch(() => {});
    $('#mhName').textContent = location.host;
    $('#viaChip').textContent = 'Web';
    stage.classList.remove('live');
    show('session');
  } catch (e) {
    fx.toast(e.message);
  } finally { delete btn.dataset.busy; btn.textContent = 'Connect'; sync(); }
};

function endSession(already) {
  if (!already) Viewer.close();
  hinted = false; Hud.setLock(false); showExec(false); $('#btnExec').hidden = true; Hud.setScreen({ mons: [] });
  $('#winWrap').hidden = true; $('#winWrap').classList.remove('open'); $('#elevBar').hidden = true;
  stage.classList.remove('live'); stage.style.cursor = '';
  if (document.fullscreenElement) document.exitFullscreen();
  pw.value = ''; sync();
  show('login');
}

show('login');

$('#btnExec').onclick = () => showExec(!$('#webExec').classList.contains('open'));
