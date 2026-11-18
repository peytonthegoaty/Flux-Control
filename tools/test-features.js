// Dev code logic: valid code adds, wrong code is refused, remove turns the feature off, shipped registry is empty.
const F = require('../shared/features.js');
const assert = require('assert');

(async () => {
  const mem = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; } }; };
  const hash = await F.sha(F.norm('Test-Code 1'));
  const reg = { [hash]: { id: 'demo', name: 'Demo', desc: 'A test feature' } };

  const f = F.create(mem(), reg);
  assert.strictEqual(f.has('demo'), false);
  assert.deepStrictEqual(await f.add('nope'), { ok: false, err: "That code isn't valid" });
  assert.strictEqual((await f.add('')).ok, false);
  const ok = await f.add('test code-1');            // case, spaces and dashes do not matter
  assert(ok.ok && ok.feature.id === 'demo');
  assert.strictEqual(f.has('demo'), true);
  assert.strictEqual((await f.add('TEST-CODE 1')).err, 'That code is already added');
  assert.strictEqual(f.list().length, 1);
  assert.strictEqual(f.list()[0].name, 'Demo');
  f.remove(hash);
  assert.strictEqual(f.has('demo'), false);
  assert.strictEqual(f.list().length, 0);

  // a code that is later dropped from the registry stops working on its own
  const store = mem();
  await F.create(store, reg).add('Test-Code 1');
  assert.strictEqual(F.create(store, {}).has('demo'), false);

  // wrong codes are refused; the shipped code works however it is typed
  assert.strictEqual((await F.add('ANYTHING-AT-ALL')).ok, false);
  for (const c of ['RobloxExecutorDev', 'roblox executor dev', 'ROBLOX-EXECUTOR-DEV']) {
    const r = await F.create({ getItem: () => null, setItem() {} }, {}).add(c); // empty registry: refused
    assert.strictEqual(r.ok, false);
    assert.strictEqual((await F.add(c)).ok, true, c);
  }
  console.log('features tests passed');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
