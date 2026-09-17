// ghost_core_v7.js — 4ndr0serviceguard Ghost Core v7.1 (MAIN world)
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

(function () {
  'use strict';

  try {

  if (window._4ndr0ghostV7) return;
  window._4ndr0ghostV7 = true;

  // === CAPTURED REAL REFERENCES (immune to later page tampering) ===
  const realNav = navigator;
  const realSW = realNav.serviceWorker || null;   // undefined on insecure origins (article: HTTP guard)
  const realShared = window.SharedWorker || null;
  const OrigWebSocket = window.WebSocket || null;
  const realCaches = window.caches || null;

  // Runtime stub captured at document_start — pages may shadow `chrome` later.
  const extRuntime = (typeof chrome !== 'undefined' && chrome && chrome.runtime &&
                      typeof chrome.runtime.sendMessage === 'function')
                     ? chrome.runtime : null;

  const noise = () => Math.random() < 0.12;
  const origin = window.location.origin;
  const GATE_TIMEOUT_MS = 120000; // last-resort auto-deny if the prompt never settles

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

  function interrogateGatekeeper(type, targetUrl) {
    let timer = null;
    const timeoutP = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), GATE_TIMEOUT_MS);
    });
    const askP = extSend({
      action: 'requestPermission',
      type: type,
      url: String(targetUrl || ''),
      pageOrigin: origin
    }).then((response) => !!(response && response.allowed));
    return Promise.race([askP, timeoutP]).then((allowed) => {
      if (timer) clearTimeout(timer);
      return allowed;
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

  // === GHOST STATUS (master toggle + whitelist enforcement, fail-safe active) ===
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
      ghostActiveForOrigin = enabled && !whitelisted;
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
    const allowed = await interrogateGatekeeper('Service Worker', scriptURL);
    if (allowed && originalRegisterFn) {
      emitBlockedAttempt('Service Worker', scriptURL, { allowed: true, source: 'gate' });
      return originalRegisterFn.call(thisArg === fakeContainer ? realSW : thisArg, scriptURL, options);
    }
    emitBlockedAttempt('Service Worker', scriptURL, { allowed: false, source: 'gate' });
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

      Object.defineProperty(phantom, 'url', { value: url, configurable: true, enumerable: true });
      Object.defineProperty(phantom, 'readyState', {
        configurable: true, enumerable: true,
        get() { return realWs ? realWs.readyState : state; }
      });
      Object.defineProperty(phantom, 'protocol', {
        configurable: true, enumerable: true,
        get() { return realWs ? realWs.protocol : ''; }
      });
      Object.defineProperty(phantom, 'extensions', {
        configurable: true, enumerable: true,
        get() { return realWs ? realWs.extensions : ''; }
      });
      Object.defineProperty(phantom, 'bufferedAmount', {
        configurable: true, enumerable: true,
        get() { return realWs ? realWs.bufferedAmount : sendBuffer.length; }
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
        } else if (state === 0) {
          sendBuffer.push(data);
        } else {
          throw new DOMException('WebSocket is already in CLOSING or CLOSED state.', 'InvalidStateError');
        }
      };

      phantom.close = function (code, reason) {
        if (realWs) realWs.close(code, reason);
        else state = 3;
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

      interrogateGatekeeper('WebSocket', url).then((allowed) => {
        if (allowed) {
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
        } else {
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
        interrogateGatekeeper('SharedWorker', scriptURL).then((allowed) => {
          if (allowed) sharedAllowed = true;
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
