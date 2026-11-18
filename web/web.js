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
  if (id !== 'session') $('#hostName').textContent = 'Not connected';
  else pillCtl.peek(3200);
}
fx.popover($('#chipWrap'), $('#chip'));
const pillCtl = fx.pill($('#top'), $('#pillF'), () => $('#chipWrap').classList.contains('open') || $('#setWrap').classList.contains('open') || $('#monWrap').classList.contains('open'));
fx.popover($('#setWrap'), $('#btnSettings'));
Hud.init();
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
  stage.classList.remove('live'); stage.style.cursor = '';
  if (document.fullscreenElement) document.exitFullscreen();
  pw.value = ''; sync();
  show('login');
}

show('login');

$('#btnExec').onclick = () => showExec(!$('#webExec').classList.contains('open'));
