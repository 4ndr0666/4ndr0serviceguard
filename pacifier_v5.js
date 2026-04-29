// 4ndr0serviceguard Content Script – Interactive Gatekeeper v5.1
// Patched for DDoS-Guard compatibility — WebSocket truce on challenge domains

(function () {
  'use strict';

  if (window._4ndr0ghostV5) return;
  window._4ndr0ghostV5 = true;

  const realNav = navigator;
  const realSW = realNav.serviceWorker;
  const realShared = window.SharedWorker || null;
  const OrigWebSocket = window.WebSocket;

  const noise = () => Math.random() < 0.15;
  const origin = window.location.origin;

  // Synthesized Fake Registration Object
  const fakeRegistration = {
    scope: origin + '/',
    scriptURL: origin + '/service-worker-fake.js',
    installing: null,
    waiting: null,
    active: {
      state: 'activated',
      scriptURL: origin + '/service-worker-fake.js',
      onstatechange: null,
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    unregister: () => Promise.resolve(true),
    update: () => Promise.resolve(),
    onupdatefound: null,
    addEventListener: () => {},
    removeEventListener: () => {}
  };

  function stealthLog(scriptURL, context) {
    try {
      chrome.runtime.sendMessage({ action: 'swAttemptLog', scriptURL: scriptURL, context: context });
    } catch (_) { }
  }

  // Gatekeeper IPC Dispatcher
  function interrogateGatekeeper(type, targetUrl) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ 
          action: 'requestPermission', 
          type: type, 
          url: targetUrl 
        }, response => {
          resolve(response && response.allowed);
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
           u.includes('pacifier_v5');
  }

  // --- GATEKEEPER: WEBSOCKET PHANTOM SOCKET (Patched) ---
  if (OrigWebSocket) {
    const callWebSocket = OrigWebSocket.apply.bind(OrigWebSocket);
    
    window.WebSocket = function WebSocket(url, protocols) {
      if (!(this instanceof WebSocket)) return callWebSocket(this, arguments);

      stealthLog(url, 'WebSocket:Init_Pending');

      // FAST PATH: Let DDoS-Guard WebSocket through without gatekeeping
      if (isDDoSGuardChallenge(url)) {
        stealthLog(url, 'WebSocket:DDoSGuard_FastPath_Allowed');
        const realWs = protocols ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
        return realWs;
      }

      // Original phantom logic for all other WebSockets
      const phantom = this;
      phantom.url = url;
      phantom.readyState = 0;

      let realWs = null;
      let sendBuffer = [];
      let eventBuffer = [];

      interrogateGatekeeper('WebSocket', url).then(allowed => {
        if (allowed) {
          stealthLog(url, 'WebSocket:Authorized');
          realWs = protocols ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
          
          realWs.onopen = phantom.onopen;
          realWs.onmessage = phantom.onmessage;
          realWs.onerror = phantom.onerror;
          realWs.onclose = phantom.onclose;
          
          eventBuffer.forEach(ev => realWs.addEventListener(ev.type, ev.listener, ev.options));
          
          realWs.addEventListener('open', () => {
            phantom.readyState = 1;
            sendBuffer.forEach(data => realWs.send(data));
            sendBuffer = [];
          });
          
          realWs.addEventListener('close', () => phantom.readyState = 3);
          realWs.addEventListener('error', () => phantom.readyState = 3);
          
        } else {
          stealthLog(url, 'WebSocket:Denied');
          phantom.readyState = 3;
          setTimeout(() => {
            if (typeof phantom.onerror === 'function') phantom.onerror(new Event('error'));
            if (typeof phantom.onclose === 'function') phantom.onclose(new CloseEvent('close'));
          }, 50);
        }
      });

      phantom.send = function(data) {
        if (realWs && realWs.readyState === 1) realWs.send(data);
        else if (phantom.readyState === 0) sendBuffer.push(data);
        else throw new DOMException('WebSocket is already in CLOSING or CLOSED state.');
      };

      phantom.close = function(code, reason) {
        phantom.readyState = 2;
        if (realWs) realWs.close(code, reason);
        else phantom.readyState = 3; 
      };

      phantom.addEventListener = function(type, listener, options) {
        if (realWs) realWs.addEventListener(type, listener, options);
        else eventBuffer.push({ type, listener, options });
      };

      return phantom;
    }.bind();
    
    window.WebSocket.prototype = OrigWebSocket.prototype;
    window.WebSocket.prototype.constructor = window.WebSocket;
  }

  // Service Worker and SharedWorker logic unchanged (kept original behavior)
  if (realSW) {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: noise(),
      enumerable: true,
      get: function () {
        return {
          register: async function (scriptURL, options) {
            stealthLog(scriptURL || 'unknown', 'ServiceWorker:Init_Pending');
            
            const allowed = await interrogateGatekeeper('Service Worker', scriptURL);
            
            if (allowed) {
              stealthLog(scriptURL, 'ServiceWorker:Authorized');
              return realSW.register.call(realSW, scriptURL, options);
            } else {
              stealthLog(scriptURL, 'ServiceWorker:Denied');
              return new Promise(resolve => {
                const delay = 40 + Math.random() * 160;
                setTimeout(() => {
                  resolve(fakeRegistration);
                  setTimeout(() => {
                    const ev = new Event('controllerchange');
                    Object.defineProperty(ev, 'target', { value: navigator.serviceWorker });
                    navigator.serviceWorker.dispatchEvent(ev);
                  }, 20);
                }, delay);
              });
            }
          },
          getRegistration: () => Promise.resolve(undefined),
          getRegistrations: () => Promise.resolve([]),
          controller: null,
          ready: new Promise(resolve => setTimeout(() => resolve(fakeRegistration), 100)),
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

  if (realShared) {
    Object.defineProperty(window, 'SharedWorker', {
      configurable: noise(),
      enumerable: true,
      get: () => function (scriptURL) {
        stealthLog(scriptURL || 'unknown', 'SharedWorker:Init_Pending');
        interrogateGatekeeper('SharedWorker', scriptURL);
        throw new DOMException('SharedWorker disabled by Interactive Gatekeeper policy', 'SecurityError');
      },
      set: () => false
    });
  }

})();
