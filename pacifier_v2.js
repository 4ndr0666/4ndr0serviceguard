// 4ndr0serviceguard Pacifier – Ghost Protocol v2.0.0
// Injected at document_start in MAIN world. Evades detection.

if (window._4ndr0serviceguardGhost) {
  // Already running. Do nothing.
} else {
  window._4ndr0serviceguardGhost = true;

  const REAL_SW = navigator.serviceWorker;

  // A more convincing fake registration
  const createDynamicMock = (realInstance) => {
    return new Proxy(realInstance, {
      get: (target, prop) => {
        if (prop === 'active' || prop === 'installing' || prop === 'waiting') {
          return null; // Always return null for worker states
        }
        if (typeof target[prop] === 'function') {
          return () => Promise.resolve(undefined); // Return undefined for all methods
        }
        return target[prop];
      },
    });
  };

  // The proxy that intercepts all ServiceWorker functionality
  const swProxy = new Proxy(REAL_SW, {
    get: (target, prop) => {
      // 1. Intercept registration attempts
      if (prop === 'register') {
        return () => new Promise((resolve, reject) => {
          const delay = 50 + Math.random() * 150; // Increased jitter
          setTimeout(() => {
            // More subtle rejection: mimic a real-world script error
            if (Math.random() < 0.03) {
              reject(new TypeError('Failed to fetch the script.'));
            } else {
              // Return a proxy of a fake registration
              resolve(createDynamicMock({
                scope: '/',
                scriptURL: '/sw.js'
              }));
            }
          }, delay);
        });
      }

      // 2. Return empty results for getters
      if (prop === 'getRegistration' || prop === 'getRegistrations') {
        return () => Promise.resolve(undefined);
      }

      // 3. Nullify the controller
      if (prop === 'controller') {
        return null;
      }
      
      // 4. Return a resolved promise for 'ready'
      if (prop === 'ready') {
          return Promise.resolve();
      }

      // 5. Block all event listener attachments
      if (prop === 'addEventListener') {
        return () => {}; // Silently discard all event listeners
      }

      // 6. Let other properties pass through (e.g. oncontrollerchange)
      if (prop in target) {
        return target[prop];
      }
      
      return undefined;
    },
  });

  // Overwrite the navigator.serviceWorker with our ghost
  Object.defineProperty(navigator, 'serviceWorker', {
    value: swProxy,
    writable: false,
    configurable: false,
  });
}
