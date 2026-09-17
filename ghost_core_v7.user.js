// ==UserScript==
// @name         4ndr0serviceguard — Ghost Core Companion
// @namespace    https://github.com/4ndr0666/4ndr0serviceguard
// @version      7.1.0
// @description  Stealth Service Worker firewall for userscript managers. Rejects new registrations by returning realistic fake registration objects, unregisters pre-existing Service Workers and clears CacheStorage. Techniques per https://www.bugbugnow.net/2020/03/Reject-to-register-a-ServiceWorker.html. Use the @exclude lines below as your whitelist.
// @author       4ndr0666
// @license      MIT
// @run-at       document-start
// @match        https://*/*
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @exclude      https://example.com/*
// @exclude      https://trusted-site.example/*
// @grant        unsafeWindow
// ==/UserScript==

// Whitelist operation: add @exclude lines above for every site that must keep
// real Service Worker functionality (the bugbugnow.net @exclude pattern).
// Scope note: this companion enforces Service Workers only. The extension
// build additionally gates WebSockets/SharedWorkers through its approval UI.

;(function (win) {
  'use strict';

  // Article guard: on plain-HTTP pages navigator.serviceWorker is undefined.
  let hasSW = false;
  try { hasSW = !!win.navigator.serviceWorker; } catch (e) { hasSW = false; }
  if (!hasSW) return;

  if (win.__4ndr0ghostUserV7) return;
  win.__4ndr0ghostUserV7 = true;

  const realSW = win.navigator.serviceWorker;
  const realCaches = (typeof caches !== 'undefined') ? caches : null;
  const origin = win.location.origin;

  // --- Stealth fake registration (self-contained; no extension IPC here) ---
  function makeEventTarget(owner) {
    const listeners = new Map();
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

  const fakeRegistrations = new Map();

  function resolveUrl(target, base) {
    try { return new win.URL(target, base || origin).href; }
    catch (e) { return String(target || (origin + '/service-worker-fake.js')); }
  }

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
    Object.defineProperty(activeWorker, 'state', { value: 'activated', configurable: true, enumerable: true });
    Object.defineProperty(activeWorker, 'scriptURL', { value: resolvedScript, configurable: true, enumerable: true });
    activeWorker.addEventListener = activeEt.addEventListener;
    activeWorker.removeEventListener = activeEt.removeEventListener;
    activeWorker.dispatchEvent = activeEt.dispatchEvent;
    activeWorker.postMessage = () => {};

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
    registration.addEventListener = et.addEventListener;
    registration.removeEventListener = et.removeEventListener;
    registration.dispatchEvent = et.dispatchEvent;
    registration.update = () => win.Promise.resolve(registration);
    registration.unregister = () => win.Promise.resolve(true);

    fakeRegistrations.set(key, registration);
    return registration;
  }

  // --- Proxy-based register replacement (article v0.3.0 technique) ---
  // The Proxy keeps toString()/name/length native, unlike a plain function
  // replacement. Stealth doctrine: resolve with a fake registration instead
  // of rejecting (rejecting is trivially detectable and breaks pages harder).
  const containerProto = realSW.constructor && realSW.constructor.prototype;
  const originalRegister = containerProto && containerProto.register;

  if (typeof originalRegister === 'function') {
    const gatedRegister = new Proxy(originalRegister, {
      apply(target, thisArg, args) {
        const fake = createFakeRegistration(args[0], args[1]);
        // Fire a controllerchange like a real (no-op) lifecycle transition.
        setTimeout(() => {
          try {
            const ev = new win.Event('controllerchange');
            Object.defineProperty(ev, 'target', { value: realSW });
            realSW.dispatchEvent(ev);
          } catch (e) { console.debug('[Ψ-Ghost] controllerchange failed:', e); }
        }, 25);
        return win.Promise.resolve(fake);
      }
    });

    let installed = false;
    try {
      if (typeof exportFunction === 'function') {
        // Greasemonkey Xray bridge (article v0.2.0 technique).
        exportFunction(gatedRegister, containerProto, { defineAs: 'register' });
        installed = true;
      }
    } catch (e) { console.debug('[Ψ-Ghost] exportFunction path failed:', e); }

    if (!installed) {
      try {
        Object.defineProperty(containerProto, 'register', {
          value: gatedRegister,
          writable: true,
          configurable: true,
          enumerable: false
        });
        installed = true;
      } catch (e) { console.debug('[Ψ-Ghost] prototype hook failed:', e); }
    }
  }

  // --- Unregister pre-existing Service Workers + clear CacheStorage (article) ---
  (async function purge() {
    try {
      const registrations = await realSW.getRegistrations();
      if (!Array.isArray(registrations) || registrations.length === 0) return;
      await win.Promise.all(registrations.map((r) => r.unregister()));
      if (realCaches) {
        const keys = await realCaches.keys();
        await win.Promise.all(keys.map((k) => realCaches.delete(k)));
      }
      console.debug('[Ψ-Ghost] purged', registrations.length, 'registration(s) and cleared cache');
    } catch (e) {
      console.debug('[Ψ-Ghost] purge failed:', e);
    }
  })();
})(typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);
