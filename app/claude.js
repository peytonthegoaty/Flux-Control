// Claude Code chats: the Claude page (ClaudeTesting dev code) and the Executor's AI mode both use ClaudeChat below.

/** Small markdown to HTML: code blocks, headings, lists, quotes, tables, bold/italic/code/links. Everything is escaped first. */
function claudeMd(src) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const blocks = [];
  src = String(src).replace(/```([\w+-]*)[^\n]*\n?([\s\S]*?)(```|$)/g, (m, l, c) => { blocks.push(`<pre data-l="${esc(l)}"><button class="cl-cp">Copy</button><code>${esc(c.replace(/\n$/, ''))}</code></pre>`); return '\n\u0000' + (blocks.length - 1) + '\u0000\n'; });
  const inl = (t) => {
    const codes = [];
    t = esc(t).replace(/`([^`\n]+)`/g, (m, c) => { codes.push(c); return '\u0001' + (codes.length - 1) + '\u0001'; });
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<i>$2</i>').replace(/~~([^~\n]+)~~/g, '<s>$1</s>').replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<u>$1</u>');
    return t.replace(/\u0001(\d+)\u0001/g, (m, i) => '<code>' + codes[i] + '</code>');
  };
  const L = src.split('\n'), out = [];
  const isB = (l) => /^\u0000\d+\u0000$/.test(l.trim()) || /^#{1,4}\s/.test(l) || /^\s*>/.test(l) || /^\s*([-*+]|\d+[.)])\s+/.test(l) || /^\s*([-*_])\1\1+\s*$/.test(l);
  let i = 0;
  while (i < L.length) {
    const ln = L[i]; let m;
    if (!ln.trim()) { i++; continue; }
    if (/^\u0000\d+\u0000$/.test(ln.trim())) { out.push(blocks[+ln.trim().slice(1, -1)]); i++; }
    else if ((m = ln.match(/^(#{1,4})\s+(.*)/))) { const n = m[1].length + 1; out.push(`<h${n}>${inl(m[2])}</h${n}>`); i++; }
    else if (/^\s*([-*_])\1\1+\s*$/.test(ln)) { out.push('<hr>'); i++; }
    else if (/^\s*>/.test(ln)) { const q = []; while (i < L.length && /^\s*>/.test(L[i])) q.push(inl(L[i++].replace(/^\s*>\s?/, ''))); out.push('<blockquote>' + q.join('<br>') + '</blockquote>'); }
    else if (/^\s*([-*+]|\d+[.)])\s+/.test(ln)) {
      const ord = /^\s*\d/.test(ln), it = [];
      while (i < L.length && /^\s*([-*+]|\d+[.)])\s+/.test(L[i])) it.push('<li>' + inl(L[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, '')) + '</li>');
      out.push((ord ? '<ol>' : '<ul>') + it.join('') + (ord ? '</ol>' : '</ul>'));
    } else if (ln.includes('|') && i + 1 < L.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(L[i + 1])) {
      const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inl(c.trim()));
      const hd = row(ln); i += 2; const rows = [];
      while (i < L.length && L[i].includes('|') && L[i].trim()) rows.push(row(L[i++]));
      out.push('<table><thead><tr>' + hd.map((c) => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>' + rows.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table>');
    } else { const p = []; while (i < L.length && L[i].trim() && !(p.length && isB(L[i]))) p.push(inl(L[i++])); out.push('<p>' + p.join('<br>') + '</p>'); }
  }
  return out.join('');
}
if (typeof module !== 'undefined') module.exports = { claudeMd };

/**
 * A Claude Code chat: a list of the chats saved on this PC (grouped by folder), the conversation and a composer.
 * Used by the Claude page and by the Executor's AI mode.
 *   root     element to build into
 *   compact  the chat list is a drawer opened from the header (narrow panels)
 *   mcp      give Claude the flux-executor tools (the live game) on every message
 *   hero     (el) => fills the new-chat screen
 *   defaultDir  async () => folder a new chat starts in (default: the user folder)
 */
function ClaudeChat(root, { compact = false, mcp = false, hero = null, defaultDir = null, onClose = null, onCode = null } = {}) {
  const $ = (s, r = root) => r.querySelector(s);
  const ICON = {
    folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    chev: '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    send: '<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>',
    tool: '<svg viewBox="0 0 24 24"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/></svg>',
    list: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
    spark: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>',
  };
  const opt = (o) => JSON.stringify(o);
  root.classList.add('cl-wrap');
  root.classList.toggle('compact', compact);
  root.innerHTML = `
    <aside class="cl-side">
      <div class="cl-sidehead"><b>Chats</b><button class="cl-new">${ICON.plus}New chat</button></div>
      <div class="fx-field cl-search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/></svg><input class="fx-input" type="text" placeholder="Search chats" spellcheck="false" autocomplete="off"></div>
      <div class="fx-scroll cl-listscroll"><div class="view cl-list"></div></div>
    </aside>
    <div class="cl-main">
      <div class="cl-head">
        <button class="cl-chats" aria-label="Chats">${ICON.list}</button>
        <div class="cl-ht"><b>New chat</b><small></small></div>
        <button class="cl-new2" aria-label="New chat">${ICON.plus}</button>
        <button class="cl-close" aria-label="Close AI mode" ${onClose ? '' : 'hidden'}><svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
      </div>
      <div class="cl-usage" hidden><div class="u-s"><span>Session</span><i><b></b></i><em></em></div><div class="u-w"><span>Weekly</span><i><b></b></i><em></em></div></div>
      <div class="cl-auth" hidden>Claude Code is not signed in on this PC, so messages will fail. Open a terminal and run <b>claude auth login</b> once. Saved chats can still be read.</div>
      <div class="fx-scroll cl-scroll"><div class="view"><div class="cl-msgs"></div></div></div>
      <div class="cl-foot">
        <div class="cl-stat"></div>
        <div class="cl-box">
          <div class="cl-input empty" contenteditable="plaintext-only" spellcheck="false" data-ph="${mcp ? 'Ask Claude to do something in your game' : 'Message Claude'}"></div>
          <div class="cl-row">
            <div class="fx-select cl-pill cl-model" data-value="" data-options='${opt([['', 'Default model'], ['claude-fable-5-2', 'Fable 5.2'], ['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5']])}'></div>
            <div class="fx-select cl-pill cl-effort" data-value="" data-options='${opt([['', 'Default effort'], ['low', 'Low effort'], ['medium', 'Medium effort'], ['high', 'High effort'], ['xhigh', 'Extra high effort'], ['max', 'Max effort']])}'></div>
            <div class="fx-select cl-pill cl-mode" data-value="manual" data-options='${opt([['manual', 'Ask'], ['acceptEdits', 'Accept edits'], ['plan', 'Plan'], ['bypassPermissions', 'Bypass permissions']])}'></div>
            <div class="chipwrap cl-aiwrap"><button class="cl-addai" aria-label="Add or remove an AI">+ AI</button><div class="tb-menu cl-aimenu"></div></div>
            <span class="grow"></span>
            <button class="cl-send" aria-label="Send"></button>
          </div>
        </div>
      </div>
    </div>`;
  root.querySelectorAll('.fx-scroll').forEach(fx.scroll);
  fx.field($('.cl-search'));

  const cl = { runText: '', id: '', cwd: '', title: '', run: '', busy: false, chats: [], cur: null, buf: '', chips: {}, home: '', keys: null, sig: '' };
  let folded = new Set(); try { folded = new Set(JSON.parse(localStorage.getItem('fluxClaudeFolded')) || []); } catch {}
  const base = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || p || '';
  const ago = (ms) => { const s = (Date.now() - ms) / 1000; return s < 60 ? 'now' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h' : s < 604800 ? Math.floor(s / 86400) + 'd' : new Date(ms).toLocaleDateString(); };
  const msgs = () => $('.cl-msgs'), view = () => $('.cl-scroll > .view');
  const scroll = (force) => { const v = view(); if (force || v.scrollHeight - v.scrollTop - v.clientHeight < 200) v.scrollTop = v.scrollHeight; };
  const bubble = (cls) => { const d = fx.el('div', 'cl-b ' + cls); msgs().appendChild(d); return d; };
  const note = (t) => { const d = fx.el('div', 'cl-note'); d.textContent = t; msgs().appendChild(d); return d; };
  let statLabel = '', statT0 = 0, statTimer = null;
  const paintStat = () => { $('.cl-stat').textContent = statLabel ? statLabel + ' · ' + Math.floor((Date.now() - statT0) / 1000) + 's' : ''; };
  const stat = (t) => {
    if (t && !statLabel) statT0 = Date.now();
    statLabel = t; $('.cl-stat').classList.toggle('on', !!t); paintStat();
    clearInterval(statTimer); if (t) statTimer = setInterval(paintStat, 1000);
  };
  const drawer = (on) => root.classList.toggle('drawer', on);

  // ---------------------------------------------------------------- chat list, grouped by folder
  function drawList(quiet) {
    const q = $('.cl-search input').value.trim().toLowerCase();
    const list = $('.cl-list'); list.innerHTML = '';
    list.classList.toggle('quiet', !!quiet);
    const groups = new Map();
    cl.chats.filter((c) => !q || (c.title + ' ' + c.cwd).toLowerCase().includes(q)).forEach((c) => { const k = c.cwd || cl.home; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); });
    for (const [dir, items] of groups) {
      const g = fx.el('div', 'cl-grp' + (folded.has(dir) && !q ? ' folded' : ''));
      const own = items.every((x) => x.custom);   // a custom AI's group: not a folder, so no "new chat in this folder"
      const h = fx.el('div', 'cl-gh', `<span class="cl-chev">${ICON.chev}</span>${ICON.folder}<span class="gn"></span><span class="gc">${items.length}</span><button class="cl-gadd" aria-label="New chat in this folder" ${own ? 'hidden' : ''}>${ICON.plus}</button>`);
      $('.gn', h).textContent = base(dir);
      h.onclick = () => { g.classList.toggle('folded'); g.classList.contains('folded') ? folded.add(dir) : folded.delete(dir); try { localStorage.setItem('fluxClaudeFolded', JSON.stringify([...folded])); } catch {} };
      $('.cl-gadd', h).onclick = (e) => { e.stopPropagation(); newChat(dir); };
      const body = fx.el('div', 'cl-gb'), inner = fx.el('div');
      items.forEach((c) => {
        const r = fx.el('div', 'cl-chat' + (c.id === cl.id ? ' on' : '') + (c.id === cl.id && cl.busy ? ' busy' : ''), '<span class="ct"></span><span class="ca"></span>');
        $('.ct', r).textContent = c.title; $('.ca', r).textContent = ago(c.ts);
        r.onclick = () => openChat(c);
        inner.appendChild(r);
      });
      body.appendChild(inner); g.append(h, body); list.appendChild(g);
    }
    if (!groups.size) list.innerHTML = `<div class="cl-empty">${q ? 'No chats match.' : 'No Claude Code chats were found on this PC yet.'}</div>`;
  }
  async function loadChats(quiet) {
    cl.chats = await winApi.claudeChats().catch(() => cl.chats);
    const sig = cl.chats.map((c) => c.id + c.title + c.cwd + Math.floor(c.ts / 60000)).join('|') + cl.id + cl.busy;
    if (quiet && sig === cl.sig) return;   // nothing visible changed
    cl.sig = sig; drawList(quiet);
  }

  function head() {
    const c = cl.chats.find((x) => x.id === cl.id);
    $('.cl-ht b').textContent = cl.id ? (c ? c.title : cl.title || 'Chat') : 'New chat';
    $('.cl-ht small').textContent = cl.cwd || cl.home;
  }

  // ---------------------------------------------------------------- opening chats
  function showHero() {
    msgs().innerHTML = '';
    const h = fx.el('div', 'cl-hero', `<div class="cl-mark">${ICON.spark}</div><h2>${mcp ? 'AI mode' : 'What can I help with?'}</h2><p>Claude Code works in the folder below, on this PC.</p><button class="cl-dir">${ICON.folder}<span></span><small>Change</small></button><div class="cl-extra"></div>`);
    $('.cl-dir span', h).textContent = cl.cwd || cl.home;
    $('.cl-dir', h).onclick = async () => { const d = await winApi.claudePickDir(); if (d) { cl.cwd = d; $('.cl-dir span', h).textContent = d; head(); } };
    if (hero) hero($('.cl-extra', h));
    msgs().appendChild(h);
  }
  async function newChat(dir) {
    if (cl.busy) return fx.toast('Wait for Claude to finish, or stop it');
    cl.id = ''; cl.title = '';
    cl.cwd = dir || (defaultDir && (await defaultDir())) || cl.cwd || '';
    drawer(false); showHero(); head(); drawList(); $('.cl-input').focus();
  }
  async function openChat(c) {
    if (cl.busy) return fx.toast('Wait for Claude to finish, or stop it');
    cl.id = c.id; cl.cwd = c.custom ? '' : c.cwd; drawer(false); head(); drawList();
    if (c.custom && c.model) {   // that AI goes back into the composer so the next message keeps using it
      const v = 'custom|' + c.ai + '|' + c.model;
      if (JSON.parse($('.cl-model').dataset.options).some((o) => o[0] === v)) { $('.cl-model').dataset.value = v; model = fx.select($('.cl-model'), keep); keep(); }
    }
    msgs().innerHTML = ''; note('Loading…');
    const items = await winApi.claudeHistory(c.id).catch(() => []);
    if (cl.id !== c.id) return;
    cl.keys = null; showItems(items);
    if (!items.length) note('This chat has nothing to show.');
    requestAnimationFrame(() => scroll(true));
  }
  const keyOf = (it) => it.role + ':' + it.text.length + ':' + (it.tools ? it.tools.length : 0);
  function itemEl(it) {
    const box = fx.el('div', 'cl-item');
    if (it.role === 'user') { const b = fx.el('div', 'cl-b u'); b.textContent = it.text; box.appendChild(b); return box; }
    if (it.text) { const b = fx.el('div', 'cl-b a'); b.innerHTML = claudeMd(it.text); box.appendChild(b); }
    if (it.tools && it.tools.length) { const d = chip(it.tools.length + (it.tools.length > 1 ? ' tool calls' : ' tool call'), it.tools.map((x) => x.n.replace(/^mcp__flux-executor__/, '')).join(', ')); $('pre', d).textContent = it.tools.map((x) => x.n + '  ' + x.s).join('\n'); box.appendChild(d); }
    return box;
  }
  /** draws the chat from the file; when only the end changed, only the end is redrawn */
  function showItems(items) {
    const keys = items.map(keyOf);
    let i = 0;
    if (cl.keys) while (i < keys.length && i < cl.keys.length && keys[i] === cl.keys[i]) i++;
    else msgs().innerHTML = '';
    if (cl.keys && i === keys.length && i === cl.keys.length) return;
    const nodes = msgs().querySelectorAll(':scope > .cl-item');
    for (let k = i; k < nodes.length; k++) nodes[k].remove();
    const f = document.createDocumentFragment();
    items.slice(i).forEach((it) => f.appendChild(itemEl(it)));
    msgs().appendChild(f);
    cl.keys = keys;
  }
  // another Claude Code window (or this one) wrote to a chat: follow it
  async function sync(ids) {
    loadChats(true);
    if (!cl.id || cl.busy || !ids.includes(cl.id)) return;
    const id = cl.id, v = view(), atEnd = v.scrollHeight - v.scrollTop - v.clientHeight < 200;
    const items = await winApi.claudeHistory(id).catch(() => null);
    if (!items || cl.id !== id || cl.busy) return;
    if (!cl.keys) msgs().innerHTML = '';
    showItems(items);
    if (atEnd) scroll(true);
  }

  // ---------------------------------------------------------------- a running answer
  function chip(name, hintText) {
    const d = fx.el('div', 'cl-tool', `<div class="th">${ICON.tool}<b></b><span></span><i>${ICON.chev}</i></div><div class="tb"><div><pre></pre></div></div>`);
    $('b', d).textContent = name.replace(/^mcp__flux-executor__/, ''); $('span', d).textContent = hintText;
    $('.th', d).onclick = () => d.classList.toggle('open');
    msgs().appendChild(d); return d;
  }

  const hintOf = (i) => { i = i || {}; for (const k of ['command', 'file_path', 'path', 'code', 'pattern', 'url', 'description', 'prompt', 'query']) if (typeof i[k] === 'string') return i[k].replace(/\s+/g, ' ').slice(0, 160); return ''; };
  let raf = 0;
  const draw = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; if (cl.cur) { cl.cur.innerHTML = claudeMd(cl.buf) + '<span class="cl-caret"></span>'; scroll(); } }); };
  function onEvent(o) {
    if (o.session_id && cl.busy && o.session_id !== cl.id) { cl.id = o.session_id; head(); }
    if (o.type === 'system') {
      if (o.subtype === 'hook_started' && cl.busy) stat('Running your hooks');
      else if (o.subtype === 'init') stat('Connecting');
      return;
    }
    if (o.type === 'stream_event' && o.event && o.event.type === 'message_start') stat('Thinking');
    if (o.type === 'stream_event') {
      const e = o.event || {}, b = e.content_block || {};
      if (e.type === 'content_block_start' && b.type === 'text') { cl.cur = bubble('a'); cl.buf = ''; stat('Writing'); }
      else if (e.type === 'content_block_start' && b.type === 'thinking') stat('Thinking');
      else if (e.type === 'content_block_start' && b.type === 'tool_use') stat('Using ' + b.name.replace(/^mcp__flux-executor__/, ''));
      else if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') { if (!cl.cur) { cl.cur = bubble('a'); cl.buf = ''; } cl.buf += e.delta.text; draw(); }
    } else if (o.type === 'assistant') {
      for (const b of (o.message && o.message.content) || []) {
        if (b.type === 'text') { cl.runText += '\n' + b.text; if (cl.cur) { cl.cur.innerHTML = claudeMd(b.text); cl.cur = null; } else bubble('a').innerHTML = claudeMd(b.text); }
        else if (b.type === 'tool_use' && !cl.chips[b.id]) cl.chips[b.id] = chip(b.name, hintOf(b.input));
      }
      scroll();
    } else if (o.type === 'user') {
      for (const b of (o.message && o.message.content) || []) {
        const c = b.type === 'tool_result' && cl.chips[b.tool_use_id]; if (!c) continue;
        const tx = typeof b.content === 'string' ? b.content : (b.content || []).map((x) => x.text || (x.type === 'image' ? '[image]' : '')).join('\n');
        $('pre', c).textContent = tx.slice(0, 4000); if (b.is_error) c.classList.add('err');
      }
      scroll();
    } else if (o.type === 'result') {
      stat('');
      if (onCode && !o.is_error) {   // the script Claude wrote goes into the Executor's current tab
        const blocks = [...cl.runText.matchAll(/```(?:lua|luau)?[^\n]*\n([\s\S]*?)```/gi)].map((m) => m[1].trim()).filter(Boolean);
        if (blocks.length) onCode(blocks[blocks.length - 1]);
      }
      if (o.is_error || (o.subtype && o.subtype !== 'success')) bubble('e').textContent = String(o.result || o.subtype || 'Something went wrong');
      else note([o.duration_ms ? (o.duration_ms / 1000).toFixed(1) + 's' : '', o.total_cost_usd != null ? '$' + (+o.total_cost_usd).toFixed(3) : ''].filter(Boolean).join(' · '));
      scroll();
    } else if (o.type === 'stderr' && o.text) note(o.text);
    else if (o.type === 'exit') done();
  }

  function done() { cl.busy = false; cl.run = ''; cl.keys = null; if (cl.cur) cl.cur.innerHTML = claudeMd(cl.buf); cl.cur = null; $('.cl-send').innerHTML = ICON.send; $('.cl-send').classList.remove('stop'); stat(''); loadChats(); }

  async function send() {
    const box = $('.cl-input'), text = box.innerText.trim();
    if (!text || cl.busy) return;
    if ($('.cl-hero', msgs())) msgs().innerHTML = '';
    bubble('u').textContent = text; box.textContent = ''; box.classList.add('empty');
    cl.busy = true; cl.chips = {}; cl.cur = null; cl.buf = ''; cl.runText = '';
    $('.cl-send').innerHTML = ICON.stop; $('.cl-send').classList.add('stop'); stat('Starting'); scroll(true);
    let r;
    const mv = model.get(), custom = mv.startsWith('custom|') ? mv.split('|') : null;
    if (cl.id && cl.id.startsWith('ai-') && !custom) return fx.toast('This chat talks to a custom AI — pick it in the model list');
    try { r = await winApi.claudeSend({ id: cl.id, cwd: cl.id ? '' : cl.cwd, model: custom ? custom.slice(2).join('|') : mv, provider: custom ? custom[1] : undefined, effort: effort.get(), mode: mode.get(), text, mcp }); }
    catch (e) { r = { error: 'Could not start Claude Code: ' + (e && e.message ? e.message : e) }; }
    if (!r || r.error) { done(); bubble('e').textContent = (r && r.error) || 'Could not start Claude Code'; return; }
    if (r.forked) note('This chat is still open in another Claude Code window, so it continues here as a copy.');
    if (!cl.id) cl.title = text.slice(0, 70);
    cl.id = r.id; cl.run = r.run; head(); drawList();
  }

  // ---------------------------------------------------------------- composer
  const PREF = 'fluxClaude' + (mcp ? 'Ai' : '');
  const pref = (() => { try { return JSON.parse(localStorage.getItem(PREF)) || {}; } catch { return {}; } })();
  for (const [s, k] of [['.cl-model', 'model'], ['.cl-effort', 'effort'], ['.cl-mode', 'mode']]) if (pref[k] != null && JSON.parse($(s).dataset.options).some((o) => o[0] === pref[k])) $(s).dataset.value = pref[k];
  const keep = () => { try { localStorage.setItem(PREF, JSON.stringify({ model: model.get(), effort: effort.get(), mode: mode.get() })); } catch {} };
  let model = fx.select($('.cl-model'), keep);
  const effort = fx.select($('.cl-effort'), keep);
  const BASE_MODELS = JSON.parse($('.cl-model').dataset.options);
  async function loadModels() {
    const ais = (winApi.aiList && (await winApi.aiList().catch(() => []))) || [];
    const opts = BASE_MODELS.concat(...ais.map((p) => p.models.map((m) => ['custom|' + p.id + '|' + m, p.name + ': ' + m])));
    const el = $('.cl-model'), v = model.get();
    el.dataset.options = JSON.stringify(opts);
    el.dataset.value = opts.some((o) => o[0] === v) ? v : (opts.some((o) => o[0] === pref.model) ? pref.model : '');
    model = fx.select(el, keep);
  }
  // ---- custom AIs: + AI opens a menu to add one, jump to one, or remove one
  const aiwrap = $('.cl-aiwrap'), aimenu = $('.cl-aimenu', aiwrap);
  fx.popover(aiwrap, $('.cl-addai', aiwrap));
  async function drawAiMenu() {
    const ais = (winApi.aiList && (await winApi.aiList().catch(() => []))) || [];
    aimenu.innerHTML = `<button class="menu-item" data-add>${ICON.plus}<span>Add an AI…</span></button><div class="menu-sep"></div>`;
    for (const p of ais) {
      const it = fx.el('div', 'menu-item', '<span class="ai-n"></span><span class="ai-c"></span><button class="ai-x" aria-label="Remove"><svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></button>');
      $('.ai-n', it).textContent = p.name; $('.ai-c', it).textContent = p.models.length;
      it.setAttribute('aria-label', p.name);
      it.onclick = () => {   // jump to that AI: its first model goes into the composer
        const opts = JSON.parse($('.cl-model').dataset.options), v = opts.find((o) => o[0].startsWith('custom|' + p.id + '|'));
        if (v) { $('.cl-model').dataset.value = v[0]; model = fx.select($('.cl-model'), keep); keep(); }
      };
      $('.ai-x', it).onclick = async (e) => {
        e.stopPropagation();   // the menu stays open and refreshes instead
        if (!(await fx.ask({ title: 'Remove this AI?', text: `"${p.name}" and its models leave the list. Its chats stay readable.`, ok: 'Remove', cancel: 'Keep' }))) return;
        if (winApi.aiRemove) await winApi.aiRemove(p.id);
        await loadModels(); drawAiMenu(); fx.toast(p.name + ' removed');
      };
      aimenu.appendChild(it);
    }
    if (!ais.length) { const h = fx.el('div', 'ai-hint'); h.textContent = 'Any OpenAI-compatible API works: base URL + key.'; aimenu.appendChild(h); }
  }
  aimenu.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-add]')) return;
    const base = await fx.ask({ title: 'Add an AI', text: 'The API base URL of any OpenAI-compatible service (OpenAI, OpenRouter, Groq, LM Studio, Ollama...).', ok: 'Next', cancel: 'Cancel', input: { placeholder: 'https://api.openai.com/v1', value: '' } });
    if (!base) return;
    const key = await fx.ask({ title: 'API key', text: 'Leave it empty if this API needs none. It is stored encrypted on the PC.', ok: 'Add', cancel: 'Cancel', input: { placeholder: 'sk-...', value: '' } });
    if (key == null) return;
    const r = await winApi.aiAdd({ base, key: key.trim() });
    if (r.error) return fx.toast(r.error);
    await loadModels(); drawAiMenu(); fx.toast(`Added ${r.name}: ${r.models.length} models`);
  });
  const mode = fx.select($('.cl-mode'), () => { keep(); $('.cl-mode').classList.toggle('danger', mode.get() === 'bypassPermissions'); });
  $('.cl-mode').classList.toggle('danger', mode.get() === 'bypassPermissions');

  const box = $('.cl-input');
  box.addEventListener('input', () => box.classList.toggle('empty', !box.innerText.trim()));
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  box.addEventListener('focus', () => $('.cl-box').classList.add('focus'));
  box.addEventListener('blur', () => $('.cl-box').classList.remove('focus'));
  $('.cl-send').innerHTML = ICON.send;
  $('.cl-send').onclick = () => { if (cl.busy) { winApi.claudeStop(cl.run); stat('Stopping'); } else send(); };
  $('.cl-new').onclick = () => newChat();
  $('.cl-new2').onclick = () => newChat();
  $('.cl-close').onclick = () => onClose && onClose();
  $('.cl-chats').onclick = () => drawer(!root.classList.contains('drawer'));
  $('.cl-search input').addEventListener('input', drawList);
  msgs().addEventListener('click', async (e) => {
    const b = e.target.closest('.cl-cp'); if (!b) return;
    if (await winApi.copy(b.parentNode.querySelector('code').textContent)) { b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1200); }
  });

  const when = (s) => { const d = new Date(s * 1000), soon = d - Date.now() < 864e5; return d.toLocaleString([], soon ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric' }); };
  function showUsage(u) {
    const box = $('.cl-usage'); if (!u || (!u.session && !u.weekly)) return;
    box.hidden = false;
    for (const [cls, w] of [['.u-s', u.session], ['.u-w', u.weekly]]) {
      const el = $(cls, box); el.hidden = !w; if (!w) continue;
      const pct = Math.round((w.utilization || 0) * 100);
      $('b', el).style.width = Math.min(100, pct) + '%';
      el.classList.toggle('hot', pct >= 90);
      $('em', el).textContent = pct + '%' + (w.resetsAt ? ' · resets ' + when(w.resetsAt) : '');
    }
  }

  let started = false;
  async function open() {
    if (!started) {
      started = true;
      winApi.onClaude((key, o) => { if (key === cl.run) onEvent(o); });   // winApi is defined by client.js, which loads after this file
      if (winApi.onClaudeChanged) winApi.onClaudeChanged((ids) => { if (root.offsetParent) sync(ids); });   // only while this chat is on screen
      if (winApi.onClaudeUsage) winApi.onClaudeUsage(showUsage);
      if (winApi.claudeUsage) winApi.claudeUsage().then(showUsage).catch(() => {});
      loadModels();
      drawAiMenu();
      cl.home = await winApi.claudeHome();
      await newChat();
    }
    loadChats();
    winApi.claudeAuth().then((a) => { $('.cl-auth').hidden = !!a.loggedIn; }).catch(() => {});
  }
  return { open, newChat };
}

const Claude = typeof document === 'undefined' || !document.querySelector('#clRoot') ? null : ClaudeChat(document.querySelector('#clRoot'));
