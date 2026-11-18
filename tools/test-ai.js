// Custom AIs: adding one lists its models, a chat with it is kept on disk, shows in the chat list and resumes.
// A fake OpenAI-compatible API (this script) answers /models and streams /chat/completions.
// Usage: node tools/test-ai.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// claude-main loads electron at the top; a stub is enough for the custom AI part
const electron = {
  ipcMain: { handle() {} },
  dialog: {},
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false },
};
const Module = require('module');
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? electron : load.call(this, request, ...rest); };

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-ai-test-'));
process.env.FLUX_HOME = home;
const claudeMain = require('../app/claude-main.js');

// ---- the fake API: model list + one streamed answer (with a Lua block, like a script Claude wrote)
let answers = 0;
const srv = http.createServer((req, res) => {
  if (req.url.endsWith('/models')) {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ data: [{ id: 'test-model' }, { id: 'test-model-2' }] }));
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const n = ++answers;
    res.setHeader('content-type', 'text/event-stream');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: `Answer ${n}:\n\`\`\`lua\nprint(${n})\n\`\`\`` } }] }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
(async () => {
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${srv.address().port}/v1`;

  // adding: the models are fetched from the API, the same base keeps its id when re-added
  const added = await claudeMain.aiAdd({ base, key: 'sk-test', name: 'TestAI' });
  assert.strictEqual(added.models.length, 2, 'models listed');
  assert.deepStrictEqual((await claudeMain.aiList()).filter((p) => !p.builtIn), [{ id: added.id, name: 'TestAI', base, models: ['test-model', 'test-model-2'] }]);
  const again = await claudeMain.aiAdd({ base, key: 'sk-test' });
  assert.strictEqual(again.id, added.id, 're-adding keeps the id');

  // a chat with it: the answer streams back as Claude-shaped events and is kept
  const seen = [];
  const sender = { isDestroyed: () => false, send: (ch, ...a) => seen.push(a) };
  const first = await claudeMain.start(sender, { provider: added.id, model: 'test-model', mode: 'manual', text: 'write me a script' });
  assert(first.id && first.id.startsWith('ai-'), 'custom chat id');
  const kinds = () => seen.filter(([, o]) => o && o.type).map(([, o]) => o.type);
  await new Promise((ok) => {
    const t = setInterval(() => kinds().includes('exit') && (clearInterval(t), ok()), 20);
    setTimeout(() => (clearInterval(t), ok()), 5000);
  });
  assert(kinds().includes('stream_event') && kinds().includes('assistant') && kinds().includes('result'), 'events arrived: ' + kinds().join(','));
  assert.strictEqual(kinds().filter((k) => k === 'result').length, 1);
  assert(!seen.some(([, o]) => o.type === 'result' && o.is_error), 'no error result');

  // saved on disk after the debounce, and readable as history; it sits in the chat list under the AI's name
  await new Promise((ok) => setTimeout(ok, 500));
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'ai-chats.json'), 'utf8'));
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].title, 'write me a script');
  assert.strictEqual(saved[0].model, 'test-model');
  let items = claudeMain.history(first.id);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].role, 'user');
  assert.strictEqual(items[1].role, 'assistant');
  assert(items[1].text.includes('Answer 1'), 'answer text');
  assert(items[1].text.includes('```lua'), 'lua block kept');
  const listed = claudeMain.chats().find((c) => c.id === first.id);
  assert(listed && listed.custom && listed.cwd === 'TestAI' && listed.model === 'test-model', 'chat is in the list');

  // resuming: the next answer continues the same chat, on disk and in the list
  const second = await claudeMain.start(sender, { id: first.id, provider: added.id, model: 'test-model-2', mode: 'manual', text: 'and another' });
  assert.strictEqual(second.id, first.id, 'same chat resumes');
  await new Promise((ok) => {
    const t = setInterval(() => seen.filter(([, o]) => o.type === 'result').length >= 2 && (clearInterval(t), ok()), 20);
    setTimeout(() => (clearInterval(t), ok()), 5000);
  });
  await new Promise((ok) => setTimeout(ok, 500));
  items = claudeMain.history(first.id);
  assert.strictEqual(items.length, 4, 'both exchanges kept');
  assert(items[3].text.includes('Answer 2'), 'second answer kept');
  assert.strictEqual(claudeMain.chats().find((c) => c.id === first.id).model, 'test-model-2', 'model follows the chat');

  // removing the AI: its list entry goes away, its chats stay readable
  assert(claudeMain.aiRemove(added.id));
  assert.strictEqual((await claudeMain.aiList()).filter((p) => !p.builtIn).length, 0);
  assert(claudeMain.chats().some((c) => c.id === first.id), 'chat survives the removal');
  assert.strictEqual(claudeMain.history(first.id).length, 4);

  srv.close();
  console.log('ai tests passed');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
