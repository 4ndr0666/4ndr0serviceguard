// 4ndr0serviceguard Pacifier – Dummy SW Layer v1.2.0
// Injected at document_start in MAIN world – owns navigator.serviceWorker

// Singleton lock
if (window._4ndr0serviceguardActive) return;
window._4ndr0serviceguardActive = true;

// Fake ServiceWorker objects
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
  ready = Promise.resolve();
};

const FakeWorker = class {
  constructor() { this.state = 'redundant'; }
  postMessage() { /* noop */ }
  terminate() { /* noop */ }
};

const FakeController = class {
  constructor() { this.scriptURL = '/sw.js'; }
};

// Jittered register (5% random fail + variable delay for realism)
const originalRegister = navigator.serviceWorker.register;
navigator.serviceWorker.register = (scriptURL, options) => {
  return new Promise((resolve, reject) => {
    const delay = 50 + Math.random() * 100; // 50-150ms mimic real load
    setTimeout(() => {
      if (Math.random() < 0.05) {
        reject(new Error('SW registration failed silently')); // Random fail for evasion tests
      } else {
        const fakeReg = new FakeRegistration();
        resolve(fakeReg);
      }
    }, delay);
  });
};

// Stub other APIs
navigator.serviceWorker.controller = null;
navigator.serviceWorker.getRegistrations = () => Promise.resolve([]);
navigator.serviceWorker.ready = Promise.resolve();
navigator.serviceWorker.oncontrollerchange = null;

// Block addEventListener on SW events
const originalAddEventListener = EventTarget.prototype.addEventListener;
EventTarget.prototype.addEventListener = function(type, listener, options) {
  if (type.startsWith('controller') || type === 'message') {
    return; // Silent noop
  }
  return originalAddEventListener.call(this, type, listener, options);
};

// Log block (send to background)
if (location.protocol !== 'chrome:' && location.hostname !== 'localhost') {
  navigator.serviceWorker.addEventListener('error', (e) => {
    chrome.runtime.sendMessage({ type: 'blockLog', domain: location.hostname });
  });
}
