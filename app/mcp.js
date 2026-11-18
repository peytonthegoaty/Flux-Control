// Executor AI mode: a local MCP server (Streamable HTTP, JSON replies) that Claude Code connects to.
// Each tool runs Lua in the game through the HubRunner file bridge (the load script), using the `flux` helpers it defines.
// Only reachable from this PC, at a random port and a secret path.
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

let dirFn = () => null, started = null;
const token = crypto.randomBytes(18).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A Lua string literal for any text (quotes, backslashes and control characters escaped). */
const lstr = (s) => '"' + [...String(s == null ? '' : s)].map((c) => (c === '\\' ? '\\\\' : c === '"' ? '\\"' : c === '\n' ? '\\n' : c < ' ' ? '\\' + String(c.charCodeAt(0)).padStart(3, '0') : c)).join('') + '"';
const lnum = (n, d) => (Number.isFinite(+n) && n !== '' && n != null ? String(Math.trunc(+n)) : String(d));

// ---------------------------------------------------------------- the bridge: one request at a time
const read = (d, n) => { try { return fs.readFileSync(path.join(d, n), 'utf8'); } catch { return null; } };
const put = (d, n, t) => { fs.writeFileSync(path.join(d, n + '.tmp'), t); fs.renameSync(path.join(d, n + '.tmp'), path.join(d, n)); };
let chain = Promise.resolve();
function runInGame(code, timeoutMs = 20000) {
  const job = chain.then(() => runNow(code, timeoutMs));
  chain = job.catch(() => {});
  return job;
}
async function runNow(code, timeoutMs) {
  const d = dirFn();
  if (!d) throw new Error('No executor workspace is set. Choose it on the Executor page in Flux Control.');
  if (Date.now() / 1000 - (+read(d, 'alive.txt') || 0) > 5) throw new Error('The executor is not connected. In Flux Control press "Copy load script" and run it in your executor.');
  const id = 'ai' + Date.now() + crypto.randomBytes(3).toString('hex');
  put(d, 'run.lua', code); put(d, 'run.id', id);   // run.id last: it is the trigger
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await sleep(100);
    let st = null; try { st = JSON.parse(read(d, 'status.json')); } catch {}
    if (st && st.id === id && st.finished) return st;
  }
  throw new Error(`No answer after ${timeoutMs / 1000} s. The code may still be running in the game.`);
}

const cap = (t, n = 30000) => (t.length > n ? t.slice(0, n) + `\n... (${t.length - n} more characters cut)` : t);
const text = (t) => [{ type: 'text', text: cap(String(t)) }];
/** run a helper that returns text; a Lua error becomes a tool error */
async function helper(lua, timeout) {
  const st = await runInGame('return ' + lua, timeout);
  if (st.ok === false) throw new Error(String(st.error || 'error').split('\nstack traceback')[0]);
  return st.result == null ? '' : String(st.result);
}

// ---------------------------------------------------------------- tools
const S = (props, req = []) => ({ type: 'object', properties: props, required: req, additionalProperties: false });
const str = (d) => ({ type: 'string', description: d }), int = (d) => ({ type: 'integer', description: d }), bool = (d) => ({ type: 'boolean', description: d });
const TOOLS = [
  {
    name: 'run_lua', title: 'Run Lua',
    description: 'Run Luau code in the live Roblox game through the executor. Returns what it print()s/warn()s, its return value (tables come back as JSON) and any error with a traceback. The executor environment is available (getgenv, hookmetamethod, etc.) plus the `flux` helper table.',
    inputSchema: S({ code: str('Luau code. Use print() or return to get data back.'), timeout_seconds: int('How long to wait for it to finish (default 20, max 120)') }, ['code']),
    run: async (a) => {
      const st = await runInGame(String(a.code || ''), Math.min(120, Math.max(1, +a.timeout_seconds || 20)) * 1000);
      const out = [];
      if (st.logs && st.logs.length) out.push('Output:\n' + st.logs.join('\n'));
      if (st.ok === false) out.push('Error:\n' + st.error);
      else if (st.result != null) out.push('Returned: ' + st.result);
      if (!out.length) out.push('Ran with no output.');
      return { content: text(out.join('\n\n')), isError: st.ok === false };
    },
  },
  {
    name: 'get_game_info', title: 'Game info',
    description: 'Place name and ids, JobId, the local player, player count, executor name and character position.',
    inputSchema: S({}), run: async () => ({ content: text(await helper('flux.info()')) }),
  },
  {
    name: 'get_tree', title: 'Instance tree',
    description: 'Children of an instance as an indented tree with class names and child counts. Paths look like "game.Workspace.Map" or "Players.LocalPlayer.PlayerGui".',
    inputSchema: S({ path: str('Instance path (default "game")'), depth: int('Levels to show, 1-6 (default 2)'), max_children: int('Children listed per instance (default 25)') }),
    run: async (a) => ({ content: text(await helper(`flux.tree(${lstr(a.path || 'game')}, ${lnum(a.depth, 2)}, ${lnum(a.max_children, 25)})`)) }),
  },
  {
    name: 'search_instances', title: 'Search instances',
    description: 'Find instances under a root by part of their name and/or by class (IsA). Returns full paths.',
    inputSchema: S({ root: str('Where to search (default "game")'), name: str('Text the name contains (case-insensitive)'), class_name: str('Class to match with IsA, e.g. "RemoteEvent", "LocalScript", "TextButton"'), limit: int('Max results (default 30)') }),
    run: async (a) => ({ content: text(await helper(`flux.search(${lstr(a.root || 'game')}, ${lstr(a.name || '')}, ${lstr(a.class_name || '')}, ${lnum(a.limit, 30)})`, 40000)) }),
  },
  {
    name: 'get_script_source', title: 'Script source',
    description: 'Decompiled source of a LocalScript or ModuleScript (needs the executor\'s decompile). Lines are numbered; use start_line/end_line for long scripts.',
    inputSchema: S({ path: str('Script path, e.g. "Players.LocalPlayer.PlayerScripts.Main"'), start_line: int('First line (default 1)'), end_line: int('Last line (default start_line + 399)') }, ['path']),
    run: async (a) => {
      const lines = (await helper(`flux.source(${lstr(a.path)})`, 60000)).split('\n');
      const s = Math.max(1, +a.start_line || 1), e = Math.min(lines.length, +a.end_line || s + 399);
      const body = lines.slice(s - 1, e).map((l, i) => String(s + i).padStart(5) + '  ' + l).join('\n');
      return { content: text(`${a.path}: lines ${s}-${e} of ${lines.length}\n${body}`) };
    },
  },
  {
    name: 'get_console', title: 'Game console',
    description: 'Recent lines of the Roblox developer console (LogService), oldest first.',
    inputSchema: S({ limit: int('How many lines (default 30)'), filter: str('Only lines containing this text') }),
    run: async (a) => ({ content: text(await helper(`flux.console(${lnum(a.limit, 30)}, ${lstr(a.filter || '')})`)) }),
  },
  {
    name: 'click_button', title: 'Click a button',
    description: 'Fire the click signals (MouseButton1Down/Click/Up, Activated) of a GUI button.',
    inputSchema: S({ path: str('Button path, e.g. "Players.LocalPlayer.PlayerGui.Main.Play"') }, ['path']),
    run: async (a) => ({ content: text(await helper(`flux.click(${lstr(a.path)})`)) }),
  },
  {
    name: 'type_text', title: 'Type into a text box',
    description: 'Set the text of a TextBox, optionally firing FocusLost(enterPressed = true) as if Enter was pressed.',
    inputSchema: S({ path: str('TextBox path'), text: str('Text to put in'), enter: bool('Press Enter after (default false)') }, ['path', 'text']),
    run: async (a) => ({ content: text(await helper(`flux.type(${lstr(a.path)}, ${lstr(a.text)}, ${a.enter ? 'true' : 'false'})`)) }),
  },
  {
    name: 'remote_spy', title: 'Remote spy',
    description: 'Log the RemoteEvent/RemoteFunction calls the game sends to the server (FireServer, InvokeServer). Start it, play a bit, then list.',
    inputSchema: S({ operation: { type: 'string', enum: ['start', 'stop', 'list', 'clear'], description: 'What to do (default list)' }, filter: str('list: only calls containing this text'), limit: int('list: how many (default 30)') }),
    run: async (a) => ({ content: text(await helper(`flux.spy(${lstr(a.operation || 'list')}, ${lstr(a.filter || '')}, ${lnum(a.limit, 30)})`)) }),
  },
  {
    name: 'screenshot', title: 'Screenshot',
    description: 'A picture of the Roblox window as it looks right now.',
    inputSchema: S({}),
    run: async () => {
      const { desktopCapturer } = require('electron');
      const srcs = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1280, height: 800 } });
      const w = srcs.find((s) => /^Roblox$/i.test(s.name)) || srcs.find((s) => /roblox/i.test(s.name));
      if (!w || w.thumbnail.isEmpty()) throw new Error('No Roblox window was found (it may be minimized)');
      return { content: [{ type: 'image', data: w.thumbnail.toJPEG(80).toString('base64'), mimeType: 'image/jpeg' }] };
    },
  },
];

// ---------------------------------------------------------------- JSON-RPC over HTTP
async function rpc(m) {
  if (!m || typeof m !== 'object') return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
  if (m.id === undefined) return null;   // a notification: nothing to answer
  const ok = (result) => ({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize':
      return ok({
        protocolVersion: (m.params && m.params.protocolVersion) || '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'flux-executor', version: '1.0.0' },
        instructions: 'Tools that act on a live Roblox game through the user\'s executor (Flux Control). Start with get_game_info.',
      });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })) });
    case 'tools/call': {
      const t = TOOLS.find((x) => x.name === (m.params && m.params.name));
      if (!t) return { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Unknown tool' } };
      try { return ok(await t.run((m.params && m.params.arguments) || {})); }
      catch (e) { return ok({ content: text(e.message || String(e)), isError: true }); }
    }
    default: return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } };
  }
}

function handle(req, res) {
  const json = (code, v) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
  // the secret path, and only this PC's own name in Host (a web page cannot reach it through DNS tricks)
  if (req.url !== '/mcp/' + token || !/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || '')) { res.writeHead(404); return res.end(); }
  if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 4e6) req.destroy(); });
  req.on('end', async () => {
    let msg; try { msg = JSON.parse(body); } catch { return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const out = (await Promise.all((Array.isArray(msg) ? msg : [msg]).map(rpc))).filter(Boolean);
    if (!out.length) { res.writeHead(202); return res.end(); }
    json(200, Array.isArray(msg) ? out : out[0]);
  });
}

/** Starts the server once; resolves to its URL. */
function ensure() {
  if (!started) started = new Promise((ok, bad) => {
    const s = http.createServer(handle);
    s.on('error', (e) => { started = null; bad(e); });
    s.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${s.address().port}/mcp/${token}`));
  });
  return started;
}

module.exports = { init: (fn) => { dirFn = fn; }, ensure, runInGame, lstr, TOOLS };
