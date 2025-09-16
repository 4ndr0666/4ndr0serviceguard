// The Cortex: Manages the global state and deploys the Nullifier Protocol.

// Set initial state and perform cleanup on first install/update
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get(['isEnabled', 'whitelist'], (result) => {
        const toStore = {};
        let needsUpdate = false;

        if (result.isEnabled === undefined) {
            toStore.isEnabled = true;
            needsUpdate = true;
        }

        const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9](?:\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])*$/;
        const whitelistStr = result.whitelist || '';
        const domains = whitelistStr.split('\n').map(d => d.trim());
        const validDomains = domains.filter(domain => domainRegex.test(domain) || domain === '');
        const cleanedWhitelist = validDomains.join('\n');

        if (result.whitelist === undefined || cleanedWhitelist !== whitelistStr) {
            toStore.whitelist = cleanedWhitelist;
            needsUpdate = true;
        }

        if (needsUpdate) {
            chrome.storage.local.set(toStore);
        }

        updateIcon(result.isEnabled !== false);
    });
});

function updateIcon(isEnabled) {
    const path = isEnabled ? 'icons/icon48.png' : 'icons/disabled48.png';
    chrome.action.setIcon({ path: path });
}

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (changes.isEnabled) {
        updateIcon(changes.isEnabled.newValue);
    }
});

// ## RT-ENHANCEMENT: Main injection logic moved to background script ##
// This uses the chrome.scripting API to bypass CSP restrictions on inline scripts.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Inject as early as possible
    if (changeInfo.status === 'loading') {
        chrome.storage.local.get(['isEnabled', 'whitelist'], (result) => {
            if (chrome.runtime.lastError || result.isEnabled === false) {
                return; // Storage error or disabled
            }

            const url = tab.url;
            if (!url || !url.startsWith('http')) {
                return; // Ignore non-web pages
            }
            
            const hostname = new URL(url).hostname;
            const whitelist = (result.whitelist || '').split('\n').map(d => d.trim()).filter(Boolean);

            if (isWhitelisted(hostname, whitelist)) {
                return; // Domain is whitelisted, do not inject.
            }

            chrome.scripting.executeScript({
                target: { tabId: tabId, allFrames: true },
                world: 'MAIN', // Execute in the page's own context
                func: pacifyServiceWorkers,
            });
        });
    }
});

function isWhitelisted(hostname, whitelist) {
    const normalizedHostname = hostname.toLowerCase().trim();
    return whitelist.some(domain => {
        const cleanDomain = domain.toLowerCase().trim();
        if (!cleanDomain) return false;
        return (normalizedHostname === cleanDomain || normalizedHostname.endsWith('.' + cleanDomain));
    });
}

// This function will be serialized and injected into the target page.
// It has no access to the extension's scope.
function pacifyServiceWorkers() {
    if (navigator.serviceWorker) {
        const logPrefix = '[Nullifier]';
        const swContainer = navigator.serviceWorker.constructor.prototype;

        // Use defineProperties to make the override more robust and less detectable.
        Object.defineProperties(swContainer, {
            register: {
                value: function(scriptURL, options) {
                    console.log(logPrefix, 'BLOCKED Service Worker registration:', scriptURL, 'Options:', options);
                    return Promise.reject(new DOMException('Service Worker registration disabled by Nullifier Protocol.', 'SecurityError'));
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
}
