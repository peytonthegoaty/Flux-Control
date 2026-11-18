// Dev codes: a code unlocks one named feature on this PC, and removing the code turns it off again.
//
// Only a SHA-256 hash of each code is stored here and on the user's PC, never the code itself.
// To create a code: node tools/make-dev-code.js "MY-CODE" my-feature-id "Name" "What it does"
// and paste the printed line into REGISTRY below. App code then asks Features.has('my-feature-id').
//
const Features = (() => {
  const REGISTRY = {
    // '<sha256 of the normalised code>': { id: 'feature-id', name: 'Shown in settings', desc: 'One line about it' },
    'd19d1cb63168058d6d40512653106207b0ed21c498bba5a9cda7f85a9f7d1eea': { id: 'claude', name: "Claude", desc: "Adds the Claude section: chat with Claude Code on this PC and read your saved chats." },
    '0120f3fb9abc15ae73cf846f454ec7c4035d0683fd9b1272bb3d0f14e82f0275': { id: 'roblox-executor', name: 'Roblox Executor', desc: 'Adds the Executor section: a script editor, an auto-execute list and a copy-load-script button.' },
  };

  const norm = (c) => String(c || '').toUpperCase().replace(/[\s-]+/g, '');
  const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');

  function create(storage, registry) {
    const KEY = 'fluxDevCodes';
    const subs = [];
    const read = () => { try { const v = JSON.parse(storage.getItem(KEY)); return Array.isArray(v) ? v : []; } catch { return []; } };
    const write = (v) => { try { storage.setItem(KEY, JSON.stringify(v)); } catch {} subs.forEach((f) => f()); };
    return {
      /** added codes that are still valid, with their feature info */
      list: () => read().filter((e) => registry[e.hash]).map((e) => ({ hash: e.hash, at: e.at, ...registry[e.hash] })),
      has: (id) => read().some((e) => registry[e.hash] && registry[e.hash].id === id),
      async add(code) {
        const n = norm(code);
        if (n.length < 4) return { ok: false, err: 'Enter a code' };
        const hash = await sha(n);
        const f = registry[hash];
        if (!f) return { ok: false, err: "That code isn't valid" };
        const cur = read();
        if (cur.some((e) => e.hash === hash)) return { ok: false, err: 'That code is already added' };
        write([...cur, { hash, at: Date.now() }]);
        return { ok: true, feature: { ...f } };
      },
      remove(hash) { write(read().filter((e) => e.hash !== hash)); },
      onChange(f) { subs.push(f); },
    };
  }

  const store = typeof localStorage !== 'undefined' ? localStorage : { getItem: () => null, setItem() {} };
  return { create, sha, norm, ...create(store, REGISTRY) };
})();
if (typeof module !== 'undefined') module.exports = Features;
