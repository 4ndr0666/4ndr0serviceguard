// ==UserScript==
// @name         4ndr0tools - 4ndr0serviceguarder
// @namespace    https://github.com/4ndr0666/4ndr0serviceguard
// @version      7.2.0
// @author       4ndr0666
// @description  Stealth Service Worker / WebSocket / SharedWorker firewall companion for the 4ndr0serviceguard extension. Default-deny: workers and sockets are spoofed or refused unless the origin is whitelisted; an absolute blacklist overrides everything. Defers to the extension's Gatekeeper whenever the extension is present on the page.
// @icon         data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20128%20128%22%20fill%3D%22none%22%20stroke%3D%22%2300E5FF%22%20stroke-width%3D%223%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M%2064%2C12%20A%2052%2C52%200%201%201%2063.9%2C12%20Z%22%20stroke-dasharray%3D%2221.78%2021.78%22%20stroke-width%3D%222%22%2F%3E%3Cpath%20d%3D%22M%2064%2C20%20A%2044%2C44%200%201%201%2063.9%2C20%20Z%22%20stroke-dasharray%3D%2210%2010%22%20stroke-width%3D%221.5%22%20opacity%3D%220.7%22%2F%3E%3Cpath%20d%3D%22M64%2030%20L91.3%2047%20L91.3%2081%20L64%2098%20L36.7%2081%20L36.7%2047%20Z%22%2F%3E%3Ctext%20x%3D%2264%22%20y%3D%2267%22%20text-anchor%3D%22middle%22%20dominant-baseline%3D%22middle%22%20fill%3D%22%2300E5FF%22%20stroke%3D%22none%22%20font-size%3D%2256%22%20font-weight%3D%22700%22%20font-family%3D%22Cinzel%20Decorative%2C%20serif%22%3E%CE%A8%3C%2Ftext%3E%3C%2Fsvg%3E
// @license      UNLICENSED - RED TEAM USE ONLY
// @match        *://*/*
// @downloadURL  https://github.com/4ndr0666/4ndr0serviceguard/raw/refs/heads/main/userscript/4ndr0tools%20-%204ndr0serviceguarder.user.js
// @updateURL    https://github.com/4ndr0666/4ndr0serviceguard/raw/refs/heads/main/userscript/4ndr0tools%20-%204ndr0serviceguarder.user.js
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// ==/UserScript==

// 4ndr0tools - 4ndr0serviceguarder v7.2.0 — completed helper userscript.
//
// Paradigm (D1): Proxy-based interception facade in the page (MAIN) context,
// mirroring ghost_core_v7.js — single paradigm, zero chimera.
//
// Vision: restore power to the user. Workers and WebSockets are denied by
// default period; the whitelist grants explicit allowance; the blacklist is
// an absolute prohibition that overrides the whitelist, the master toggle,
// the DDoS-Guard fast path and pass-through mode — exactly the enforcement
// order the extension's background gate applies (rate → blacklist → toggle
// → DDoS-Guard → whitelist → default-deny).
//
// Companion-mode doctrine (no double gating):
//   - If the extension's guard flag (window._4ndr0ghostV7) is already set at
//     install time, the extension owns the page: this script installs NO
//     hooks and runs as a utility layer (menus + status HUD) only.
//   - If this script installed first and the extension arrives later, every
//     hook lazily detects the flag at CALL time and becomes a transparent
//     conduit to whatever the extension layered on top of it (or beneath
//     it) — the extension's Gatekeeper runs exactly once either way.
//
// Stealth doctrine (bugbugnow.net v0.3.0 techniques, ported from
// ghost_core_v7.js): Proxy-based hooks keep toString()/name/length native;
// the phantom ServiceWorkerContainer is a memoized identity-stable singleton;
// denied WebSockets resolve into buffered phantom sockets that surface
// native-faithful error/close events at the 40 ms cadence instead of
// rejecting (rejections are trivially detectable and break pages harder).
//
// Storage keys: the baseline whitelist key ('4ndr0guard_whitelist_v6') is
// preserved verbatim so existing user data survives the upgrade; blacklist
// and toggle state live in sibling keys.

;(function (win) {
  'use strict';

  if (!win) return;

  // Guard flag (baseline name preserved).
  if (win.__4ndr0ghostUserV7) return;
  win.__4ndr0ghostUserV7 = true;

  // === POLICY STATE (local, GM storage — survives reloads) ===

  const WHITELIST_KEY = '4ndr0guard_whitelist_v6';  // baseline key: user data preserved
  const BLACKLIST_KEY = '4ndr0guard_blacklist_v7';
  const ENABLED_KEY = '4ndr0guard_enabled_v7';
  const NOTIFY_KEY = '4ndr0guard_notify_v7';

  const GATE_DENY_EVENT_MS = 40;    // denied-event cadence (v7 doctrine)
  const CONTROLLERCHANGE_MS = 25;   // blocked-registration lifecycle dispatch
  const NOTIFY_MIN_INTERVAL_MS = 8000;
  const NOTIFY_MAX_SESSION = 20;

  function loadList(key) {
    const raw = GM_getValue(key, []);
    if (Array.isArray(raw)) return raw.map(normalizeDomain).filter(Boolean);
    if (typeof raw === 'string') {
      return raw.split('\n').map((l) => normalizeDomain(l)).filter(Boolean);
    }
    return [];
  }

  let whitelist = loadList(WHITELIST_KEY);
  let blacklist = loadList(BLACKLIST_KEY);
  let enabled = GM_getValue(ENABLED_KEY, true) !== false; // default-deny period
  let denyNotifications = GM_getValue(NOTIFY_KEY, false) === true; // stealth by default

  const stats = { sw: 0, ws: 0, shared: 0, purged: 0 };
  let notifyCount = 0;
  let lastNotifyAt = 0;

  function normalizeDomain(domain) {
    return String(domain || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/xn--/g, '');
  }

  function persistWhitelist() {
    whitelist = Array.from(new Set(whitelist));
    GM_setValue(WHITELIST_KEY, whitelist);
  }

  function persistBlacklist() {
    blacklist = Array.from(new Set(blacklist));
    GM_setValue(BLACKLIST_KEY, blacklist);
  }

  function hostnameOf(url) {
    try { return new win.URL(String(url), win.location.href).hostname.toLowerCase(); }
    catch (e) { return ''; }
  }

  function listMatches(list, url) {
    const host = hostnameOf(url);
    if (!host) return false;
    return list.some((domain) => host === domain || host.endsWith('.' + domain));
  }

  function isWhitelisted(url) { return listMatches(whitelist, url); }
  function isBlacklisted(url) { return listMatches(blacklist, url); }

  // DDoS-Guard fast path — the full four-pattern heuristic (the unfinished
  // baseline draft only matched one; the extension core matches all four).
  function isDDoSGuardChallenge(url) {
    if (!url) return false;
    const u = String(url).toLowerCase();
    return u.includes('ddos-guard.net') ||
           u.includes('check.ddos-guard') ||
           u.includes('pacifier_v5') ||
           u.includes('/.well-known/ddos-guard/');
  }

  // === EXTENSION PRESENCE (lazy, at call time — race-free) ===

  function extensionActive() {
    return win._4ndr0ghostV7 === true;
  }

  const extensionOwnedAtInstall = extensionActive();

  // === LOCAL GATE (mirror of the extension's background gate order) ===

  const pageOrigin = (function () {
    try { return win.location.origin; } catch (e) { return ''; }
  })();

  function decide(targetUrl) {
    if (isBlacklisted(targetUrl) || (pageOrigin && isBlacklisted(pageOrigin))) {
      return { allow: false, reason: 'blacklist' };
    }
    if (!enabled) {
      return { allow: true, reason: 'disabled' };
    }
    if (isDDoSGuardChallenge(targetUrl)) {
      return { allow: true, reason: 'ddos-guard' };
    }
    if (isWhitelisted(targetUrl) || (pageOrigin && isWhitelisted(pageOrigin))) {
      return { allow: true, reason: 'whitelist' };
    }
    return { allow: false, reason: 'default-deny' };
  }

  function notifyDeny(kind, target) {
    if (!denyNotifications) return;
    if (notifyCount >= NOTIFY_MAX_SESSION) return; // bounded (B.1)
    const now = Date.now();
    if (now - lastNotifyAt < NOTIFY_MIN_INTERVAL_MS) return; // throttled
    lastNotifyAt = now;
    notifyCount += 1;
    try {
      if (typeof GM_notification === 'function') {
        const host = hostnameOf(target) || target;
        GM_notification({
          title: 'Ψ Ghost Protocol — DENIED',
          text: kind + ' blocked: ' + String(host).slice(0, 80),
          timeout: 4000
        });
      }
    } catch (e) { /* notification channel is best-effort; never break the page */ }
  }

  // === CAPTURED REAL REFERENCES (page context, immune to later shadowing) ===

  const realNav = win.navigator || null;
  const realSW = (realNav && realNav.serviceWorker) || null; // undefined on insecure origins
  const realShared = win.SharedWorker || null;
  const OrigWebSocket = win.WebSocket || null;
  const realCaches = win.caches || null;

  // === FUNCTIONAL EVENT TARGET (from ghost_core_v7.js) ===

  function makeEventTarget(owner) {
    const listeners = new Map(); // type -> Set<coerced listener>
    function coerce(listener) {
      if (typeof listener === 'function') return listener;
      if (listener && typeof listener.handleEvent === 'function') {
        return function (ev) { listener.handleEvent(ev); };
      }
      return null;
    }
    return {
      addEventListener(type, listener) {
        const fn = coerce(listener);
        if (!fn) return;
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, listener) {
        const set = listeners.get(type);
        const fn = coerce(listener);
        if (set && fn) set.delete(fn);
      },
      dispatchEvent(ev) {
        const set = listeners.get(ev && ev.type);
        if (set) {
          for (const fn of Array.from(set)) {
            try { fn.call(owner, ev); }
            catch (e) { console.debug('[Ψ-Ghost] listener error:', e); }
          }
        }
        return true;
      }
    };
  }

  function defineOnHandler(targetObj, et, propName, eventName) {
    let current = null;
    Object.defineProperty(targetObj, propName, {
      configurable: true,
      enumerable: true,
      get() { return current; },
      set(fn) {
        if (current) et.removeEventListener(eventName, current);
        current = (typeof fn === 'function' || (fn && typeof fn.handleEvent === 'function')) ? fn : null;
        if (current) et.addEventListener(eventName, current);
      }
    });
  }

  function tag(obj, name) {
    Object.defineProperty(obj, Symbol.toStringTag, { value: name, configurable: true });
  }

  function resolveUrl(target, base) {
    try { return new win.URL(target, base || pageOrigin).href; }
    catch (e) { return String(target || (pageOrigin + '/service-worker-fake.js')); }
  }

  // === ENHANCED FAKE REGISTRATION (memoized, scope-aware, identity-stable) ===

  const fakeRegistrations = new Map();

  function createFakeRegistration(scriptURL, options) {
    const resolvedScript = resolveUrl(scriptURL, pageOrigin);
    const scope = (options && typeof options.scope === 'string')
      ? resolveUrl(options.scope, pageOrigin)
      : pageOrigin + '/';
    const key = resolvedScript + '|' + scope;
    if (fakeRegistrations.has(key)) return fakeRegistrations.get(key);

    const registration = {};
    const et = makeEventTarget(registration);

    const activeWorker = {};
    const activeEt = makeEventTarget(activeWorker);
    tag(activeWorker, 'ServiceWorker');
    Object.defineProperty(activeWorker, 'state', { value: 'activated', configurable: true, enumerable: true });
    Object.defineProperty(activeWorker, 'scriptURL', { value: resolvedScript, configurable: true, enumerable: true });
    defineOnHandler(activeWorker, activeEt, 'onstatechange', 'statechange');
    activeWorker.addEventListener = activeEt.addEventListener;
    activeWorker.removeEventListener = activeEt.removeEventListener;
    activeWorker.dispatchEvent = activeEt.dispatchEvent;
    activeWorker.postMessage = () => {};

    tag(registration, 'ServiceWorkerRegistration');
    Object.defineProperty(registration, 'scope', { value: scope, configurable: true, enumerable: true });
    Object.defineProperty(registration, 'scriptURL', { value: resolvedScript, configurable: true, enumerable: true });
    Object.defineProperty(registration, 'installing', { value: null, configurable: true, enumerable: true });
    Object.defineProperty(registration, 'waiting', { value: null, configurable: true, enumerable: true });
    Object.defineProperty(registration, 'active', { value: activeWorker, configurable: true, enumerable: true });
    Object.defineProperty(registration, 'navigationPreload', {
      value: {
        enable: () => win.Promise.resolve(),
        disable: () => win.Promise.resolve(),
        getState: () => win.Promise.resolve('disabled')
      },
      configurable: true,
      enumerable: true
    });
    defineOnHandler(registration, et, 'onupdatefound', 'updatefound');
    registration.addEventListener = et.addEventListener;
    registration.removeEventListener = et.removeEventListener;
    registration.dispatchEvent = et.dispatchEvent;
    registration.update = () => win.Promise.resolve(registration); // identity-stable across update()
    registration.unregister = () => win.Promise.resolve(true);

    fakeRegistrations.set(key, registration);
    return registration;
  }

  const defaultFakeRegistration = () => createFakeRegistration(pageOrigin + '/service-worker-fake.js');

  // === SERVICE WORKER GATEKEEPER (dual-layer, Proxy-based) ===
  //
  // The baseline draft's whitelisted path recursed infinitely: it called
  // navigator.serviceWorker.register, which resolved back to its own fake.
  // Fixed doctrine: the original register is captured ONCE before any hook
  // is installed, and the pass-through path always calls the captured
  // original — never the (possibly hooked) live property.

  const swProto = (realSW && realSW.constructor && realSW.constructor.prototype) || null;
  const originalRegisterFn = (realSW && typeof realSW.register === 'function') ? realSW.register : null;

  // Memoized identity-stable phantom container (native metadata fidelity).
  const fakeContainer = {};
  const containerEt = makeEventTarget(fakeContainer);
  tag(fakeContainer, 'ServiceWorkerContainer');
  let fakeReadyPromise = null;

  // Constructor fidelity: native containers report ServiceWorkerContainer as
  // their constructor. Matching it removes an identity-detection vector and
  // keeps layered hooks (this script under/over the extension) away from
  // Object.prototype.
  if (realSW && realSW.constructor) {
    Object.defineProperty(fakeContainer, 'constructor', {
      value: realSW.constructor,
      configurable: true,
      enumerable: false,
      writable: true
    });
  }

  function passThrough() {
    // Extension governs, master switch off, or the policy allows the origin.
    return extensionActive() || decide(pageOrigin).allow;
  }

  async function gatedRegister(thisArg, scriptURL, options) {
    if (passThrough() && originalRegisterFn) {
      return originalRegisterFn.call(thisArg === fakeContainer ? realSW : thisArg, scriptURL, options);
    }
    const verdict = decide(resolveUrl(scriptURL, pageOrigin));
    if (verdict.allow && originalRegisterFn) {
      return originalRegisterFn.call(thisArg === fakeContainer ? realSW : thisArg, scriptURL, options);
    }
    stats.sw += 1;
    notifyDeny('Service Worker', scriptURL);
    const fake = createFakeRegistration(scriptURL, options);
    setTimeout(() => {
      try {
        const ev = new win.Event('controllerchange');
        Object.defineProperty(ev, 'target', { value: fakeContainer });
        containerEt.dispatchEvent(ev);
      } catch (e) {
        console.debug('[Ψ-Ghost] controllerchange dispatch failed:', e);
      }
    }, CONTROLLERCHANGE_MS);
    return fake;
  }

  function installServiceWorkerGate() {
    if (!realSW) return; // article guard: undefined on insecure origins

    if (originalRegisterFn) {
      // Proxy around the native register: toString/name/length stay native.
      const containerRegisterProxy = new Proxy(originalRegisterFn, {
        apply(target, thisArg, args) {
          return gatedRegister(thisArg, args[0], args[1]);
        }
      });
      Object.defineProperty(fakeContainer, 'register', {
        value: containerRegisterProxy,
        writable: true,
        configurable: true,
        enumerable: true
      });
    }

    fakeContainer.getRegistration = function (scope) {
      if (passThrough()) return realSW.getRegistration(scope);
      return win.Promise.resolve(undefined);
    };
    fakeContainer.getRegistrations = function () {
      if (passThrough()) return realSW.getRegistrations();
      return win.Promise.resolve([]);
    };
    Object.defineProperty(fakeContainer, 'controller', {
      configurable: true,
      enumerable: true,
      get() { return passThrough() ? realSW.controller : null; }
    });
    Object.defineProperty(fakeContainer, 'ready', {
      configurable: true,
      enumerable: true,
      get() {
        if (passThrough()) return realSW.ready;
        if (!fakeReadyPromise) fakeReadyPromise = win.Promise.resolve(defaultFakeRegistration());
        return fakeReadyPromise;
      }
    });
    fakeContainer.addEventListener = containerEt.addEventListener;
    fakeContainer.removeEventListener = containerEt.removeEventListener;
    fakeContainer.dispatchEvent = containerEt.dispatchEvent;
    defineOnHandler(fakeContainer, containerEt, 'oncontrollerchange', 'controllerchange');
    defineOnHandler(fakeContainer, containerEt, 'onmessage', 'message');
    fakeContainer.startMessages = function () {
      if (passThrough()) realSW.startMessages();
    };

    // Primary hook: navigator.serviceWorker (memoized getter — identity stable).
    try {
      Object.defineProperty(realNav, 'serviceWorker', {
        configurable: true,
        enumerable: true,
        get: function () { return fakeContainer; },
        set: () => false
      });
    } catch (e) {
      console.debug('[Ψ-Ghost] navigator.serviceWorker hook failed:', e);
    }

    // Secondary hardening hook: prototype level (survives property restoration).
    if (swProto && originalRegisterFn) {
      const protoRegisterProxy = new Proxy(originalRegisterFn, {
        apply(target, thisArg, args) {
          if (thisArg === fakeContainer) return Reflect.apply(target, realSW, args);
          return gatedRegister(thisArg, args[0], args[1]);
        }
      });
      try {
        if (typeof exportFunction === 'function') {
          // Greasemonkey Xray bridge (article v0.2.0 technique).
          exportFunction(protoRegisterProxy, swProto, { defineAs: 'register' });
        } else {
          const desc = Object.getOwnPropertyDescriptor(swProto, 'register') ||
                       { writable: true, configurable: true, enumerable: false };
          Object.defineProperty(swProto, 'register', {
            value: protoRegisterProxy,
            writable: desc.writable !== false,
            configurable: desc.configurable !== false,
            enumerable: !!desc.enumerable
          });
        }
      } catch (e) {
        console.debug('[Ψ-Ghost] prototype hook failed:', e);
      }
    }
  }

  // === PURGE-ON-LOAD (bugbugnow.net technique) ===
  //
  // Blocking new registrations is not enough: previously registered workers
  // keep running and keep their caches. Unregister them and clear
  // CacheStorage — only when registrations existed (article spec).

  async function purgeExistingWorkers() {
    if (!realSW) return false;
    try {
      const regs = await realSW.getRegistrations();
      if (!Array.isArray(regs) || regs.length === 0) return false;
      await win.Promise.all(regs.map((r) => r.unregister()));
      if (realCaches) {
        const keys = await realCaches.keys();
        await win.Promise.all(keys.map((k) => realCaches.delete(k)));
      }
      stats.purged += regs.length;
      return true;
    } catch (e) {
      console.debug('[Ψ-Ghost] purge failed:', e);
      return false;
    }
  }

  // === WEBSOCKET PHANTOM (Proxy construct trap, native-faithful denial) ===
  //
  // Allowed connections pass through untouched (100% native objects — zero
  // detection surface). Denied connections resolve into buffered phantom
  // sockets: CONNECTING state, live property surface, native-faithful
  // error/close events at the 40 ms cadence — never a rejection.

  function makePhantomWebSocket(url, protocols) {
    const phantom = Object.create(OrigWebSocket.prototype);
    let state = 0;
    let sendBuffer = [];
    let closeRequested = false;
    const eventBuffer = [];
    const pendingOn = {};
    let storedBinaryType = 'blob';

    Object.defineProperty(phantom, 'url', { value: url, configurable: true, enumerable: true });
    Object.defineProperty(phantom, 'readyState', {
      configurable: true, enumerable: true,
      get() { return state; }
    });
    Object.defineProperty(phantom, 'protocol', {
      configurable: true, enumerable: true,
      get() { return state === 1 ? String(protocols || '').split(',')[0] || '' : ''; }
    });
    Object.defineProperty(phantom, 'extensions', {
      configurable: true, enumerable: true,
      get() { return ''; }
    });
    Object.defineProperty(phantom, 'bufferedAmount', {
      configurable: true, enumerable: true,
      get() { return sendBuffer.length; }
    });
    Object.defineProperty(phantom, 'binaryType', {
      configurable: true, enumerable: true,
      get() { return storedBinaryType; },
      set(v) { storedBinaryType = v; }
    });

    ['open', 'message', 'error', 'close'].forEach((name) => {
      const key = 'on' + name;
      Object.defineProperty(phantom, key, {
        configurable: true, enumerable: true,
        get() { return pendingOn[name]; },
        set(fn) { pendingOn[name] = fn; }
      });
    });

    phantom.send = function (data) {
      if (state === 0) {
        sendBuffer.push(data); // native CONNECTING semantics: buffer the frame
        return;
      }
      throw new win.DOMException('WebSocket is already in CLOSING or CLOSED state.', 'InvalidStateError');
    };

    phantom.close = function () {
      closeRequested = true;
      if (state === 0) state = 2; // CLOSING, then the cadence timer settles CLOSED
    };

    phantom.addEventListener = function (type, listener, options) {
      eventBuffer.push({ type: type, listener: listener, options: options });
    };

    phantom.removeEventListener = function (type, listener) {
      const idx = eventBuffer.findIndex((e) => e.type === type && e.listener === listener);
      if (idx !== -1) eventBuffer.splice(idx, 1);
    };

    phantom.dispatchEvent = function (ev) {
      eventBuffer.forEach((e) => {
        if (e.type === ev.type && typeof e.listener === 'function') {
          try { e.listener.call(phantom, ev); }
          catch (err) { console.debug('[Ψ-Ghost] ws listener error:', err); }
        }
      });
      return true;
    };

    // Denied-event cadence: handshake "fails" after 40 ms — error (unless the
    // page already called close(), which natively yields close-only), then close.
    setTimeout(() => {
      state = 3;
      try {
        if (!closeRequested) {
          if (typeof phantom.onerror === 'function') phantom.onerror(new win.Event('error'));
          eventBuffer.forEach((e) => {
            if (e.type === 'error' && typeof e.listener === 'function') {
              try { e.listener.call(phantom, new win.Event('error')); }
              catch (err) { console.debug('[Ψ-Ghost] ws listener error:', err); }
            }
          });
        }
        const closeEv = new win.CloseEvent('close');
        if (typeof phantom.onclose === 'function') phantom.onclose(closeEv);
        eventBuffer.forEach((e) => {
          if (e.type === 'close' && typeof e.listener === 'function') {
            try { e.listener.call(phantom, closeEv); }
            catch (err) { console.debug('[Ψ-Ghost] ws listener error:', err); }
          }
        });
        sendBuffer = [];
      } catch (e) {
        console.debug('[Ψ-Ghost] denied-event cadence failed:', e);
      }
    }, GATE_DENY_EVENT_MS);

    return phantom;
  }

  function installWebSocketGate() {
    if (!OrigWebSocket) return;

    const wsProxy = new Proxy(OrigWebSocket, {
      construct(target, args) {
        const url = args[0];
        const protocols = args[1];

        // Extension governs this page — become a transparent conduit so the
        // extension's Gatekeeper (layered above or below us) runs exactly once.
        if (extensionActive()) {
          return (protocols === undefined || protocols === null)
            ? Reflect.construct(target, [url])
            : Reflect.construct(target, [url, protocols]);
        }

        // DDoS-Guard fast path (baseline auto-allow, full four-pattern check).
        if (isDDoSGuardChallenge(url)) {
          return (protocols === undefined || protocols === null)
            ? Reflect.construct(target, [url])
            : Reflect.construct(target, [url, protocols]);
        }

        const verdict = decide(url);
        if (verdict.allow) {
          return (protocols === undefined || protocols === null)
            ? Reflect.construct(target, [url])
            : Reflect.construct(target, [url, protocols]);
        }

        stats.ws += 1;
        notifyDeny('WebSocket', url);
        return makePhantomWebSocket(url, protocols);
      },
      apply() {
        // Native classes throw when invoked without `new` — mirror that.
        throw new win.TypeError("Failed to construct 'WebSocket': Please use the 'new' operator");
      }
    });

    try {
      Object.defineProperty(win, 'WebSocket', {
        value: wsProxy,
        writable: true,
        configurable: true,
        enumerable: true
      });
      // Static constants (CONNECTING/OPEN/CLOSING/CLOSED), name, length and
      // toString() forward to the native constructor through the Proxy. The
      // constructor back-reference is the only aliasing needed.
      win.WebSocket.prototype.constructor = win.WebSocket;
    } catch (e) {
      console.debug('[Ψ-Ghost] WebSocket hook failed:', e);
    }
  }

  // === SHAREDWORKER GATEKEEPER (coherent allow/deny) ===

  function installSharedWorkerGate() {
    if (!realShared) return;

    const sharedProxy = new Proxy(realShared, {
      construct(target, args) {
        const scriptURL = args[0];
        if (extensionActive()) return Reflect.construct(target, args);
        const verdict = decide(scriptURL);
        if (verdict.allow) return Reflect.construct(target, args);
        stats.shared += 1;
        notifyDeny('SharedWorker', scriptURL);
        throw new win.DOMException('SharedWorker disabled by Ghost Protocol', 'SecurityError');
      }
    });

    try {
      Object.defineProperty(win, 'SharedWorker', {
        configurable: true,
        enumerable: true,
        get: () => sharedProxy,
        set: () => false
      });
    } catch (e) {
      console.debug('[Ψ-Ghost] SharedWorker hook failed:', e);
    }
  }

  // === CSP VIOLATION LISTENER (worker-directed violations) ===

  function installCSPListener() {
    if (extensionActive()) return; // the extension already emits its own
    try {
      document.addEventListener('securitypolicyviolation', (e) => {
        const directive = e.violatedDirective || '';
        if (directive.includes('worker') || directive.includes('service-worker')) {
          stats.sw += 1;
          notifyDeny('CSP worker', e.blockedURI || 'unknown');
        }
      });
    } catch (e) {
      console.debug('[Ψ-Ghost] CSP listener failed:', e);
    }
  }

  // === LIST MANAGEMENT (mutual exclusion on single-domain adds) ===

  function currentDomain() {
    return normalizeDomain(win.location.hostname);
  }

  function addToWhitelist(domain) {
    const clean = normalizeDomain(domain);
    if (!clean) return false;
    let changed = false;
    if (!whitelist.includes(clean)) { whitelist.push(clean); changed = true; }
    const blIdx = blacklist.indexOf(clean);
    if (blIdx !== -1) { blacklist.splice(blIdx, 1); changed = true; }
    if (changed) {
      persistWhitelist();
      persistBlacklist();
      try {
        if (typeof GM_notification === 'function') {
          GM_notification({ title: 'Ψ Ghost Protocol', text: 'Whitelisted: ' + clean, timeout: 3000 });
        }
      } catch (e) { /* best-effort */ }
    }
    return changed;
  }

  function addToBlacklist(domain) {
    const clean = normalizeDomain(domain);
    if (!clean) return false;
    let changed = false;
    if (!blacklist.includes(clean)) { blacklist.push(clean); changed = true; }
    const wlIdx = whitelist.indexOf(clean);
    if (wlIdx !== -1) { whitelist.splice(wlIdx, 1); changed = true; }
    if (changed) {
      persistBlacklist();
      persistWhitelist();
      try {
        if (typeof GM_notification === 'function') {
          GM_notification({ title: 'Ψ Ghost Protocol', text: 'Blacklisted: ' + clean, timeout: 3000 });
        }
      } catch (e) { /* best-effort */ }
    }
    return changed;
  }

  function removeFromLists(domain) {
    const clean = normalizeDomain(domain);
    const wlIdx = whitelist.indexOf(clean);
    const blIdx = blacklist.indexOf(clean);
    if (wlIdx !== -1) whitelist.splice(wlIdx, 1);
    if (blIdx !== -1) blacklist.splice(blIdx, 1);
    if (wlIdx !== -1 || blIdx !== -1) {
      persistWhitelist();
      persistBlacklist();
      return true;
    }
    return false;
  }

  // Baseline UX preserved: prompt()/confirm() dialogs for list editing.
  function editList(kind) {
    const isWhitelistKind = kind === 'whitelist';
    const current = (isWhitelistKind ? whitelist : blacklist).join('\n');
    const input = win.prompt(
      isWhitelistKind
        ? 'Whitelist (one domain per line) — explicit allowance:'
        : 'Blacklist (one domain per line) — absolute prohibition:',
      current
    );
    if (input === null) return;
    const lines = input.split('\n').map((l) => normalizeDomain(l)).filter(Boolean);
    if (isWhitelistKind) {
      whitelist = Array.from(new Set(lines));
      persistWhitelist();
    } else {
      blacklist = Array.from(new Set(lines));
      persistBlacklist();
    }
    try {
      if (typeof GM_notification === 'function') {
        GM_notification({ title: 'Ψ Ghost Protocol', text: (isWhitelistKind ? 'Whitelist' : 'Blacklist') + ' updated', timeout: 3000 });
      }
    } catch (e) { /* best-effort */ }
  }

  function clearList(kind) {
    const isWhitelistKind = kind === 'whitelist';
    const ok = win.confirm(
      isWhitelistKind
        ? 'Clear the entire whitelist? All origins fall back to default-deny.'
        : 'Clear the entire blacklist? Blacklisted origins return to normal gating.'
    );
    if (!ok) return;
    if (isWhitelistKind) { whitelist = []; persistWhitelist(); }
    else { blacklist = []; persistBlacklist(); }
    try {
      if (typeof GM_notification === 'function') {
        GM_notification({ title: 'Ψ Ghost Protocol', text: (isWhitelistKind ? 'Whitelist' : 'Blacklist') + ' cleared', timeout: 3000 });
      }
    } catch (e) { /* best-effort */ }
  }

  function setEnabled(next) {
    enabled = next !== false;
    GM_setValue(ENABLED_KEY, enabled);
    try {
      if (typeof GM_notification === 'function') {
        GM_notification({
          title: 'Ψ Ghost Protocol',
          text: enabled ? 'ACTIVE — default deny' : 'DISABLED — pass-through (reload pages)',
          timeout: 3000
        });
      }
    } catch (e) { /* best-effort */ }
  }

  // === STATUS HUD (3lectric-Glass paradigm, shadow-DOM isolated) ===
  //
  // Manual-invocation control surface (menu command) — zero passive DOM
  // footprint while closed, so the stealth doctrine is preserved. All styles
  // live inside a closed shadow root: the page's CSS can neither leak in nor
  // be polluted. No remote font fetches; local font stacks only.

  const HUD_HOST_ID = '__4ndr0guard_hud_host';
  let hudOpen = false;
  let hudController = null; // listener lifecycle — aborted on close (D4)

  function hudGlyphSvg() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 128 128');
    svg.setAttribute('class', 'glyph');
    const ring1 = document.createElementNS(NS, 'path');
    ring1.setAttribute('d', 'M 64,12 A 52,52 0 1 1 63.9,12 Z');
    ring1.setAttribute('stroke-dasharray', '21.78 21.78');
    ring1.setAttribute('stroke-width', '2');
    ring1.setAttribute('class', 'glyph-ring-1');
    const ring2 = document.createElementNS(NS, 'path');
    ring2.setAttribute('d', 'M 64,20 A 44,44 0 1 1 63.9,20 Z');
    ring2.setAttribute('stroke-dasharray', '10 10');
    ring2.setAttribute('stroke-width', '1.5');
    ring2.setAttribute('opacity', '0.7');
    const hex = document.createElementNS(NS, 'path');
    hex.setAttribute('d', 'M64 30 L91.3 47 L91.3 81 L64 98 L36.7 81 L36.7 47 Z');
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', '64');
    text.setAttribute('y', '67');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'middle');
    text.setAttribute('font-size', '56');
    text.setAttribute('font-weight', '700');
    text.setAttribute('font-family', "'Cinzel Decorative', serif");
    text.textContent = 'Ψ';
    svg.appendChild(ring1);
    svg.appendChild(ring2);
    svg.appendChild(hex);
    svg.appendChild(text);
    return svg;
  }

  function hudStyle() {
    const style = document.createElement('style');
    style.textContent = [
      ':host { all: initial; }',
      '* { box-sizing: border-box; font-family: "JetBrains Mono", "Fira Mono", ui-monospace, monospace; }',
      '.panel { position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;',
      '  width: 300px; padding: 0 0 12px 0; background: rgba(10, 19, 26, 0.65);',
      '  border: 1px solid rgba(0, 229, 255, 0.3); border-radius: 4px;',
      '  box-shadow: 0 0 20px rgba(0, 229, 255, 0.15);',
      '  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);',
      '  color: #00E5FF; font-size: 12px; }',
      '.header { display: flex; align-items: center; gap: 10px; padding: 10px;',
      '  background: rgba(10, 19, 26, 0.95); border-bottom: 2px solid #00E5FF;',
      '  border-radius: 4px 4px 0 0; }',
      '.glyph { width: 34px; height: 34px; flex-shrink: 0; stroke: #00E5FF;',
      '  fill: none; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }',
      '.glyph text { fill: #00E5FF; }',
      '.title { font-family: "Orbitron", "JetBrains Mono", sans-serif;',
      '  font-size: 13px; font-weight: 700; color: #67E8F9; letter-spacing: 1px; }',
      '.subtitle { font-size: 9px; color: rgba(0, 229, 255, 0.7); letter-spacing: 2px; margin-top: 2px; }',
      '.body { padding: 12px 12px 0 12px; }',
      '.row { display: flex; justify-content: space-between; gap: 8px;',
      '  padding: 3px 0; font-size: 11px; }',
      '.row .k { color: rgba(0, 229, 255, 0.7); text-transform: uppercase; letter-spacing: 1px; font-size: 10px; }',
      '.row .v { color: #67E8F9; text-align: right; word-break: break-all; }',
      '.row .v.destructive { color: #ff0055; }',
      '.note { margin: 8px 0 0 0; font-size: 10px; line-height: 1.5;',
      '  color: rgba(0, 229, 255, 0.7); }',
      '.actions { display: flex; gap: 6px; padding: 12px 12px 0 12px; }',
      '.actions button { flex: 1; padding: 8px 6px; background: rgba(10, 19, 26, 0.65);',
      '  border: 1px solid rgba(0, 229, 255, 0.4); border-radius: 0; color: #00E5FF;',
      '  font-weight: bold; font-size: 10px; letter-spacing: 0.05em;',
      '  text-transform: uppercase; cursor: pointer; transition: all 150ms ease-in-out; }',
      '.actions button:hover { background: rgba(0, 229, 255, 0.2);',
      '  border-color: #00E5FF; box-shadow: 0 0 20px rgba(0, 229, 255, 0.5); color: #67E8F9; }',
      '.actions button:active { background: rgba(0, 229, 255, 0.3); color: #ffffff; }',
      '.actions button.destructive { border-color: #ff0055; color: #ff0055; }',
      '.actions button.destructive:hover { background: rgba(255, 0, 85, 0.3);',
      '  box-shadow: 0 0 25px #ff0055; color: #ffffff; }',
      '.actions button:disabled { opacity: 0.45; cursor: default; box-shadow: none; }'
    ].join('\n');
    return style;
  }

  function hudRow(label, value, destructive) {
    const row = document.createElement('div');
    row.className = 'row';
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = label;
    const v = document.createElement('span');
    v.className = 'v' + (destructive ? ' destructive' : '');
    v.textContent = value;
    row.appendChild(k);
    row.appendChild(v);
    return row;
  }

  function hudButton(label, destructive, onClick) {
    const btn = document.createElement('button');
    btn.textContent = label;
    if (destructive) btn.className = 'destructive';
    btn.addEventListener('click', onClick);
    return btn;
  }

  function closeHud() {
    const host = document.getElementById(HUD_HOST_ID);
    if (host && host.parentNode) host.parentNode.removeChild(host); // ruthless reclamation
    if (hudController) { hudController.abort(); hudController = null; }
    hudOpen = false;
  }

  function showHud() {
    if (hudOpen) { closeHud(); return; }
    if (!document.documentElement) return;
    hudOpen = true;

    const host = document.createElement('div');
    host.id = HUD_HOST_ID;
    const root = host.attachShadow({ mode: 'closed' });
    const panel = document.createElement('div');
    panel.className = 'panel';
    root.appendChild(hudStyle());
    root.appendChild(panel);

    // Header (spec 4.3)
    const header = document.createElement('div');
    header.className = 'header';
    header.appendChild(hudGlyphSvg());
    const headerText = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = 'GHOST PROTOCOL';
    const subtitle = document.createElement('div');
    subtitle.className = 'subtitle';
    subtitle.textContent = extensionOwnedAtInstall || extensionActive()
      ? 'EXTENSION-LINKED v7.2'
      : 'STANDALONE v7.2';
    headerText.appendChild(title);
    headerText.appendChild(subtitle);
    header.appendChild(headerText);
    panel.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'body';
    const domain = currentDomain() || '(no domain)';
    body.appendChild(hudRow('DOMAIN', domain));
    body.appendChild(hudRow('MODE', extensionOwnedAtInstall || extensionActive()
      ? 'Extension governs this page'
      : 'Local gate (this script)'));
    body.appendChild(hudRow('MASTER', enabled ? 'ACTIVE — DEFAULT DENY' : 'DISABLED — PASS-THROUGH', !enabled));
    const wlRow = hudRow('WHITELIST', String(whitelist.length) + ' domain(s)');
    body.appendChild(wlRow);
    body.appendChild(hudRow('BLACKLIST', String(blacklist.length) + ' domain(s)', blacklist.length > 0));
    body.appendChild(hudRow('SESSION', 'SW ' + stats.sw + ' · WS ' + stats.ws + ' · SHR ' + stats.shared + ' · PURGED ' + stats.purged));
    panel.appendChild(body);

    if (extensionOwnedAtInstall || extensionActive()) {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = 'The 4ndr0serviceguard extension is active on this page — its Gatekeeper owns enforcement. This script stands down to avoid double gating. Local lists below apply on pages where the extension is absent.';
      panel.appendChild(note);
    }

    // Actions
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.appendChild(hudButton('WHITELIST DOMAIN', false, () => {
      addToWhitelist(currentDomain());
      closeHud();
      showHud(); // re-render with fresh state
    }));
    actions.appendChild(hudButton('BLACKLIST DOMAIN', true, () => {
      addToBlacklist(currentDomain());
      closeHud();
      showHud();
    }));
    panel.appendChild(actions);

    const actions2 = document.createElement('div');
    actions2.className = 'actions';
    const purgeBtn = hudButton('PURGE WORKERS', false, () => {
      purgeExistingWorkers().then((done) => {
        try {
          if (typeof GM_notification === 'function') {
            GM_notification({
              title: 'Ψ Ghost Protocol',
              text: done ? 'Service Workers purged, caches cleared' : 'No registrations to purge',
              timeout: 3000
            });
          }
        } catch (e) { /* best-effort */ }
        closeHud();
        showHud();
      });
    });
    if (extensionOwnedAtInstall || extensionActive()) {
      purgeBtn.disabled = true;
      purgeBtn.title = 'The extension owns purge timing on this page';
    }
    actions2.appendChild(purgeBtn);
    actions2.appendChild(hudButton('CLOSE', false, () => closeHud()));
    panel.appendChild(actions2);

    document.documentElement.appendChild(host);

    // Escape closes; click outside closes. Both listeners are bound to a
    // per-session AbortController so closeHud() reclaims them completely.
    hudController = new AbortController();
    const onKey = (e) => { if (e.key === 'Escape') closeHud(); };
    const onOutside = (e) => {
      if (hudOpen && e.target !== host && !(host.contains && host.contains(e.target))) closeHud();
    };
    document.addEventListener('keydown', onKey, { signal: hudController.signal });
    document.addEventListener('click', onOutside, { capture: true, signal: hudController.signal });
  }

  // === MENU COMMANDS (top frame only — no iframe registration spam) ===

  function isTopFrame() {
    try { return win.top === win; } catch (e) { return false; }
  }

  function registerMenus() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    if (!isTopFrame()) return;

    GM_registerMenuCommand('Ψ Toggle Ghost Protocol (master)', () => setEnabled(!enabled));
    GM_registerMenuCommand('Whitelist current domain', () => {
      addToWhitelist(currentDomain());
    });
    GM_registerMenuCommand('Blacklist current domain', () => {
      addToBlacklist(currentDomain());
    });
    GM_registerMenuCommand('Remove current domain from lists', () => {
      removeFromLists(currentDomain());
    });
    GM_registerMenuCommand('Edit whitelist…', () => editList('whitelist'));
    GM_registerMenuCommand('Edit blacklist…', () => editList('blacklist'));
    GM_registerMenuCommand('Clear whitelist', () => clearList('whitelist'));
    GM_registerMenuCommand('Clear blacklist', () => clearList('blacklist'));
    GM_registerMenuCommand('Purge Service Workers now', () => {
      purgeExistingWorkers().then((done) => {
        try {
          if (typeof GM_notification === 'function') {
            GM_notification({
              title: 'Ψ Ghost Protocol',
              text: done ? 'Service Workers purged, caches cleared' : 'No registrations to purge',
              timeout: 3000
            });
          }
        } catch (e) { /* best-effort */ }
      });
    });
    GM_registerMenuCommand('Toggle deny notifications', () => {
      denyNotifications = !denyNotifications;
      GM_setValue(NOTIFY_KEY, denyNotifications);
      try {
        if (typeof GM_notification === 'function') {
          GM_notification({
            title: 'Ψ Ghost Protocol',
            text: denyNotifications ? 'Deny notifications ON' : 'Deny notifications OFF (stealth)',
            timeout: 3000
          });
        }
      } catch (e) { /* best-effort */ }
    });
    GM_registerMenuCommand('Show status HUD (Ψ)', () => showHud());
  }

  // === BOOTSTRAP ===

  registerMenus();

  if (extensionOwnedAtInstall) {
    // Companion mode: the extension installed first and owns every gate on
    // this page. Installing our own hooks here would layer a fake container
    // over the extension's and break its capture chain — stand down.
    console.debug('[Ψ-Ghost] Extension detected at install — utility mode (no hooks).');
    return;
  }

  installServiceWorkerGate();
  installWebSocketGate();
  installSharedWorkerGate();
  installCSPListener();

  // Purge-on-load: only when this origin is actively denied (the extension's
  // doctrine — purge requires the ghost to be active for the origin).
  if (!decide(pageOrigin).allow) {
    purgeExistingWorkers();
  }

})(typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);
