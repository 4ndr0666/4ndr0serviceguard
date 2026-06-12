// 4ndr0serviceguard Content Script – Ghost Core v7 (Final)
// Superset of v6 — Prototype-level hook + CSP violation detection
// Production-ready | Final revision

(function () {
  'use strict';

  if (window._4ndr0ghostV7) return;
  window._4ndr0ghostV7 = true;

  const realNav = navigator;
  const realSW = realNav.serviceWorker;
  const realShared = window.SharedWorker || null;
  const OrigWebSocket = window.WebSocket;

  const noise = () => Math.random() < 0.12;
  const origin = window.location.origin;

  // === ENHANCED FAKE REGISTRATION ===
  const createFakeRegistration = (scriptURL = origin + '/service-worker-fake.js') => ({
    scope: origin + '/',
    scriptURL: scriptURL,
    installing: null,
    waiting: null,
    active: {
      state: 'activated',
      scriptURL: scriptURL,
      onstatechange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      postMessage: () => {}
    },
    unregister: () => Promise.resolve(true),
    update: () => Promise.resolve(createFakeRegistration(scriptURL)),
    onupdatefound: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    navigationPreload: {
      enable: () => Promise.resolve(),
      disable: () => Promise.resolve(),
      getState: () => Promise.resolve('disabled')
    }
  });

  function emitBlockedAttempt(type, target) {
    try {
      if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          action: 'swAttemptLog',
          type: type,
          target: target,
          origin: origin,
          timestamp: Date.now()
        });
      }
    } catch (_) {}
  }

  function stealthLog(target, context) {
    emitBlockedAttempt(context, target);
  }

  function interrogateGatekeeper(type, targetUrl) {
    return new Promise(resolve => {
      try {
        if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
          resolve(false);
          return;
        }
        chrome.runtime.sendMessage({
          action: 'requestPermission',
          type: type,
          url: targetUrl
        }, response => {
          if (chrome.runtime.lastError) {
            resolve(false);
            return;
          }
          resolve(!!(response && response.allowed));
        });
      } catch (e) {
        resolve(false);
      }
    });
  }

  // === DDoS-Guard FAST PATH ===
  function isDDoSGuardChallenge(url) {
    if (!url) return false;
    const u = url.toLowerCase();
    return u.includes('ddos-guard.net') ||
           u.includes('check.ddos-guard') ||
           u.includes('pacifier_v5') ||
           u.includes('/.well-known/ddos-guard/');
  }

  // === CSP VIOLATION LISTENER ===
  document.addEventListener('securitypolicyviolation', (e) => {
    const directive = e.violatedDirective || '';
    if (directive.includes('worker') || directive.includes('service-worker')) {
      emitBlockedAttempt('CSP_VIOLATION', e.blockedURI || 'unknown');
    }
  });

  // === WEBSOCKET PHANTOM ===
  if (OrigWebSocket) {
    const callWebSocket = OrigWebSocket.apply.bind(OrigWebSocket);

    window.WebSocket = function WebSocket(url, protocols) {
      if (!(this instanceof WebSocket)) {
        return callWebSocket(this, arguments);
      }

      if (isDDoSGuardChallenge(url)) {
        stealthLog(url, 'WebSocket:DDoSGuard_FastPath');
        return protocols ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
      }

      const phantom = this;
      phantom.url = url;
      phantom.readyState = 0;
      phantom.protocol = '';
      phantom.extensions = '';
      phantom.bufferedAmount = 0;
      phantom.binaryType = 'blob';

      let realWs = null;
      let sendBuffer = [];
      let eventBuffer = [];

      interrogateGatekeeper('WebSocket', url).then(allowed => {
        if (allowed) {
          realWs = protocols ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
          phantom.protocol = realWs.protocol;
          phantom.extensions = realWs.extensions;

          realWs.onopen = phantom.onopen;
          realWs.onmessage = phantom.onmessage;
          realWs.onerror = phantom.onerror;
          realWs.onclose = phantom.onclose;

          eventBuffer.forEach(ev => realWs.addEventListener(ev.type, ev.listener, ev.options));

          realWs.addEventListener('open', () => {
            phantom.readyState = 1;
            sendBuffer.forEach(d => realWs.send(d));
            sendBuffer = [];
          });
          realWs.addEventListener('close', () => phantom.readyState = 3);
          realWs.addEventListener('error', () => phantom.readyState = 3);
        } else {
          phantom.readyState = 3;
          setTimeout(() => {
            if (typeof phantom.onerror === 'function') phantom.onerror(new Event('error'));
            if (typeof phantom.onclose === 'function') phantom.onclose(new CloseEvent('close'));
          }, 40);
        }
      });

      phantom.send = function (data) {
        if (realWs && realWs.readyState === 1) realWs.send(data);
        else if (phantom.readyState === 0) sendBuffer.push(data);
        else throw new DOMException('WebSocket is already in CLOSING or CLOSED state.', 'InvalidStateError');
      };

      phantom.close = function (code, reason) {
        phantom.readyState = 2;
        if (realWs) realWs.close(code, reason);
        else phantom.readyState = 3;
      };

      phantom.addEventListener = function (type, listener, options) {
        if (realWs) realWs.addEventListener(type, listener, options);
        else eventBuffer.push({ type, listener, options });
      };

      return phantom;
    }.bind();

    window.WebSocket.prototype = OrigWebSocket.prototype;
    window.WebSocket.prototype.constructor = window.WebSocket;
  }

  // === SERVICE WORKER GATEKEEPER v7 (Dual Hook) ===

  // Primary hook via navigator.serviceWorker
  if (realSW) {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: noise(),
      enumerable: true,
      get: function () {
        return {
          register: async function (scriptURL, options) {
            const allowed = await interrogateGatekeeper('Service Worker', scriptURL);

            if (allowed) {
              return realSW.register.call(realSW, scriptURL, options);
            } else {
              const fake = createFakeRegistration(scriptURL);
              setTimeout(() => {
                try {
                  const ev = new Event('controllerchange');
                  Object.defineProperty(ev, 'target', { value: navigator.serviceWorker });
                  navigator.serviceWorker.dispatchEvent(ev);
                } catch (_) {}
              }, 25);
              return Promise.resolve(fake);
            }
          },
          getRegistration: () => Promise.resolve(undefined),
          getRegistrations: () => Promise.resolve([]),
          controller: null,
          ready: Promise.resolve(createFakeRegistration()),
          addEventListener: () => {},
          removeEventListener: () => {},
          oncontrollerchange: null,
          onmessage: null,
          startMessages: () => {}
        };
      },
      set: () => false
    });
  }

  // Secondary hardening hook via prototype (v7 addition)
  if (realSW && realSW.constructor && realSW.constructor.prototype) {
    const proto = realSW.constructor.prototype;
    const originalRegister = proto.register;

    if (typeof originalRegister === 'function') {
      proto.register = async function (scriptURL, options) {
        const allowed = await interrogateGatekeeper('Service Worker', scriptURL);

        if (allowed) {
          return originalRegister.call(this, scriptURL, options);
        } else {
          return Promise.resolve(createFakeRegistration(scriptURL));
        }
      };
    }
  }

  // === SHAREDWORKER GATEKEEPER ===
  if (realShared) {
    Object.defineProperty(window, 'SharedWorker', {
      configurable: noise(),
      enumerable: true,
      get: () => function (scriptURL) {
        interrogateGatekeeper('SharedWorker', scriptURL);
        throw new DOMException('SharedWorker disabled by Ghost Protocol', 'SecurityError');
      },
      set: () => false
    });
  }

})();
