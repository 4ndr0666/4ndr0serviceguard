// The Pacifier: Runs in the MAIN world to neutralize Service Workers.
// This script executes before other page scripts thanks to "run_at": "document_start".

// Preserve original methods for potential restoration by the background script.
if (navigator.serviceWorker && !window.__SW_ORIGINALS__) {
    window.__SW_ORIGINALS__ = {
        register: navigator.serviceWorker.constructor.prototype.register,
        getRegistration: navigator.serviceWorker.constructor.prototype.getRegistration,
        getRegistrations: navigator.serviceWorker.constructor.prototype.getRegistrations,
    };
}

// The Nullifier Protocol
if (navigator.serviceWorker) {
    const logPrefix = '[4ndr0serviceguard]';
    const swContainer = navigator.serviceWorker.constructor.prototype;

    Object.defineProperties(swContainer, {
        register: {
            value: function(scriptURL, options) {
                console.log(logPrefix, 'PACIFIED Service Worker registration (stealth-mode): ', scriptURL);
                // Deceive the caller by returning a resolved promise with a fake registration.
                return Promise.resolve({ scope: options?.scope || '/' });
            },
            writable: true,
            configurable: true
        },
        getRegistration: {
            value: function() {
                console.log(logPrefix, 'BLOCKED Service Worker getRegistration call.');
                return Promise.resolve(undefined);
            },
            writable: true,
            configurable: true
        },
        getRegistrations: {
            value: function() {
                console.log(logPrefix, 'BLOCKED Service Worker getRegistrations call.');
                return Promise.resolve([]);
            },
            writable: true,
            configurable: true
        }
    });
}
