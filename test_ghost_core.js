#!/usr/bin/env node
// test_ghost_core.js — 4ndr0SERVICEGUARD v7.4.0 behavioral harness (ghost_core_v7.js)
// GUP v5.3.1 evidence artifact. Executes the REAL MAIN-world Ghost Core in a
// fresh Node vm context per scenario, including the exact throwing-getter
// crash class from the v7.4.0 field report (sandboxed iframes). 30 cases,
// families G01–G10.
//
// Usage: node test_ghost_core.js   (sources resolved ../4ndr0serviceguard/)
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, 'ghost_core_v7.js');
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

// === Page-world classes (host shims) ===
class FakeEvent { constructor(type, init) { this.type = type; if (init) Object.assign(this, init); } }
class FakeCloseEvent extends FakeEvent {}
class FakeDOMException extends Error {
  constructor(message, name) { super(message); this.name = name || 'Error'; }
}

class FakeNativeWebSocket {
  constructor(url, protocols) {
    this.url = url; this.protocols = protocols;
    this.readyState = 0; this.sent = []; this.listeners = []; this.binaryType = 'blob';
    FakeNativeWebSocket.constructed.push(this);
  }
  addEventListener(type, listener, options) { this.listeners.push({ type, listener, options }); }
  removeEventListener() {}
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; }
}
FakeNativeWebSocket.constructed = [];
FakeNativeWebSocket.prototype[Symbol.toStringTag] = 'WebSocket';

class FakeNativeSharedWorker {
  constructor(scriptURL) { this.scriptURL = scriptURL; FakeNativeSharedWorker.constructed.push(this); }
}
FakeNativeSharedWorker.constructed = [];

// === Scenario loader ===
// opts.chromeResponder: (message) => response object | null (dead channel)
// opts.ghostStatus: response for ghostStatus IPC (default active)
// opts.sandboxed: simulate an opaque-origin sandboxed iframe
function loadCore(opts) {
  const o = opts || {};
  const clock = new ManualClock();
  const state = {
    ipc: [], consoleDebug: [], consoleErrors: [],
    ws: FakeNativeWebSocket.constructed.length,
    shared: FakeNativeSharedWorker.constructed.length,
  };

  const responder = o.chromeResponder || ((msg) => {
    if (msg && msg.action === 'ghostStatus') {
      return o.ghostStatus || { active: true, whitelisted: false, blacklisted: false, spooflisted: false };
    }
    if (msg && msg.action === 'requestPermission') return { allowed: o.gateAction === 'allow', action: o.gateAction || 'deny' };
    return { status: 'ok' };
  });

  const chromeStub = {
    runtime: {
      id: 'testextensionid0000000000000000000',
      lastError: undefined,
      getManifest: undefined,
      sendMessage(idOrMsg, maybeMsg, maybeCb) {
        const msg = (typeof maybeMsg === 'object' && maybeCb) ? maybeMsg : idOrMsg;
        const cb = (typeof maybeMsg === 'function') ? maybeMsg : maybeCb;
        state.ipc.push(msg);
        const resp = responder(msg);
        Promise.resolve().then(() => {
          if (resp === null) { chromeStub.runtime.lastError = { message: 'dead channel' }; }
          if (cb) cb(resp === null ? undefined : resp);
          chromeStub.runtime.lastError = undefined;
        });
      },
    },
  };

  const documentMock = {
    documentElement: { getAttribute: () => null, setAttribute() {} },
    addEventListener(type, fn) { (this.listeners = this.listeners || {})[type] = fn; },
  };
  if (o.sandboxed) {
    Object.defineProperty(documentMock, 'cookie', { get() { throw new FakeDOMException('Access to storage is not allowed from this document.', 'SecurityError'); } });
  } else {
    documentMock.cookie = 'session=1';
  }

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
      value: navigatorMock.serviceWorker.register,
      writable: true, configurable: true, enumerable: false,
    });
  }

  const sandbox = {
    console: { log() {}, error: (...a) => state.consoleErrors.push(a.join(' ')), debug: (...a) => state.consoleDebug.push(a.join(' ')) },
    URL, Event: FakeEvent, CloseEvent: FakeCloseEvent, DOMException: FakeDOMException,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    navigator: navigatorMock,
    document: documentMock,
    Math, Promise, Object, Array, String, Number, Map, Set, Symbol, JSON, Reflect, Proxy, TypeError, Error,
    location: { origin: o.opaqueOrigin ? 'null' : 'https://page.example', href: 'https://page.example/' },
    WebSocket: FakeNativeWebSocket,
    SharedWorker: FakeNativeSharedWorker,
    caches: undefined,
    chrome: o.noChrome ? undefined : chromeStub,
  };
  if (!o.cachesThrowing) {
    sandbox.caches = { keys: () => Promise.resolve(['c1']), delete() { return Promise.resolve(true); } };
  } else {
    Object.defineProperty(sandbox, 'caches', { get() { throw new FakeDOMException('Access to cache storage is denied.', 'SecurityError'); }, configurable: true });
  }
  sandbox.window = sandbox;
  sandbox.self = sandbox;

  // Direct reference to the real SW mock (navigator.serviceWorker is replaced
  // by the core's memoized getter after installation, so property access on
  // navigatorMock no longer reaches the real object — capture BEFORE install).
  const realSWRef = (o.sandboxed || o.noServiceWorker) ? null : navigatorMock.serviceWorker;
  let loadError = null;
  try { vm.runInNewContext(SOURCE, sandbox, { filename: 'ghost_core_v7.js' }); }
  catch (e) { loadError = e; }

  return { sandbox, clock, state, loadError, chromeStub, navigatorMock, documentMock, realSWRef };
}

// === Runner ===
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, e, msg) { if (a !== e) throw new Error((msg || 'eq') + ': expected ' + JSON.stringify(e) + ', got ' + JSON.stringify(a)); }
async function main() {
  let pass = 0; let fail = 0;
  for (const t of tests) {
    try { await t.fn(); pass++; }
    catch (e) { fail++; console.log('  [FAIL] ' + t.name + ' :: ' + (e && e.message)); }
  }
  console.log('\n[test_ghost_core] ' + pass + '/' + tests.length + ' cases passed' + (fail ? (' — ' + fail + ' FAILED') : ''));
  process.exitCode = (fail || tests.length !== 32) ? 1 : 0;
}

// =====================================================================
// G01 — safeGet defensive capture layer (the v7.4.0 fix itself), exercised
//        through the real capture block: the exact throwing-getter classes
//        from the field report (navigator.serviceWorker, window.caches).
// =====================================================================
test('G01a throwing serviceWorker getter yields null — WS gate still arms', async () => {
  const core = loadCore({ sandboxed: true });
  eq(core.loadError, null, 'G01a — core survived the throwing capture');
  ok(core.sandbox.WebSocket !== FakeNativeWebSocket, 'G01a2 — WS gate installed');
  const ws = new core.sandbox.WebSocket('wss://sandboxed.example/ws');
  eq(ws.readyState, 0, 'G01a3 — phantom CONNECTING');
});
test('G01b throwing window.caches getter (second crash class) yields null', async () => {
  const core = loadCore({ cachesThrowing: true });
  eq(core.loadError, null, 'G01b — core survived caches read refusal');
  ok(core.navigatorMock.serviceWorker, 'G01b2 — SW surface still captured');
  const reg = await core.sandbox.navigator.serviceWorker.register('sw.js');
  ok(reg, 'G01b3 — SW gate functional with null caches (purge skips cache clear)');
});
test('G01c undefined serviceWorker normalized to null — gate skipped, WS armed', async () => {
  const core = loadCore({ noServiceWorker: true });
  eq(core.loadError, null, 'G01c — load ok');
  eq(core.navigatorMock.serviceWorker, undefined, 'G01c2 — no fake container installed (insecure-origin doctrine)');
  ok(core.sandbox.WebSocket !== FakeNativeWebSocket, 'G01c3 — WS gate installed');
});

// =====================================================================
// G02 — sandboxed-frame detection & survival
// =====================================================================
test('G02a core survives in a sandboxed frame (document.cookie throws)', async () => {
  const core = loadCore({ sandboxed: true });
  eq(core.loadError, null, 'G02a — no load exception');
  eq(core.sandbox.window._4ndr0ghostV7, true, 'G02a2 — guard flag set in sandboxed frame');
});
test('G02b sandboxed frame emits the condensed debug notice, no error noise', async () => {
  const core = loadCore({ sandboxed: true });
  ok(core.state.consoleDebug.some((l) => l.includes('sandboxed frame')), 'G02b — debug notice present');
  ok(!core.state.consoleDebug.some((l) => l.includes('core initialization failed')), 'G02b2 — core did NOT die');
});
test('G02c ordinary document: no sandbox notice, core arms fully', async () => {
  const core = loadCore({});
  ok(!core.state.consoleDebug.some((l) => l.includes('sandboxed frame')), 'G02c');
  ok(core.navigatorMock.serviceWorker, 'G02c2 — real SW surface captured');
});

// =====================================================================
// G03 — load guard & dead-channel fail-safe
// =====================================================================
test('G03a double load: guard flag prevents re-installation', async () => {
  const core = loadCore({});
  vm.runInNewContext(SOURCE, core.sandbox, { filename: 'ghost_core_v7.js(2)' });
  ok(core.state.ipc.filter((m) => m.action === 'ghostStatus').length <= 12, 'G03a — no second init storm');
});
test('G03b dead extension channel: WebSocket gate still denies by default', async () => {
  const core = loadCore({ noChrome: true });
  eq(core.loadError, null, 'G03b load ok');
  const ws = new core.sandbox.WebSocket('wss://dead.example/ws');
  eq(ws.readyState, 0, 'G03b2 — CONNECTING phantom');
  await core.clock.advance(60);
  eq(ws.readyState, 3, 'G03b3 — CLOSED via native-faithful failure');
});

// =====================================================================
// G04 — WebSocket gate installation
// =====================================================================
test('G04a window.WebSocket is replaced by a Proxy (construct trap)', async () => {
  const core = loadCore({});
  ok(core.sandbox.WebSocket !== FakeNativeWebSocket, 'G04a');
  eq(typeof core.sandbox.WebSocket, 'function', 'G04a2');
});
test('G04b denied construction returns a phantom WebSocket, not a rejection', async () => {
  const core = loadCore({ gateAction: 'deny' });
  const ws = new core.sandbox.WebSocket('wss://phantom.example/ws');
  eq(FakeNativeWebSocket.constructed.length, core.state.ws, 'G04b — zero native constructions for denied url');
  ok(!FakeNativeWebSocket.constructed.some((c) => c === ws), 'G04b2 — phantom is not a native instance');
  eq(ws.url, 'wss://phantom.example/ws', 'G04b3');
  eq(ws.readyState, 0, 'G04b4 — phantom starts CONNECTING');
});

// =====================================================================
// G05 — gatedRegister & the fake registration surface
// =====================================================================
async function registerOnce(core, scriptURL, options) {
  return core.sandbox.navigator.serviceWorker.register(scriptURL, options);
}
test('G05a fake registration: resolved scope + scriptURL', async () => {
  const core = loadCore({ gateAction: 'deny' });
  const reg = await registerOnce(core, 'sw.js', { scope: '/app/' });
  eq(reg.scope, 'https://page.example/app/', 'G05a');
  eq(reg.scriptURL, 'https://page.example/sw.js', 'G05a2');
});
test('G05b fake registration: active worker activated + identity tags', async () => {
  const core = loadCore({ gateAction: 'deny' });
  const reg = await registerOnce(core, 'sw.js');
  eq(reg.active.state, 'activated', 'G05b');
  eq(reg.active.scriptURL, 'https://page.example/sw.js', 'G05b2');
  eq(reg[Symbol.toStringTag], 'ServiceWorkerRegistration', 'G05b3');
  eq(reg.active[Symbol.toStringTag], 'ServiceWorker', 'G05b4');
});
test('G05c fake registration memoized: same script+scope → identical object', async () => {
  const core = loadCore({ gateAction: 'deny' });
  const r1 = await registerOnce(core, 'sw.js', { scope: '/x/' });
  const r2 = await registerOnce(core, 'sw.js', { scope: '/x/' });
  ok(r1 === r2, 'G05c — identity-stable');
  const r3 = await registerOnce(core, 'sw.js', { scope: '/y/' });
  ok(r1 !== r3, 'G05c2 — different scope, distinct registration');
});
test('G05d update() is identity-stable; unregister resolves true', async () => {
  const core = loadCore({ gateAction: 'deny' });
  const reg = await registerOnce(core, 'sw.js');
  const updated = await reg.update();
  ok(updated === reg, 'G05d');
  eq(await reg.unregister(), true, 'G05d2');
});
test('G05e blocked register dispatches controllerchange at 25ms', async () => {
  const core = loadCore({ gateAction: 'deny' });
  let fired = 0;
  core.sandbox.navigator.serviceWorker.addEventListener('controllerchange', () => { fired++; });
  await registerOnce(core, 'sw.js');
  await core.clock.advance(10);
  eq(fired, 0, 'G05e — not yet');
  await core.clock.advance(20);
  eq(fired, 1, 'G05e2 — fired at the 25ms lifecycle point');
});
test('G05f gatedRegister allow path calls the real register', async () => {
  const core = loadCore({ gateAction: 'allow' });
  const reg = await registerOnce(core, 'real.js');
  ok(core.realSWRef.registerCalls, 'G05f — real register invoked');
  eq(core.realSWRef.registerCalls.length, 1, 'G05f2');
  eq(core.realSWRef.registerCalls[0].url, 'real.js', 'G05f3');
  ok(reg !== undefined, 'G05f4');
});
test('G05j TWO blocked registers fire TWO controllerchange events (per-attempt lifecycle)', async () => {
  const core = loadCore({ gateAction: 'deny' });
  let fired = 0;
  core.sandbox.navigator.serviceWorker.addEventListener('controllerchange', () => { fired++; });
  await registerOnce(core, 'one.js');
  await registerOnce(core, 'two.js');
  await core.clock.advance(30);
  eq(fired, 2, 'G05j — one event per blocked registration');
});

// =====================================================================
// G06 — spoof pacifier (the v7.3.0 action model)
// =====================================================================
test('G06a spoofed socket "opens" at the 40ms cadence', async () => {
  const core = loadCore({ gateAction: 'spoof' });
  const ws = new core.sandbox.WebSocket('wss://spoof.example/ws');
  let opened = 0;
  ws.onopen = () => { opened++; };
  await core.clock.advance(10);
  eq(ws.readyState, 0, 'G06a — still CONNECTING');
  await core.clock.advance(35);
  eq(ws.readyState, 1, 'G06a2 — OPEN');
  eq(opened, 1, 'G06a3 — synthetic open fired once');
});
test('G06b spoofed socket swallows sends silently, bufferedAmount 0', async () => {
  const core = loadCore({ gateAction: 'spoof' });
  const ws = new core.sandbox.WebSocket('wss://spoof.example/ws');
  await core.clock.advance(50);
  ws.send('page data');
  ws.send('more data');
  eq(ws.bufferedAmount, 0, 'G06b — healthy socket, no backpressure');
  eq(FakeNativeWebSocket.constructed.length, core.state.ws, 'G06b2 — nothing was ever really sent');
});
test('G06c spoofed socket negotiates the first requested subprotocol', async () => {
  const core = loadCore({ gateAction: 'spoof' });
  const ws = new core.sandbox.WebSocket('wss://spoof.example/ws', 'chat, superchat');
  await core.clock.advance(50);
  eq(ws.protocol, 'chat', 'G06c');
});
test('G06d page-initiated close of a spoofed socket settles clean 1000', async () => {
  const core = loadCore({ gateAction: 'spoof' });
  const ws = new core.sandbox.WebSocket('wss://spoof.example/ws');
  await core.clock.advance(50);
  let closeEv = null;
  ws.onclose = (ev) => { closeEv = ev; };
  ws.close();
  eq(ws.readyState, 3, 'G06d — CLOSED');
  await core.clock.advance(5);
  ok(closeEv, 'G06d2 — clean close fired');
  eq(closeEv.code, 1000, 'G06d3'); eq(closeEv.wasClean, true, 'G06d4');
});
test('G06e spoofed send-then-close mid-handshake never opens', async () => {
  const core = loadCore({ gateAction: 'spoof' });
  const ws = new core.sandbox.WebSocket('wss://spoof.example/ws');
  ws.send('early');
  ws.close(); // page closed during CONNECTING
  await core.clock.advance(60);
  eq(ws.readyState, 2, 'G06e — settled CLOSING (page-owned close)');
  let opened = 0; let errored = 0;
  ws.onopen = () => { opened++; };
  ws.onerror = () => { errored++; };
  await core.clock.advance(10);
  eq(opened, 0, 'G06e2 — no late open');
  eq(errored, 0, 'G06e3 — no error surfaced');
});

// =====================================================================
// G07 — deny path (v7.2 behavior, preserved verbatim)
// =====================================================================
test('G07a denied socket: error then close at the 40ms cadence', async () => {
  const core = loadCore({ gateAction: 'deny' });
  const ws = new core.sandbox.WebSocket('wss://deny.example/ws');
  const events = [];
  ws.onerror = () => { events.push('error'); };
  ws.onclose = () => { events.push('close'); };
  await core.clock.advance(10);
  eq(events.length, 0, 'G07a — not yet');
  await core.clock.advance(35);
  eq(events.join(','), 'error,close', 'G07a2 — error precedes close');
  eq(ws.readyState, 3, 'G07a3');
});
test('G07b send after CLOSED is a non-throwing no-op (WHATWG §3.1)', async () => {
  const core = loadCore({ gateAction: 'deny' });
  const ws = new core.sandbox.WebSocket('wss://deny2.example/ws');
  await core.clock.advance(60);
  let thrown = null;
  try { ws.send('late'); } catch (e) { thrown = e; }
  eq(thrown, null, 'G07b — must not throw InvalidStateError on CLOSED');
  eq(ws.readyState, 3, 'G07b2 — remains CLOSED');
});

// =====================================================================
// G08 — allow path (live forwarding)
// =====================================================================
test('G08a allowed socket constructs the real WebSocket', async () => {
  const core = loadCore({ gateAction: 'allow' });
  const ws = new core.sandbox.WebSocket('wss://real.example/ws');
  await core.clock.advance(10);
  eq(FakeNativeWebSocket.constructed.length, core.state.ws + 1, 'G08a — one native construction');
  ok(ws.readyState === 0 || ws.readyState === undefined, 'G08a2');
});
test('G08b buffered sends and listeners forward to the real socket', async () => {
  const core = loadCore({ gateAction: 'allow' });
  const ws = new core.sandbox.WebSocket('wss://real2.example/ws');
  const heard = [];
  ws.addEventListener('open', () => { heard.push('open'); });
  ws.send('during-handshake');
  await core.clock.advance(10);
  const real = FakeNativeWebSocket.constructed[FakeNativeWebSocket.constructed.length - 1];
  ok(real && real.url === 'wss://real2.example/ws', 'G08b — real created');
  ok(real.sent.includes('during-handshake'), 'G08b2 — buffered send forwarded');
  ok(real.listeners.some((l) => l.type === 'open'), 'G08b3 — listener forwarded');
});
test('G08c allowed realWs in CLOSING or CLOSED does not throw InvalidStateError on send()', async () => {
  const core = loadCore({ gateAction: 'allow' });
  const ws = new core.sandbox.WebSocket('wss://chatgpt.com/ws');
  await core.clock.advance(10);
  const real = FakeNativeWebSocket.constructed[FakeNativeWebSocket.constructed.length - 1];
  ok(real, 'G08c — realWs constructed');
  real.readyState = 2; // CLOSING
  let errClosing = null;
  try { ws.send('during-closing'); } catch (e) { errClosing = e; }
  eq(errClosing, null, 'G08c2 — CLOSING send must not throw');
  real.readyState = 3; // CLOSED
  let errClosed = null;
  try { ws.send('after-closed'); } catch (e) { errClosed = e; }
  eq(errClosed, null, 'G08c3 — CLOSED send must not throw');
  eq(real.sent.length, 0, 'G08c4 — nothing transmitted while CLOSING/CLOSED');
});
test('G08d realWs rejecting CONNECTING send re-queues and flushes on open', async () => {
  const core = loadCore({ gateAction: 'allow' });
  const origSend = FakeNativeWebSocket.prototype.send;
  FakeNativeWebSocket.prototype.send = function (data) {
    if (this.readyState === 0) throw new FakeDOMException('Still in CONNECTING state.', 'InvalidStateError');
    this.sent.push(data);
  };
  try {
    const ws = new core.sandbox.WebSocket('wss://strict-browser.example/ws');
    ws.send('frame-1');
    await core.clock.advance(10);
    const real = FakeNativeWebSocket.constructed[FakeNativeWebSocket.constructed.length - 1];
    eq(real.sent.length, 0, 'G08d — held while CONNECTING');
    ws.send('frame-2');
    real.readyState = 1;
    real.listeners.filter((l) => l.type === 'open').forEach((l) => l.listener(new FakeEvent('open')));
    eq(real.sent.join(','), 'frame-1,frame-2', 'G08d2 — both pre-allow and mid-connecting frames flushed on open');
  } finally {
    FakeNativeWebSocket.prototype.send = origSend;
  }
});

// =====================================================================
// G09 — SharedWorker gatekeeper
// =====================================================================
test('G09a SharedWorker construction throws the baseline SecurityError', async () => {
  const core = loadCore({ gateAction: 'deny' });
  let thrown = null;
  try { new core.sandbox.SharedWorker('shared.js'); } catch (e) { thrown = e; }
  ok(thrown, 'G09a — threw');
  eq(thrown.name, 'SecurityError', 'G09a2');
});
test('G09b allow latch: after an allow decision, later constructions pass', async () => {
  const core = loadCore({ gateAction: 'allow' });
  let first = null;
  try { new core.sandbox.SharedWorker('shared.js'); } catch (e) { first = e; }
  ok(first instanceof FakeDOMException || first === null, 'G09b — first may throw (decision pending)');
  await core.clock.advance(10); // interrogateGatekeeper resolves allow → sharedAllowed latch
  const sw = new core.sandbox.SharedWorker('shared2.js');
  ok(sw instanceof FakeNativeSharedWorker, 'G09b2 — real construction after allow');
});

// =====================================================================
// G10 — DDoS-Guard fast path
// =====================================================================
test('G10a DDoS-Guard challenge constructs the real WebSocket directly', async () => {
  const core = loadCore({ gateAction: 'deny' });
  const ws = new core.sandbox.WebSocket('https://check.ddos-guard.net/pacifier_v5.js');
  eq(FakeNativeWebSocket.constructed.length, core.state.ws + 1, 'G10a — real, not phantom');
  ok(ws instanceof FakeNativeWebSocket, 'G10a2');
});
test('G10b fast path bypasses the gatekeeper entirely (no requestPermission)', async () => {
  const core = loadCore({ gateAction: 'deny' });
  new core.sandbox.WebSocket('https://check.ddos-guard.net/pacifier_v5.js');
  await core.clock.advance(10);
  eq(core.state.ipc.filter((m) => m && m.action === 'requestPermission').length, 0, 'G10b');
});

main();
