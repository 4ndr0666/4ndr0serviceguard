// 4ndr0serviceguard Pacifier – Dummy SW Layer v1.2.2
// Injected at document_start in MAIN world – owns navigator.serviceWorker

// Singleton lock – this is the ONLY line that can be at the very top
if (window._4ndr0serviceguardActive) {
  // Do absolutely nothing – just exit silently
} else {
  window._4ndr0serviceguardActive = true;

  // ────── Fake ServiceWorker objects ──────
  const FakeRegistration = class {
    constructor() {
      this.scope = '/';
      this.scriptURL = '/sw.js';
      this.installing = null;
      this.waiting = null;
      this.active = null;
    }
    update() { return Promise.resolve(); }
    unregister() { return Promise.resolve(true); }
  };

  const FakeWorker = class {
    constructor() { this.state = 'redundant'; }
    postMessage() { /* noop */ }
    terminate() { /* noop */ }
  };

  const FakeController = class {
    constructor() { this.scriptURL = '/sw.js'; }
  };

  // ────── Jittered register (5% random fail + variable delay) ──────
  navigator.serviceWorker.register = (scriptURL, options) => {
    return new Promise((resolve, reject) => {
      const delay = 50 + Math.random() * 100;
      setTimeout(() => {
        if (Math.random() < 0.05) {
          reject(new Error('SW registration failed silently'));
        } else {
          resolve(new FakeRegistration());
        }
      }, delay);
    });
  };

  // ────── Stub other APIs ──────
  navigator.serviceWorker.controller = null;
  navigator.serviceWorker.getRegistrations = () => Promise.resolve([]);
  navigator.serviceWorker.ready = Promise.resolve();
  navigator.serviceWorker.oncontrollerchange = null;

  // ────── Block addEventListener on SW events ──────
  const origAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type, listener, options) {
    if (type.startsWith('controller') || type === 'message') return;
    return origAdd.call(this, type, listener, options);
  };

  // ────── Log block to background (optional) ──────
  if (location.protocol !== 'chrome:' && location.hostname !== 'localhost') {
    navigator.serviceWorker.addEventListener?.('error', () => {
      chrome.runtime.sendMessage({ type: 'blockLog', domain: location.hostname });
    });
  }
}
