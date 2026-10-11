#!/usr/bin/env node
// test_userscript.js — 4ndr0SERVICEGUARD v7.4.0 behavioral harness
// (userscript/4ndr0tools - 4ndr0serviceguarder.user.js)
// GUP v5.3.1 evidence artifact. Executes the REAL helper userscript in a fresh
// Node vm context per scenario with GM_* mocks, a minimal DOM, a synthetic
// window and a deterministic manual clock. 89 cases; the U30–U34 family is
// the sandboxed-frame (opaque origin) resilience matrix.
//
// Usage: node test_userscript.js   (sources resolved ../4ndr0serviceguard/)
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '4ndr0serviceguard', 'userscript', '4ndr0tools - 4ndr0serviceguarder.user.js');
const SOURCE = fs.readFileSync(SRC, 'utf8');

// === Manual deterministic clock ===
class ManualClock {
  constructor(start) { this.now = start || 1755000000000; this.seq = 0; this.timers = new Map(); this.errors = []; }
  setTimeout(fn, ms) { const id = ++this.seq; this.timers.set(id, { at: this.now + Math.max(0, Number(ms) || 0), fn }); return id; }
  clearTimeout(id) { this.timers.delete(id); }
  async flush() { for (let i = 0; i < 24; i++) await new Promise((r) => setImmediate(r)); }
  async advance(ms) {
    const target = this.now + ms;
    await this.flush(); // let pending promise chains schedule their timers first
    for (;;) {
      let best = null;
      for (const [id, t] of this.timers) if (!best || t.at < best.at) best = { id, at: t.at, fn: t.fn };
      if (!best || best.at > target) break;
      this.now = best.at;
      this.timers.delete(best.id);
      try { best.fn(); } catch (e) { this.errors.push(e); }
      await this.flush();
    }
    this.now = Math.max(this.now, target);
    await this.flush();
  }
}

// === Page-world shims ===
class FakeEvent { constructor(type, init) { this.type = type; if (init) Object.assign(this, init); } }
class FakeCloseEvent extends FakeEvent {}
class FakeDOMException extends Error { constructor(m, n) { super(m); this.name = n || 'Error'; } }

class FakeNativeWebSocket {
  constructor(url, protocols) { this.url = url; this.protocols = protocols; this.readyState = 0; this.sent = []; this.listeners = []; FakeNativeWebSocket.constructed.push(this); }
  addEventListener(t, l) { this.listeners.push({ type: t, listener: l }); }
  removeEventListener() {}
  send(d) { this.sent.push(d); }
  close() { this.readyState = 3; }
}
FakeNativeWebSocket.constructed = [];
class FakeNativeSharedWorker {
  constructor(scriptURL) { this.scriptURL = scriptURL; FakeNativeSharedWorker.constructed.push(this); }
}
FakeNativeSharedWorker.constructed = [];

// === Minimal DOM ===
class MiniElement {
  constructor(tag) {
    this.tagName = String(tag || '').toUpperCase(); this.children = []; this._listeners = new Map();
    this._shadowRoot = null; this.id = ''; this.className = ''; this.textContent = ''; this.dataset = {};
    this.style = {}; this.disabled = false; this.title = ''; this.parentNode = null; this.value = '';
    this.attributes = {}; this._cls = new Set();
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i !== -1) this.children.splice(i, 1); c.parentNode = null; return c; }
  contains(c) { if (c === this) return true; return this.children.some((ch) => ch.contains(c)); }
  addEventListener(type, fn, opts) { if (!this._listeners.has(type)) this._listeners.set(type, []); this._listeners.get(type).push({ fn, opts }); }
  removeEventListener(type, fn) { const l = this._listeners.get(type) || []; const i = l.findIndex((x) => x.fn === fn); if (i !== -1) l.splice(i, 1); }
  dispatch(type, ev) { (this._listeners.get(type) || []).forEach((l) => l.fn(ev || { type })); }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k]; }
  hasAttribute(k) { return k in this.attributes; }
  attachShadow(opts) { if (!this._shadowRoot) { this._shadowRoot = new MiniElement('#shadow'); this._shadowRoot.mode = opts && opts.mode; } return this._shadowRoot; }
  get classList() {
    const self = this;
    return {
      add(...cs) { cs.forEach((c) => self._cls.add(c)); },
      remove(...cs) { cs.forEach((c) => self._cls.delete(c)); },
      toggle(cls, force) { const on = force === undefined ? !self._cls.has(cls) : !!force; if (on) self._cls.add(cls); else self._cls.delete(cls); return on; },
      contains(c) { return self._cls.has(c); },
    };
  }
  click() { this.dispatch('click', { isTrusted: true, target: this, preventDefault() {} }); }
}

function makeDocument(opts) {
  const o = opts || {};
  const doc = {
    documentElement: new MiniElement('html'),
    listeners: new Map(),
    created: [],
  };
  doc.createElement = (t) => { const el = new MiniElement(t); doc.created.push(el); return el; };
  doc.createElementNS = (ns, t) => doc.createElement(t);
  doc.getElementById = (id) => findInTree(doc.documentElement, (el) => el.id === id);
  doc.addEventListener = (type, fn, opts) => { if (!doc.listeners.has(type)) doc.listeners.set(type, []); doc.listeners.get(type).push({ fn, opts }); };
  doc.removeEventListener = (type, fn) => { const l = doc.listeners.get(type) || []; const i = l.findIndex((x) => x.fn === fn); if (i !== -1) l.splice(i, 1); };
  if (o.sandboxed) {
    Object.defineProperty(doc, 'cookie', { get() { throw new FakeDOMException('Access to storage is not allowed from this document.', 'SecurityError'); } });
  } else {
    doc.cookie = 'sid=1';
  }
  return doc;
}
function findInTree(root, pred) { if (pred(root)) return root; for (const c of root.children) { const f = findInTree(c, pred); if (f) return f; } return null; }
function findAllInTree(root, pred, out) { out = out || []; if (pred(root)) out.push(root); for (const c of root.children) findAllInTree(c, pred, out); return out; }

// === GM mocks ===
function makeGM(preset, opts) {
  const o = opts || {};
  const store = new Map(preset || []);
  const gm = {
    store,
    menus: [], notifications: [], writes: [],
    getValue: (k, d) => (store.has(k) ? store.get(k) : d),
    setValue: (k, v) => { store.set(k, v); gm.writes.push([k, v]); },
    registerMenuCommand: (label, fn) => { gm.menus.push({ label, fn }); return gm.menus.length; },
    notification: (obj) => { gm.notifications.push(obj); },
  };
  if (o.noNotificationApi) gm.notification = undefined; // simulate a manager without GM_notification
  return gm;
}

// === Scenario loader ===
function loadUserScript(opts) {
  const o = opts || {};
  const clock = new ManualClock();
  const gm = makeGM(o.gm, o);
  const doc = makeDocument(o);

  const win = {
    _messages: [], _promptCalls: [], _confirmCalls: [],
    location: {
      origin: o.opaque ? 'null' : 'https://stand.example',
      href: 'https://stand.example/page',
      hostname: 'stand.example',
    },
    URL, Promise, Event: FakeEvent, CloseEvent: FakeCloseEvent, DOMException: FakeDOMException, TypeError,
    postMessage(msg, target) { win._messages.push({ msg, target }); if (win._postMessageThrows) throw new Error('postMessage failed (injected)'); },
    prompt(title, current) { win._promptCalls.push({ title, current }); return win._promptResult !== undefined ? win._promptResult : null; },
    confirm(text) { win._confirmCalls.push(text); return win._confirmResult !== undefined ? win._confirmResult : false; },
  };
  win.top = o.iframe ? { marker: 'top-frame' } : win;
  win.WebSocket = FakeNativeWebSocket;
  win.SharedWorker = FakeNativeSharedWorker;
  win.caches = { keys: () => Promise.resolve(['c1']), delete: (k) => { win._cacheDeletes = (win._cacheDeletes || []).concat(k); return Promise.resolve(true); } };
  win._4ndr0ghostV7 = o.extensionPresent ? true : undefined;

  const navigatorMock = {};
  if (o.sandboxed) {
    Object.defineProperty(navigatorMock, 'serviceWorker', {
      get() { throw new FakeDOMException('Access to service workers is denied for this origin.', 'SecurityError'); },
      configurable: true,
    });
  } else if (o.noServiceWorker) {
    navigatorMock.serviceWorker = undefined;
  } else {
    navigatorMock.serviceWorker = {
      constructor: { prototype: {} },
      register(url, options) { this.registerCalls = this.registerCalls || []; this.registerCalls.push({ url, options }); return Promise.resolve({ scope: (options && options.scope) || './' }); },
      getRegistrations() { return Promise.resolve(o.registrations || []); },
      getRegistration() { return Promise.resolve(undefined); },
      controller: null,
      ready: Promise.resolve({}),
    };
    Object.defineProperty(navigatorMock.serviceWorker.constructor.prototype, 'register', {
      value: navigatorMock.serviceWorker.register, writable: true, configurable: true, enumerable: false,
    });
  }
  win.navigator = navigatorMock;
  const realSWRef = (o.sandboxed || o.noServiceWorker) ? null : navigatorMock.serviceWorker;

  const sandbox = {
    document: doc, console: {
      log() {},
      error() {},
      debug: (...a) => { (sandbox._debugLogs = sandbox._debugLogs || []).push(a.join(' ')); },
    },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    Date: { now: () => clock.now },
    AbortController,
    GM_getValue: gm.getValue,
    GM_setValue: gm.setValue,
    GM_registerMenuCommand: gm.registerMenuCommand,
    GM_notification: gm.notification,
    unsafeWindow: win,
    window: win,
  };

  let loadError = null;
  try { vm.runInNewContext(SOURCE, sandbox, { filename: 'helper.user.js' }); }
  catch (e) { loadError = e; }

  return { sandbox, win, doc, gm, clock, loadError, navigatorMock, realSWRef };
}

// === Runner ===
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, e, msg) { if (a !== e) throw new Error((msg || 'eq') + ': expected ' + JSON.stringify(e) + ', got ' + JSON.stringify(a)); }
function menuByLabel(gm, prefix) { const m = gm.menus.find((x) => x.label.startsWith(prefix)); if (!m) throw new Error('menu not found: ' + prefix); return m; }
function wsBaseline() { return FakeNativeWebSocket.constructed.length; }
function hudHost(doc) { return findInTree(doc.documentElement, (el) => el.id === '__4ndr0guard_hud_host'); }
function hudShadow(doc) { const h = hudHost(doc); return h ? h._shadowRoot : null; }
function findByText(root, text) { return findInTree(root, (el) => el.textContent === text); }
function rowValue(shadow, label) {
  const rows = findAllInTree(shadow, (el) => String(el.className).split(/\s+/).includes('row'));
  for (const r of rows) {
    const k = r.children[0]; const v = r.children[1];
    if (k && v && k.textContent === label) return v;
  }
  return null;
}
async function main() {
  let pass = 0; let fail = 0;
  for (const t of tests) {
    try { await t.fn(); pass++; }
    catch (e) { fail++; console.log('  [FAIL] ' + t.name + ' :: ' + (e && e.message)); }
  }
  console.log('\n[test_userscript] ' + pass + '/' + tests.length + ' cases passed' + (fail ? (' — ' + fail + ' FAILED') : ''));
  process.exitCode = (fail || tests.length !== 89) ? 1 : 0;
}

// =====================================================================
// U01–U03 — normalizeDomain (exercised through editList persistence)
// =====================================================================
test('U01 editList strips https scheme, path and case', async () => {
  const s = loadUserScript({});
  s.win._promptResult = 'https://A.com/deep/path';
  menuByLabel(s.gm, 'Edit whitelist').fn();
  eq(s.gm.store.get('4ndr0guard_whitelist_v6').join(), 'a.com', 'U01');
});
test('U02 editList strips http scheme and punycode marker', async () => {
  const s = loadUserScript({});
  s.win._promptResult = 'http://xn--b.com';
  menuByLabel(s.gm, 'Edit whitelist').fn();
  eq(s.gm.store.get('4ndr0guard_whitelist_v6').join(), 'b.com', 'U02');
});
test('U03 userscript normalizer keeps non-http schemes (documented fidelity)', async () => {
  const s = loadUserScript({});
  s.win._promptResult = 'wss://kept.example';
  menuByLabel(s.gm, 'Edit whitelist').fn();
  eq(s.gm.store.get('4ndr0guard_whitelist_v6').join(), 'wss:', 'U03 — the helper strips http(s):// only; its path-strip then truncates wss:// inputs (as-shipped v7.4.0 behavior)');
});

// =====================================================================
// U04–U15 — decide(): the local gate order (observed through the WS gate)
// =====================================================================
test('U04 decide: blacklisted target → deny phantom', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_blacklist_v7', ['bad.example']]] });
  const before = wsBaseline();
  new s.win.WebSocket('wss://bad.example/ws');
  eq(FakeNativeWebSocket.constructed.length, before, 'U04 — no real construction');
});
test('U05 decide: blacklisted page origin → deny even for clean targets', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_blacklist_v7', ['stand.example']]] });
  const before = wsBaseline();
  new s.win.WebSocket('wss://clean.example/ws');
  eq(FakeNativeWebSocket.constructed.length, before, 'U05');
});
test('U06 decide: blacklist outranks spooflist', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_blacklist_v7', ['dual.example']], ['4ndr0guard_spooflist_v7', ['dual.example']]] });
  const ws = new s.win.WebSocket('wss://dual.example/ws');
  const events = [];
  ws.onerror = () => { events.push('error'); };
  ws.onclose = () => { events.push('close'); };
  await s.clock.advance(60);
  eq(events.join(','), 'error,close', 'U06 — deny wins (native failure), not spoof');
  eq(ws.readyState, 3, 'U06b');
});
test('U07 decide: blacklist outranks disabled master toggle', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_blacklist_v7', ['bad.example']], ['4ndr0guard_enabled_v7', false]] });
  const before = wsBaseline();
  new s.win.WebSocket('wss://bad.example/ws');
  eq(FakeNativeWebSocket.constructed.length, before, 'U07 — prohibition survives pass-through');
});
test('U08 decide: spooflisted target → pacified socket', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_spooflist_v7', ['pacify.example']]] });
  const ws = new s.win.WebSocket('wss://pacify.example/ws');
  await s.clock.advance(50);
  eq(ws.readyState, 1, 'U08 — OPEN at the 40ms cadence');
});
test('U09 decide: spooflisted page origin → pacified socket', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_spooflist_v7', ['stand.example']]] });
  const ws = new s.win.WebSocket('wss://anything.example/ws');
  await s.clock.advance(50);
  eq(ws.readyState, 1, 'U09');
});
test('U10 decide: spooflist outranks whitelist', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_spooflist_v7', ['dual.example']], ['4ndr0guard_whitelist_v6', ['dual.example']]] });
  const ws = new s.win.WebSocket('wss://dual.example/ws');
  await s.clock.advance(50);
  eq(ws.readyState, 1, 'U10 — spoof wins');
});
test('U11 decide: spooflist outranks disabled toggle', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_spooflist_v7', ['pacify.example']], ['4ndr0guard_enabled_v7', false]] });
  const ws = new s.win.WebSocket('wss://pacify.example/ws');
  await s.clock.advance(50);
  eq(ws.readyState, 1, 'U11 — explicit spoof survives pass-through');
});
test('U12 decide: disabled master toggle → real connection', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_enabled_v7', false]] });
  const before = wsBaseline();
  const ws = new s.win.WebSocket('wss://passthrough.example/ws');
  eq(FakeNativeWebSocket.constructed.length, before + 1, 'U12');
  ok(ws instanceof FakeNativeWebSocket, 'U12b');
});
test('U13 decide: DDoS-Guard fast path → real connection', async () => {
  const s = loadUserScript({});
  const before = wsBaseline();
  const ws = new s.win.WebSocket('https://check.ddos-guard.net/pacifier_v5.js');
  eq(FakeNativeWebSocket.constructed.length, before + 1, 'U13');
  ok(ws instanceof FakeNativeWebSocket, 'U13b');
});
test('U14 decide: whitelisted target → real connection', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_whitelist_v6', ['real.example']]] });
  const before = wsBaseline();
  new s.win.WebSocket('wss://real.example/ws');
  eq(FakeNativeWebSocket.constructed.length, before + 1, 'U14');
});
test('U15 decide: default-deny for unknown targets', async () => {
  const s = loadUserScript({});
  const before = wsBaseline();
  const ws = new s.win.WebSocket('wss://unknown.example/ws');
  eq(FakeNativeWebSocket.constructed.length, before, 'U15 — phantom, not real');
  eq(ws.readyState, 0, 'U15b — CONNECTING');
});

// =====================================================================
// U16–U25 — list management (mutual exclusion, edits, persistence)
// =====================================================================
test('U16 authorize-site menu prunes blacklist + spooflist siblings', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_blacklist_v7', ['stand.example']], ['4ndr0guard_spooflist_v7', ['stand.example']]] });
  menuByLabel(s.gm, 'Authorize current domain').fn();
  eq(s.gm.store.get('4ndr0guard_whitelist_v6').join(), 'stand.example', 'U16');
  eq(String(s.gm.store.get('4ndr0guard_blacklist_v7')), '', 'U16b');
  eq(String(s.gm.store.get('4ndr0guard_spooflist_v7')), '', 'U16c');
});
test('U17 blacklist-site menu prunes whitelist + spooflist siblings', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_whitelist_v6', ['stand.example']], ['4ndr0guard_spooflist_v7', ['stand.example']]] });
  menuByLabel(s.gm, 'Blacklist current domain').fn();
  eq(s.gm.store.get('4ndr0guard_blacklist_v7').join(), 'stand.example', 'U17');
  eq(String(s.gm.store.get('4ndr0guard_whitelist_v6')), '', 'U17b');
  eq(String(s.gm.store.get('4ndr0guard_spooflist_v7')), '', 'U17c');
});
test('U18 spoof-site menu prunes whitelist + blacklist siblings', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_whitelist_v6', ['stand.example']], ['4ndr0guard_blacklist_v7', ['stand.example']]] });
  menuByLabel(s.gm, 'Spoof current domain').fn();
  eq(s.gm.store.get('4ndr0guard_spooflist_v7').join(), 'stand.example', 'U18');
  eq(String(s.gm.store.get('4ndr0guard_whitelist_v6')), '', 'U18b');
  eq(String(s.gm.store.get('4ndr0guard_blacklist_v7')), '', 'U18c');
});
test('U19 remove-current-domain menu clears every list', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_whitelist_v6', ['stand.example', 'other.example']], ['4ndr0guard_blacklist_v7', ['stand.example']], ['4ndr0guard_spooflist_v7', ['stand.example']]] });
  menuByLabel(s.gm, 'Remove current domain from lists').fn();
  eq(s.gm.store.get('4ndr0guard_whitelist_v6').join(), 'other.example', 'U19');
  eq(String(s.gm.store.get('4ndr0guard_blacklist_v7')), '', 'U19b');
  eq(String(s.gm.store.get('4ndr0guard_spooflist_v7')), '', 'U19c');
});
test('U20 editList normalizes and dedups every line', async () => {
  const s = loadUserScript({});
  s.win._promptResult = 'A.com\na.com\nhttps://B.com/x\n\n';
  menuByLabel(s.gm, 'Edit blacklist').fn();
  eq(s.gm.store.get('4ndr0guard_blacklist_v7').join(), 'a.com,b.com', 'U20');
});
test('U21 editList prompt cancel keeps the list intact', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_spooflist_v7', ['keep.example']]] });
  s.win._promptResult = null; // user pressed Cancel
  menuByLabel(s.gm, 'Edit spooflist').fn();
  eq(s.gm.store.get('4ndr0guard_spooflist_v7').join(), 'keep.example', 'U21');
});
test('U22 clearList confirm-cancel keeps entries', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_whitelist_v6', ['keep.example']]] });
  s.win._confirmResult = false;
  menuByLabel(s.gm, 'Clear whitelist').fn();
  eq(s.gm.store.get('4ndr0guard_whitelist_v6').join(), 'keep.example', 'U22');
});
test('U23 clearList confirm-ok empties the list', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_blacklist_v7', ['gone.example']]] });
  s.win._confirmResult = true;
  menuByLabel(s.gm, 'Clear blacklist').fn();
  eq(s.gm.store.get('4ndr0guard_blacklist_v7').length, 0, 'U23');
});
test('U24 master toggle menu persists + notifies', async () => {
  const s = loadUserScript({});
  menuByLabel(s.gm, 'Ψ Toggle Ghost Protocol').fn();
  eq(s.gm.store.get('4ndr0guard_enabled_v7'), false, 'U24');
  eq(s.gm.notifications.length, 1, 'U24b — user notified');
});
test('U25 duplicate add is a no-op (no double entries)', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_whitelist_v6', ['stand.example', 'other.example']]] });
  menuByLabel(s.gm, 'Authorize current domain').fn();
  eq(s.gm.store.get('4ndr0guard_whitelist_v6').join(), 'stand.example,other.example', 'U25 — unchanged');
});

// =====================================================================
// U26–U29 — notifications & menus
// =====================================================================
test('U26 deny notifications are OFF by default (stealth)', async () => {
  const s = loadUserScript({});
  new s.win.WebSocket('wss://quiet.example/ws');
  await s.clock.advance(60);
  eq(s.gm.notifications.length, 0, 'U26');
});
test('U27 deny notifications throttle to one per 8 seconds', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_notify_v7', true]] });
  new s.win.WebSocket('wss://one.example/ws');
  await s.clock.advance(50);
  new s.win.WebSocket('wss://two.example/ws');
  await s.clock.advance(50);
  eq(s.gm.notifications.length, 1, 'U27 — second denial inside the window suppressed');
});
test('U28 deny notifications bounded at 20 per session', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_notify_v7', true]] });
  for (let i = 0; i < 25; i++) {
    new s.win.WebSocket('wss://cap' + i + '.example/ws');
    await s.clock.advance(9000); // outside the throttle window every time
  }
  eq(s.gm.notifications.length, 20, 'U28 — session cap enforced');
});
test('U29 exactly 14 menu commands registered on top frames', async () => {
  const s = loadUserScript({});
  eq(s.gm.menus.length, 14, 'U29');
});

// =====================================================================
// U30–U34 — SANDBOXED-FRAME RESILIENCE MATRIX (v7.4.0)
// =====================================================================
test('U30a load survives in a sandboxed frame (cookie + SW getters throw)', async () => {
  const s = loadUserScript({ sandboxed: true });
  eq(s.loadError, null, 'U30a — no uncaught exception at load');
});
test('U30b guard flag set + condensed debug notice in sandboxed frames', async () => {
  const s = loadUserScript({ sandboxed: true });
  eq(s.win.__4ndr0ghostUserV7, true, 'U30b — flag set');
  ok((s.sandbox._debugLogs || []).some((l) => l.includes('sandboxed frame')), 'U30b2 — one condensed debug notice');
});
test('U30c no uncaught SecurityError replaces the v7.3 core death', async () => {
  const s = loadUserScript({ sandboxed: true });
  ok(!(s.sandbox._debugLogs || []).some((l) => l.includes('core initialization failed')), 'U30c');
  ok(s.clock.errors.length === 0, 'U30c2 — zero deferred crashes');
});
test('U31a WebSocket gate still armed inside sandboxed frames', async () => {
  const s = loadUserScript({ sandboxed: true });
  ok(s.win.WebSocket !== FakeNativeWebSocket, 'U31a — proxy installed');
  const before = wsBaseline();
  const ws = new s.win.WebSocket('wss://frame.example/ws');
  eq(FakeNativeWebSocket.constructed.length, before, 'U31a2 — phantom under default-deny');
  eq(ws.readyState, 0, 'U31a3');
});
test('U31b SW gate skipped in sandboxed frames (realSW is null there)', async () => {
  const s = loadUserScript({ sandboxed: true });
  // navigator.serviceWorker still the throwing getter — no fake container defined
  let threw = null;
  try { void s.win.navigator.serviceWorker; } catch (e) { threw = e; }
  ok(threw, 'U31b — the native prohibition surface is untouched');
});
test('U31c SharedWorker gate still installs in sandboxed frames', async () => {
  const s = loadUserScript({ sandboxed: true });
  let thrown = null;
  try { new s.win.SharedWorker('shared.js'); } catch (e) { thrown = e; }
  ok(thrown && thrown.name === 'SecurityError', 'U31c — default-deny SecurityError inside the sandbox');
});
test('U32 default-deny cadence works inside sandboxed frames (40ms error+close)', async () => {
  const s = loadUserScript({ sandboxed: true });
  const ws = new s.win.WebSocket('wss://denied.example/ws');
  const events = [];
  ws.onerror = () => { events.push('error'); };
  ws.onclose = () => { events.push('close'); };
  await s.clock.advance(50);
  eq(events.join(','), 'error,close', 'U32');
  eq(ws.readyState, 3, 'U32b');
});
test('U33 spooflisted frame host pacifies even on opaque origins', async () => {
  const s = loadUserScript({ sandboxed: true, gm: [['4ndr0guard_spooflist_v7', ['opaque-target.example']]] });
  const ws = new s.win.WebSocket('wss://opaque-target.example/ws');
  await s.clock.advance(50);
  eq(ws.readyState, 1, 'U33 — target-host spooflist match works regardless of page origin opacity');
});
test('U34a utility mode under the extension flag inside sandboxed frames', async () => {
  const s = loadUserScript({ sandboxed: true, extensionPresent: true });
  ok((s.sandbox._debugLogs || []).some((l) => l.includes('utility mode')), 'U34a');
  eq(s.win.WebSocket, FakeNativeWebSocket, 'U34a2 — no hooks layered over the extension');
});
test('U34b purge skipped in sandboxed frames (no SW surface to purge)', async () => {
  const s = loadUserScript({ sandboxed: true, registrations: [{ unregister() { throw new Error('must not run'); } }] });
  await s.clock.flush();
  eq(s.win.__4ndr0ghostUserV7, true, 'U34b — script alive, purge path inert (realSW null)');
});

// =====================================================================
// U35 — menu registration discipline
// =====================================================================
test('U35 iframes register zero menu commands (no iframe spam)', async () => {
  const s = loadUserScript({ iframe: true });
  eq(s.gm.menus.length, 0, 'U35');
});

// =====================================================================
// U36–U41 — companion mode & single-gate deferral doctrine
// =====================================================================
test('U36 extension-first install: no hooks layered (utility mode)', async () => {
  const s = loadUserScript({ extensionPresent: true });
  eq(s.win.WebSocket, FakeNativeWebSocket, 'U36 — WS untouched');
  eq(s.win.SharedWorker, FakeNativeSharedWorker, 'U36b — SharedWorker untouched');
  ok((s.sandbox._debugLogs || []).some((l) => l.includes('utility mode')), 'U36c');
});
test('U37 extension-first install: menus still registered (utility surface)', async () => {
  const s = loadUserScript({ extensionPresent: true });
  eq(s.gm.menus.length, 14, 'U37');
});
test('U38 extension arriving later: WS gate becomes a transparent conduit', async () => {
  const s = loadUserScript({});
  s.win._4ndr0ghostV7 = true; // the extension layers in after us
  const before = wsBaseline();
  const ws = new s.win.WebSocket('wss://governed.example/ws');
  eq(FakeNativeWebSocket.constructed.length, before + 1, 'U38 — real conduit');
  ok(ws instanceof FakeNativeWebSocket, 'U38b');
});
test('U39 extension arriving later: SW gate passes through', async () => {
  const s = loadUserScript({});
  s.win._4ndr0ghostV7 = true;
  await s.win.navigator.serviceWorker.register('later.js');
  ok(s.realSWRef.registerCalls, 'U39 — original register invoked');
  eq(s.realSWRef.registerCalls.length, 1, 'U39b');
  eq(s.realSWRef.registerCalls[0].url, 'later.js', 'U39c');
});
test('U40 extension arriving later: SharedWorker gate passes through', async () => {
  const s = loadUserScript({});
  s.win._4ndr0ghostV7 = true;
  const before = FakeNativeSharedWorker.constructed.length;
  const sw = new s.win.SharedWorker('conduit.js');
  eq(FakeNativeSharedWorker.constructed.length, before + 1, 'U40');
  ok(sw instanceof FakeNativeSharedWorker, 'U40b');
});
test('U41 standalone install: CSP violation listener registered', async () => {
  const s = loadUserScript({});
  ok(s.doc.listeners.has('securitypolicyviolation'), 'U41 — the helper owns CSP telemetry when alone');
});

// =====================================================================
// U42–U50 — Service Worker gatekeeper surface
// =====================================================================
test('U42 fake registration: resolved scope + scriptURL', async () => {
  const s = loadUserScript({});
  const reg = await s.win.navigator.serviceWorker.register('sw.js', { scope: '/x/' });
  eq(reg.scope, 'https://stand.example/x/', 'U42');
  eq(reg.scriptURL, 'https://stand.example/sw.js', 'U42b');
});
test('U43 fake registration: activated worker + identity tags', async () => {
  const s = loadUserScript({});
  const reg = await s.win.navigator.serviceWorker.register('sw.js');
  eq(reg.active.state, 'activated', 'U43');
  eq(reg.active.scriptURL, 'https://stand.example/sw.js', 'U43b');
  eq(reg[Symbol.toStringTag], 'ServiceWorkerRegistration', 'U43c');
  eq(reg.active[Symbol.toStringTag], 'ServiceWorker', 'U43d');
});
test('U44 fake registration memoized (identity-stable per script+scope)', async () => {
  const s = loadUserScript({});
  const r1 = await s.win.navigator.serviceWorker.register('sw.js', { scope: '/m/' });
  const r2 = await s.win.navigator.serviceWorker.register('sw.js', { scope: '/m/' });
  ok(r1 === r2, 'U44');
  const r3 = await s.win.navigator.serviceWorker.register('sw.js', { scope: '/n/' });
  ok(r1 !== r3, 'U44b — distinct scope, distinct registration');
});
test('U45 registration.update() identity-stable; unregister resolves true', async () => {
  const s = loadUserScript({});
  const reg = await s.win.navigator.serviceWorker.register('sw.js');
  ok((await reg.update()) === reg, 'U45');
  eq(await reg.unregister(), true, 'U45b');
});
test('U46 blocked register dispatches controllerchange at 25ms', async () => {
  const s = loadUserScript({});
  let fired = 0;
  s.win.navigator.serviceWorker.addEventListener('controllerchange', () => { fired++; });
  await s.win.navigator.serviceWorker.register('sw.js');
  await s.clock.advance(10);
  eq(fired, 0, 'U46 — not yet');
  await s.clock.advance(20);
  eq(fired, 1, 'U46b — fired at the 25ms lifecycle point');
});
test('U47 prototype hardening hook installed alongside the container hook', async () => {
  const s = loadUserScript({});
  const proto = s.win.navigator.serviceWorker.constructor.prototype;
  ok(proto.register && typeof proto.register === 'function', 'U47');
  const r = await proto.register.call(s.realSWRef, 'proto.js');
  ok(r && r[Symbol.toStringTag] === 'ServiceWorkerRegistration', 'U47b — proto path routes through the gate');
});
test('U48 container getRegistrations: [] when gated, real when allowed', async () => {
  const gated = loadUserScript({});
  const regs = await gated.win.navigator.serviceWorker.getRegistrations();
  ok(Array.isArray(regs) && regs.length === 0, 'U48 — gated view is empty');
  const allowed = loadUserScript({
    gm: [['4ndr0guard_whitelist_v6', ['stand.example']]],
    registrations: [{ unregister() { return Promise.resolve(true); } }],
  });
  const real = await allowed.win.navigator.serviceWorker.getRegistrations();
  ok(Array.isArray(real) && real.length === 1, 'U48b — passthrough serves the real container');
});
test('U49 container controller null while gated; ready serves the fake', async () => {
  const s = loadUserScript({});
  eq(s.win.navigator.serviceWorker.controller, null, 'U49');
  const reg = await s.win.navigator.serviceWorker.ready;
  eq(reg[Symbol.toStringTag], 'ServiceWorkerRegistration', 'U49b');
});
test('U50 whitelisted script host: register calls the real one', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_whitelist_v6', ['real.example']]] });
  await s.win.navigator.serviceWorker.register('https://real.example/sw.js');
  ok(s.realSWRef.registerCalls, 'U50');
  eq(s.realSWRef.registerCalls[0].url, 'https://real.example/sw.js', 'U50b');
});

// =====================================================================
// U51–U60 — WebSocket gatekeeper (three-way action model)
// =====================================================================
test('U51 denied socket: CONNECTING phantom then error+close at 40ms', async () => {
  const s = loadUserScript({});
  const ws = new s.win.WebSocket('wss://denied.example/ws');
  const events = [];
  ws.onerror = () => { events.push('error'); };
  ws.onclose = () => { events.push('close'); };
  eq(ws.readyState, 0, 'U51 — CONNECTING at first');
  await s.clock.advance(50);
  eq(events.join(','), 'error,close', 'U51b — native-faithful failure cadence');
  eq(ws.readyState, 3, 'U51c');
});
test('U52 denied socket: buffered sends during CONNECTING, throw after CLOSED', async () => {
  const s = loadUserScript({});
  const ws = new s.win.WebSocket('wss://buf.example/ws');
  ws.send('during-connecting');
  eq(ws.bufferedAmount, 1, 'U52 — buffered');
  await s.clock.advance(50);
  let thrown = null;
  try { ws.send('late'); } catch (e) { thrown = e; }
  ok(thrown && thrown.name === 'InvalidStateError', 'U52b');
});
test('U53 page-close during denied handshake: close-only, no error event', async () => {
  const s = loadUserScript({});
  const ws = new s.win.WebSocket('wss://early.example/ws');
  ws.close(); // page gave up before the cadence fired
  const events = [];
  ws.onerror = () => { events.push('error'); };
  ws.onclose = () => { events.push('close'); };
  await s.clock.advance(50);
  eq(events.join(','), 'close', 'U53 — no error after page-initiated close');
});
test('U54 spoofed socket: buffered listeners hear the synthetic open', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_spooflist_v7', ['pacify.example']]] });
  const ws = new s.win.WebSocket('wss://pacify.example/ws');
  const heard = [];
  ws.addEventListener('open', () => { heard.push('open'); });
  await s.clock.advance(50);
  eq(heard.length, 1, 'U54 — buffered listener fired once');
});
test('U55 spoofed socket: sends swallowed, bufferedAmount stays 0', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_spooflist_v7', ['pacify.example']]] });
  const ws = new s.win.WebSocket('wss://pacify.example/ws');
  await s.clock.advance(50);
  ws.send('page data');
  eq(ws.bufferedAmount, 0, 'U55');
});
test('U56 spoofed socket: subprotocol negotiation (first requested)', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_spooflist_v7', ['pacify.example']]] });
  const ws = new s.win.WebSocket('wss://pacify.example/ws', 'chat, superchat');
  await s.clock.advance(50);
  eq(ws.protocol, 'chat', 'U56');
});
test('U57 spoofed socket: page close settles a clean 1000/wasClean', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_spooflist_v7', ['pacify.example']]] });
  const ws = new s.win.WebSocket('wss://pacify.example/ws');
  await s.clock.advance(50);
  let closeEv = null;
  ws.onclose = (ev) => { closeEv = ev; };
  ws.close();
  await s.clock.advance(5);
  ok(closeEv, 'U57');
  eq(closeEv.code, 1000, 'U57b'); eq(closeEv.wasClean, true, 'U57c');
});
test('U58 spoofed socket closed mid-handshake never opens', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_spooflist_v7', ['pacify.example']]] });
  const ws = new s.win.WebSocket('wss://pacify.example/ws');
  ws.close(); // during CONNECTING
  await s.clock.advance(60);
  let opened = 0;
  ws.onopen = () => { opened++; };
  await s.clock.advance(10);
  eq(opened, 0, 'U58');
});
test('U59 WebSocket() invoked without new throws TypeError (native parity)', async () => {
  const s = loadUserScript({});
  let thrown = null;
  try { s.win.WebSocket('wss://x.example/'); } catch (e) { thrown = e; }
  ok(thrown && thrown instanceof TypeError, 'U59');
});
test('U60 constructor alias: prototype.constructor points at the proxy', async () => {
  const s = loadUserScript({});
  eq(FakeNativeWebSocket.prototype.constructor, s.win.WebSocket, 'U60');
});

// =====================================================================
// U61–U64 — SharedWorker gatekeeper
// =====================================================================
test('U61 denied SharedWorker throws the baseline SecurityError', async () => {
  const s = loadUserScript({});
  let thrown = null;
  try { new s.win.SharedWorker('shared.js'); } catch (e) { thrown = e; }
  ok(thrown && thrown.name === 'SecurityError', 'U61');
});
test('U62 spoofed target: SharedWorker keeps the SecurityError (documented doctrine)', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_spooflist_v7', ['spoofed.example']]] });
  let thrown = null;
  try { new s.win.SharedWorker('https://spoofed.example/w.js'); } catch (e) { thrown = e; }
  ok(thrown && thrown.name === 'SecurityError', 'U62 — MessagePort pacification out of scope');
});
test('U63 whitelisted SharedWorker constructs for real', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_whitelist_v6', ['ok.example']]] });
  const before = FakeNativeSharedWorker.constructed.length;
  const sw = new s.win.SharedWorker('https://ok.example/w.js');
  eq(FakeNativeSharedWorker.constructed.length, before + 1, 'U63');
  ok(sw instanceof FakeNativeSharedWorker, 'U63b');
});
test('U64 denied SharedWorker increments the session stats (HUD view)', async () => {
  const s = loadUserScript({});
  try { new s.win.SharedWorker('shared1.js'); } catch (e) { /* denied */ }
  try { new s.win.SharedWorker('shared2.js'); } catch (e) { /* denied */ }
  menuByLabel(s.gm, 'Show status HUD').fn();
  const v = rowValue(hudShadow(s.doc), 'SESSION');
  ok(v && v.textContent.includes('SHR 2'), 'U64 — stats surfaced: ' + (v && v.textContent));
});

// =====================================================================
// U65–U68 — purge-on-load discipline
// =====================================================================
test('U65 boot purge unregisters existing workers + clears caches', async () => {
  const unregistered = [];
  const s = loadUserScript({ registrations: [{ unregister() { unregistered.push(1); return Promise.resolve(true); } }, { unregister() { unregistered.push(2); return Promise.resolve(true); } }] });
  await s.clock.flush();
  eq(unregistered.length, 2, 'U65 — default-deny origin purged');
  eq(String(s.win._cacheDeletes), 'c1', 'U65b — cache cleared');
});
test('U66 whitelisted page origin: no boot purge', async () => {
  const unregistered = [];
  const s = loadUserScript({
    gm: [['4ndr0guard_whitelist_v6', ['stand.example']]],
    registrations: [{ unregister() { unregistered.push(1); return Promise.resolve(true); } }],
  });
  await s.clock.flush();
  eq(unregistered.length, 0, 'U66 — allowed origin keeps its workers');
});
test('U67 menu purge with no registrations reports "nothing to purge"', async () => {
  const s = loadUserScript({});
  await s.clock.flush();
  menuByLabel(s.gm, 'Purge Service Workers now').fn();
  await s.clock.flush();
  ok(s.gm.notifications.some((n) => /No registrations/.test(n.text)), 'U67');
});
test('U68 HUD SESSION row reflects the purge count', async () => {
  const s = loadUserScript({ registrations: [{ unregister() { return Promise.resolve(true); } }] });
  await s.clock.flush();
  menuByLabel(s.gm, 'Show status HUD').fn();
  const v = rowValue(hudShadow(s.doc), 'SESSION');
  ok(v && v.textContent.includes('PURGED 1'), 'U68 — ' + (v && v.textContent));
});

// =====================================================================
// U69–U73 — policy bridge (v7.3.0 split-brain fix)
// =====================================================================
test('U69 policyRequest message shape posted to the page', async () => {
  const s = loadUserScript({});
  s.win._4ndr0ghostV7 = true; // extension governs now
  menuByLabel(s.gm, 'Blacklist current domain').fn();
  eq(s.win._messages.length, 1, 'U69');
  const m = s.win._messages[0].msg;
  eq(m.__4ndr0guard, 'policyRequest', 'U69b');
  eq(m.kind, 'blacklist', 'U69c');
  eq(m.domain, 'stand.example', 'U69d');
});
test('U70 standalone page: local execution, no bridge post', async () => {
  const s = loadUserScript({});
  menuByLabel(s.gm, 'Blacklist current domain').fn();
  eq(s.win._messages.length, 0, 'U70 — nothing posted');
  eq(s.gm.store.get('4ndr0guard_blacklist_v7').join(), 'stand.example', 'U70b — local list written');
});
test('U71 governed page: bridge posted, local list NOT written', async () => {
  const s = loadUserScript({});
  s.win._4ndr0ghostV7 = true;
  menuByLabel(s.gm, 'Blacklist current domain').fn();
  eq(s.win._messages.length, 1, 'U71 — posted for confirmation');
  eq(s.gm.store.has('4ndr0guard_blacklist_v7'), false, 'U71b — no unconfirmed write');
});
test('U72 governed page: user notified about the pending confirmation', async () => {
  const s = loadUserScript({});
  s.win._4ndr0ghostV7 = true;
  menuByLabel(s.gm, 'Spoof current domain').fn();
  ok(s.gm.notifications.some((n) => /Requested spooflist/.test(n.text)), 'U72');
});
test('U73 postMessage failure is contained (no crash, no local write)', async () => {
  const s = loadUserScript({});
  s.win._postMessageThrows = true;
  s.win._4ndr0ghostV7 = true;
  let threw = false;
  try { menuByLabel(s.gm, 'Authorize current domain').fn(); } catch (e) { threw = true; }
  eq(threw, false, 'U73 — requestPolicyBridge caught the failure');
  eq(s.gm.store.has('4ndr0guard_whitelist_v6'), false, 'U73b — nothing written without confirmation');
});

// =====================================================================
// U74–U84 — status HUD (3lectric-Glass, manual-invocation doctrine)
// =====================================================================
test('U74 HUD creates a closed shadow-root host on invocation', async () => {
  const s = loadUserScript({});
  menuByLabel(s.gm, 'Show status HUD').fn();
  const host = hudHost(s.doc);
  ok(host, 'U74 — host element appended');
  ok(host._shadowRoot && host._shadowRoot.mode === 'closed', 'U74b — closed shadow root');
});
test('U75 HUD subtitle reads STANDALONE v7.4 when alone', async () => {
  const s = loadUserScript({});
  menuByLabel(s.gm, 'Show status HUD').fn();
  const sub = findByText(hudShadow(s.doc), 'STANDALONE v7.4');
  ok(sub, 'U75');
});
test('U76 HUD subtitle reads EXTENSION-LINKED v7.4 when governed', async () => {
  const s = loadUserScript({});
  s.win._4ndr0ghostV7 = true;
  menuByLabel(s.gm, 'Show status HUD').fn();
  const sub = findByText(hudShadow(s.doc), 'EXTENSION-LINKED v7.4');
  ok(sub, 'U76');
});
test('U77 HUD MASTER row flags disabled state destructively', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_enabled_v7', false]] });
  menuByLabel(s.gm, 'Show status HUD').fn();
  const v = rowValue(hudShadow(s.doc), 'MASTER');
  ok(v && v.textContent.includes('DISABLED'), 'U77');
  ok(v && String(v.className).includes('destructive'), 'U77b');
});
test('U78 HUD lists row counts reflect all three registries', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_whitelist_v6', ['a.com', 'b.com']], ['4ndr0guard_spooflist_v7', ['c.com']], ['4ndr0guard_blacklist_v7', ['d.com', 'e.com', 'f.com']]] });
  menuByLabel(s.gm, 'Show status HUD').fn();
  eq(rowValue(hudShadow(s.doc), 'WHITELIST').textContent, '2 domain(s)', 'U78');
  eq(rowValue(hudShadow(s.doc), 'SPOOFLIST').textContent, '1 domain(s)', 'U78b');
  eq(rowValue(hudShadow(s.doc), 'BLACKLIST').textContent, '3 domain(s)', 'U78c');
});
test('U79 ESC closes the HUD and aborts its listeners', async () => {
  const s = loadUserScript({});
  menuByLabel(s.gm, 'Show status HUD').fn();
  ok(hudHost(s.doc), 'U79 setup — open');
  const keyOpts = (s.doc.listeners.get('keydown') || []).map((l) => l.opts).filter(Boolean);
  ok(keyOpts.length === 1 && keyOpts[0].signal, 'U79b — listener bound to a signal');
  const signal = keyOpts[0].signal;
  (s.doc.listeners.get('keydown') || []).forEach((l) => l.fn({ key: 'Escape' }));
  ok(!hudHost(s.doc), 'U79c — closed');
  eq(signal.aborted, true, 'U79d — AbortController reclaimed the listener');
});
test('U80 outside click closes the HUD', async () => {
  const s = loadUserScript({});
  menuByLabel(s.gm, 'Show status HUD').fn();
  const outsider = new MiniElement('div');
  (s.doc.listeners.get('click') || []).forEach((l) => l.fn({ target: outsider }));
  ok(!hudHost(s.doc), 'U80 — closed by outside click');
});
test('U81 HUD AUTHORIZE SITE writes the local whitelist when standalone', async () => {
  const s = loadUserScript({});
  menuByLabel(s.gm, 'Show status HUD').fn();
  const btn = findByText(hudShadow(s.doc), 'AUTHORIZE SITE');
  ok(btn, 'U81 setup');
  btn.click();
  eq(s.gm.store.get('4ndr0guard_whitelist_v6').join(), 'stand.example', 'U81');
});
test('U82 HUD SPOOF SITE routes through the bridge when governed', async () => {
  const s = loadUserScript({});
  s.win._4ndr0ghostV7 = true;
  menuByLabel(s.gm, 'Show status HUD').fn();
  const btn = findByText(hudShadow(s.doc), 'SPOOF SITE');
  btn.click();
  eq(s.win._messages.length, 1, 'U82 — policy request posted');
  eq(s.win._messages[0].msg.kind, 'spooflist', 'U82b');
  eq(s.gm.store.has('4ndr0guard_spooflist_v7'), false, 'U82c — no unconfirmed local write');
});
test('U83 HUD RESET SITE removes the domain from every local list', async () => {
  const s = loadUserScript({ gm: [['4ndr0guard_whitelist_v6', ['stand.example']], ['4ndr0guard_blacklist_v7', ['stand.example']]] });
  menuByLabel(s.gm, 'Show status HUD').fn();
  const btn = findByText(hudShadow(s.doc), 'RESET SITE');
  btn.click();
  eq(String(s.gm.store.get('4ndr0guard_whitelist_v6')), '', 'U83');
  eq(String(s.gm.store.get('4ndr0guard_blacklist_v7')), '', 'U83b');
});
test('U84 HUD PURGE disabled under extension governance', async () => {
  const s = loadUserScript({ extensionPresent: true });
  menuByLabel(s.gm, 'Show status HUD').fn();
  const btn = findByText(hudShadow(s.doc), 'PURGE WORKERS');
  ok(btn, 'U84 setup');
  eq(btn.disabled, true, 'U84 — the extension owns purge timing');
});

main();
