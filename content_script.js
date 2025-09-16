// The Infiltrator: Deploys the pacification protocol based on orders from the Cortex.

(function() {
    // This function runs immediately in the isolated content script context.
    // Its job is to fetch the configuration and then inject the actual payload
    // into the page's own context to win any race conditions.

    chrome.storage.local.get(['isEnabled', 'whitelist'], (result) => {
        if (chrome.runtime.lastError) {
            console.error('[Nullifier] Storage error:', chrome.runtime.lastError.message);
            return;
        }

        const isEnabled = result.isEnabled !== false; // Default to true
        if (!isEnabled) {
            return; // Protocol is disabled, do nothing.
        }

        const whitelist = result.whitelist || '';

        // ## RT-ENHANCEMENT: Synchronous Script Injection ##
        // This is the core of the hardening. We create a script tag and inject it
        // directly into the page's DOM. This script runs in the page's own execution
        // context and executes synchronously, before any of the page's other scripts.
        // This eliminates the async race condition of waiting for storage.get().

        const injectionCode = `
            (() => {
                const whitelistStr = ${JSON.stringify(whitelist)};
                const whitelist = whitelistStr ? whitelistStr.split('\\n').map(d => d.trim()).filter(Boolean) : [];
                const currentHostname = window.location.hostname;

                const isWhitelisted = (hostname, list) => {
                    const normalizedHostname = hostname.toLowerCase().trim();
                    return list.some(domain => {
                        const cleanDomain = domain.toLowerCase().trim();
                        if (!cleanDomain) return false;
                        // Exact match or subdomain match
                        return (normalizedHostname === cleanDomain || normalizedHostname.endsWith('.' + cleanDomain));
                    });
                };

                if (isWhitelisted(currentHostname, whitelist)) {
                    // Log to console but do not interfere with whitelisted sites.
                    console.log('[Nullifier] Pacification bypassed for whitelisted domain: ' + currentHostname);
                    return;
                }

                if (navigator.serviceWorker) {
                    const logPrefix = '[Nullifier]';
                    // Override the methods on the prototype for maximum coverage
                    const swContainer = navigator.serviceWorker.constructor.prototype;

                    Object.defineProperties(swContainer, {
                        register: {
                            value: function(scriptURL, options) {
                                console.log(logPrefix, 'BLOCKED Service Worker registration:', scriptURL, 'Options:', options);
                                return Promise.reject(new DOMException('Service Worker registration disabled by Nullifier Protocol.', 'SecurityError'));
                            },
                            writable: false,
                            configurable: false
                        },
                        getRegistration: {
                            value: function() {
                                console.log(logPrefix, 'BLOCKED Service Worker getRegistration call.');
                                return Promise.resolve(undefined);
                            },
                            writable: false,
                            configurable: false
                        },
                        getRegistrations: {
                            value: function() {
                                console.log(logPrefix, 'BLOCKED Service Worker getRegistrations call.');
                                return Promise.resolve([]);
                            },
                            writable: false,
                            configurable: false
                        }
                    });
                }
            })();
        `;

        const script = document.createElement('script');
        script.textContent = injectionCode;
        // Append to documentElement to ensure it's added as early as possible.
        (document.head || document.documentElement).appendChild(script);
        // Clean up the script tag from the DOM after it has run.
        script.remove();
    });
})();
