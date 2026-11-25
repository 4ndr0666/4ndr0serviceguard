#!/usr/bin/env node
// test_background.js — 4ndr0SERVICEGUARD v7.4.0 behavioral harness (background.js)
// GUP v5.3.1 evidence artifact. Executes the REAL background.js in a fresh
// Node vm context per scenario, with a deterministic manual clock and a
// faithful MV3 chrome.* mock. 112 cases, case families B01–B112.
//
// Usage: node test_background.js   (from gup-evidence/; sources resolved ../4ndr0serviceguard/)
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, 'background.js');
const SOURCE = fs.readFileSync(SRC, 'utf8');

// === Manual deterministic clock ===
class ManualClock {
  constructor(start) { this.now = start || 1755000000000; this.seq = 0; this.timers = new Map(); this.intervals = new Map(); this.errors = []; }
  setTimeout(fn, ms) { const id = ++this.seq; this.timers.set(id, { at: this.now + Math.max(0, Number(ms) || 0), fn }); return id; }
  clearTimeout(id) { this.timers.delete(id); }
  setInterval(fn, ms) { const id = ++this.seq; const every = Math.max(1, Number(ms) || 1); this.intervals.set(id, { next: this.now + every, every, fn }); return id; }
  clearInterval(id) { this.intervals.delete(id); }
  async flush() { for (let i = 0; i < 24; i++) await new Promise((r) => setImmediate(r)); }
  async advance(ms) {
    const target = this.now + ms;
    await this.flush(); // let pending promise chains schedule their timers first
    for (;;) {
      let best = null;
      for (const [id, t] of this.timers) if (!best || t.at < best.at) best = { kind: 'timer', id, at: t.at, fn: t.fn };
      for (const [id, iv] of this.intervals) if (!best || iv.next < best.at) best = { kind: 'interval', id, at: iv.next, fn: iv.fn };
      if (!best || best.at > target) break;
      this.now = best.at;
      if (best.kind === 'timer') this.timers.delete(best.id);
      else { const iv = this.intervals.get(best.id); iv.next += iv.every; }
      try { best.fn(); } catch (e) { this.errors.push(e); }
      await this.flush();
    }
    this.now = Math.max(this.now, target);
    await this.flush();
  }
}

// === MV3 chrome mock ===
function makeEnv(opts) {
  const o = opts || {};
  const clock = new ManualClock();
  const store = { sync: new Map(o.sync || []), local: new Map(o.local || []) };
  const listeners = { onMessage: [], onMessageExternal: [], onInstalled: [], tabsUpdated: [], tabsRemoved: [], windowsRemoved: [], storageChanged: [] };
  const state = {
    icons: [], windowsCreated: [], windowsRemoved: [], tabsMessages: [],
    consoleDebug: [], consoleErrors: [], consoleLogs: [],
  };
  let windowSeq = 100;
  state.tabsResponder = o.tabsResponder || null;   // (message) => response | 'NO_ACK' | 'THROW'
  state.windowCreator = o.windowCreator || null;   // (opts) => {id} | 'FAIL'

  function fireChanged(area, obj, old) {
    const changes = {};
    for (const k of Object.keys(obj)) {
      changes[k] = { oldValue: old && k in old ? old[k] : undefined, newValue: obj[k] };
    }
    listeners.storageChanged.forEach((fn) => fn(changes, area));
  }

  const chromeApi = {
    runtime: {
      id: 'testextensionid0000000000000000000',
      lastError: null,
      onMessage: { addListener: (fn) => listeners.onMessage.push(fn) },
      onMessageExternal: { addListener: (fn) => listeners.onMessageExternal.push(fn) },
      onInstalled: { addListener: (fn) => listeners.onInstalled.push(fn) },
    },
    storage: {
      sync: {
        async get(keys) {
          if (state.failNextGet) { state.failNextGet = false; throw new Error('storage get failed (injected)'); }
          const ks = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys || {}));
          const out = {};
          ks.forEach((k) => { if (store.sync.has(k)) out[k] = store.sync.get(k); });
          return out;
        },
        async set(obj) {
          const old = {};
          for (const k of Object.keys(obj)) { old[k] = store.sync.has(k) ? store.sync.get(k) : undefined; store.sync.set(k, obj[k]); }
          fireChanged('sync', obj, old);
        },
      },
      local: {
        async get(keys) {
          const ks = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys || {}));
          const out = {};
          ks.forEach((k) => { if (store.local.has(k)) out[k] = store.local.get(k); });
          return out;
        },
        async set(obj) {
          const old = {};
          for (const k of Object.keys(obj)) { old[k] = store.local.has(k) ? store.local.get(k) : undefined; store.local.set(k, obj[k]); }
          fireChanged('local', obj, old);
        },
        async remove(keys) {
          const ks = Array.isArray(keys) ? keys : [keys];
          const old = {};
          ks.forEach((k) => { old[k] = store.local.has(k) ? store.local.get(k) : undefined; store.local.delete(k); });
          const gone = {}; ks.forEach((k) => { gone[k] = undefined; });
          listeners.storageChanged.forEach((fn) => {
            const changes = {}; ks.forEach((k) => { changes[k] = { oldValue: old[k], newValue: undefined }; });
            fn(changes, 'local');
          });
        },
      },
      onChanged: { addListener: (fn) => listeners.storageChanged.push(fn) },
    },
    tabs: {
      sendMessage(tabId, message, options, cb) {
        state.tabsMessages.push({ tabId, message, options: options || {} });
        const callback = (typeof options === 'function' && !cb) ? options : cb;
        const r = state.tabsResponder ? state.tabsResponder(message) : { status: 'shown' };
        if (r === 'THROW') { throw new Error('tabs.sendMessage failed (injected)'); }
        if (r === 'NO_ACK') return; // frame gone: no callback, no response
        Promise.resolve().then(() => { chromeApi.runtime.lastError = undefined; if (callback) callback(r); });
      },
      onUpdated: { addListener: (fn) => listeners.tabsUpdated.push(fn) },
      onRemoved: { addListener: (fn) => listeners.tabsRemoved.push(fn) },
    },
    windows: {
      create(createOpts, cb) {
        const result = state.windowCreator ? state.windowCreator(createOpts) : { id: ++windowSeq };
        Promise.resolve().then(() => {
          if (result === 'FAIL') { chromeApi.runtime.lastError = { message: 'window create failed' }; if (cb) cb(undefined); chromeApi.runtime.lastError = null; }
          else { state.windowsCreated.push(Object.assign({ createOpts }, result)); if (cb) cb(result); }
        });
      },
      remove(id, cb) {
        state.windowsRemoved.push(id);
        Promise.resolve().then(() => { if (cb) cb(); });
      },
      onRemoved: { addListener: (fn) => listeners.windowsRemoved.push(fn) },
    },
    action: { async setIcon(d) { state.icons.push(d); } },
  };

  const consoleMock = {
    log: (...a) => state.consoleLogs.push(a.join(' ')),
    error: (...a) => state.consoleErrors.push(a.join(' ')),
    debug: (...a) => state.consoleDebug.push(a.join(' ')),
  };

  function load() {
    const sandbox = {
      chrome: chromeApi, console: consoleMock, URL: URL,
      setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
      clearTimeout: (id) => clock.clearTimeout(id),
      setInterval: (fn, ms) => clock.setInterval(fn, ms),
      clearInterval: (id) => clock.clearInterval(id),
      Date: { now: () => clock.now },
      self: null,
    };
    sandbox.self = { addEventListener: () => {} };
    vm.runInNewContext(SOURCE, sandbox, { filename: 'background.js' });
    return sandbox;
  }

  function call(request, sender, channel, overrideSendResponse) {
    const list = channel === 'external' ? listeners.onMessageExternal : listeners.onMessage;
    return new Promise((resolve) => {
      const sendResponse = (resp) => { resolve(resp); if (overrideSendResponse) overrideSendResponse(resp); };
      list.forEach((fn) => fn(request, sender || {}, sendResponse));
    });
  }

  return { clock, store, listeners, state, chromeApi, call, load, fireChanged };
}

// === Runner ===
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error((msg || 'eq') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}
async function main() {
  let pass = 0; let fail = 0;
  for (const t of tests) {
    try { await t.fn(); pass++; }
    catch (e) { fail++; console.log('  [FAIL] ' + t.name + ' :: ' + (e && e.message)); }
  }
  console.log('\n[test_background] ' + pass + '/' + tests.length + ' cases passed' + (fail ? (' — ' + fail + ' FAILED') : ''));
  process.exitCode = (fail || tests.length !== 112) ? 1 : 0;
}

const senderPage = { url: 'https://page.example/start', tab: { id: 1 }, frameId: 0 };
const senderPage2 = { url: 'https://other.example/x', tab: { id: 2 }, frameId: 0 };

// =====================================================================
// FAMILY A — normalizeDomain (B01–B09)
// =====================================================================
let envA;
test('B01 normalizeDomain: bare domain unchanged', async () => {
  envA = makeEnv(); const s = envA.load();
  const r = await vm.runInNewContext('normalizeDomain("example.com")', s);
  eq(r, 'example.com', 'B01');
});
test('B02 normalizeDomain: uppercase lowered + trimmed', async () => {
  const s = makeEnv().load();
  const r = await vm.runInNewContext('normalizeDomain("  ExAmple.COM ")', s);
  eq(r, 'example.com', 'B02');
});
test('B03 normalizeDomain: https scheme stripped', async () => {
  const s = makeEnv().load();
  const r = await vm.runInNewContext('normalizeDomain("https://example.com/")', s);
  eq(r, 'example.com', 'B03');
});
test('B04 normalizeDomain: wss scheme + path stripped', async () => {
  const s = makeEnv().load();
  const r = await vm.runInNewContext('normalizeDomain("wss://sock.example.com/live/socket")', s);
  eq(r, 'sock.example.com', 'B04');
});
test('B05 normalizeDomain: query + fragment stripped', async () => {
  const s = makeEnv().load();
  const r = await vm.runInNewContext('normalizeDomain("example.com/a/b?token=1#frag")', s);
  eq(r, 'example.com', 'B05');
});
test('B06 normalizeDomain: port stripped', async () => {
  const s = makeEnv().load();
  const r = await vm.runInNewContext('normalizeDomain("example.com:8443")', s);
  eq(r, 'example.com', 'B06');
});
test('B07 normalizeDomain: boundary dots stripped', async () => {
  const s = makeEnv().load();
  const r = await vm.runInNewContext('normalizeDomain(".example.com.")', s);
  eq(r, 'example.com', 'B07');
});
test('B08 normalizeDomain: punycode marker removed (v7.2 behavior)', async () => {
  const s = makeEnv().load();
  const r = await vm.runInNewContext('normalizeDomain("xn--example.com")', s);
  eq(r, 'example.com', 'B08');
});
test('B09 normalizeDomain: null/undefined → empty string', async () => {
  const s = makeEnv().load();
  const r = await vm.runInNewContext('normalizeDomain(null) + "|" + normalizeDomain(undefined)', s);
  eq(r, '|', 'B09');
});

// =====================================================================
// FAMILY B — DDoS-Guard heuristic (B10–B13)
// =====================================================================
test('B10 isDDoSGuardChallenge: ddos-guard.net host', async () => {
  const s = makeEnv().load();
  eq(await vm.runInNewContext('isDDoSGuardChallenge("https://ddos-guard.net/x")', s), true, 'B10');
});
test('B11 isDDoSGuardChallenge: pacifier_v5 script path', async () => {
  const s = makeEnv().load();
  eq(await vm.runInNewContext('isDDoSGuardChallenge("https://site.example/pacifier_v5.js")', s), true, 'B11');
});
test('B12 isDDoSGuardChallenge: .well-known path', async () => {
  const s = makeEnv().load();
  eq(await vm.runInNewContext('isDDoSGuardChallenge("https://site.example/.well-known/ddos-guard/c")', s), true, 'B12');
});
test('B13 isDDoSGuardChallenge: ordinary URL negative', async () => {
  const s = makeEnv().load();
  eq(await vm.runInNewContext('isDDoSGuardChallenge("wss://ordinary.example/ws")', s), false, 'B13');
});

// =====================================================================
// FAMILY C — coerceVerdict (B14–B16)
// =====================================================================
test('B14 coerceVerdict: {allowed:true} → allow', async () => {
  const s = makeEnv().load();
  const r = await vm.runInNewContext('coerceVerdict({allowed:true})', s);
  eq(r.allowed, true); eq(r.action, 'allow', 'B14');
});
test('B15 coerceVerdict: {allowed:false} → deny', async () => {
  const s = makeEnv().load();
  const r = await vm.runInNewContext('coerceVerdict({allowed:false})', s);
  eq(r.allowed, false); eq(r.action, 'deny', 'B15');
});
test('B16 coerceVerdict: spoof preserved over boolean', async () => {
  const s = makeEnv().load();
  const r = await vm.runInNewContext('coerceVerdict({allowed:false, action:"spoof"})', s);
  eq(r.action, 'spoof', 'B16'); eq(r.allowed, false, 'B16b');
});

// =====================================================================
// FAMILY D — toggle / isEnabled (B17–B19)
// =====================================================================
test('B17 isEnabled: default enabled when unset (default-deny)', async () => {
  const s = makeEnv().load();
  eq(await vm.runInNewContext('isEnabled()', s), true, 'B17');
});
test('B18 isEnabled: false when stored false → gate pass-through', async () => {
  const env = makeEnv({ sync: [['enabled', false]] });
  env.load();
  const r = await env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://fresh.example/ws' }, senderPage);
  eq(r.allowed, true, 'B18'); eq(r.action, 'allow', 'B18b'); eq(r.reason, 'disabled', 'B18c');
});
test('B19 handleToggle writes enabled=false + icon debounce', async () => {
  const env = makeEnv(); env.load();
  const r = await env.call({ action: 'toggle', enabled: false });
  eq(r.status, 'toggled', 'B19'); eq(r.state, false, 'B19b');
  eq(env.store.sync.get('enabled'), false, 'B19c');
  await env.clock.advance(400);
  const last = env.state.icons[env.state.icons.length - 1];
  eq(last.path['16'], 'icons/disabled16.png', 'B19d');
});

// =====================================================================
// FAMILY E — registries & caches (B20–B23)
// =====================================================================
test('B20 getWhitelist normalizes stored lines', async () => {
  const env = makeEnv({ sync: [['whitelist', 'A.com\n\n wss://B.com/x \n.C.com.']] });
  const s = env.load();
  const r = await vm.runInNewContext('getWhitelist()', s);
  eq(r.join(','), 'a.com,b.com,c.com', 'B20');
});
test('B21 whitelist TTL: no re-read within window', async () => {
  const env = makeEnv({ sync: [['whitelist', 'a.com']] });
  const sandbox = env.load();
  await vm.runInNewContext('getWhitelist()', sandbox); // populate cache
  let reads = 0;
  const orig = env.chromeApi.storage.sync.get.bind(env.chromeApi.storage.sync);
  env.chromeApi.storage.sync.get = async (k) => { reads++; return orig(k); };
  env.clock.advance(1000); // inside the 30s TTL window
  const r = await vm.runInNewContext('getWhitelist()', sandbox);
  eq(reads, 0, 'B21 — cached read performs no storage get');
  eq(r.join(','), 'a.com', 'B21b — cached value served');
});
test('B22 whitelist TTL: expiry re-reads storage', async () => {
  const env = makeEnv({ sync: [['whitelist', 'a.com']] });
  const sandbox = env.load();
  await vm.runInNewContext('getWhitelist()', sandbox); // populate cache
  env.store.sync.set('whitelist', 'b.com'); // raw map write — bypasses onChanged
  await env.clock.advance(31000);
  const r = await vm.runInNewContext('getWhitelist()', sandbox);
  eq(r.join(','), 'b.com', 'B22 — TTL expiry serves fresh data');
});
test('B23 storage.onChanged invalidates blacklist cache immediately', async () => {
  const env = makeEnv(); env.load();
  const p = env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://neutral.example/x' }, senderPage);
  await env.clock.advance(50);
  await env.chromeApi.storage.sync.set({ blacklist: 'neutral.example' });
  eq(env.store.sync.get('blacklist'), 'neutral.example', 'B23 write');
  const reqId = env.state.tabsMessages[env.state.tabsMessages.length - 1].message.reqId;
  await env.call({ action: 'resolvePermission', id: reqId, decision: 'deny' });
  eq((await p).action, 'deny', 'B23 first settle');
  const p2 = env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://neutral.example/x' }, senderPage);
  await env.clock.flush();
  const r2 = await Promise.race([p2, env.clock.flush().then(() => null)]);
  ok(r2 && r2.reason === 'blacklisted', 'B23 — invalidated cache re-reads and hard-denies without clock advance');
});

// =====================================================================
// FAMILY F — bulk saves (B24–B30)
// =====================================================================
test('B24 setWhitelist normalizes + dedups, returns count', async () => {
  const env = makeEnv(); env.load();
  const r = await env.call({ action: 'setWhitelist', whitelist: ['A.com', 'a.com', 'https://B.com/x', ''] });
  eq(r.status, 'saved', 'B24'); eq(r.count, 2, 'B24b');
  eq(env.store.sync.get('whitelist'), 'a.com\nb.com', 'B24c');
});
test('B25 setBlacklist normalizes entries', async () => {
  const env = makeEnv(); env.load();
  const r = await env.call({ action: 'setBlacklist', blacklist: ['X.COM:99', 'y.com'] });
  eq(r.count, 2, 'B25');
  eq(env.store.sync.get('blacklist'), 'x.com\ny.com', 'B25b');
});
test('B26 setSpooflist normalizes entries', async () => {
  const env = makeEnv(); env.load();
  const r = await env.call({ action: 'setSpooflist', spooflist: ['spoof.example'] });
  eq(r.count, 1, 'B26');
  eq(env.store.sync.get('spooflist'), 'spoof.example', 'B26b');
});
test('B27 bulk whitelist save never destroys blacklist+spooflist', async () => {
  const env = makeEnv({ sync: [['blacklist', 'b1.com'], ['spooflist', 's1.com']] }); env.load();
  await env.call({ action: 'setWhitelist', whitelist: ['w1.com'] });
  eq(env.store.sync.get('blacklist'), 'b1.com', 'B27');
  eq(env.store.sync.get('spooflist'), 's1.com', 'B27b');
});
test('B28 bulk blacklist save never destroys whitelist+spooflist', async () => {
  const env = makeEnv({ sync: [['whitelist', 'w1.com'], ['spooflist', 's1.com']] }); env.load();
  await env.call({ action: 'setBlacklist', blacklist: ['b1.com'] });
  eq(env.store.sync.get('whitelist'), 'w1.com', 'B28');
  eq(env.store.sync.get('spooflist'), 's1.com', 'B28b');
});
test('B29 bulk spooflist save never destroys whitelist+blacklist', async () => {
  const env = makeEnv({ sync: [['whitelist', 'w1.com'], ['blacklist', 'b1.com']] }); env.load();
  await env.call({ action: 'setSpooflist', spooflist: ['s1.com'] });
  eq(env.store.sync.get('whitelist'), 'w1.com', 'B29');
  eq(env.store.sync.get('blacklist'), 'b1.com', 'B29b');
});
test('B30 setXlist with empty array clears the list', async () => {
  const env = makeEnv({ sync: [['whitelist', 'gone.com']] }); env.load();
  await env.call({ action: 'setWhitelist', whitelist: [] });
  eq(env.store.sync.get('whitelist'), '', 'B30');
});

// =====================================================================
// FAMILY G — addToList mutual exclusion (B31–B35)
// =====================================================================
test('B31 addWhitelist prunes blacklist + spooflist siblings', async () => {
  const env = makeEnv({ sync: [['blacklist', 'dual.com'], ['spooflist', 'dual.com']] }); env.load();
  const r = await env.call({ action: 'addWhitelist', domain: 'dual.com' });
  eq(r.status, 'added', 'B31');
  eq(env.store.sync.get('whitelist'), 'dual.com', 'B31b');
  eq(env.store.sync.get('blacklist'), '', 'B31c');
  eq(env.store.sync.get('spooflist'), '', 'B31d');
});
test('B32 addBlacklist prunes whitelist + spooflist siblings', async () => {
  const env = makeEnv({ sync: [['whitelist', 'dual.com'], ['spooflist', 'dual.com']] }); env.load();
  const r = await env.call({ action: 'addBlacklist', domain: 'https://DUAL.com/x' });
  eq(r.status, 'added', 'B32'); eq(r.domain, 'dual.com', 'B32b');
  eq(env.store.sync.get('whitelist'), '', 'B32c');
  eq(env.store.sync.get('spooflist'), '', 'B32d');
  eq(env.store.sync.get('blacklist'), 'dual.com', 'B32e');
});
test('B33 addSpooflist prunes whitelist + blacklist siblings', async () => {
  const env = makeEnv({ sync: [['whitelist', 'dual.com'], ['blacklist', 'dual.com']] }); env.load();
  await env.call({ action: 'addSpooflist', domain: 'dual.com' });
  eq(env.store.sync.get('spooflist'), 'dual.com', 'B33');
  eq(env.store.sync.get('whitelist'), '', 'B33b');
  eq(env.store.sync.get('blacklist'), '', 'B33c');
});
test('B34 addToList: already present, no conflict → exists, no rewrite', async () => {
  const env = makeEnv({ sync: [['whitelist', 'keep.com\nother.com']] }); env.load();
  const r = await env.call({ action: 'addWhitelist', domain: 'keep.com' });
  eq(r.status, 'exists', 'B34');
  eq(env.store.sync.get('whitelist'), 'keep.com\nother.com', 'B34b');
});
test('B35 addToList: same domain on multiple lists (bulk-saved) resolves in gate order', async () => {
  const env = makeEnv({ sync: [['blacklist', 'multi.com'], ['spooflist', 'multi.com'], ['whitelist', 'multi.com']] }); env.load();
  const r = await env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://multi.com/x' }, senderPage);
  eq(r.reason, 'blacklisted', 'B35 — blacklist wins');
});

// =====================================================================
// FAMILY H — removeDomain / ASK AGAIN (B36–B38)
// =====================================================================
test('B36 removeDomain removes from all three lists', async () => {
  const env = makeEnv({ sync: [['whitelist', 'gone.com\nstay.com'], ['blacklist', 'gone.com'], ['spooflist', 'gone.com']] }); env.load();
  const r = await env.call({ action: 'removeDomain', domain: 'GONE.com' });
  eq(r.status, 'removed', 'B36'); eq(r.removed, 3, 'B36b');
  eq(env.store.sync.get('whitelist'), 'stay.com', 'B36c');
  eq(env.store.sync.get('blacklist'), '', 'B36d');
  eq(env.store.sync.get('spooflist'), '', 'B36e');
});
test('B37 removeDomain: unknown domain → removed 0', async () => {
  const env = makeEnv(); env.load();
  const r = await env.call({ action: 'removeDomain', domain: 'nothing.example' });
  eq(r.status, 'removed', 'B37'); eq(r.removed, 0, 'B37b');
});
test('B38 removeDomain: empty domain → invalid', async () => {
  const env = makeEnv(); env.load();
  const r = await env.call({ action: 'removeDomain', domain: '' });
  eq(r.status, 'invalid', 'B38');
});

// =====================================================================
// FAMILY I — gate order doctrine (B39–B50)
// =====================================================================
test('B39 gate: blacklisted target hard-denies', async () => {
  const env = makeEnv({ sync: [['blacklist', 'bad.example']] }); env.load();
  const r = await env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://bad.example/ws' }, senderPage);
  eq(r.allowed, false, 'B39'); eq(r.action, 'deny', 'B39b'); eq(r.reason, 'blacklisted', 'B39c');
});
test('B40 gate: blacklisted page origin hard-denies any target', async () => {
  const env = makeEnv({ sync: [['blacklist', 'page.example']] }); env.load();
  const r = await env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://clean.example/ws' }, senderPage);
  eq(r.reason, 'blacklisted', 'B40');
});
test('B41 gate: blacklist outranks whitelist', async () => {
  const env = makeEnv({ sync: [['blacklist', 'both.com'], ['whitelist', 'both.com']] }); env.load();
  const r = await env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://both.com/ws' }, senderPage);
  eq(r.reason, 'blacklisted', 'B41');
});
test('B42 gate: blacklist outranks disabled master toggle', async () => {
  const env = makeEnv({ sync: [['blacklist', 'bad.example'], ['enabled', false]] }); env.load();
  const r = await env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://bad.example/ws' }, senderPage);
  eq(r.reason, 'blacklisted', 'B42 — prohibition survives pass-through');
});
test('B43 gate: blacklist outranks spooflist', async () => {
  const env = makeEnv({ sync: [['blacklist', 'bad.example'], ['spooflist', 'bad.example']] }); env.load();
  const r = await env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://bad.example/ws' }, senderPage);
  eq(r.reason, 'blacklisted', 'B43');
});
test('B44 gate: spooflisted target auto-spoofs silently', async () => {
  const env = makeEnv({ sync: [['spooflist', 'pacify.example']] }); env.load();
  const r = await env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://pacify.example/ws' }, senderPage);
  eq(r.allowed, false, 'B44'); eq(r.action, 'spoof', 'B44b'); eq(r.reason, 'spooflisted', 'B44c');
  eq(env.state.tabsMessages.length, 0, 'B44d — never interactive');
});
test('B45 gate: spooflisted page origin auto-spoofs', async () => {
  const env = makeEnv({ sync: [['spooflist', 'page.example']] }); env.load();
  const r = await env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://any.example/ws' }, senderPage);
  eq(r.action, 'spoof', 'B45'); eq(r.reason, 'spooflisted', 'B45b');
});
test('B46 gate: spooflist outranks whitelist', async () => {
  const env = makeEnv({ sync: [['spooflist', 'both.com'], ['whitelist', 'both.com']] }); env.load();
  const r = await env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://both.com/ws' }, senderPage);
  eq(r.action, 'spoof', 'B46');
});
test('B47 gate: spooflist outranks disabled toggle', async () => {
  const env = makeEnv({ sync: [['spooflist', 'pacify.example'], ['enabled', false]] }); env.load();
  const r = await env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://pacify.example/ws' }, senderPage);
  eq(r.action, 'spoof', 'B47 — explicit spoof survives pass-through');
});
test('B48 gate: ddos-guard fast path allows when enabled', async () => {
  const env = makeEnv(); env.load();
  const r = await env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://site.example/.well-known/ddos-guard/chk' }, senderPage);
  eq(r.allowed, true, 'B48'); eq(r.reason, 'ddos-guard', 'B48b');
});
test('B49 gate: whitelist auto-allows (suffix match honored)', async () => {
  const env = makeEnv({ sync: [['whitelist', 'base.example']] }); env.load();
  const r = await env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://deep.sub.base.example/ws' }, senderPage);
  eq(r.allowed, true, 'B49'); eq(r.reason, 'whitelisted', 'B49b');
});
test('B50 gate: unknown target settles interactive (default-deny pending)', async () => {
  const env = makeEnv(); env.load();
  const p = env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://unknown.example/ws' }, senderPage);
  let settled = null; p.then((r) => { settled = r; });
  await env.clock.advance(50);
  ok(!settled, 'B50 — stays pending (interactive)');
  eq(env.state.tabsMessages.length, 1, 'B50b — quick bar dispatched');
});

// =====================================================================
// FAMILY J — rate limits (B51–B55)
// =====================================================================
test('B51 rate limit: 41st gate request per tab/min denied', async () => {
  const env = makeEnv(); env.load();
  const url = 'wss://same.example/ws';
  const first = env.call({ action: 'requestPermission', type: 'WebSocket', url }, senderPage);
  for (let i = 2; i <= 40; i++) env.call({ action: 'requestPermission', type: 'WebSocket', url }, senderPage);
  const r41 = await env.call({ action: 'requestPermission', type: 'WebSocket', url }, senderPage);
  eq(r41.reason, 'rate_limited', 'B51'); eq(r41.action, 'deny', 'B51b');
  await env.clock.flush();
  const reqId = env.state.tabsMessages[env.state.tabsMessages.length - 1].message.reqId;
  await env.call({ action: 'resolvePermission', id: reqId, decision: 'deny' });
  eq((await first).action, 'deny', 'B51c');
});
test('B52 rate limit: window resets after 60s', async () => {
  const env = makeEnv(); env.load();
  const url = 'wss://same.example/ws';
  env.call({ action: 'requestPermission', type: 'WebSocket', url }, senderPage);
  for (let i = 0; i < 40; i++) env.call({ action: 'requestPermission', type: 'WebSocket', url }, senderPage);
  const r41 = await env.call({ action: 'requestPermission', type: 'WebSocket', url }, senderPage);
  eq(r41.reason, 'rate_limited', 'B52 setup');
  await env.clock.advance(61000);
  const p = env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://fresh.example/ws' }, senderPage);
  let settled = null; p.then((r) => { settled = r; });
  await env.clock.flush();
  ok(!settled, 'B52 — window reset, new request not rate limited');
});
test('B53 telemetry rate limit: 61st swAttemptLog limited', async () => {
  const env = makeEnv(); env.load();
  for (let i = 0; i < 60; i++) {
    const r = await env.call({ action: 'swAttemptLog', type: 'WebSocket', target: 'wss://x.example/' + i }, senderPage);
    eq(r.status, 'telemetry_recorded', 'B53 loop ' + i);
  }
  const r61 = await env.call({ action: 'swAttemptLog', type: 'WebSocket', target: 'wss://x.example/61' }, senderPage);
  eq(r61.status, 'rate_limited', 'B53');
});
test('B54 rate limits are keyed per tab', async () => {
  const env = makeEnv(); env.load();
  const url = 'wss://same.example/ws';
  for (let i = 0; i < 41; i++) env.call({ action: 'requestPermission', type: 'WebSocket', url }, senderPage);
  const limited = await env.call({ action: 'requestPermission', type: 'WebSocket', url }, senderPage);
  eq(limited.reason, 'rate_limited', 'B54 setup');
  const p = env.call({ action: 'requestPermission', type: 'WebSocket', url }, senderPage2);
  let settled = null; p.then((r) => { settled = r; });
  await env.clock.flush();
  ok(!settled, 'B54 — other tab unaffected');
});
test('B55 tabs.onRemoved evicts per-tab rate state', async () => {
  const env = makeEnv(); env.load();
  const url = 'wss://same.example/ws';
  for (let i = 0; i < 41; i++) env.call({ action: 'requestPermission', type: 'WebSocket', url }, senderPage);
  eq((await env.call({ action: 'requestPermission', type: 'WebSocket', url }, senderPage)).reason, 'rate_limited', 'B55 setup');
  env.listeners.tabsRemoved.forEach((fn) => fn(1));
  const p = env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://newurl.example/ws' }, senderPage);
  let settled = null; p.then((r) => { settled = r; });
  await env.clock.flush();
  ok(!settled, 'B55 — eviction restores allowance');
});

// =====================================================================
// FAMILY K — dedup + prompt cap (B56–B62)
// =====================================================================
test('B56 dedup: same key joins one pending decision', async () => {
  const env = makeEnv(); env.load();
  const url = 'wss://dedup.example/ws';
  const p1 = env.call({ action: 'requestPermission', type: 'WebSocket', url }, senderPage);
  const p2 = env.call({ action: 'requestPermission', type: 'WebSocket', url }, senderPage);
  await env.clock.flush();
  eq(env.state.tabsMessages.length, 1, 'B56 — one ask only');
  const reqId = env.state.tabsMessages[0].message.reqId;
  await env.call({ action: 'resolvePermission', id: reqId, decision: 'allow' });
  const [r1, r2] = await Promise.all([p1, p2]);
  eq(r1.reason, 'prompt', 'B56b'); eq(r2.reason, 'dedup', 'B56c');
  eq(r1.action, 'allow', 'B56d'); eq(r2.action, 'allow', 'B56e');
});
test('B57 dedup canon strips query strings (token-bearing sockets)', async () => {
  const env = makeEnv(); env.load();
  const p1 = env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://dedup.example/ws?token=aaa' }, senderPage);
  env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://dedup.example/ws?token=bbb' }, senderPage);
  await env.clock.flush();
  eq(env.state.tabsMessages.length, 1, 'B57 — query strings do not defeat dedup');
  const reqId = env.state.tabsMessages[0].message.reqId;
  await env.call({ action: 'resolvePermission', id: reqId, decision: 'deny' });
  eq((await p1).action, 'deny', 'B57b');
});
test('B58 dedup canon strips fragments', async () => {
  const env = makeEnv(); env.load();
  env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://dedup.example/ws#one' }, senderPage);
  env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://dedup.example/ws#two' }, senderPage);
  await env.clock.flush();
  eq(env.state.tabsMessages.length, 1, 'B58');
});
test('B59 different connection type → separate decisions', async () => {
  const env = makeEnv(); env.load();
  env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://dedup.example/ws' }, senderPage);
  env.call({ action: 'requestPermission', type: 'Service Worker', url: 'wss://dedup.example/ws' }, senderPage);
  await env.clock.flush();
  eq(env.state.tabsMessages.length, 2, 'B59');
});
test('B60 different page origin → separate decisions', async () => {
  const env = makeEnv(); env.load();
  env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://dedup.example/ws' }, senderPage);
  env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://dedup.example/ws' }, senderPage2);
  await env.clock.flush();
  eq(env.state.tabsMessages.length, 2, 'B60');
});
test('B61 prompt cap: 4th concurrent per tab denied', async () => {
  const env = makeEnv(); env.load();
  for (let i = 1; i <= 3; i++) env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://cap' + i + '.example/ws' }, senderPage);
  const r4 = await env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://cap4.example/ws' }, senderPage);
  eq(r4.reason, 'prompt_cap', 'B61'); eq(r4.action, 'deny', 'B61b');
});
test('B62 settled prompt frees its cap slot', async () => {
  const env = makeEnv(); env.load();
  for (let i = 1; i <= 3; i++) env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://cap' + i + '.example/ws' }, senderPage);
  await env.clock.flush();
  eq((await env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://cap4.example/ws' }, senderPage)).reason, 'prompt_cap', 'B62 setup');
  const reqId = env.state.tabsMessages[0].message.reqId;
  await env.call({ action: 'resolvePermission', id: reqId, decision: 'deny' });
  await env.clock.flush();
  const p = env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://cap4.example/ws' }, senderPage);
  let settled = null; p.then((r) => { settled = r; });
  await env.clock.flush();
  ok(!settled, 'B62 — slot freed, new prompt allowed');
});

// =====================================================================
// FAMILY L — settlements / resolvePermission (B63–B74)
// =====================================================================
test('B63 resolvePermission v7.2 shape: {allowed:true} settles allow', async () => {
  const env = makeEnv(); env.load();
  const p = env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://v72.example/ws' }, senderPage);
  await env.clock.flush();
  const reqId = env.state.tabsMessages[0].message.reqId;
  const r = await env.call({ action: 'resolvePermission', id: reqId, allowed: true });
  eq(r.status, 'resolved', 'B63');
  eq((await p).action, 'allow', 'B63b');
});
test('B64 resolvePermission v7.2 shape: blacklist grant + deny', async () => {
  const env = makeEnv(); env.load();
  const p = env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://v72b.example/ws' }, senderPage);
  await env.clock.flush();
  const reqId = env.state.tabsMessages[0].message.reqId;
  await env.call({ action: 'resolvePermission', id: reqId, allowed: false, blacklist: true, domain: 'v72b.example' });
  eq((await p).action, 'deny', 'B64');
  ok(String(env.store.sync.get('blacklist')).includes('v72b.example'), 'B64b — blacklisted');
});
test('B65 resolvePermission v7.3 shape: decision spoof', async () => {
  const env = makeEnv(); env.load();
  const p = env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://v73.example/ws' }, senderPage);
  await env.clock.flush();
  const reqId = env.state.tabsMessages[0].message.reqId;
  await env.call({ action: 'resolvePermission', id: reqId, decision: 'spoof' });
  const r = await p;
  eq(r.action, 'spoof', 'B65'); eq(r.allowed, false, 'B65b');
});
test('B66 resolvePermission v7.3 shape: decision deny', async () => {
  const env = makeEnv(); env.load();
  const p = env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://v73d.example/ws' }, senderPage);
  await env.clock.flush();
  const reqId = env.state.tabsMessages[0].message.reqId;
  await env.call({ action: 'resolvePermission', id: reqId, decision: 'deny' });
  eq((await p).action, 'deny', 'B66');
});
test('B67 remember=site allow → whitelist grant (page-origin scope)', async () => {
  const env = makeEnv(); env.load();
  const p = env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://endpoint.example/ws' }, senderPage);
  await env.clock.flush();
  const reqId = env.state.tabsMessages[0].message.reqId;
  await env.call({ action: 'resolvePermission', id: reqId, decision: 'allow', remember: 'site', domain: 'page.example' });
  eq((await p).action, 'allow', 'B67');
  ok(String(env.store.sync.get('whitelist')).includes('page.example'), 'B67b — site-scoped grant');
});
test('B68 remember=site spoof → spooflist grant', async () => {
  const env = makeEnv(); env.load();
  const p = env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://x.example/ws' }, senderPage);
  await env.clock.flush();
  const reqId = env.state.tabsMessages[0].message.reqId;
  await env.call({ action: 'resolvePermission', id: reqId, decision: 'spoof', remember: 'site', domain: 'page.example' });
  ok(String(env.store.sync.get('spooflist')).includes('page.example'), 'B68');
});
test('B69 remember=endpoint deny → blacklist grant on endpoint host', async () => {
  const env = makeEnv(); env.load();
  const p = env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://endp.example/ws' }, senderPage);
  await env.clock.flush();
  const reqId = env.state.tabsMessages[0].message.reqId;
  await env.call({ action: 'resolvePermission', id: reqId, decision: 'deny', remember: 'endpoint', domain: 'endp.example' });
  ok(String(env.store.sync.get('blacklist')).includes('endp.example'), 'B69');
});
test('B70 remember with invalid decision → settlement only, no grant', async () => {
  const env = makeEnv(); env.load();
  const p = env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://g.example/ws' }, senderPage);
  await env.clock.flush();
  const reqId = env.state.tabsMessages[0].message.reqId;
  await env.call({ action: 'resolvePermission', id: reqId, decision: undefined, allowed: false, remember: 'site', domain: 'page.example' });
  eq((await p).action, 'deny', 'B70');
  eq(env.store.sync.get('whitelist'), undefined, 'B70b — deny grant went to blacklist not whitelist');
  ok(String(env.store.sync.get('blacklist')).includes('page.example'), 'B70c');
});
test('B71 resolvePermission with invalid id → invalid_id', async () => {
  const env = makeEnv(); env.load();
  const r = await env.call({ action: 'resolvePermission', id: 'not-a-number' });
  eq(r.status, 'invalid_id', 'B71');
});
test('B72 dedup-joined requests all resolve on one settlement', async () => {
  const env = makeEnv(); env.load();
  const url = 'wss://join.example/ws';
  const p1 = env.call({ action: 'requestPermission', type: 'WebSocket', url }, senderPage);
  const p2 = env.call({ action: 'requestPermission', type: 'WebSocket', url }, senderPage);
  const p3 = env.call({ action: 'requestPermission', type: 'WebSocket', url }, senderPage);
  await env.clock.flush();
  const reqId = env.state.tabsMessages[0].message.reqId;
  await env.call({ action: 'resolvePermission', id: reqId, decision: 'spoof' });
  const rs = await Promise.all([p1, p2, p3]);
  eq(rs[0].action, 'spoof', 'B72'); eq(rs[1].action, 'spoof', 'B72b'); eq(rs[2].action, 'spoof', 'B72c');
});
test('B73 inline settlement dismisses the quick bar', async () => {
  const env = makeEnv(); env.load();
  const p = env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://qb.example/ws' }, senderPage);
  await env.clock.flush();
  const reqId = env.state.tabsMessages[0].message.reqId;
  await env.call({ action: 'resolvePermission', id: reqId, decision: 'deny' });
  eq((await p).action, 'deny', 'B73');
  const dismiss = env.state.tabsMessages.filter((m) => m.message.action === 'ghostQuickDismiss');
  eq(dismiss.length, 1, 'B73b — dismissal dispatched');
  eq(dismiss[0].message.reqId, reqId, 'B73c');
  eq(dismiss[0].options.frameId, 0, 'B73d — frame-targeted');
});
test('B74 settlement removes the prompt window', async () => {
  const env = makeEnv({ sync: [['promptMode', 'window']] }); env.load();
  const p = env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://win.example/ws' }, senderPage);
  await env.clock.flush();
  eq(env.state.windowsCreated.length, 1, 'B74 setup');
  const reqId = Number(new URL(env.state.windowsCreated[0].createOpts.url, 'https://ext.invalid/').searchParams.get('id'));
  await env.call({ action: 'resolvePermission', id: reqId, decision: 'allow' });
  eq((await p).action, 'allow', 'B74');
  eq(env.state.windowsRemoved.length, 1, 'B74b — window removed');
});

// =====================================================================
// FAMILY M — decision dispatch surfaces (B75–B84)
// =====================================================================
test('B75 inline mode + quick bar ack → no prompt window', async () => {
  const env = makeEnv(); env.load();
  env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://inline.example/ws' }, senderPage);
  await env.clock.advance(100);
  eq(env.state.tabsMessages.length, 1, 'B75 — ask dispatched');
  eq(env.state.windowsCreated.length, 0, 'B75b — no window fallback');
});
test('B76 inline mode + missing ack → window fallback after 1600ms', async () => {
  const env = makeEnv(); env.load();
  env.state.tabsResponder = () => 'NO_ACK';
  env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://noack.example/ws' }, senderPage);
  await env.clock.advance(100);
  eq(env.state.windowsCreated.length, 0, 'B76 — not yet');
  await env.clock.advance(1600);
  eq(env.state.windowsCreated.length, 1, 'B76b — window fallback after ack window');
});
test('B77 inline mode + bar unavailable → window fallback', async () => {
  const env = makeEnv(); env.load();
  env.state.tabsResponder = () => ({ status: 'unavailable' });
  env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://unav.example/ws' }, senderPage);
  await env.clock.advance(100);
  eq(env.state.windowsCreated.length, 1, 'B77');
});
test('B78 quick bar send throws → window fallback', async () => {
  const env = makeEnv(); env.load();
  env.state.tabsResponder = () => 'THROW';
  env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://throw.example/ws' }, senderPage);
  await env.clock.advance(100);
  eq(env.state.windowsCreated.length, 1, 'B78');
});
test('B79 promptMode window → direct prompt window', async () => {
  const env = makeEnv({ sync: [['promptMode', 'window']] }); env.load();
  env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://mode.example/ws' }, senderPage);
  await env.clock.advance(100);
  eq(env.state.tabsMessages.length, 0, 'B79 — no inline attempt');
  eq(env.state.windowsCreated.length, 1, 'B79b');
});
test('B80 window create failure → auto-deny', async () => {
  const env = makeEnv({ sync: [['promptMode', 'window']] }); env.load();
  env.state.windowCreator = () => 'FAIL';
  const p = env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://failwin.example/ws' }, senderPage);
  await env.clock.advance(100);
  const r = await p;
  eq(r.action, 'deny', 'B80'); eq(r.reason, 'prompt', 'B80b');
});
test('B81 user closes prompt window → deny settlement', async () => {
  const env = makeEnv({ sync: [['promptMode', 'window']] }); env.load();
  const p = env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://close.example/ws' }, senderPage);
  await env.clock.advance(50);
  const winId = env.state.windowsCreated[0].id;
  env.listeners.windowsRemoved.forEach((fn) => fn(winId));
  const r = await p;
  eq(r.action, 'deny', 'B81 — closing the prompt denies');
});
test('B82 prompt window URL carries id/type/url/origin', async () => {
  const env = makeEnv({ sync: [['promptMode', 'window']] }); env.load();
  env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://params.example/ws?x=1' }, senderPage);
  await env.clock.advance(50);
  const u = new URL(env.state.windowsCreated[0].createOpts.url, 'https://ext.invalid/');
  eq(u.searchParams.get('type'), 'WebSocket', 'B82');
  eq(u.searchParams.get('url'), 'wss://params.example/ws?x=1', 'B82b');
  eq(u.searchParams.get('origin'), 'https://page.example', 'B82c');
  ok(u.searchParams.get('id'), 'B82d');
});
test('B83 prompt window geometry 380x460 popup', async () => {
  const env = makeEnv({ sync: [['promptMode', 'window']] }); env.load();
  env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://geom.example/ws' }, senderPage);
  await env.clock.advance(50);
  const co = env.state.windowsCreated[0].createOpts;
  eq(co.width, 380, 'B83'); eq(co.height, 460, 'B83b'); eq(co.type, 'popup', 'B83c');
});
test('B84 sender without tab → prompt window directly', async () => {
  const env = makeEnv(); env.load();
  const noTab = { url: 'https://notab.example/x', frameId: 0 };
  env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://notab.example/ws' }, noTab);
  await env.clock.advance(100);
  eq(env.state.tabsMessages.length, 0, 'B84 — no tabs.sendMessage possible');
  eq(env.state.windowsCreated.length, 1, 'B84b');
});

// =====================================================================
// FAMILY N — router discipline (B85–B92)
// =====================================================================
test('B85 internal unknown action → unknown_action', async () => {
  const env = makeEnv(); env.load();
  eq((await env.call({ action: 'nonsense' })).status, 'unknown_action', 'B85');
});
test('B86 external non-whitelisted action → forbidden', async () => {
  const env = makeEnv(); env.load();
  eq((await env.call({ action: 'addBlacklist', domain: 'evil.example' }, senderPage, 'external')).status, 'forbidden', 'B86');
});
test('B87 external ghostStatus allowed', async () => {
  const env = makeEnv(); env.load();
  const r = await env.call({ action: 'ghostStatus' }, senderPage, 'external');
  eq(r.status, 'ok', 'B87'); eq(r.active, true, 'B87b');
});
test('B88 external requestPermission allowed', async () => {
  const env = makeEnv(); env.load();
  const p = env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://ext.example/ws' }, senderPage, 'external');
  await env.clock.flush();
  const reqId = env.state.tabsMessages[0].message.reqId;
  await env.call({ action: 'resolvePermission', id: reqId, decision: 'allow' });
  eq((await p).action, 'allow', 'B88');
});
test('B89 external swAttemptLog allowed', async () => {
  const env = makeEnv(); env.load();
  eq((await env.call({ action: 'swAttemptLog', type: 'WebSocket', target: 'wss://e.example/' }, senderPage, 'external')).status, 'telemetry_recorded', 'B89');
});
test('B90 external list mutations forbidden (spoof too)', async () => {
  const env = makeEnv(); env.load();
  eq((await env.call({ action: 'addSpooflist', domain: 'evil.example' }, senderPage, 'external')).status, 'forbidden', 'B90');
  eq((await env.call({ action: 'setBlacklist', blacklist: ['evil.example'] }, senderPage, 'external')).status, 'forbidden', 'B90b');
});
test('B91 non-string action → invalid_request', async () => {
  const env = makeEnv(); env.load();
  eq((await env.call({ action: 42 })).status, 'invalid_request', 'B91');
  eq((await env.call({})).status, 'invalid_request', 'B91b');
});
test('B92 dead message port never leaks (safeRespond)', async () => {
  const env = makeEnv(); env.load();
  const r = await env.call({ action: 'ghostStatus' }, senderPage, 'internal', () => { throw new Error('Attempting to use a disconnected port object'); });
  eq(r.status, 'ok', 'B92 — response recorded before port death');
  ok(env.state.consoleDebug.some((l) => l.includes('undeliverable')), 'B92b — failure logged at debug boundary');
});

// =====================================================================
// FAMILY O — ghostStatus flags (B93–B96)
// =====================================================================
test('B93 ghostStatus: default active + no flags', async () => {
  const env = makeEnv(); env.load();
  const r = await env.call({ action: 'ghostStatus' }, senderPage);
  eq(r.active, true, 'B93'); eq(r.whitelisted, false, 'B93b');
  eq(r.blacklisted, false, 'B93c'); eq(r.spooflisted, false, 'B93d');
});
test('B94 ghostStatus: whitelisted origin flag', async () => {
  const env = makeEnv({ sync: [['whitelist', 'page.example']] }); env.load();
  eq((await env.call({ action: 'ghostStatus' }, senderPage)).whitelisted, true, 'B94');
});
test('B95 ghostStatus: blacklisted origin flag (guarded even if whitelisted)', async () => {
  const env = makeEnv({ sync: [['blacklist', 'page.example'], ['whitelist', 'page.example']] }); env.load();
  const r = await env.call({ action: 'ghostStatus' }, senderPage);
  eq(r.blacklisted, true, 'B95'); eq(r.whitelisted, true, 'B95b');
});
test('B96 ghostStatus: spooflisted origin flag', async () => {
  const env = makeEnv({ sync: [['spooflist', 'page.example']] }); env.load();
  eq((await env.call({ action: 'ghostStatus' }, senderPage)).spooflisted, true, 'B96');
});

// =====================================================================
// FAMILY P — swAttemptLog telemetry (B97–B100)
// =====================================================================
test('B97 swAttemptLog entry shape', async () => {
  const env = makeEnv(); env.load();
  await env.call({ action: 'swAttemptLog', type: 'Service Worker', target: 'https://t.example/sw.js', origin: 'https://o.example', allowed: false, source: 'gate' }, senderPage);
  const attempts = env.store.local.get('detailedAttempts');
  eq(attempts.length, 1, 'B97');
  const a = attempts[0];
  eq(a.type, 'Service Worker', 'B97b'); eq(a.target, 'https://t.example/sw.js', 'B97c');
  eq(a.origin, 'https://o.example', 'B97d'); eq(a.allowed, false, 'B97e');
  eq(a.pageUrl, 'https://page.example/start', 'B97f'); eq(a.tabId, 1, 'B97g');
});
test('B98 swAttemptLog optional detail field', async () => {
  const env = makeEnv(); env.load();
  await env.call({ action: 'swAttemptLog', type: 'PURGE', target: 'x', detail: '2 registration(s) removed' }, senderPage);
  eq(env.store.local.get('detailedAttempts')[0].detail, '2 registration(s) removed', 'B98');
});
test('B99 swAttemptLog target falls back to scriptURL', async () => {
  const env = makeEnv(); env.load();
  await env.call({ action: 'swAttemptLog', type: 'SW', scriptURL: 'https://s.example/sw.js' }, senderPage);
  eq(env.store.local.get('detailedAttempts')[0].target, 'https://s.example/sw.js', 'B99');
});
test('B100 telemetry bound: MAX_ATTEMPTS=1000 ring buffer', async () => {
  const pre = []; for (let i = 0; i < 1000; i++) pre.push({ type: 'x', i });
  const env = makeEnv({ local: [['detailedAttempts', pre]] }); env.load();
  await env.call({ action: 'swAttemptLog', type: 'new', target: 't' }, senderPage);
  const a = env.store.local.get('detailedAttempts');
  eq(a.length, 1000, 'B100 — bounded');
  eq(a[999].type, 'new', 'B100b — newest kept');
  eq(a[0].i, 1, 'B100c — oldest evicted (index 0 dropped)');
});

// =====================================================================
// FAMILY Q — getSitePolicy (B101–B104)
// =====================================================================
test('B101 getSitePolicy: domain parsed from origin URL', async () => {
  const env = makeEnv(); env.load();
  const r = await env.call({ action: 'getSitePolicy', origin: 'https://sub.example.com/deep/path' });
  eq(r.status, 'ok', 'B101'); eq(r.domain, 'sub.example.com', 'B101b');
});
test('B102 getSitePolicy: raw domain fallback when origin is not a URL', async () => {
  const env = makeEnv(); env.load();
  eq((await env.call({ action: 'getSitePolicy', origin: 'plain.example' })).domain, 'plain.example', 'B102');
});
test('B103 getSitePolicy: flags reflect all three lists', async () => {
  const env = makeEnv({ sync: [['whitelist', 'multi.example'], ['spooflist', 'multi.example'], ['blacklist', 'multi.example']] }); env.load();
  const r = await env.call({ action: 'getSitePolicy', origin: 'https://multi.example/x' });
  eq(r.whitelisted, true, 'B103'); eq(r.spooflisted, true, 'B103b'); eq(r.blacklisted, true, 'B103c');
});
test('B104 getSitePolicy: enabled + promptMode included', async () => {
  const env = makeEnv({ sync: [['enabled', false], ['promptMode', 'window']] }); env.load();
  const r = await env.call({ action: 'getSitePolicy', origin: 'https://q.example/' });
  eq(r.enabled, false, 'B104'); eq(r.promptMode, 'window', 'B104b');
});

// =====================================================================
// FAMILY R — onInstalled defaults + legacy migration (B105–B109)
// =====================================================================
test('B105 onInstalled writes fresh defaults', async () => {
  const env = makeEnv(); env.load();
  env.listeners.onInstalled.forEach((fn) => fn({ reason: 'install' }));
  await env.clock.flush();
  eq(env.store.sync.get('enabled'), true, 'B105');
  eq(env.store.sync.get('blacklist'), '', 'B105b');
  eq(env.store.sync.get('spooflist'), '', 'B105c');
  eq(env.store.sync.get('promptMode'), 'inline', 'B105d');
});
test('B106 onInstalled migrates legacy local whitelist array', async () => {
  const env = makeEnv({ local: [['whitelist', ['Legacy.COM', 'old.example']]] }); env.load();
  env.listeners.onInstalled.forEach((fn) => fn({ reason: 'install' }));
  await env.clock.flush();
  eq(env.store.sync.get('whitelist'), 'legacy.com\nold.example', 'B106');
  eq(env.store.local.has('whitelist'), false, 'B106b — legacy key removed');
});
test('B107 onInstalled migrates legacy ghostActive=false → enabled=false', async () => {
  const env = makeEnv({ local: [['ghostActive', false]] }); env.load();
  env.listeners.onInstalled.forEach((fn) => fn({ reason: 'install' }));
  await env.clock.flush();
  eq(env.store.sync.get('enabled'), false, 'B107');
  eq(env.store.local.has('ghostActive'), false, 'B107b');
});
test('B108 onInstalled preserves existing values (no clobber)', async () => {
  const env = makeEnv({ sync: [['enabled', false], ['whitelist', 'keep.example']] }); env.load();
  env.listeners.onInstalled.forEach((fn) => fn({ reason: 'update' }));
  await env.clock.flush();
  eq(env.store.sync.get('enabled'), false, 'B108');
  eq(env.store.sync.get('whitelist'), 'keep.example', 'B108b');
});
test('B109 onInstalled failure is contained (no throw)', async () => {
  const env = makeEnv(); env.load();
  env.state.failNextGet = true;
  env.listeners.onInstalled.forEach((fn) => fn({ reason: 'install' }));
  await env.clock.flush();
  ok(env.state.consoleErrors.some((l) => l.includes('onInstalled failed')), 'B109 — logged, not thrown');
});

// =====================================================================
// FAMILY S — navigation telemetry + tab eviction (B110–B112)
// =====================================================================
test('B110 navigation to non-whitelisted domain logs a block', async () => {
  const env = makeEnv(); env.load();
  env.listeners.tabsUpdated.forEach((fn) => fn(9, { url: 'https://navlog.example/page' }, { status: 'loading' }));
  await env.clock.flush();
  eq(env.store.local.get('swBlocks')['navlog.example'], 1, 'B110');
});
test('B111 chrome:// and whitelisted navigations are not logged', async () => {
  const env = makeEnv({ sync: [['whitelist', 'ok.example']] }); env.load();
  env.listeners.tabsUpdated.forEach((fn) => fn(9, { url: 'chrome://settings/' }, { status: 'loading' }));
  env.listeners.tabsUpdated.forEach((fn) => fn(9, { url: 'https://ok.example/x' }, { status: 'loading' }));
  await env.clock.flush();
  eq(env.store.local.get('swBlocks'), undefined, 'B111');
});
test('B112 tab close evicts prompt-cap state too', async () => {
  const env = makeEnv(); env.load();
  for (let i = 1; i <= 3; i++) env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://ev' + i + '.example/ws' }, senderPage);
  eq((await env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://ev4.example/ws' }, senderPage)).reason, 'prompt_cap', 'B112 setup');
  env.listeners.tabsRemoved.forEach((fn) => fn(1));
  const p = env.call({ action: 'requestPermission', type: 'WebSocket', url: 'wss://ev5.example/ws' }, senderPage);
  let settled = null; p.then((r) => { settled = r; });
  await env.clock.flush();
  ok(!settled, 'B112 — cap state evicted');
});

main();
