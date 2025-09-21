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

// The Infiltrator content script runs on all pages at document_start, disabling
// service workers immediately. The logic below is responsible for *restoring*
// service worker functionality on whitelisted domains.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Not all updates have a URL.
    if (!tab.url || !tab.url.startsWith('http')) {
        return;
    }

    // Restore on 'loading' to minimize the time SWs are disabled on whitelisted sites.
    if (changeInfo.status === 'loading') {
        chrome.storage.local.get(['isEnabled', 'whitelist'], (result) => {
            if (chrome.runtime.lastError || result.isEnabled === false) {
                return; // Storage error or disabled, so SWs remain disabled.
            }

            const hostname = new URL(tab.url).hostname;
            const whitelist = (result.whitelist || '').split('\n').map(d => d.trim()).filter(Boolean);

            if (isWhitelisted(hostname, whitelist)) {
                // This domain is whitelisted. Inject the restorer.
                chrome.scripting.executeScript({
                    target: { tabId: tabId, allFrames: true },
                    world: 'MAIN', // Execute in the page's own context
                    func: restoreServiceWorkers,
                }).catch(err => {
                    // This can happen if the tab is closed or the context is invalidated.
                    if (!err.message.includes('Cannot access a chrome:// URL')) {
                        console.warn(`Could not inject restorer into ${hostname}:`, err);
                    }
                });
            }
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

// This function is injected into whitelisted pages to restore the original
// Service Worker functionality that was preserved by the Infiltrator.
function restoreServiceWorkers() {
    if (window.__SW_ORIGINALS__) {
        const swContainer = navigator.serviceWorker.constructor.prototype;
        Object.defineProperties(swContainer, {
            register: {
                value: window.__SW_ORIGINALS__.register,
                writable: true,
                configurable: true
            },
            getRegistration: {
                value: window.__SW_ORIGINALS__.getRegistration,
                writable: true,
                configurable: true
            },
            getRegistrations: {
                value: window.__SW_ORIGINALS__.getRegistrations,
                writable: true,
                configurable: true
            }
        });
        delete window.__SW_ORIGINALS__; // Clean up the window object
    }
}
