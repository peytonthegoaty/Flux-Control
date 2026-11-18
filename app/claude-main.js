// Claude page and Executor AI mode, main-process side: lists the Claude Code chats saved on this PC (~/.claude/projects),
// reads one (incrementally, so a live chat can be followed cheaply), watches for changes, and runs the Claude Code CLI
// (`claude -p`, streaming JSON). Every run is logged to FluxControl/claude.log.
const { ipcMain, dialog, BrowserWindow, safeStorage } = require('electron');
const { spawn, execFile } = require('child_process');
const readline = require('readline');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const mcp = require('./mcp');

const projects = () => path.join(os.homedir(), '.claude', 'projects');
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '');
const lines = (s) => s.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const safeDir = (p) => { try { return fs.readdirSync(p); } catch { return []; } };

// ---------------------------------------------------------------- log (for "it never started" reports)
const logFile = () => path.join(process.env.FLUX_HOME || path.join(process.env.LOCALAPPDATA || os.homedir(), 'FluxControl'), 'claude.log');
function log(...a) {
  try {
    const f = logFile();
    if (fs.existsSync(f) && fs.statSync(f).size > 1 << 20) fs.renameSync(f, f + '.old');
    fs.appendFileSync(f, new Date().toISOString() + ' ' + a.join(' ') + '\n');
  } catch {}
}

const files = new Map();   // id -> path of its .jsonl
function sessionFile(id) {
  if (!isUuid(id)) return null;
  if (files.has(id) && fs.existsSync(files.get(id))) return files.get(id);
  for (const d of safeDir(projects())) { const p = path.join(projects(), d, id + '.jsonl'); if (fs.existsSync(p)) { files.set(id, p); return p; } }
  return null;
}

// the head of a chat file says where it ran and what it is about; once both are known they are kept
const heads = new Map();
function head(p, mtime) {
  const c = heads.get(p); if (c && (c.mtime === mtime || (c.cwd && c.named))) return c;
  let cwd = '', name = '', first = '';
  try {
    const fd = fs.openSync(p, 'r'), buf = Buffer.alloc(256 * 1024), n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    for (const v of lines(buf.toString('utf8', 0, n))) {
      if (!cwd && v.cwd) cwd = v.cwd;
      if (v.customTitle || v.aiTitle) name = v.customTitle || v.aiTitle;
      if (!first && v.type === 'user' && !v.isSidechain && !v.isMeta) { const t = textOf(v.message && v.message.content).trim(); if (t && !t.startsWith('<')) first = t.slice(0, 90); }
    }
  } catch {}
  const r = { mtime, cwd, title: name || first, named: !!name };
  heads.set(p, r);
  return r;
}

/** Saved chats, newest first: { id, title, cwd, ts } */
// chats started in Flux Control (the lists show only these, never the PC's other Claude Code chats): id -> 'claude' | 'exec'
const ownFile = () => path.join(process.env.FLUX_HOME || path.join(process.env.LOCALAPPDATA || os.homedir(), 'FluxControl'), 'flux-chats.json');
let own = {}; try { own = JSON.parse(fs.readFileSync(ownFile(), 'utf8')) || {}; } catch {}
try { for (const id of JSON.parse(fs.readFileSync(ownFile().replace('flux-chats', 'exec-chats'), 'utf8'))) own[id] = 'exec'; } catch {}   // from 0.15.4
const markOwn = (id, kind) => { if (!id || own[id] === kind) return; own[id] = kind; try { fs.writeFileSync(ownFile(), JSON.stringify(own)); } catch {} };

function chats() {
  const found = [];
  for (const d of safeDir(projects())) for (const f of safeDir(path.join(projects(), d))) {
    if (!f.endsWith('.jsonl') || !isUuid(f.slice(0, -6))) continue;
    const p = path.join(projects(), d, f);
    try { found.push({ p, id: f.slice(0, -6), m: fs.statSync(p).mtimeMs }); files.set(f.slice(0, -6), p); } catch {}
  }
  found.sort((a, b) => b.m - a.m);
  const claude = found.filter((x) => own[x.id]).slice(0, 200).map((x) => { const h = head(x.p, x.m); return h.title ? { id: x.id, title: h.title, cwd: h.cwd, ts: x.m, own: own[x.id] } : null; }).filter((c) => c && c.own);
  // the custom AIs' chats join the list; their "folder" is the AI's name
  const custom = [...aiChats.values()].filter((c) => c.title).sort((a, b) => b.ts - a.ts)
    .map((c) => ({ id: c.id, title: c.title, cwd: aiName(c.provider, c.name), ts: c.ts, custom: true, ai: c.provider, model: c.model }));
  return claude.concat(custom).sort((a, b) => b.ts - a.ts);
}

const hint = (i) => { i = i || {}; for (const k of ['command', 'file_path', 'path', 'code', 'pattern', 'url', 'description', 'prompt', 'query']) if (typeof i[k] === 'string') return i[k].replace(/\s+/g, ' ').slice(0, 160); return ''; };

// chat files only grow, so each one is read from where the last read stopped; only the readable parts are kept
const reads = new Map();   // path -> { size, rest: Buffer, rows: [{ role, text, tools }] }
function rowsOf(p) {
  let size; try { size = fs.statSync(p).size; } catch { return []; }
  let c = reads.get(p);
  if (!c || size < c.size) c = { size: 0, rest: Buffer.alloc(0), rows: [] };
  if (size > c.size) {
    const fd = fs.openSync(p, 'r'), buf = Buffer.alloc(size - c.size);
    fs.readSync(fd, buf, 0, buf.length, c.size); fs.closeSync(fd);
    const all = Buffer.concat([c.rest, buf]), cut = all.lastIndexOf(10) + 1;   // only whole lines; a half-written one waits
    c.rest = all.subarray(cut); c.size = size;
    for (const v of lines(all.subarray(0, cut).toString('utf8'))) {
      if (v.isSidechain || v.isMeta) continue;
      const m = v.message && v.message.content;
      if (v.type === 'user') { const t = textOf(m); if (t && !t.startsWith('<')) c.rows.push({ role: 'user', text: t.slice(0, 20000) }); }
      else if (v.type === 'assistant') {
        const t = textOf(m), tools = (Array.isArray(m) ? m : []).filter((b) => b.type === 'tool_use').map((b) => ({ n: b.name, s: hint(b.input) }));
        if (t || tools.length) c.rows.push({ role: 'assistant', text: t.slice(0, 20000), tools });
      }
    }
    reads.set(p, c);
  }
  return c.rows;
}

/** The readable part of a saved chat (last 80 turns): text and the tools that ran. */
function history(id) {
  const p = sessionFile(id);
  if (!p && (String(id).startsWith('ai-') || aiChats.has(id))) {   // a custom AI's chat (or OpenCode in API mode): same shape, built from what it kept
    const items = [];
    for (const m of (aiChats.get(id) || {}).msgs || []) {
      if (m.role === 'user') items.push({ role: 'user', text: String(m.content || '').slice(0, 20000) });
      else if (m.role === 'assistant') {
        const calls = (m.tool_calls || []).map((t) => ({ n: (t.function && t.function.name) || 'tool', s: String((t.function && t.function.arguments) || '').slice(0, 160) }));
        const text = typeof m.content === 'string' ? m.content : '';
        const last = items[items.length - 1];
        if (last && last.role === 'assistant') { last.text = last.text && text ? last.text + '\n\n' + text : last.text + text; last.tools = last.tools.concat(calls); }
        else items.push({ role: 'assistant', text, tools: calls });
      }
    }
    return items.slice(-80);
  }
  if (!p) return [];
  const items = [];
  for (const r of rowsOf(p)) {
    const last = items[items.length - 1];
    if (r.role === 'assistant' && last && last.role === 'assistant') { last.text = last.text && r.text ? last.text + '\n\n' + r.text : last.text + r.text; last.tools = last.tools.concat(r.tools); }
    else items.push({ ...r, tools: r.tools ? r.tools.slice() : undefined });
  }
  return items.slice(-80);
}

// ---------------------------------------------------------------- live sync: tell pages which chats changed (at most every 150 ms)
let watcher = null, changed = new Set(), flushT = null;
function watch() {
  if (watcher) return;
  try {
    watcher = fs.watch(projects(), { recursive: true }, (_e, f) => {
      if (!f || !f.endsWith('.jsonl') || /subagents/.test(f)) return;
      changed.add(path.basename(f, '.jsonl'));
      if (!flushT) flushT = setTimeout(() => {
        flushT = null;
        const ids = [...changed]; changed.clear();
        broadcast('claude:changed', ids);
      }, 150);
    });
    watcher.on('error', () => { watcher = null; });
  } catch { watcher = null; }
}

// ---------------------------------------------------------------- running Claude Code
// Claude Desktop hands its own session variables to child processes; the CLI would wait for that host, so they are removed
function env() {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if ((k.startsWith('CLAUDE') && k !== 'CLAUDE_CONFIG_DIR') || k === 'ANTHROPIC_BASE_URL') delete e[k];
  return e;
}
const exe = () => { const p = path.join(os.homedir(), '.local', 'bin', 'claude.exe'); return fs.existsSync(p) ? p : 'claude'; };

const AI_PROMPT = 'You are running inside the Executor of Flux Control and are connected to a live Roblox game through the user\'s executor. Use the flux-executor MCP tools to look at and act in the game: start with get_game_info, explore with get_tree and search_instances, read scripts with get_script_source, and run Luau with run_lua. The working folder is the executor workspace, where the user\'s saved .lua scripts live; save new scripts there when asked.';
const MODES = ['manual', 'acceptEdits', 'plan', 'bypassPermissions'], EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const runs = new Map();   // run key -> { sid, child }

/** Starts one message. d: { id?, cwd?, model?, effort?, mode, text, mcp? }. Output arrives as 'claude:line' events. */
async function start(sender, d) {
  const text = String(d.text || '').trim();
  if (!text || text.length > 100000) return { error: 'Write a message first' };
  if (d.provider) return startCustom(sender, d, text);
  const resume = !!d.id;
  if (resume && !isUuid(d.id)) return { error: 'Unknown chat' };
  const sid = resume ? d.id : crypto.randomUUID();
  if ([...runs.values()].some((r) => r.sid === sid)) return { error: 'That chat is still answering' };
  let cwd = String(d.cwd || '').trim();
  if (!cwd && resume) cwd = (chats().find((c) => c.id === sid) || {}).cwd || '';
  if (!cwd) cwd = os.homedir();
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return { error: 'That folder does not exist' };
  const mode = MODES.includes(d.mode) ? d.mode : 'manual';
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', mode, resume ? '--resume' : '--session-id', sid];
  // a chat that is still open in another Claude Code window continues as a copy, so the two never fight over one file
  const p = resume && sessionFile(sid);
  const live = !!p && !own[sid] && Date.now() - fs.statSync(p).mtimeMs < 90000;   // our own chats (just written by us, e.g. after a model switch) never fork
  if (live) args.push('--fork-session');
  if (d.model) { if (!/^[\w.[\]-]{1,60}$/.test(d.model)) return { error: 'Unknown model' }; args.push('--model', d.model); }
  if (d.effort) { if (!EFFORTS.includes(d.effort)) return { error: 'Unknown effort' }; args.push('--effort', d.effort); }
  if (d.mcp) {   // Executor AI mode: the flux-executor tools reach the live game through the load script
    let url; try { url = await mcp.ensure(); } catch (e) { return { error: 'Could not start the game tools: ' + e.message }; }
    const cfg = path.join(os.tmpdir(), `flux-mcp-${process.pid}.json`);
    fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { 'flux-executor': { type: 'http', url } } }));
    // only the game tools: the PC's other MCP servers would add hundreds of tool definitions (tokens) to every chat
    args.push('--strict-mcp-config', '--mcp-config', cfg, '--allowedTools', 'mcp__flux-executor', '--append-system-prompt', AI_PROMPT);
  }

  let child;
  const t0 = Date.now();
  log('start', exe(), 'cwd=' + cwd, args.filter((a) => a !== AI_PROMPT).join(' '));
  const runEnv = env();
  if (['off', 'lite', 'full', 'ultra'].includes(d.ponytail)) runEnv.PONYTAIL_DEFAULT_MODE = d.ponytail;   // the ponytail plugin's level for this message (its SessionStart hook reads it)
  try { child = spawn(exe(), args, { cwd, env: runEnv, windowsHide: true }); } catch (e) { log('spawn failed', e.message); return { error: 'Could not start Claude Code: ' + e.message }; }
  const key = crypto.randomUUID();
  runs.set(key, { sid, child });
  markOwn(sid, d.mcp ? 'exec' : 'claude');
  let firstOut = true;
  const send = (o) => { if (!sender.isDestroyed()) sender.send('claude:line', key, o); };
  child.on('error', (e) => { log('error', e.code || '', e.message); send({ type: 'stderr', text: e.code === 'ENOENT' ? 'Claude Code is not installed on this PC.' : e.message }); });
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    if (firstOut) { firstOut = false; log('first output after', Date.now() - t0, 'ms'); }
    let o; try { o = JSON.parse(l); } catch { return send({ type: 'stderr', text: l }); }
    if (o.type === 'rate_limit_event') setUsage(o.rate_limit_info);
    if (o.session_id) markOwn(o.session_id, d.mcp ? 'exec' : 'claude');   // a chat continued as a copy gets a new id
    send(o);
  });
  readline.createInterface({ input: child.stderr }).on('line', (l) => { log('stderr', l); send({ type: 'stderr', text: l }); });
  child.on('close', (code) => { log('exit', code, 'after', Date.now() - t0, 'ms'); runs.delete(key); send({ type: 'exit', code }); });
  child.stdin.on('error', () => {});
  child.stdin.end(text);
  return { run: key, id: sid, forked: live };
}

// ---------------------------------------------------------------- usage: Claude Code reports the plan's limits with every answer
const home = () => process.env.FLUX_HOME || path.join(process.env.LOCALAPPDATA || os.homedir(), 'FluxControl');
let usage = null;
try { usage = JSON.parse(fs.readFileSync(path.join(home(), 'usage.json'), 'utf8')); } catch {}
function setUsage(info) {
  const w = (info && info.unifiedWindows) || {};
  usage = { at: Date.now(), session: w.five_hour || null, weekly: w.seven_day || null };
  try { fs.mkdirSync(home(), { recursive: true }); fs.writeFileSync(path.join(home(), 'usage.json'), JSON.stringify(usage)); } catch {}
  broadcast('claude:usage', usage);
}

// pages that get chat events: app windows, plus web clients (main.js adds a sink that relays through the host)
const sinks = new Set();
function broadcast(ch, ...a) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(ch, ...a);
  for (const s of sinks) s(ch, ...a);
}

// ---------------------------------------------------------------- custom AIs (any OpenAI-compatible API: base URL + key)
const aiFile = () => path.join(home(), 'ai.json');
const readAi = () => { try { const v = JSON.parse(fs.readFileSync(aiFile(), 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; } };
const writeAi = (v) => { fs.mkdirSync(home(), { recursive: true }); fs.writeFileSync(aiFile(), JSON.stringify(v)); };
const seal = (k) => (safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(k).toString('base64') : k);   // keys are stored encrypted for this Windows user
const unseal = (k) => (String(k).startsWith('enc:') ? safeStorage.decryptString(Buffer.from(k.slice(4), 'base64')) : k);
const cleanBase = (b) => String(b || '').trim().replace(/\/+$/, '').replace(/\/(chat\/completions|models)$/, '');

async function aiAdd({ base, key, name }) {
  base = cleanBase(base);
  if (!/^https?:\/\/[^\s]+$/i.test(base)) return { error: 'Enter the API base URL, like https://api.openai.com/v1' };
  let models;
  try {
    const r = await fetch(base + '/models', { headers: key ? { Authorization: 'Bearer ' + key } : {} });
    if (!r.ok) return { error: `The API answered ${r.status}. Check the URL and key.` };
    const j = await r.json();
    models = (Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : Array.isArray(j) ? j : []).map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean).slice(0, 300);
  } catch (e) { return { error: 'Could not reach that API: ' + e.message }; }
  if (!models.length) return { error: 'That API did not list any models' };
  const old = readAi().find((x) => x.base === base);   // re-adding one keeps its id, so its chats keep working
  const list = readAi().filter((x) => x.base !== base);
  const p = { id: old ? old.id : crypto.randomBytes(4).toString('hex'), name: String(name || (old && old.name) || new URL(base).hostname).slice(0, 40), base, key: key ? seal(key) : '', models };
  list.push(p); writeAi(list);
  return { id: p.id, name: p.name, models };
}
// OpenCode: "personal" runs through the local OpenCode CLI; "api" talks to an OpenAI-compatible endpoint (e.g. `opencode serve`)
const ocExe = () => { const p = path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'); return fs.existsSync(p) ? p : null; };
const ocCfgFile = () => path.join(home(), 'opencode.json');
const readOcCfg = () => { try { const c = JSON.parse(fs.readFileSync(ocCfgFile(), 'utf8')); return { mode: c.mode === 'api' ? 'api' : 'cli', base: cleanBase(c.base) || 'http://127.0.0.1:4096/v1', key: c.key || '' }; } catch { return { mode: 'cli', base: 'http://127.0.0.1:4096/v1', key: '' }; } };
const writeOcCfg = (c) => { fs.mkdirSync(home(), { recursive: true }); fs.writeFileSync(ocCfgFile(), JSON.stringify(c)); };
let ocFree = null, ocApiModels = null, ocApiBase = '', ocApiEff = '';
const ocApiBases = (base) => {
  base = cleanBase(base);
  const out = [base];
  if (/\/v1$/i.test(base)) out.push(base.replace(/\/v1$/i, '')); else out.push(base + '/v1');
  return [...new Set(out.filter(Boolean))];
};
const ocFetchModels = async (cfg) => {
  const key = cfg.key ? unseal(cfg.key) : '';
  for (const b of ocApiBases(cfg.base)) {
    try {
      const r = await fetch(b + '/models', { headers: key ? { Authorization: 'Bearer ' + key } : {} });
      if (!r.ok) continue;
      const j = await r.json().catch(() => null);
      const m = (Array.isArray(j && j.data) ? j.data : Array.isArray(j && j.models) ? j.models : Array.isArray(j) ? j : []).map((x) => (typeof x === 'string' ? x : x && (x.id || x.name))).filter(Boolean).slice(0, 300);
      if (m.length) return { models: m, eff: b };
    } catch (e) { log('opencode api models', b, e.message || e); }
  }
  return { models: [], eff: cleanBase(cfg.base) };
};
const ocModels = () => {
  const cfg = readOcCfg();
  if (cfg.mode === 'api') {
    if (ocApiModels && ocApiBase === cleanBase(cfg.base)) return Promise.resolve(ocApiModels);
    return ocFetchModels(cfg).then(({ models, eff }) => {
      ocApiBase = cleanBase(cfg.base);
      if (models.length) { ocApiModels = models; ocApiEff = eff; }
      return models.length ? models : (ocApiBase === cleanBase(cfg.base) && ocApiModels ? ocApiModels : []);
    });
  }
  return (ocFree || !ocExe() ? Promise.resolve(ocFree || []) : new Promise((ok) => execFile(ocExe(), ['models'], { windowsHide: true, timeout: 60000 }, (_e, out) => {
    const m = String(out || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[\w.-]+\/[\w.:\/@-]+$/.test(s));   // every model OpenCode has, all its providers (provider/model)
    if (m.length) ocFree = m;
    ok(m);
  })));
};
const aiList = async () => {
  const list = readAi().map(({ id, name, base, models }) => ({ id, name, base, models }));
  const oc = await ocModels();
  const cfg = readOcCfg();
  const show = oc.length || ocExe() || cfg.mode === 'api';   // show the entry so its mode can be configured/restarted
  return show ? [{ id: 'opencode', name: 'OpenCode', base: cfg.mode === 'api' ? cfg.base : '', models: oc, builtIn: true, mode: cfg.mode }, ...list] : list;
};
const ocSessions = new Map();   // our chat id -> OpenCode session id (CLI mode)
async function startOpenCode(sender, d, text) {
  const cfg = readOcCfg();
  if (cfg.mode === 'api') return startOpenCodeApi(sender, d, text, cfg);
  const exe = ocExe(); if (!exe) return { error: 'OpenCode is not installed on this PC' };
  const model = String(d.model || '');
  if (!/^[\w.-]+\/[\w.:\/@-]{1,120}$/.test(model)) return { error: 'Unknown model' };
  if (text.length > 30000) return { error: 'That message is too long for OpenCode (30,000 characters at most)' };
  const id = d.id && aiChats.has(d.id) ? d.id : 'oc-' + crypto.randomUUID();
  const chat = aiChats.get(id) || { id, provider: 'opencode', name: 'OpenCode', model: '', title: '', ts: 0, msgs: [] };
  chat.provider = 'opencode'; chat.name = 'OpenCode'; chat.model = model || chat.model;
  if (!chat.title) chat.title = text.slice(0, 70);
  chat.ts = Date.now();
  aiChats.set(id, chat);
  chat.msgs.push({ role: 'user', content: text.slice(0, 40000) });
  saveAiChats(); broadcast('claude:changed', [id]);
  let cwd = String(d.cwd || '').trim(); if (!cwd || !fs.existsSync(cwd)) cwd = os.homedir();
  const args = ['run', '-m', model, '--format', 'json'];
  if (d.mcp) args.push('--auto');
  const ocSid = chat.ocSid || ocSessions.get(id);
  if (ocSid) args.push('-s', ocSid);
  let prompt = text;
  let mcpCfg = null;
  if (d.mcp) {
    try {
      const url = await mcp.ensure();
      mcpCfg = path.join(os.tmpdir(), 'flux-oc-mcp-' + process.pid + '-' + Date.now() + '.json');
      fs.writeFileSync(mcpCfg, JSON.stringify({ mcp: { 'flux-executor': { type: 'remote', url, enabled: true } } }));
      prompt = AI_PROMPT + '\n\nUser request: ' + text;
    } catch (e) { return { error: 'Could not start the game tools: ' + e.message }; }
  }
  args.push(prompt);   // spawn passes it as one argument, never through a shell
  const env = { ...process.env };
  if (mcpCfg) env.OPENCODE_CONFIG = mcpCfg;
  let child; try { child = spawn(exe, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env }); } catch (e) { try { if (mcpCfg) fs.rmSync(mcpCfg, { force: true }); } catch {} return { error: 'Could not start OpenCode: ' + e.message }; }
  try { child.stdin.end(); } catch {}
  const key = crypto.randomUUID(), t0 = Date.now();
  runs.set(key, { sid: id, child });
  const send = (o) => { if (!sender.isDestroyed()) sender.send('claude:line', key, o); };
  const errs = [];
  let hadErr = null;
  const textParts = [];
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    let o; try { o = JSON.parse(l); } catch { return; }
    if (o.sessionID) { chat.ocSid = o.sessionID; ocSessions.set(id, o.sessionID); }
    const p = o.part || {};
    if ((o.type === 'text' || p.type === 'text') && (p.text || o.text)) {
      const t = p.text || o.text;
      textParts.push(t);
      send({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
    } else if (p.type === 'tool' || o.type === 'tool_use') {
      const st = p.state || {};
      send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: p.callID || p.id, name: p.tool || 'tool', input: st.input || {} }] } });
      if (st.status === 'completed' || st.status === 'error' || st.output != null || st.error) send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: p.callID || p.id, content: String(st.output || st.error || ''), is_error: !!st.error || st.status === 'error' }] } });
    } else if (o.type === 'error') {
      const msg = (o.error && ((o.error.data && o.error.data.message) || o.error.message)) || (typeof o.error === 'string' ? o.error : '') || 'OpenCode error';
      hadErr = String(msg);
      errs.push(hadErr);
    }
  });
  readline.createInterface({ input: child.stderr }).on('line', (l) => { if (l) errs.push(l); });
  child.on('error', (e) => errs.push(e.message || String(e)));
  child.on('close', (code) => {
    runs.delete(key);
    try { if (mcpCfg) fs.rmSync(mcpCfg, { force: true }); } catch {}
    const outText = textParts.join('\n\n').trim();
    if (outText) chat.msgs.push({ role: 'assistant', content: outText });
    chat.ts = Date.now();
    saveAiChats(); broadcast('claude:changed', [id]);
    const errMsg = hadErr || errs.slice(-3).join('\n') || 'OpenCode stopped (' + code + ')';
    send(code === 0 && !hadErr ? { type: 'result', subtype: 'success', duration_ms: Date.now() - t0 } : { type: 'result', subtype: 'error', is_error: true, result: errMsg });
    send({ type: 'exit', code });
  });
  return { run: key, id };
}
function startOpenCodeApi(sender, d, text, cfg) {
  const base = cleanBase(cfg.base);
  if (!/^https?:\/\/[^\s]+$/i.test(base)) return { error: 'Set the OpenCode API base URL first (in + AI → OpenCode).' };
  const id = d.id && aiChats.has(d.id) ? d.id : 'oc-' + crypto.randomUUID();
  const chat = aiChats.get(id) || { id, provider: 'opencode', name: 'OpenCode', model: '', title: '', ts: 0, msgs: [{ role: 'system', content: d.mcp ? AI_PROMPT.replace('MCP tools', 'tools') : 'You are a helpful assistant.' }] };
  chat.provider = 'opencode'; chat.name = 'OpenCode'; if (d.model) chat.model = String(d.model).slice(0, 120);
  if (!chat.title) chat.title = text.slice(0, 70);
  chat.ts = Date.now();
  aiChats.set(id, chat);
  const msgs = chat.msgs;
  msgs.push({ role: 'user', content: text.slice(0, 40000) });
  saveAiChats(); broadcast('claude:changed', [id]);
  const key = crypto.randomUUID(), ac = new AbortController();
  runs.set(key, { sid: id, child: { kill: () => ac.abort() } });
  const send = (o) => { if (!sender.isDestroyed()) sender.send('claude:line', key, o); };
  const tools = d.mcp ? mcp.TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) : undefined;
  const t0 = Date.now(), apiKey = cfg.key ? unseal(cfg.key) : '';
  const bases = ocApiBases(base);
  if (ocApiEff && cleanBase(cfg.base) === ocApiBase && bases.includes(ocApiEff)) bases.sort((a, b) => (a === ocApiEff ? -1 : b === ocApiEff ? 1 : 0));
  else if (ocApiEff && cleanBase(cfg.base) === ocApiBase) bases.unshift(ocApiEff);
  (async () => {
    try {
      let effBase = bases[0];
      for (let round = 0; round < 12; round++) {
        let r = null, lastErr = null;
        for (const b of (round === 0 ? bases : [effBase])) {
          try {
            const to = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(20000) : null;
            const signal = to && AbortSignal.any ? AbortSignal.any([ac.signal, to]) : ac.signal;
            const res = await fetch(b + '/chat/completions', {
              method: 'POST', signal,
              headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}) },
              body: JSON.stringify({ model: d.model, messages: msgs, stream: true, ...(tools ? { tools } : {}) }),
            });
            if (!res.ok) {
              const body = (await res.text()).slice(0, 300);
              lastErr = new Error(`The API answered ${res.status}: ${body}`);
              if (res.status === 404 || res.status === 405) continue;
              throw lastErr;
            }
            r = res; effBase = b; ocApiEff = b; ocApiBase = cleanBase(cfg.base); break;
          } catch (e) { lastErr = e; if (ac.signal.aborted) throw e; }
        }
        if (!r) throw lastErr || new Error('Could not reach the OpenCode API');
        let textOut = '', started = false, calls = [], buf = '';
        const dec = new TextDecoder();
        for await (const chunk of r.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim(); if (data === '[DONE]') continue;
            let j; try { j = JSON.parse(data); } catch { continue; }
            const dl = (j.choices && j.choices[0] && j.choices[0].delta) || {};
            if (dl.content) {
              if (!started) { started = true; send({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } }); }
              textOut += dl.content;
              send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: dl.content } } });
            }
            for (const tc of dl.tool_calls || []) {
              const c = calls[tc.index || 0] || (calls[tc.index || 0] = { id: tc.id || 'call' + round + (tc.index || 0), name: '', args: '' });
              if (tc.id) c.id = tc.id;
              if (tc.function && tc.function.name) c.name += tc.function.name;
              if (tc.function && tc.function.arguments) c.args += tc.function.arguments;
            }
          }
        }
        calls = calls.filter(Boolean);
        if (textOut) send({ type: 'assistant', message: { content: [{ type: 'text', text: textOut }] } });
        msgs.push({ role: 'assistant', content: textOut || null, ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) } : {}) });
        if (!calls.length) { saveAiChats(); broadcast('claude:changed', [id]); break; }
        for (const c of calls) {
          let args = {}; try { args = JSON.parse(c.args || '{}'); } catch {}
          send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: c.id, name: c.name, input: args }] } });
          let out, isErr = false;
          const t = mcp.TOOLS.find((x) => x.name === c.name);
          try { const res = t ? await t.run(args) : { content: [{ type: 'text', text: 'Unknown tool' }], isError: true }; out = res.content.map((x) => x.text || '[image]').join('\n'); isErr = !!res.isError; }
          catch (e) { out = e.message; isErr = true; }
          send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: c.id, content: out, is_error: isErr }] } });
          msgs.push({ role: 'tool', tool_call_id: c.id, content: String(out).slice(0, 40000) });
        }
        saveAiChats(); broadcast('claude:changed', [id]);
      }
      send({ type: 'result', subtype: 'success', duration_ms: Date.now() - t0 });
    } catch (e) {
      send({ type: 'result', subtype: 'error', is_error: true, result: ac.signal.aborted ? 'Stopped' : e.message });
    } finally { runs.delete(key); send({ type: 'exit' }); }
  })();
  return { run: key, id };
}
function ocRestart() {
  for (const [k, r] of runs) if (String(r.sid).startsWith('oc-')) { try { r.child.kill(); } catch {} runs.delete(k); }
  ocSessions.clear();
  ocFree = null; ocApiModels = null; ocApiBase = ''; ocApiEff = '';
  return { ok: true };
}
function ocSetMode(d) {
  const cfg = readOcCfg();
  const mode = d && d.mode === 'api' ? 'api' : 'cli';
  const base = cleanBase((d && d.base) || cfg.base || 'http://127.0.0.1:4096/v1') || 'http://127.0.0.1:4096/v1';
  const key = d && typeof d.key === 'string' ? (d.key ? seal(d.key) : '') : cfg.key;
  writeOcCfg({ mode, base, key });
  ocRestart(); // drop stale sessions/cache so the new mode starts clean
  return { ok: true, mode, base };
}
const aiRemove = (id) => { writeAi(readAi().filter((p) => p.id !== id)); return true; };

// custom AI chats live on disk too: they survive a restart and sit in the chat list next to Claude Code's
const aiChatsFile = () => path.join(home(), 'ai-chats.json');
const aiChats = new Map();   // chat id -> { id, provider, name, model, title, ts, msgs }
try { for (const c of JSON.parse(fs.readFileSync(aiChatsFile(), 'utf8'))) if (c && c.id && Array.isArray(c.msgs)) aiChats.set(c.id, c); } catch {}
let aiSaveT = null;
function saveAiChats() {   // debounced: a burst of pushes becomes one write
  clearTimeout(aiSaveT);
  aiSaveT = setTimeout(() => {
    try {
      const list = [...aiChats.values()].sort((a, b) => b.ts - a.ts).slice(0, 60).map((c) => ({ ...c, msgs: c.msgs.slice(-400).map((m) => (typeof m.content === 'string' && m.content.length > 40000 ? { ...m, content: m.content.slice(0, 40000) } : m)) }));
      fs.mkdirSync(home(), { recursive: true });
      fs.writeFileSync(aiChatsFile(), JSON.stringify(list));
    } catch {}
  }, 300);
}
const aiName = (id, fallback) => (readAi().find((x) => x.id === id) || {}).name || fallback || 'AI';

async function startCustom(sender, d, text) {
  if (d.provider === 'opencode') return startOpenCode(sender, d, text);
  const p = readAi().find((x) => x.id === d.provider);
  if (!p) return { error: 'That AI was removed' };
  const id = d.id && aiChats.has(d.id) ? d.id : 'ai-' + crypto.randomUUID();
  const chat = aiChats.get(id) || { id, provider: p.id, name: p.name, model: '', title: '', ts: 0, msgs: [{ role: 'system', content: d.mcp ? AI_PROMPT.replace('MCP tools', 'tools') : 'You are a helpful assistant.' }] };
  chat.provider = p.id; chat.name = p.name; if (d.model) chat.model = String(d.model).slice(0, 120);
  if (!chat.title) chat.title = text.slice(0, 70);
  chat.ts = Date.now();
  aiChats.set(id, chat);
  const msgs = chat.msgs;
  msgs.push({ role: 'user', content: text.slice(0, 40000) });
  saveAiChats(); broadcast('claude:changed', [id]);   // the lists follow the new chat right away
  const key = crypto.randomUUID(), ac = new AbortController();
  runs.set(key, { sid: id, child: { kill: () => ac.abort() } });
  const send = (o) => { if (!sender.isDestroyed()) sender.send('claude:line', key, o); };
  const tools = d.mcp ? mcp.TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) : undefined;
  const t0 = Date.now();
  (async () => {
    try {
      for (let round = 0; round < 12; round++) {
        const r = await fetch(p.base + '/chat/completions', {
          method: 'POST', signal: ac.signal,
          headers: { 'Content-Type': 'application/json', ...(p.key ? { Authorization: 'Bearer ' + unseal(p.key) } : {}) },
          body: JSON.stringify({ model: d.model, messages: msgs, stream: true, ...(tools ? { tools } : {}) }),
        });
        if (!r.ok) throw new Error(`The API answered ${r.status}: ${(await r.text()).slice(0, 300)}`);
        let textOut = '', started = false, calls = [], buf = '';
        const dec = new TextDecoder();
        for await (const chunk of r.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim(); if (data === '[DONE]') continue;
            let j; try { j = JSON.parse(data); } catch { continue; }
            const dl = (j.choices && j.choices[0] && j.choices[0].delta) || {};
            if (dl.content) {
              if (!started) { started = true; send({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } }); }
              textOut += dl.content;
              send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: dl.content } } });
            }
            for (const tc of dl.tool_calls || []) {
              const c = calls[tc.index || 0] || (calls[tc.index || 0] = { id: tc.id || 'call' + round + (tc.index || 0), name: '', args: '' });
              if (tc.id) c.id = tc.id;
              if (tc.function && tc.function.name) c.name += tc.function.name;
              if (tc.function && tc.function.arguments) c.args += tc.function.arguments;
            }
          }
        }
        calls = calls.filter(Boolean);
        if (textOut) send({ type: 'assistant', message: { content: [{ type: 'text', text: textOut }] } });
        msgs.push({ role: 'assistant', content: textOut || null, ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) } : {}) });
        if (!calls.length) { saveAiChats(); broadcast('claude:changed', [id]); break; }
        for (const c of calls) {
          let args = {}; try { args = JSON.parse(c.args || '{}'); } catch {}
          send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: c.id, name: c.name, input: args }] } });
          let out, isErr = false;
          const t = mcp.TOOLS.find((x) => x.name === c.name);
          try { const res = t ? await t.run(args) : { content: [{ type: 'text', text: 'Unknown tool' }], isError: true }; out = res.content.map((x) => x.text || '[image]').join('\n'); isErr = !!res.isError; }
          catch (e) { out = e.message; isErr = true; }
          send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: c.id, content: out, is_error: isErr }] } });
          msgs.push({ role: 'tool', tool_call_id: c.id, content: String(out).slice(0, 40000) });
        }
        saveAiChats(); broadcast('claude:changed', [id]);
      }
      send({ type: 'result', subtype: 'success', duration_ms: Date.now() - t0 });
    } catch (e) {
      send({ type: 'result', subtype: 'error', is_error: true, result: ac.signal.aborted ? 'Stopped' : e.message });
    } finally { runs.delete(key); send({ type: 'exit' }); }
  })();
  return { run: key, id };
}

// ---------------------------------------------------------------- handlers (app windows over IPC; web clients through the host relay)
const H = {
  'claude:chats': () => { watch(); return chats(); },
  'claude:history': (_s, id) => history(id),
  'claude:send': async (s, d) => { try { return await start(s, d || {}); } catch (err) { log('send failed', err.stack || err); return { error: 'Could not start Claude Code: ' + err.message }; } },
  'claude:stop': (_s, key) => { const r = runs.get(key); if (r) r.child.kill(); },
  'claude:auth': () => new Promise((ok) => execFile(exe(), ['auth', 'status'], { env: env(), windowsHide: true, timeout: 20000 }, (_err, out) => {
    let v = {}; try { v = JSON.parse(out); } catch {}
    ok({ loggedIn: v.loggedIn === true });
  })),
  'claude:home': () => os.homedir(),
  'claude:usage': () => usage,
  // the folder picker: folders of this PC (drives when no path is given)
  'fs:dirs': (_s, dir) => {
    if (!dir) return { path: '', parent: null, dirs: 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => l + ':\\').filter((d) => fs.existsSync(d)), home: os.homedir() };
    const p = path.resolve(String(dir));
    let dirs = [];
    try { dirs = fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('$')).map((e) => e.name).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })); }
    catch (e) { return { error: 'That folder cannot be opened', path: p, parent: path.dirname(p) === p ? '' : path.dirname(p), dirs: [] }; }
    return { path: p, parent: path.dirname(p) === p ? '' : path.dirname(p), dirs, home: os.homedir() };
  },
  'claude:plugins': () => {   // which Claude Code plugins the chat offers settings for
    try { const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')); return { ponytail: !!(s.enabledPlugins || {})['ponytail@ponytail'] }; }
    catch { return { ponytail: false }; }
  },
  'ai:list': () => aiList(),
  'ai:add': (_s, d) => aiAdd(d || {}),
  'ai:remove': (_s, id) => aiRemove(id),
  'ai:opencode-config': () => { const c = readOcCfg(); return { mode: c.mode, base: c.base, hasKey: !!c.key }; },
  'ai:opencode-set': (_s, d) => ocSetMode(d || {}),
  'ai:opencode-restart': () => ocRestart(),
};
for (const [k, f] of Object.entries(H)) ipcMain.handle(k, (e, ...a) => f(e.sender, ...a));
ipcMain.handle('claude:pickDir', async (e) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: 'Choose the folder Claude works in', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

module.exports = { chats, history, isUuid, start, aiAdd, aiList, aiRemove, addSink: (f) => sinks.add(f) };
