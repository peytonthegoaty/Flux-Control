// Executor page (unlocked by the RobloxExecutorDev dev code): a script editor, an auto-execute list and a
// "copy load script" button. It only edits and copies text; nothing here runs a script.

/** One line of Lua that carries the whole script: a one-line script is copied as it is, anything longer is wrapped in loadstring("...")(). */
function toLoadScript(text) {
  const t = String(text).replace(/\r\n?/g, '\n').trim();
  if (!t.includes('\n')) return t;
  const esc = [...t].map((c) => {
    if (c === '\\') return '\\\\';
    if (c === '"') return '\\"';
    if (c === '\n') return '\\n';
    return c < ' ' ? '\\' + String(c.charCodeAt(0)).padStart(3, '0') : c;
  }).join('');
  return `loadstring("${esc}")()`;
}
if (typeof module !== 'undefined') module.exports = { toLoadScript };

const Executor = typeof document === 'undefined' ? null : (() => {
  const $ = (s, r = document) => r.querySelector(s);
  const AUTO = 'fluxAuto';
  const readAuto = () => { try { const v = JSON.parse(localStorage.getItem(AUTO)); return Array.isArray(v) ? v : []; } catch { return []; } };
  let auto = readAuto();                       // [{name, on}]
  let monaco = null, editor = null, booting = null;
  let scripts = [];
  const tabs = [];                             // {id, title, file|null, model, saved}  file = the saved script it belongs to
  let active = null, seq = 0;

  const ICON = {
    file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
    bolt: '<svg viewBox="0 0 24 24"><path d="M13 3L5 13.5h6L10 21l8-10.5h-6L13 3z"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  };

  const saveAuto = () => { try { localStorage.setItem(AUTO, JSON.stringify(auto)); } catch {} };

  // ---------------------------------------------------------------- Monaco (kept in the Flux folder, downloaded once)
  function boot() {
    if (booting) return booting;
    booting = (async () => {
      const root = $('#exEditor');
      root.innerHTML = '<div class="exec-boot"><span class="shimmer">Preparing the editor…</span></div>';
      const r = await winApi.monacoEnsure();
      if (r.error) throw new Error(r.error);
      r.base = new URL(r.base, location.href).href.replace(/\/$/, '');   // absolute: the editor's worker loads from a blob URL
      await new Promise((ok, bad) => {
        const s = document.createElement('script'); s.src = r.base + '/loader.js';
        s.onload = ok; s.onerror = () => bad(new Error('The editor files could not be loaded'));
        document.head.appendChild(s);
      });
      window.require.config({ paths: { vs: r.base } });
      window.MonacoEnvironment = { getWorkerUrl: () => URL.createObjectURL(new Blob([`self.MonacoEnvironment={baseUrl:'${r.base}/'};importScripts('${r.base}/base/worker/workerMain.js');`], { type: 'text/javascript' })) };
      monaco = await new Promise((ok) => window.require(['vs/editor/editor.main'], () => ok(window.monaco)));
      registerLuau(monaco);
      root.innerHTML = '';
      editor = monaco.editor.create(root, {
        theme: 'flux', language: 'luau', automaticLayout: true, minimap: { enabled: false }, fontFamily: '"Cascadia Code", Consolas, monospace', fontSize: 14, lineHeight: 22, fontLigatures: true,
        quickSuggestions: { other: true, comments: false, strings: false }, suggestOnTriggerCharacters: true, tabCompletion: 'on', wordBasedSuggestions: 'currentDocument', snippetSuggestions: 'inline', renderWhitespace: 'none', guides: { indentation: true }, cursorBlinking: 'smooth', mouseWheelZoom: false, fixedOverflowWidgets: true,
        scrollBeyondLastLine: false, smoothScrolling: true, cursorSmoothCaretAnimation: 'on', contextmenu: false, padding: { top: 14, bottom: 14 }, renderLineHighlight: 'line',
        overviewRulerLanes: 0, hideCursorInOverviewRuler: true, scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 }, bracketPairColorization: { enabled: false },
      });
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save());
      editor.onDidChangeCursorPosition((e) => { $('#exPos').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`; });
    })().catch((e) => { booting = null; throw e; });
    return booting;
  }

  // ---------------------------------------------------------------- files (saved scripts) and tabs (what you are working on)
  const label = (t) => (t.file || t.title).replace(/\.lua$/, '');
  const dirty = (t) => (t.file ? t.model.getValue() !== t.saved : t.model.getValue() !== '');
  const cur = () => tabs.find((t) => t.id === active);

  async function refresh() {
    scripts = await winApi.scriptsList();
    $('#exCount').textContent = scripts.length || '';
    drawLists();
  }

  function row(cls, name, extra) {
    const r = fx.el('div', 'exec-row ' + cls, `<span class="ri">${ICON.file}</span><span class="rn"></span>`);
    $('.rn', r).textContent = name.replace(/\.lua$/, '');
    if (extra) extra(r);
    return r;
  }

  function drawLists() {
    const q = $('#exSearch').value.trim().toLowerCase();
    const list = $('#exScripts'); list.innerHTML = '';
    scripts.filter((n) => n.toLowerCase().includes(q)).forEach((n) => {
      const r = row(cur() && cur().file === n ? 'sel' : '', n, (r) => {
        const acts = fx.el('span', 'acts');
        const a = fx.el('button', 'ract', ICON.bolt); a.setAttribute('aria-label', 'Add to Auto Execute');
        a.onclick = (e) => { e.stopPropagation(); if (!auto.some((x) => x.name === n)) { auto.push({ name: n, on: true }); saveAuto(); drawLists(); } };
        const d = fx.el('button', 'ract danger', ICON.trash); d.setAttribute('aria-label', 'Delete');
        d.onclick = async (e) => {
          e.stopPropagation();
          if (!(await fx.ask({ title: 'Delete this script?', text: `"${n.replace(/\.lua$/, '')}" will be removed from this PC.`, ok: 'Delete', cancel: 'Keep' }))) return;
          tabs.filter((t) => t.file === n).forEach((t) => closeTab(t.id, true));
          auto = auto.filter((x) => x.name !== n); saveAuto();
          await winApi.scriptsDelete(n); refresh();
        };
        acts.append(a, d); r.appendChild(acts);
      });
      r.onclick = () => openFile(n);
      list.appendChild(r);
    });
    $('#exEmptyScripts').classList.toggle('open', !scripts.length);

    const al = $('#exAuto'); al.innerHTML = '';
    auto = auto.filter((x) => scripts.includes(x.name));        // a deleted script leaves the list
    auto.forEach((x) => {
      const r = row('', x.name, (r) => {
        const t = fx.el('div', 'fx-toggle' + (x.on ? ' on' : '')); fx.toggle(t, (v) => { x.on = v; saveAuto(); });
        const rm = fx.el('button', 'ract', ICON.x); rm.setAttribute('aria-label', 'Remove from Auto Execute');
        rm.onclick = () => { auto = auto.filter((y) => y !== x); saveAuto(); drawLists(); };
        r.append(rm, t);
      });
      r.classList.toggle('off', !x.on);
      al.appendChild(r);
    });
    $('#exEmptyAuto').classList.toggle('open', !auto.length);
  }

  // tabs survive a restart (including ones that were never saved)
  let persistT;
  const persistSoon = () => { clearTimeout(persistT); persistT = setTimeout(() => { try { localStorage.setItem('fluxTabs', JSON.stringify({ tabs: tabs.map((t) => ({ file: t.file, title: t.title, text: t.model.getValue() })), active: tabs.findIndex((t) => t.id === active) })); } catch {} }, 400); };

  function drawTabs() {
    const bar = $('#exTabs'); bar.innerHTML = '';
    tabs.forEach((t) => {
      const b = fx.el('div', 'exec-tab' + (t.id === active ? ' on' : '') + (dirty(t) ? ' dirty' : ''), `<span class="tn"></span><i class="dot"></i><button class="tx" aria-label="Close">${ICON.x}</button>`);
      $('.tn', b).textContent = label(t);
      b.onclick = () => setActive(t.id);
      $('.tx', b).onclick = (e) => { e.stopPropagation(); closeTab(t.id); };
      bar.appendChild(b);
    });
    const add = fx.el('button', 'exec-tabadd', '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>'); add.setAttribute('aria-label', 'New tab');
    add.onclick = () => newTab();
    bar.appendChild(add);
    const c = $('#exCrumb'), t = cur();
    c.innerHTML = '<span></span><i>/</i><b></b><em></em>';
    $('span', c).textContent = $('#exWsName').textContent;
    $('b', c).textContent = t ? (t.file || label(t)) : '';
    $('em', c).textContent = t && !t.file ? 'not saved' : '';
  }

  function setActive(id) {
    active = id;
    const t = cur();
    if (t && editor) editor.setModel(t.model);
    drawTabs(); drawLists(); persistSoon();
  }

  function makeTab({ file = null, title, text = '', saved = null }) {
    const t = { id: ++seq, title, file, model: monaco.editor.createModel(text, 'luau'), saved };
    t.model.onDidChangeContent(() => { drawTabs(); persistSoon(); });
    tabs.push(t);
    return t;
  }

  function newTab() {
    let n = 1; while (tabs.some((t) => t.title === `Script ${n}`)) n++;
    setActive(makeTab({ title: `Script ${n}` }).id);
  }

  async function openFile(name) {
    try { await boot(); } catch (e) { return showError(e); }
    const have = tabs.find((t) => t.file === name);
    if (have) return setActive(have.id);
    const text = await winApi.scriptsRead(name);
    if (text == null) return fx.toast('That script could not be read');
    const lone = tabs.length === 1 && !tabs[0].file && !tabs[0].model.getValue();   // an empty blank tab makes way for it
    const t = makeTab({ file: name, title: name, text, saved: text });
    if (lone) closeTab(tabs[0].id, true);
    setActive(t.id);
  }

  async function closeTab(id, force) {
    const i = tabs.findIndex((t) => t.id === id); if (i < 0) return;
    if (!force && dirty(tabs[i]) && !(await fx.ask({ title: 'Close without saving?', text: `"${label(tabs[i])}" has changes that are not saved.`, ok: 'Close', cancel: 'Keep' }))) return;
    tabs[i].model.dispose(); tabs.splice(i, 1);
    if (!tabs.length) return newTab();                                   // there is always one tab open
    if (active === id) setActive(tabs[Math.min(i, tabs.length - 1)].id); else { drawTabs(); persistSoon(); }
    drawLists();
  }

  const goodName = (n) => /^[\w][\w .-]{0,54}$/.test(n);

  async function save() {
    const t = cur(); if (!t) return;
    const text = t.model.getValue();
    if (!t.file) {
      const typed = await fx.ask({ title: 'Save script', text: 'Give it a name.', ok: 'Save', cancel: 'Cancel', input: { placeholder: 'My script', value: t.title } });
      if (typed == null) return;
      const name = typed.trim().replace(/\.lua$/i, '');
      if (!goodName(name)) return fx.toast('Use letters, numbers, spaces, - and _ in the name');
      const file = name + '.lua';
      if (scripts.includes(file) && !(await fx.ask({ title: 'Replace it?', text: `"${name}" already exists.`, ok: 'Replace', cancel: 'Cancel' }))) return;
      if (!(await winApi.scriptsWrite(file, text))) return fx.toast('Could not save');
      t.file = file; t.saved = text; await refresh(); drawTabs(); persistSoon(); return fx.toast('Saved');
    }
    if (await winApi.scriptsWrite(t.file, text)) { t.saved = text; drawTabs(); fx.toast('Saved'); } else fx.toast('Could not save');
  }

  // the main process owns the clipboard (the page's own clipboard API depends on window focus)
  const copy = async (text, msg) => {
    if (!text.trim()) return fx.toast('This tab is empty, write or paste a script first');   // an empty copy would just blank the clipboard
    fx.toast((await winApi.copy(text)) ? `${msg} (${text.length} characters)` : 'Copy failed');
  };

  // ---------------------------------------------------------------- console (Flux events + print/warn/errors that come back from the executor)
  const lines = [];                                          // {t, level, text}
  const pad = (n) => String(n).padStart(2, '0');
  function drawCon(last) {
    const q = $('#conSearch').value.trim().toLowerCase();
    const box = $('#conLog .view');
    const shown = lines.filter((l) => !q || l.text.toLowerCase().includes(q));
    $('#conCount').textContent = lines.length ? (q ? `${shown.length} / ${lines.length}` : lines.length) : '';
    if (last && !q && box.children.length === lines.length - 1) { box.appendChild(conLine(last)); }
    else { box.innerHTML = ''; shown.forEach((l) => box.appendChild(conLine(l))); if (!shown.length) box.innerHTML = `<div class="con-empty">${lines.length ? 'Nothing matches.' : 'Output from your scripts shows up here.'}</div>`; }
    box.scrollTop = box.scrollHeight;
  }
  function conLine(l) {
    const d = fx.el('div', 'con-line ' + l.level, '<span class="ct"></span><i class="con-dot"></i><span class="ctx"></span>');
    $('.ct', d).textContent = l.t; $('.ctx', d).textContent = l.text;
    return d;
  }
  function con(level, text) {
    const d = new Date(), l = { t: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`, level, text: String(text) };
    lines.push(l); if (lines.length > 500) lines.shift();
    drawCon(l);
  }
  $('#conSearch').addEventListener('input', () => drawCon());
  $('#conClear').onclick = () => { lines.length = 0; drawCon(); };
  $('#conToggle').onclick = () => { const c = $('#exConsole'); c.classList.toggle('collapsed'); $('#conToggle').setAttribute('aria-label', c.classList.contains('collapsed') ? 'Expand console' : 'Collapse console'); };
  drawCon();

  // ---------------------------------------------------------------- toolbar
  document.querySelectorAll('#executor [data-toggle]').forEach((h) => h.addEventListener('click', (e) => { if (!e.target.closest('button')) h.parentElement.classList.toggle('collapsed'); }));
  $('#exSearch').addEventListener('input', drawLists);
  $('#exSave').onclick = save;
  $('#exClear').onclick = () => { const t = cur(); if (t) t.model.setValue(''); };
  $('#exCopy').onclick = () => { const t = cur(); if (t) copy(t.model.getValue(), 'Copied'); };
  // Copy load script = HubRunner on one line: paste it into your executor once and Flux Control can reach it through the workspace folder
  $('#exLoad').onclick = async () => copy(toLoadScript(await winApi.bridgeLoader()), 'Load script copied. Paste it into your executor once');
  $('#exRun').onclick = async () => {
    const t = cur(); if (!t) return;
    if (!connected) return fx.toast('Not connected yet. Use Copy load script and paste it into your executor');
    if (!(await winApi.bridgeSend(t.model.getValue()))) fx.toast('Nothing to send'); else con('info', `Sent ${label(t)}`);
  };
  $('#exAutoCopy').onclick = async () => {
    const on = auto.filter((x) => x.on);
    if (!on.length) return fx.toast('Turn on a script in Auto Execute first');
    const lines = [];
    for (const x of on) { const t = tabs.find((y) => y.file === x.name); lines.push(toLoadScript(t ? t.model.getValue() : (await winApi.scriptsRead(x.name)) || '')); }
    copy(lines.join(';'), `Copied ${on.length} script${on.length > 1 ? 's' : ''} as one line`);
  };

  function showError(e) {
    const root = $('#exEditor');
    root.innerHTML = '<div class="exec-boot"><div></div><button class="btn small" style="margin:12px 0 0">Try again</button></div>';
    $('.exec-boot div', root).textContent = e.message;
    $('.exec-boot button', root).onclick = () => { booting = null; open(); };
  }

  // ---------------------------------------------------------------- connection to the executor (HubRunner heartbeat in the workspace)
  let connected = false, lastRun = null, poll = null;
  async function pollBridge() {
    if (!ws || !$('#executor').classList.contains('active')) return;
    const st = await winApi.bridgeState();
    if (st.connected && !connected) {                         // just connected: send the Auto Execute scripts
      const on = auto.filter((x) => x.on);
      if (on.length) {
        const parts = [];
        for (const x of on) { const t = tabs.find((y) => y.file === x.name); parts.push(t ? t.model.getValue() : (await winApi.scriptsRead(x.name)) || ''); }
        if (await winApi.bridgeSend(parts.join('\n'))) { fx.toast(`Auto Execute sent (${on.length})`); con('info', `Auto Execute sent (${on.length})`); }
      }
    }
    if (st.connected !== connected) con(st.connected ? 'info' : 'warn', st.connected ? 'Executor connected' : 'Executor disconnected');
    connected = st.connected;
    $('#exConn').classList.toggle('on', connected);
    $('#exConnText').textContent = connected ? 'Connected' : 'Not connected';
    const r = st.status;                                      // an error from the last script is shown once
    if (r && r.id !== lastRun && r.finished) {
      lastRun = r.id;
      (r.logs || []).forEach((x) => (x.startsWith('[warn] ') ? con('warn', x.slice(7)) : con('info', x)));
      if (r.ok === false && r.error) { con('error', r.error); fx.toast('Script error: ' + String(r.error).split('\n')[0].slice(0, 120)); }
    }
  }
  setInterval(pollBridge, 1500);

  // ---------------------------------------------------------------- AI mode: Claude Code with the flux-executor tools (the live game)
  const FEATURES = [
    ['Run Lua', 'runs code in your game and reads what it prints or returns'],
    ['Look around', 'instance tree and search by name or class'],
    ['Read scripts', 'decompiled source of the game\'s scripts'],
    ['Console', 'reads the Roblox developer console'],
    ['GUI', 'clicks buttons and types into text boxes'],
    ['Remote spy', 'logs the remotes the game fires to the server'],
    ['Screenshot', 'sees the Roblox window'],
    ['Your scripts', 'reads and writes the .lua files in your workspace'],
  ];
  let ai = null, aiOn = false;
  try { aiOn = localStorage.getItem('fluxExecAi') === '1'; } catch {}
  function setAi(on, fit = true) {
    aiOn = on;
    try { localStorage.setItem('fluxExecAi', on ? '1' : '0'); } catch {}
    wrap().classList.toggle('ai', on); $('#exAiBtn').classList.toggle('on', on);
    if (fit) winApi.fit({ w: on ? 1760 : 1340, h: 840 });
    if (!on) return;
    if (!ai) ai = ClaudeChat($('#exAi'), {
      compact: true, mcp: true, defaultDir: async () => ws, onClose: () => setAi(false),
      onCode: (code) => {   // Claude wrote a script: it goes into the current tab (Ctrl+Z brings the old text back)
        const t = cur(); if (!t || !editor) return;
        editor.setModel(t.model);
        editor.executeEdits('claude', [{ range: t.model.getFullModelRange(), text: code }]);
        editor.pushUndoStop();
        fx.toast("Claude's script is in the current tab (Ctrl+Z to undo)");
      },
      hero: (el) => {
        el.innerHTML = '<div class="ai-fh">What Claude can do in your game</div><ul class="ai-feat"></ul><div class="ai-need"><i></i><span></span></div>';
        FEATURES.forEach(([b, t]) => { const li = fx.el('li', '', '<b></b><span></span>'); $('b', li).textContent = b; $('span', li).textContent = t; $('.ai-feat', el).appendChild(li); });
        $('.ai-need', el).classList.toggle('on', connected);
        $('.ai-need span', el).textContent = connected ? 'Your executor is connected.' : 'Run the load script in your executor first: press Copy load script and paste it there.';
      },
    });
    ai.open();
  }
  $('#exAiBtn').onclick = () => setAi(!aiOn);

  // ---------------------------------------------------------------- workspace folder
  let ws = null;
  const wrap = () => $('.exec-wrap');
  function showWs() {
    $('#exWsName').textContent = ws ? ws.split(/[\\/]/).filter(Boolean).pop() || ws : 'No workspace';
    wrap().classList.toggle('needs-ws', !ws);
  }
  async function pickWs() {
    const dir = await winApi.workspacePick();
    if (!dir) return false;
    ws = dir;
    tabs.splice(0).forEach((t) => t.model.dispose()); active = null;   // tabs belonged to the old folder
    showWs(); await refresh();
    try { await boot(); } catch (e) { showError(e); return true; }
    newTab();
    return true;
  }
  $('#exPick').onclick = pickWs;
  $('#exWs').onclick = pickWs;

  async function open() {
    ws = await winApi.workspaceGet(); showWs();
    document.querySelectorAll('#executor .fx-field').forEach((f) => f.classList.contains('wired') || (f.classList.add('wired'), fx.field(f)));
    if (!ws) return;                       // the page stays on its setup card until a folder is chosen
    await refresh();
    try { await boot(); } catch (e) { return showError(e); }
    if (aiOn) setAi(true, false);
    if (tabs.length) return;
    let saved = null; try { saved = JSON.parse(localStorage.getItem('fluxTabs')); } catch {}
    for (const s of (saved && saved.tabs) || []) {
      const onDisk = s.file && scripts.includes(s.file) ? await winApi.scriptsRead(s.file) : null;
      makeTab(onDisk != null ? { file: s.file, title: s.title, text: s.text, saved: onDisk } : { title: s.title || 'Script', text: s.text });
    }
    if (!tabs.length) return newTab();
    setActive(tabs[Math.min(Math.max(saved.active, 0), tabs.length - 1)].id);
  }

  return { open, wide: () => aiOn };
})();
