// Flux Control custom controls. Nothing here may use a native/default control (see CLAUDE.md).
const fx = (() => {
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const chev = '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';

  const icons = {
    globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/></svg>',
    monitor: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2.5"/><path d="M8 20h8M12 16v4"/></svg>',
    layers: '<svg viewBox="0 0 24 24"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg>',
    server: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>',
    sliders: '<svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>',
    wifi: '<svg viewBox="0 0 24 24"><path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><path d="M12 19.5h.01"/></svg>',
    upnp: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 8l5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg>',
    tunnel: '<svg viewBox="0 0 24 24"><path d="M4 20V11a8 8 0 0 1 16 0v9"/><path d="M9 20v-8a3 3 0 0 1 6 0v8"/></svg>',
    link: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/></svg>',
    hash: '<svg viewBox="0 0 24 24"><path d="M5 9h14M5 15h14M10 3L8 21M16 3l-2 18"/></svg>',
    cloud: '<svg viewBox="0 0 24 24"><path d="M7 18a4 4 0 0 1-.6-7.96A6 6 0 0 1 18 9.5a4.2 4.2 0 0 1-.5 8.5H7z"/></svg>',
    terminal: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 10l3 2.5L7 15M13 15h4"/></svg>',
    bolt: '<svg viewBox="0 0 24 24"><path d="M13 3L5 13.5h6L10 21l8-10.5h-6L13 3z"/></svg>',
    qr: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 14h3v3M21 14v.01M14 21h3M21 17v4"/></svg>',
  };

  // ---- custom scrollbar -------------------------------------------------
  function scroll(root) {
    const view = root.querySelector('.view');
    const thumb = el('div', 'thumb');
    const ft = el('div', 'fx-fade t'), fb = el('div', 'fx-fade b');
    ft.style.transition = fb.style.transition = 'opacity .3s';
    root.append(thumb, ft, fb);
    let hide;
    const upd = () => {
      const { scrollTop: st, scrollHeight: sh, clientHeight: ch } = view;
      const can = sh > ch + 1;
      root.classList.toggle('noscroll', !can);
      ft.style.opacity = can && st > 4 ? 1 : 0;
      fb.style.opacity = can && st < sh - ch - 4 ? 1 : 0;
      if (!can) return;
      const th = Math.max(36, (ch * ch) / sh);
      thumb.style.height = th + 'px';
      thumb.style.transform = `translateY(${(st / (sh - ch)) * (ch - th)}px)`;
    };
    view.addEventListener('scroll', () => {
      upd(); root.classList.add('act'); clearTimeout(hide); hide = setTimeout(() => root.classList.remove('act'), 900);
    });
    new ResizeObserver(upd).observe(view);
    new MutationObserver(upd).observe(view, { childList: true, subtree: true });
    thumb.addEventListener('pointerdown', (e) => {
      e.preventDefault(); thumb.setPointerCapture(e.pointerId); thumb.classList.add('drag');
      const y0 = e.clientY, s0 = view.scrollTop;
      const mv = (m) => { const { scrollHeight: sh, clientHeight: ch } = view; const th = thumb.offsetHeight; view.scrollTop = s0 + ((m.clientY - y0) * (sh - ch)) / (ch - th); };
      const up = () => { thumb.classList.remove('drag'); thumb.removeEventListener('pointermove', mv); thumb.removeEventListener('pointerup', up); };
      thumb.addEventListener('pointermove', mv); thumb.addEventListener('pointerup', up);
    });
    upd();
  }

  // ---- dropdown ---------------------------------------------------------
  const closeAll = (except) => document.querySelectorAll('.fx-select.open').forEach((s) => s !== except && s.classList.remove('open'));
  document.addEventListener('click', () => closeAll());
  // scrolling inside an open menu must not close it (a long model list scrolls); scrolling the page under it re-pins the menu
  document.addEventListener('scroll', (e) => {
    const open = [...document.querySelectorAll('.fx-select.open')];
    if (!open.length) return;
    if (e.target instanceof Node && open.some((s) => s.contains(e.target))) return;
    open.forEach((s) => s._place && s._place());
  }, true);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeAll());

  function select(root, onchange) {
    const opts = JSON.parse(root.dataset.options);
    let val = root.dataset.value;
    const long = opts.length > 8;   // long lists (models) get a search box
    root.innerHTML = `<button class="cur"><span></span>${chev}</button><div class="menu">${long ? '<div class="fx-field sel-search"><input class="fx-input" type="text" placeholder="Search" spellcheck="false" autocomplete="off"></div>' : ''}<div class="opts"></div></div>`;
    const label = root.querySelector('.cur span'), menu = root.querySelector('.menu'), list = menu.querySelector('.opts'), q = menu.querySelector('input');
    const render = () => {
      label.textContent = (opts.find((o) => o[0] === val) || opts[0])[1];
      const f = q ? q.value.trim().toLowerCase() : '';
      list.innerHTML = opts.filter((o) => !f || String(o[1]).toLowerCase().includes(f)).map((o) => `<div class="opt ${o[0] === val ? 'sel' : ''}" data-v="${o[0]}">${o[1]}</div>`).join('') || '<div class="opt none">No matches</div>';
    };
    if (q) { q.onclick = (e) => e.stopPropagation(); q.oninput = render; }
    // the menu is position:fixed so scroll containers never clip it
    const place = () => {
      const r = root.querySelector('.cur').getBoundingClientRect();
      const h = Math.min(220, opts.length * 40 + 12);
      const up = r.bottom + h + 100 > innerHeight;
      menu.style.left = r.left + 'px'; menu.style.width = r.width + 'px';
      menu.style.top = up ? 'auto' : r.bottom + 8 + 'px';
      menu.style.bottom = up ? innerHeight - r.top + 8 + 'px' : 'auto';
      menu.style.transformOrigin = up ? 'bottom' : 'top';
    };
    root.querySelector('.cur').onclick = (e) => { e.stopPropagation(); closeAll(root); place(); root.classList.toggle('open'); if (q && root.classList.contains('open')) { q.value = ''; render(); setTimeout(() => q.focus(), 50); } };
    root._place = place;   // the scroll handler re-pins the fixed menu when the page under it scrolls
    menu.onclick = (e) => {
      const o = e.target.closest('.opt'); if (!o || o.classList.contains('none')) return;
      val = o.dataset.v; render(); root.classList.remove('open'); onchange && onchange(val);
    };
    render();
    return { get: () => val };
  }

  // ---- toggle -----------------------------------------------------------
  function toggle(root, onchange) {
    root.setAttribute('role', 'switch');
    root.onclick = () => { root.classList.toggle('on'); onchange && onchange(root.classList.contains('on')); };
  }

  // ---- slider -----------------------------------------------------------
  function slider(root, onchange) {
    const min = +root.dataset.min, max = +root.dataset.max, step = +root.dataset.step;
    let v = +root.dataset.value;
    const fmt = { bal: (x) => (x < 35 ? 'Lowest latency' : x < 65 ? 'Balanced' : 'Best quality') }[root.dataset.fmt] || ((x) => x + (root.dataset.suffix || ''));
    root.innerHTML = `<div class="sl-head" style="margin-bottom:8px"><span style="color:var(--mut)">${root.dataset.label || ''}</span><b class="sl-val"></b></div><div class="trk"><div class="fill"></div><div class="knob"></div></div>`;
    const trk = root.querySelector('.trk'), fill = root.querySelector('.fill'), knob = root.querySelector('.knob'), out = root.querySelector('.sl-val');
    const draw = () => { const p = ((v - min) / (max - min)) * 100; fill.style.width = p + '%'; knob.style.left = p + '%'; out.textContent = fmt(v); };
    const setFrom = (x) => {
      const r = trk.getBoundingClientRect();
      const raw = min + Math.min(1, Math.max(0, (x - r.left) / r.width)) * (max - min);
      const nv = Math.round(raw / step) * step;
      if (nv !== v) { v = nv; draw(); onchange && onchange(v); }
    };
    root.addEventListener('pointerdown', (e) => {
      root.setPointerCapture(e.pointerId); root.classList.add('drag'); setFrom(e.clientX);
      const mv = (m) => setFrom(m.clientX);
      const up = () => { root.classList.remove('drag'); root.removeEventListener('pointermove', mv); root.removeEventListener('pointerup', up); };
      root.addEventListener('pointermove', mv); root.addEventListener('pointerup', up);
    });
    draw();
    return { get: () => v };
  }

  // ---- cards (single or multi select) ----------------------------------
  function cards(root, items, { multi = false, selected = [], onchange } = {}) {
    const sel = new Set(selected);
    root.innerHTML = '';
    items.forEach((it) => {
      const b = el('button', 'fx-card' + (multi ? ' multi' : '') + (sel.has(it.id) ? ' sel' : '') + (it.disabled ? ' dis' : ''),
        `<div class="ci">${icons[it.icon] || ''}</div><div class="ct">${it.title}</div>${it.badge ? `<span class="badge ${it.badgeKind || ''}">${it.badge}</span>` : ''}<div class="cd">${it.desc}</div>${it.url ? `<div class="url">${it.url}</div>` : ''}`);
      b.onclick = () => {
        if (it.disabled) return;
        if (multi) {
          if (sel.has(it.id)) sel.delete(it.id);
          else {
            // an exclusive card clears the others; picking any other card clears exclusive ones
            items.forEach((o) => { if (it.exclusive || o.exclusive) sel.delete(o.id); });
            sel.add(it.id);
          }
          root.querySelectorAll('.fx-card').forEach((c, i) => c.classList.toggle('sel', sel.has(items[i].id)));
        }
        else { sel.clear(); sel.add(it.id); root.querySelectorAll('.fx-card').forEach((c) => c.classList.remove('sel')); b.classList.add('sel'); }
        onchange && onchange([...sel]);
      };
      root.appendChild(b);
    });
  }

  // ---- text field focus chrome -----------------------------------------
  function field(root) {
    const i = root.querySelector('.fx-input');
    i.addEventListener('focus', () => root.classList.add('focus'));
    i.addEventListener('blur', () => root.classList.remove('focus'));
  }

  // ---- toast -------------------------------------------------------------
  function toast(msg) {
    const t = el('div', 'toast', msg);
    document.getElementById('toasts').appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 450); }, 2600);
  }

  // ---- modal dialog ------------------------------------------
  function ask({ title, text = '', ok = 'OK', cancel = 'Cancel', input = null }) {
    return new Promise((res) => {
      const m = el('div', 'fx-modal', `<div class="box"><h3>${title}</h3><p>${text}</p>${input ? '<div class="fx-field" style="margin-top:14px"><input class="fx-input" type="text" spellcheck="false" autocomplete="off"></div>' : ''}<div class="acts"><button class="btn ghost" data-r="0">${cancel}</button><button class="btn pri" data-r="1">${ok}</button></div></div>`);
      const field = m.querySelector('.fx-input');
      if (field) { field.placeholder = input.placeholder || ''; field.value = input.value || ''; fx.field(field.parentElement); setTimeout(() => field.focus(), 350); }
      const done = (v) => { m.classList.remove('open'); document.removeEventListener('keydown', key); setTimeout(() => m.remove(), 300); res(field ? (v ? field.value : null) : v); };
      const key = (e) => { if (e.key === 'Escape') done(false); if (e.key === 'Enter') done(true); };
      m.addEventListener('click', (e) => { const b = e.target.closest('[data-r]'); if (b) done(b.dataset.r === '1'); else if (e.target === m) done(false); });
      document.addEventListener('keydown', key);
      document.body.appendChild(m);
      requestAnimationFrame(() => requestAnimationFrame(() => m.classList.add('open')));
    });
  }

  // ---- popover menu (toggle button + menu inside one wrapper) -------------
  function popover(wrap, trigger, enabled = () => true) {
    const close = () => wrap.classList.remove('open');
    trigger.addEventListener('click', (e) => { e.stopPropagation(); if (enabled()) wrap.classList.toggle('open'); });
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target) || e.target.closest('.menu-item')) close(); });
    document.addEventListener('keydown', (e) => e.key === 'Escape' && close());
    return { close };
  }

  // ---- floating pill: a circle with the F until the pointer comes near; it folds back when the pointer leaves --------
  function pill(bar, circleBtn, keepOpen = () => false) {
    let t;
    const open = () => {
      clearTimeout(t);
      bar.classList.remove('collapsed');
      t = setTimeout(() => bar.classList.add('settled'), 520);   // menus may hang outside it once it has finished opening
    };
    const close = () => {
      clearTimeout(t);
      if (keepOpen()) { t = setTimeout(close, 700); return; }   // a menu is open: stay
      bar.classList.remove('settled');
      bar.classList.add('collapsed');
    };
    // no circle: the bar stays open; Right Ctrl (flux:topbar from the viewer) hides and shows it
    circleBtn.hidden = true;
    document.addEventListener('flux:topbar', () => (bar.classList.contains('collapsed') ? open() : close()));
    open();
    return { open, close, peek: () => {} };
  }

  return { el, icons, scroll, select, toggle, slider, cards, field, toast, ask, popover, pill };
})();
