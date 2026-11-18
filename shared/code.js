// Flux connection codes. One rule, works the same on every computer (host, wizard and client share this file).
//
//   FLUX-XXXXX-XXXXX-...   Crockford base32 (0-9 A-Z without I L O U), groups of 5, any length
//
//   bytes = [version=1][method][flags][payload...][crc16-ccitt hi][crc16 lo]
//   method 1 lan        payload = ipv4 (4 bytes) + port (2 bytes, big endian)
//   method 2 upnp       payload = ipv4 (4 bytes) + port (2 bytes)
//   method 3 cloudflare payload = tunnel label (utf8)   -> https://<label>.trycloudflare.com
//   method 4 localhostrun payload = full host (utf8)   -> https://<host>   (e.g. abc.app.lhr.life; an older label-only payload means <label>.lhr.life)
//   method 5 ngrok      payload = full host (utf8)      -> https://<host>   (ngrok-free.app / ngrok-free.dev / ngrok.app / ngrok.io)
//   flags bit0 = a password is required
//
// Picking a share option decides the method byte, so the code IS that option.
const FluxCode = (() => {
  const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const NGROK_HOST = /^[a-z0-9-]{1,63}\.ngrok(-free)?\.(app|dev|io)$/;
  const METHODS = {
    1: { id: 'lan', name: 'Local network', ip: true },
    2: { id: 'upnp', name: 'Public (UPnP)', ip: true },
    3: { id: 'cloudflare', name: 'Cloudflare tunnel', suffix: '.trycloudflare.com' },
    4: { id: 'localhostrun', name: 'localhost.run tunnel', full: true, re: /^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})*\.lhr\.life$/ },
    5: { id: 'ngrok', name: 'ngrok tunnel', full: true, re: NGROK_HOST },
  };
  const byId = Object.fromEntries(Object.entries(METHODS).map(([n, m]) => [m.id, +n]));

  const crc16 = (b) => {
    let c = 0xffff;
    for (const x of b) { c ^= x << 8; for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; }
    return c;
  };

  function b32enc(bytes) {
    let out = '', bits = 0, acc = 0;
    for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { out += ALPHA[(acc >> (bits - 5)) & 31]; bits -= 5; } }
    if (bits) out += ALPHA[(acc << (5 - bits)) & 31];
    return out;
  }

  function b32dec(s) {
    const out = []; let bits = 0, acc = 0;
    for (const ch of s) {
      const v = ALPHA.indexOf(ch); if (v < 0) return null;
      acc = (acc << 5) | v; bits += 5;
      if (bits >= 8) { out.push((acc >> (bits - 8)) & 255); bits -= 8; }
    }
    return bits && (acc & ((1 << bits) - 1)) ? null : out; // leftover bits must be zero
  }

  // Crockford: users may type O for 0 and I/L for 1
  const clean = (s) => s.toUpperCase().replace(/^\s*FLUX/, '').replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');

  /** encode({method:'lan'|..., host:'192.168.1.24', port:8080} | {method:'cloudflare', host:'<label>'}, password:boolean) */
  function encode({ method, host, port, password = false }) {
    const n = byId[method]; if (!n) throw new Error('unknown method');
    const m = METHODS[n];
    let payload;
    if (m.ip) {
      const p = host.split('.').map(Number);
      if (p.length !== 4 || p.some((x) => !(x >= 0 && x <= 255))) throw new Error('bad ip');
      if (!(port >= 1 && port <= 65535)) throw new Error('bad port');
      payload = [...p, port >> 8, port & 255];
    } else if (m.full) {
      if (!m.re.test(host)) throw new Error('bad tunnel host');
      payload = [...new TextEncoder().encode(host)];
    } else {
      if (!/^[a-z0-9-]{1,63}$/.test(host)) throw new Error('bad tunnel label');
      payload = [...new TextEncoder().encode(host)];
    }
    const body = [1, n, password ? 1 : 0, ...payload];
    const c = crc16(body);
    const s = b32enc([...body, c >> 8, c & 255]);
    return 'FLUX-' + s.match(/.{1,5}/g).join('-');
  }

  /** decode(text) -> {ok:true, method, name, url, password} | {ok:false, error} */
  function decode(text) {
    const s = clean(String(text || ''));
    if (s.length < 8) return { ok: false, error: 'Too short' };
    const b = b32dec(s);
    if (!b || b.length < 6) return { ok: false, error: 'Not a Flux code' };
    const crc = (b[b.length - 2] << 8) | b[b.length - 1];
    const body = b.slice(0, -2);
    if (crc16(body) !== crc) return { ok: false, error: 'Code has a typo' };
    const [ver, n, flags, ...p] = body;
    const m = METHODS[n];
    if (ver !== 1 || !m) return { ok: false, error: 'Unsupported code version' };
    let url;
    if (m.ip) {
      if (p.length !== 6) return { ok: false, error: 'Bad code' };
      url = `http://${p.slice(0, 4).join('.')}:${(p[4] << 8) | p[5]}`;
    } else if (m.full) {
      let h = new TextDecoder().decode(new Uint8Array(p));
      if (n === 4 && !h.includes('.')) h += '.lhr.life';   // codes made before the full host was stored
      if (!m.re.test(h)) return { ok: false, error: 'Bad code' };
      url = `https://${h}`;
    } else {
      const label = new TextDecoder().decode(new Uint8Array(p));
      if (!/^[a-z0-9-]{1,63}$/.test(label)) return { ok: false, error: 'Bad code' };
      url = `https://${label}${m.suffix}`;
    }
    return { ok: true, method: m.id, name: m.name, url, password: !!(flags & 1) };
  }

  return { encode, decode, METHODS };
})();
if (typeof module !== 'undefined') module.exports = FluxCode;
