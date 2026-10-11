// ghost_core_v7.js — 4ndr0serviceguard Ghost Core v7.4 (MAIN world)
//
// Paradigm (D1): Proxy-based interception facade — single paradigm, no chimera.
//   navigator.serviceWorker                       → memoized phantom container
//   ServiceWorkerContainer.prototype.register     → toString-transparent Proxy
//   window.WebSocket / window.SharedWorker        → Proxy construct traps
//
// IPC: MAIN-world scripts have no chrome.* API access, so the Ghost Core talks
// to the background service worker through the externally_connectable runtime
// stub (chrome.runtime.sendMessage(extensionId, ...)). The extension ID is
// published into the DOM at document_start by ghost_bridge.js (ISOLATED world).
// If the channel is unavailable the core fails safe: default-deny.
//
// Superset contract over the v7.0 baseline (pacifier_v7.js) — every baseline
// guarantee preserved: default-deny policy, fake-registration stealth,
// DDoS-Guard WebSocket fast path, dual-layer SW hooking, CSP violation
// telemetry, WebSocket phantom buffering, SharedWorker SecurityError.
// New in v7.1 (bugbugnow.net techniques + gap closure):
//   - unregister of pre-existing Service Workers + CacheStorage clearing
//   - whitelist / master-toggle enforcement via a working IPC channel
//   - identity-stable container, functional event target, live WS forwarding
// v7.2.0: blacklist-aware ghost status. ghostStatus now also reports whether
//   the page origin is blacklisted; a blacklisted origin stays guarded even
//   when the master toggle is off or the origin is whitelisted (the blacklist
//   is an absolute prohibition — the background gate enforces the same order).
// v7.3.0: three-way action model. The gate now answers with an ACTION, not a
//   boolean: 'allow' (real connection), 'spoof' (pacify — the phantom socket
//   transitions CONNECTING→OPEN at the 40 ms cadence, fires a synthetic open,
//   then swallows every send() silently and honors close(): the page believes
//   it has a live socket and never nags or retries) or 'deny' (v7.2 behavior,
//   preserved verbatim: native-faithful error+close handshake failure at the
//   40 ms cadence). Service Workers pacify through the fake registration for
//   both 'spoof' and 'deny' (a fake registration IS the Service Worker
//   pacifier); SharedWorkers keep the baseline SecurityError for both.
//   ghostStatus additionally reports the spooflisted flag so a spooflisted
//   origin stays guarded (and purged) exactly like a blacklisted one.
// v7.4.0: sandboxed-frame resilience (console debrief 2026-10-09). Content
//   scripts run with all_frames:true, so this core also executes inside
//   sandboxed iframes (opaque origins), where reading navigator.serviceWorker
//   or window.caches THROWS SecurityError — the v7.3 core died inside its
//   top-level catch there and silently removed every gate from every
//   sandboxed frame. The capture block now reads privileged properties
//   defensively (safeGet): a sandboxed frame yields null references, the SW
//   surface is skipped (the sandbox itself already forbids SW registration
//   natively — nothing to pacify), while the WebSocket and SharedWorker gates
//   still install. The externally_connectable stub is absent in opaque-origin
//   frames, so interrogateGatekeeper fails safe to 'deny' — silent
//   default-deny phantom sockets, the doctrine, with zero console noise.
//   window._4ndr0ghostV7 is now set in sandboxed frames too, so the helper
//   userscript's single-gate deferral doctrine works there as well.

(function () {
  'use strict';

  try {

  if (window._4ndr0ghostV7) return;
  window._4ndr0ghostV7 = true;

  // === CAPTURED REAL REFERENCES (immune to later page tampering) ===
  // v7.4.0: privileged reads are defensive — sandboxed documents THROW
  // SecurityError on these getters (see header). safeGet() yields null on
  // refusal; the existing !realSW / !realCaches guards then skip exactly the
  // surfaces the sandbox already forbids natively, while the WebSocket and
  // SharedWorker gates below still install and enforce fail-safe deny.
  function safeGet(obj, prop) {
    try { const v = obj[prop]; return v === undefined ? null : v; }
    catch (e) { return null; } // sandboxed document / insecure context — fail safe
  }

  let sandboxedFrame = false;
  try { void document.cookie; } catch (e) { sandboxedFrame = true; }

  const realNav = navigator;
  const realSW = safeGet(realNav, 'serviceWorker'); // null on insecure origins AND sandboxed frames
  const realShared = safeGet(window, 'SharedWorker');
  const OrigWebSocket = safeGet(window, 'WebSocket');
  const realCaches = safeGet(window, 'caches');

  if (sandboxedFrame) {
    // One condensed debug-level notice (invisible at the default console
    // filter — stealth doctrine) instead of the v7.3 silent core death:
    // the frame is sandboxed, its SW APIs are natively unavailable, and the
    // WebSocket gate is armed with fail-safe deny.
    console.debug('[Ψ-Ghost] sandboxed frame (opaque origin) — SW API natively unavailable; WebSocket gate active, fail-safe deny.');
  }

  // Runtime stub captured at document_start — pages may shadow `chrome` later.
  const extRuntime = (typeof chrome !== 'undefined' && chrome && chrome.runtime &&
                      typeof chrome.runtime.sendMessage === 'function')
                     ? chrome.runtime : null;

  const noise = () => Math.random() < 0.12;
  const origin = window.location.origin;
  const GATE_TIMEOUT_MS = 120000; // last-resort auto-deny if the decision never settles
  const GATE_SPOOF_OPEN_MS = 40;  // v7.3.0: pacified sockets "open" at the v7 cadence

  function resolveExtId() {
    if (extRuntime && extRuntime.id) return extRuntime.id;
    const root = document.documentElement;
    if (root) {
      const v = root.getAttribute('data-4ndr0-ext');
      if (v) return v;
    }
    return null;
  }

  // === IPC LAYER ===
  function extSend(message) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
      try {
        if (!extRuntime) { finish(null); return; }
        const id = resolveExtId();
        if (!id) { finish(null); return; }
        const cb = (response) => {
          const err = extRuntime.lastError; // must be read to avoid unchecked-error noise
          finish(err ? null : (response === undefined ? null : response));
        };
        if (typeof extRuntime.getManifest === 'function') {
          // Internal-API context (isolated world / extension page): direct form.
          extRuntime.sendMessage(message, cb);
        } else {
          // Page-context externally_connectable stub: addressed form.
          extRuntime.sendMessage(id, message, cb);
        }
      } catch (e) {
        console.debug('[Ψ-Ghost] IPC failure:', e);
        finish(null);
      }
    });
  }

  // v7.3.0: the gatekeeper answers with an action. The v7.2 boolean shape is
  // still honored (allowed:true → 'allow', anything else → 'deny'), and a
  // dead channel or an unsettled decision fails safe to 'deny'.
  function interrogateGatekeeper(type, targetUrl) {
    let timer = null;
    const timeoutP = new Promise((resolve) => {
      timer = setTimeout(() => resolve('deny'), GATE_TIMEOUT_MS);
    });
    const askP = extSend({
      action: 'requestPermission',
      type: type,
      url: String(targetUrl || ''),
      pageOrigin: origin
    }).then((response) => {
      if (!response || typeof response !== 'object') return 'deny';
      if (response.action === 'spoof') return 'spoof';
      return response.allowed === true ? 'allow' : 'deny';
    });
    return Promise.race([askP, timeoutP]).then((action) => {
      if (timer) clearTimeout(timer);
      return action;
    });
  }

  // Deliberate interceptor (D6): telemetry must never break the host page.
  function emitBlockedAttempt(type, target, extra) {
    const msg = {
      action: 'swAttemptLog',
      type: String(type || 'Unknown'),
      target: String(target || 'unknown'),
      origin: origin,
      timestamp: Date.now(),
      allowed: !!(extra && extra.allowed === true),
      source: (extra && extra.source) || 'gate'
    };
    if (extra && extra.detail) msg.detail = String(extra.detail);
    extSend(msg);
  }

  function stealthLog(target, context) {
    emitBlockedAttempt(context, target);
  }

  // === DDoS-Guard FAST PATH (baseline heuristic, preserved verbatim) ===
  // 'pacifier_v5' matches DDoS-Guard's challenge script path, not a local file.
  function isDDoSGuardChallenge(url) {
    if (!url) return false;
    const u = url.toLowerCase();
    return u.includes('ddos-guard.net') ||
           u.includes('check.ddos-guard') ||
           u.includes('pacifier_v5') ||
           u.includes('/.well-known/ddos-guard/');
  }

  // === FUNCTIONAL EVENT TARGET (fixes dead addEventListener/dispatchEvent) ===
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
    try { return new URL(target, base || origin).href; }
    catch (e) { return String(target || (origin + '/service-worker-fake.js')); }
  }

  // === ENHANCED FAKE REGISTRATION (memoized, scope-aware, identity-stable) ===
  const fakeRegistrations = new Map();

  function createFakeRegistration(scriptURL, options) {
    const resolvedScript = resolveUrl(scriptURL, origin);
    const scope = (options && typeof options.scope === 'string')
      ? resolveUrl(options.scope, origin)
      : origin + '/';
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
        enable: () => Promise.resolve(),
        disable: () => Promise.resolve(),
        getState: () => Promise.resolve('disabled')
      },
      configurable: true,
      enumerable: true
    });
    defineOnHandler(registration, et, 'onupdatefound', 'updatefound');
    registration.addEventListener = et.addEventListener;
    registration.removeEventListener = et.removeEventListener;
    registration.dispatchEvent = et.dispatchEvent;
    registration.update = () => Promise.resolve(registration); // identity-stable across update()
    registration.unregister = () => Promise.resolve(true);

    fakeRegistrations.set(key, registration);
    return registration;
  }

  const defaultFakeRegistration = () => createFakeRegistration(origin + '/service-worker-fake.js');

  // === GHOST STATUS (master toggle + list enforcement, fail-safe active) ===
  let ghostActiveForOrigin = true;
  let sharedAllowed = false;

  // bugbugnow.net technique: unregister pre-existing Service Workers and clear
  // CacheStorage — blocking new registrations alone leaves registered workers
  // running. Cache clearing only fires when registrations existed (article spec).
  async function purgeExistingWorkers() {
    if (!realSW) return;
    try {
      const regs = await realSW.getRegistrations();
      if (!Array.isArray(regs) || regs.length === 0) return;
      await Promise.all(regs.map((r) => r.unregister()));
      if (realCaches) {
        const keys = await realCaches.keys();
        await Promise.all(keys.map((k) => realCaches.delete(k)));
      }
      emitBlockedAttempt('PURGE', origin, {
        source: 'purge',
        detail: regs.length + ' registration(s) removed, cache cleared'
      });
    } catch (e) {
      console.debug('[Ψ-Ghost] purge failed:', e);
    }
  }

  function initGhostStatus(attempt) {
    const n = attempt || 0;
    extSend({ action: 'ghostStatus', pageOrigin: origin }).then((status) => {
      if (status === null || status === undefined || typeof status !== 'object') {
        // Channel unavailable: bounded retry, then stay default-active (deny)
        // without destructive purge — purge requires positive confirmation.
        if (n < 12) setTimeout(() => initGhostStatus(n + 1), 50);
        return;
      }
      const enabled = status.active !== false;
      const whitelisted = status.whitelisted === true;
      // v7.2.0: blacklist is absolute — a blacklisted origin stays guarded
      // even when the master toggle is off or the origin is whitelisted.
      const blacklisted = status.blacklisted === true;
      // v7.3.0: spooflist is an equally explicit user decision — a spooflisted
      // origin stays guarded (workers purged, sockets pacified) even when the
      // master toggle is off or the origin is whitelisted.
      const spooflisted = status.spooflisted === true;
      ghostActiveForOrigin = (enabled && !whitelisted) || blacklisted || spooflisted;
      if (ghostActiveForOrigin) purgeExistingWorkers();
    });
  }

  // === SERVICE WORKER GATEKEEPER (dual-layer, Proxy-based) ===
  const swProto = (realSW && realSW.constructor && realSW.constructor.prototype) || null;
  const originalRegisterFn = (realSW && typeof realSW.register === 'function') ? realSW.register : null;

  async function gatedRegister(thisArg, scriptURL, options) {
    if (!ghostActiveForOrigin && originalRegisterFn) {
      // Pass-through: master toggle off or origin whitelisted.
      return originalRegisterFn.call(thisArg === fakeContainer ? realSW : thisArg, scriptURL, options);
    }
    const action = await interrogateGatekeeper('Service Worker', scriptURL);
    if (action === 'allow' && originalRegisterFn) {
      emitBlockedAttempt('Service Worker', scriptURL, { allowed: true, source: 'gate' });
      return originalRegisterFn.call(thisArg === fakeContainer ? realSW : thisArg, scriptURL, options);
    }
    // 'deny' AND 'spoof' resolve into the fake registration here — a
    // convincing no-op registration IS the Service Worker pacifier (v7.2
    // behavior, preserved); the actions differ only in telemetry source.
    emitBlockedAttempt('Service Worker', scriptURL, {
      allowed: false,
      source: action === 'spoof' ? 'spoof' : 'gate'
    });
    const fake = createFakeRegistration(scriptURL, options);
    setTimeout(() => {
      try {
        const ev = new Event('controllerchange');
        Object.defineProperty(ev, 'target', { value: fakeContainer });
        containerEt.dispatchEvent(ev);
      } catch (e) {
        console.debug('[Ψ-Ghost] controllerchange dispatch failed:', e);
      }
    }, 25);
    return fake;
  }

  // Identity-stable phantom container (native metadata fidelity).
  const fakeContainer = {};
  const containerEt = makeEventTarget(fakeContainer);
  tag(fakeContainer, 'ServiceWorkerContainer');
  // v7.2.0: constructor fidelity — native containers report
  // ServiceWorkerContainer as their constructor. Matching it removes an
  // identity-detection vector and keeps layered companions (the helper
  // userscript capturing the container second) from resolving the
  // container's prototype to Object.prototype.
  if (realSW && realSW.constructor) {
    Object.defineProperty(fakeContainer, 'constructor', {
      value: realSW.constructor,
      configurable: true,
      enumerable: false,
      writable: true
    });
  }
  let fakeReadyPromise = null;

  if (realSW) {
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
      if (!ghostActiveForOrigin) return realSW.getRegistration(scope);
      return Promise.resolve(undefined);
    };
    fakeContainer.getRegistrations = function () {
      if (!ghostActiveForOrigin) return realSW.getRegistrations();
      return Promise.resolve([]);
    };
    Object.defineProperty(fakeContainer, 'controller', {
      configurable: true,
      enumerable: true,
      get() { return ghostActiveForOrigin ? null : realSW.controller; }
    });
    Object.defineProperty(fakeContainer, 'ready', {
      configurable: true,
      enumerable: true,
      get() {
        if (!ghostActiveForOrigin) return realSW.ready;
        if (!fakeReadyPromise) fakeReadyPromise = Promise.resolve(defaultFakeRegistration());
        return fakeReadyPromise;
      }
    });
    fakeContainer.addEventListener = containerEt.addEventListener;
    fakeContainer.removeEventListener = containerEt.removeEventListener;
    fakeContainer.dispatchEvent = containerEt.dispatchEvent;
    defineOnHandler(fakeContainer, containerEt, 'oncontrollerchange', 'controllerchange');
    defineOnHandler(fakeContainer, containerEt, 'onmessage', 'message');
    fakeContainer.startMessages = function () {
      if (!ghostActiveForOrigin) realSW.startMessages();
    };

    // Primary hook: navigator.serviceWorker (memoized getter — identity stable).
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: noise(),
      enumerable: true,
      get: function () { return fakeContainer; },
      set: () => false
    });

    // Secondary hardening hook: prototype level (survives property restoration).
    if (swProto && originalRegisterFn) {
      const protoRegisterProxy = new Proxy(originalRegisterFn, {
        apply(target, thisArg, args) {
          if (thisArg === fakeContainer) return Reflect.apply(target, realSW, args);
          return gatedRegister(thisArg, args[0], args[1]);
        }
      });
      const desc = Object.getOwnPropertyDescriptor(swProto, 'register') ||
                   { writable: true, configurable: true, enumerable: false };
      Object.defineProperty(swProto, 'register', {
        value: protoRegisterProxy,
        writable: desc.writable !== false,
        configurable: desc.configurable !== false,
        enumerable: !!desc.enumerable
      });
    }
  }

  // === CSP VIOLATION LISTENER (baseline, preserved) ===
  document.addEventListener('securitypolicyviolation', (e) => {
    const directive = e.violatedDirective || '';
    if (directive.includes('worker') || directive.includes('service-worker')) {
      emitBlockedAttempt('CSP_VIOLATION', e.blockedURI || 'unknown');
    }
  });

  // === WEBSOCKET PHANTOM (Proxy construct trap + live property forwarding) ===
  if (OrigWebSocket) {

    function makePhantomWebSocket(url, protocols) {
      const phantom = Object.create(OrigWebSocket.prototype);
      let state = 0;
      let realWs = null;
      let sendBuffer = [];
      const eventBuffer = [];
      const pendingOn = {};
      let storedBinaryType = 'blob';
      let spoofOpen = false;      // v7.3.0: pacified sockets report OPEN forever
      let closeRequested = false; // v7.3.0: page-initiated close during pacified CONNECTING

      Object.defineProperty(phantom, 'url', { value: url, configurable: true, enumerable: true });
      Object.defineProperty(phantom, 'readyState', {
        configurable: true, enumerable: true,
        get() { return realWs ? realWs.readyState : state; }
      });
      Object.defineProperty(phantom, 'protocol', {
        configurable: true, enumerable: true,
        get() {
          if (realWs) return realWs.protocol;
          // v7.3.0: a pacified OPEN socket negotiates the first requested
          // subprotocol (or '' when none was requested) — native fidelity.
          if (spoofOpen) return String(protocols || '').split(',')[0] || '';
          return '';
        }
      });
      Object.defineProperty(phantom, 'extensions', {
        configurable: true, enumerable: true,
        get() { return realWs ? realWs.extensions : ''; }
      });
      Object.defineProperty(phantom, 'bufferedAmount', {
        configurable: true, enumerable: true,
        get() { return realWs ? realWs.bufferedAmount : (spoofOpen ? 0 : sendBuffer.length); }
      });
      Object.defineProperty(phantom, 'binaryType', {
        configurable: true, enumerable: true,
        get() { return realWs ? realWs.binaryType : storedBinaryType; },
        set(v) { storedBinaryType = v; if (realWs) realWs.binaryType = v; }
      });

      ['open', 'message', 'error', 'close'].forEach((name) => {
        const key = 'on' + name;
        Object.defineProperty(phantom, key, {
          configurable: true, enumerable: true,
          get() { return realWs ? realWs[key] : pendingOn[name]; },
          set(fn) {
            if (realWs) realWs[key] = fn;
            else pendingOn[name] = fn;
          }
        });
      });

      phantom.send = function (data) {
        if (realWs) {
          if (realWs.readyState === 1) realWs.send(data);
          else if (realWs.readyState === 0) sendBuffer.push(data);
          else throw new DOMException('WebSocket is already in CLOSING or CLOSED state.', 'InvalidStateError');
        } else if (spoofOpen) {
          // v7.3.0 pacifier: a native OPEN socket accepts sends — we swallow
          // them silently. bufferedAmount stays 0 (a healthy socket) so
          // backpressure-watching pages never panic or retry.
          return;
        } else if (state === 0) {
          sendBuffer.push(data);
        } else {
          throw new DOMException('WebSocket is already in CLOSING or CLOSED state.', 'InvalidStateError');
        }
      };

      phantom.close = function (code, reason) {
        if (realWs) {
          realWs.close(code, reason);
          return;
        }
        if (spoofOpen) {
          // v7.3.0: page-initiated closure of a pacified socket settles like
          // a normal endpoint closure (CLOSED + clean close event).
          spoofOpen = false;
          state = 3;
          setTimeout(() => {
            fireWsEvent('close', new CloseEvent('close', { code: 1000, reason: '', wasClean: true }));
          }, 0);
          return;
        }
        if (state === 0) {
          closeRequested = true;
          state = 2; // CLOSING — the pending cadence settles CLOSED
        } else {
          state = 3;
        }
      };

      phantom.addEventListener = function (type, listener, options) {
        if (realWs) realWs.addEventListener(type, listener, options);
        else eventBuffer.push({ type: type, listener: listener, options: options });
      };

      phantom.removeEventListener = function (type, listener, options) {
        if (realWs) realWs.removeEventListener(type, listener, options);
        else {
          const idx = eventBuffer.findIndex((e) => e.type === type && e.listener === listener);
          if (idx !== -1) eventBuffer.splice(idx, 1);
        }
      };

      phantom.dispatchEvent = function (ev) {
        if (realWs) return realWs.dispatchEvent(ev);
        eventBuffer.forEach((e) => {
          if (e.type === ev.type && typeof e.listener === 'function') {
            try { e.listener.call(phantom, ev); }
            catch (err) { console.debug('[Ψ-Ghost] ws listener error:', err); }
          }
        });
        return true;
      };

      // Synthetic event fan-out honoring both on-handlers and buffered
      // listeners (v7.3.0 — shared by the pacifier open/close paths).
      function fireWsEvent(name, ev) {
        try {
          const fn = pendingOn[name];
          if (typeof fn === 'function') fn.call(phantom, ev);
          eventBuffer.forEach((e) => {
            if (e.type === name && typeof e.listener === 'function') {
              try { e.listener.call(phantom, ev); }
              catch (err) { console.debug('[Ψ-Ghost] ws listener error:', err); }
            }
          });
        } catch (e) {
          console.debug('[Ψ-Ghost] ws synthetic event failed:', e);
        }
      }

      interrogateGatekeeper('WebSocket', url).then((action) => {
        if (action === 'allow') {
          emitBlockedAttempt('WebSocket', url, { allowed: true, source: 'gate' });
          realWs = (protocols === undefined || protocols === null)
            ? new OrigWebSocket(url)
            : new OrigWebSocket(url, protocols);
          realWs.binaryType = storedBinaryType;
          eventBuffer.forEach((e) => realWs.addEventListener(e.type, e.listener, e.options));
          eventBuffer.length = 0;
          ['open', 'message', 'error', 'close'].forEach((name) => {
            const fn = pendingOn[name];
            if (typeof fn === 'function') realWs['on' + name] = fn;
          });
          sendBuffer.forEach((d) => realWs.send(d));
          sendBuffer = [];
        } else if (action === 'spoof') {
          // v7.3.0 pacifier: the socket "completes its handshake" at the v7
          // cadence and stays OPEN forever. Nothing is ever sent; close() is
          // honored; no error is ever surfaced. Sites that merely want a live
          // socket keep working and never nag, retry or fall back.
          emitBlockedAttempt('WebSocket', url, { allowed: false, source: 'spoof' });
          setTimeout(() => {
            if (closeRequested || state === 3) return; // page closed mid-handshake
            state = 1;
            spoofOpen = true;
            sendBuffer = []; // the "handshake flush" — nothing was ever sent
            fireWsEvent('open', new Event('open'));
          }, GATE_SPOOF_OPEN_MS);
        } else {
          // v7.2 denial, preserved verbatim: native-faithful handshake
          // failure — error, then close, at the 40 ms cadence.
          emitBlockedAttempt('WebSocket', url, { allowed: false, source: 'gate' });
          state = 3;
          setTimeout(() => {
            if (typeof phantom.onerror === 'function') phantom.onerror(new Event('error'));
            if (typeof phantom.onclose === 'function') phantom.onclose(new CloseEvent('close'));
          }, 40);
        }
      });

      return phantom;
    }

    const wsProxy = new Proxy(OrigWebSocket, {
      construct(target, args) {
        const url = args[0];
        const protocols = args[1];
        if (isDDoSGuardChallenge(url)) {
          stealthLog(url, 'WebSocket:DDoSGuard_FastPath');
          return (protocols === undefined || protocols === null)
            ? Reflect.construct(target, [url])
            : Reflect.construct(target, [url, protocols]);
        }
        return makePhantomWebSocket(url, protocols);
      },
      apply() {
        // Native classes throw when invoked without `new` — mirror that.
        throw new TypeError("Failed to construct 'WebSocket': Please use the 'new' operator");
      }
    });

    window.WebSocket = wsProxy;
    // Static constants (CONNECTING/OPEN/CLOSING/CLOSED), name, length and
    // toString() forward to the native constructor through the Proxy.
    // NOTE: wsProxy.prototype already forwards to OrigWebSocket.prototype —
    // assigning .prototype on a class Proxy would throw (non-writable), so the
    // constructor back-reference below is the only aliasing needed.
    window.WebSocket.prototype.constructor = window.WebSocket;
  }

  // === SHAREDWORKER GATEKEEPER (coherent allow/deny with retry latch) ===
  // v7.3.0 note: SharedWorker pacification (a fake MessagePort surface) is
  // deliberately out of scope — both 'deny' and 'spoof' keep the baseline
  // SecurityError, which is the native-faithful refusal for SharedWorker.
  if (realShared) {
    const sharedProxy = new Proxy(realShared, {
      construct(target, args) {
        const scriptURL = args[0];
        if (!ghostActiveForOrigin || sharedAllowed) {
          return Reflect.construct(target, args);
        }
        emitBlockedAttempt('SharedWorker', scriptURL, { allowed: false, source: 'gate' });
        // Prompt is fired for future retries; this construction is denied
        // synchronously with the baseline SecurityError.
        interrogateGatekeeper('SharedWorker', scriptURL).then((action) => {
          if (action === 'allow') sharedAllowed = true;
        });
        throw new DOMException('SharedWorker disabled by Ghost Protocol', 'SecurityError');
      }
    });
    Object.defineProperty(window, 'SharedWorker', {
      configurable: noise(),
      enumerable: true,
      get: () => sharedProxy,
      set: () => false
    });
  }

  // === BOOTSTRAP ===
  initGhostStatus();

  } catch (e) {
    // Scoped interceptor: the Ghost Core must never break the host page.
    console.debug('[Ψ-Ghost] core initialization failed:', e);
  }
})();
