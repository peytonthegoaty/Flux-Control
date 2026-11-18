// Executor AI mode: the MCP server answers the protocol and its tools reach the game through the file bridge.
// A fake HubRunner (this script) answers run.lua the way the real load script does.
// Usage: node tools/test-mcp.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const mcp = require('../app/mcp.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-mcp-test-'));
mcp.init(() => dir);

// Lua string literals survive quotes, backslashes, newlines and control characters
assert.strictEqual(mcp.lstr('a"b\\c\nd\x01'), '"a\\"b\\\\c\\nd\\001"');

// fake HubRunner: heartbeat + answer each new run.id
let last = null, seen = [];
fs.writeFileSync(path.join(dir, 'alive.txt'), String(Math.floor(Date.now() / 1000)));   // connected from the start
const beat = setInterval(() => {
  fs.writeFileSync(path.join(dir, 'alive.txt'), String(Math.floor(Date.now() / 1000)));
  let id; try { id = fs.readFileSync(path.join(dir, 'run.id'), 'utf8'); } catch { return; }
  if (id === last) return;
  last = id;
  const code = fs.readFileSync(path.join(dir, 'run.lua'), 'utf8');
  seen.push(code);
  const st = code.startsWith('return flux.tree(') ? { ok: true, result: 'game [DataModel]\n  Workspace [Workspace]' }
    : code.includes('error(') ? { ok: false, error: 'HubRunner:1: boom\nstack traceback:\n  x' }
    : { ok: true, result: '42', logs: ['hello'] };
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ id, finished: 1, ...st }));
}, 50);

(async () => {
  try {
    const url = await mcp.ensure();
    const call = async (body, extra = {}) => {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...extra }, body: JSON.stringify(body) });
      return { status: r.status, json: r.status === 200 ? await r.json() : null };
    };
    const init = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    assert.strictEqual(init.json.result.serverInfo.name, 'flux-executor');
    assert.strictEqual(init.json.result.protocolVersion, '2025-06-18');
    assert.strictEqual((await call({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = list.json.result.tools.map((t) => t.name);
    for (const n of ['run_lua', 'get_game_info', 'get_tree', 'search_instances', 'get_script_source', 'get_console', 'click_button', 'type_text', 'remote_spy', 'screenshot']) assert(names.includes(n), 'missing tool ' + n);

    const run = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_lua', arguments: { code: 'print("hello") return 42' } } });
    assert.match(run.json.result.content[0].text, /hello[\s\S]*Returned: 42/);
    const tree = await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_tree', arguments: { path: 'game.Work"space', depth: 3 } } });
    assert.match(tree.json.result.content[0].text, /Workspace \[Workspace\]/);
    assert(seen.includes('return flux.tree("game.Work\\"space", 3, 25)'), 'tree call was not escaped: ' + seen[seen.length - 1]);
    const bad = await call({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'run_lua', arguments: { code: 'error("boom")' } } });
    assert.strictEqual(bad.json.result.isError, true);

    // wrong path, foreign Host header: refused
    assert.strictEqual((await fetch(url.replace(/\/mcp\/.*/, '/mcp/nope'), { method: 'POST', body: '{}' })).status, 404);
    const u = new URL(url);   // fetch cannot fake Host, plain http can
    const evil = await new Promise((ok) => require('http').request({ host: '127.0.0.1', port: u.port, path: u.pathname, method: 'POST', headers: { Host: 'evil.example' } }, (r) => ok(r.statusCode)).end('{}'));
    assert.strictEqual(evil, 404);

    // not connected: a clear error instead of a hang
    clearInterval(beat); fs.writeFileSync(path.join(dir, 'alive.txt'), '0');
    const off = await call({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_game_info', arguments: {} } });
    assert(off.json.result.isError && /not connected/.test(off.json.result.content[0].text));
    console.log('mcp tests passed');
    process.exit(0);
  } catch (e) { console.error('FAILED:', e.message); process.exit(1); }
})();
