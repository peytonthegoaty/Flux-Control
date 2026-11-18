// FPS and ping pills (top right) plus their toggles in the pill's settings menu, and the mouse-lock toggle.
// If both are on, FPS is on top and ping below; if only one is on it sits alone in the top right corner.
const Hud = (() => {
  const KEY = 'fluxHud2';   // new key: everyone starts with FPS and ping on
  const $ = (s) => document.querySelector(s);
  let on = { fps: true, ping: true, auto: true };
  try { on = { ...on, ...JSON.parse(localStorage.getItem(KEY)) }; } catch {}

  function paint() {
    $('#hudFps').classList.toggle('on', on.fps);
    $('#hudPing').classList.toggle('on', on.ping);
  }
  function update() {
    const s = Viewer.stats();
    $('#fpsVal').textContent = s && s.fps != null ? s.fps + (s.hf != null ? ' / ' + s.hf : '') : '-';   // shown / sent by the PC
    $('#pingVal').textContent = s && s.ping != null ? Math.round(s.ping) + ' ms' : '-';
  }
  function init() {
    const set = (id, key) => {
      const t = $(id);
      t.classList.toggle('on', on[key]);
      fx.toggle(t, (v) => { on[key] = v; try { localStorage.setItem(KEY, JSON.stringify(on)); } catch {} paint(); });
    };
    set('#tgFps', 'fps'); set('#tgPing', 'ping'); set('#tgAuto', 'auto');
    fx.toggle($('#tgLock'), (v) => Viewer.lock(v));
    fx.popover($('#monWrap'), $('#btnMon'));
    paint();
    setInterval(update, 500);
  }
  // screen picker: only shown when the shared PC has more than one monitor
  const MON = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>';
  let mons = [], monCur = 0;
  function setScreen(info) {
    if (Array.isArray(info.mons)) mons = info.mons.filter((x) => x && Number.isInteger(x.i));
    if (Number.isInteger(info.mon)) monCur = info.mon;
    $('#monWrap').hidden = mons.length < 2;
    const menu = $('#monMenu');
    menu.innerHTML = '<div class="menu-head"><div class="mh-name">Screens</div><div class="mh-sub">Pick the screen to see and control</div></div><div class="menu-sep"></div>';
    mons.forEach((x) => {
      const b = document.createElement('button');
      b.className = 'menu-item mon-item' + (x.i === monCur ? ' on' : '');
      b.innerHTML = MON + '<span></span><small></small>';
      b.querySelector('span').textContent = String(x.name || 'Display ' + (x.i + 1)) + (x.primary ? ' (main)' : '');
      b.querySelector('small').textContent = `${+x.w || 0}×${+x.h || 0}`;
      b.onclick = () => { if (x.i !== monCur) { Viewer.monitor(x.i); fx.toast('Switching screen'); } };
      menu.appendChild(b);
    });
  }
  /** the viewer reports when the lock really starts or ends (Esc releases it) */
  const setLock = (v) => $('#tgLock').classList.toggle('on', !!v);
  return { init, setLock, setScreen, auto: () => on.auto, cur: () => monCur };
})();
