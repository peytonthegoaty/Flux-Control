// toLoadScript: one line out, and the Lua string inside decodes back to the original script.
const { toLoadScript } = require('../app/executor.js');
const assert = require('assert');

const one = 'loadstring(game:HttpGet("https://example.com/x.lua"))()';
assert.strictEqual(toLoadScript(one + '\n'), one, 'a one-line script is copied as it is');

const src = '-- comment\nprint("hi \\ there")\r\nlocal t = {1,\t2}\n';
const out = toLoadScript(src);
assert(!/[\r\n]/.test(out), 'result is a single line');
assert(out.startsWith('loadstring("') && out.endsWith('")()'));
// decode the Lua string literal back
const body = out.slice('loadstring("'.length, -'")()'.length);
const back = body.replace(/\\(\d{3}|.)/g, (_, c) => (c === 'n' ? '\n' : c.length === 3 ? String.fromCharCode(+c) : c));
assert.strictEqual(back, src.replace(/\r\n?/g, '\n').trim());
console.log('loader tests passed');
