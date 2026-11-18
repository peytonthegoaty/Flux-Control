// Round-trip and corruption tests for shared/code.js
const C = require('../shared/code.js');
const assert = require('assert');

const cases = [
  { method: 'lan', host: '192.168.1.24', port: 8080 },
  { method: 'upnp', host: '203.0.113.7', port: 65535, password: true },
  { method: 'cloudflare', host: 'quiet-river-4821' },
  { method: 'localhostrun', host: 'b05d89fbd124ac.app.lhr.life', password: true },
  { method: 'ngrok', host: 'x'.repeat(40) + '.ngrok-free.app' },
  { method: 'ngrok', host: 'quiet-river.ngrok-free.dev', password: true },
];
for (const c of cases) {
  const code = C.encode(c);
  const d = C.decode(code);
  assert(d.ok, code + ' failed: ' + d.error);
  assert.strictEqual(d.method, c.method);
  assert.strictEqual(d.password, !!c.password);
  console.log(c.method.padEnd(13), code);
  // forgiving input: lowercase, spaces, no dashes, O/0 + I/1 confusion
  assert(C.decode(code.toLowerCase().replace(/-/g, ' ')).ok, 'lowercase/space form');
  // any single changed character must be rejected
  const chars = code.replace(/-/g, '').slice(4);
  for (let i = 0; i < chars.length; i++) {
    const alt = chars[i] === 'A' ? 'B' : 'A';
    assert(!C.decode('FLUX' + chars.slice(0, i) + alt + chars.slice(i + 1)).ok, 'typo not caught at ' + i);
  }
}
assert(!C.decode('hello').ok);
// codes made by v0.4.0 held only the label
const legacy = C.decode((() => { // hand-build: ver 1, method 4, flags 1, label bytes, crc
  const crc = (b) => { let c = 0xffff; for (const x of b) { c ^= x << 8; for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; } return c; };
  const body = [1, 4, 1, ...Buffer.from('oldlabel')]; const c = crc(body); const bytes = [...body, c >> 8, c & 255];
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; let out = '', bits = 0, acc = 0;
  for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { out += A[(acc >> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += A[(acc << (5 - bits)) & 31]; return 'FLUX-' + out;
})());
assert(legacy.ok && legacy.url === 'https://oldlabel.lhr.life', 'old label-only localhost.run codes still decode');
assert.throws(() => C.encode({ method: 'lan', host: '300.1.1.1', port: 80 }));
console.log('code tests passed');
