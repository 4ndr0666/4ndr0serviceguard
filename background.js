// The Cortex: Manages the global state and deploys the Nullifier Protocol.
// Refactored to use async/await for modern, robust asynchronous operations.

const updateIcon = async (isEnabled) => {
    try {
        const path = isEnabled ? 'icons/icon48.png' : 'icons/disabled48.png';
        await chrome.action.setIcon({ path });
    } catch (error) {
        console.warn('Could not update icon:', error);
    }
};

const isValidDomain = (domain) => {
    // This regex is sufficient for cleaning stored data.
    const domainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
    return domainRegex.test(domain);
};

// Set initial state and perform cleanup on first install/update.
chrome.runtime.onInstalled.addListener(async () => {
    try {
        const result = await chrome.storage.local.get(['isEnabled', 'whitelist']);
        const toStore = {};
        let needsUpdate = false;

        // Set default enabled state to true if it's not defined.
        if (result.isEnabled === undefined) {
            toStore.isEnabled = true;
            needsUpdate = true;
        }

        const whitelistStr = result.whitelist || '';
        // Cleanse any invalid domains that might exist in storage.
        const domains = whitelistStr.split('\n').map(d => d.trim());
        const validDomains = domains.filter(domain => domain === '' || isValidDomain(domain));
        const cleanedWhitelist = validDomains.join('\n');

        // Update storage only if the whitelist was undefined or needed cleaning.
        if (result.whitelist === undefined || cleanedWhitelist !== whitelistStr) {
            toStore.whitelist = cleanedWhitelist;
            needsUpdate = true;
        }

        if (needsUpdate) {
            await chrome.storage.local.set(toStore);
        }

        // Initialize icon state based on stored or default settings.
        await updateIcon(toStore.isEnabled !== false);

    } catch (error) {
        console.error('Error during onInstalled event:', error);
    }
});

// Listen for storage changes to update the icon in real-time.
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.isEnabled) {
        updateIcon(changes.isEnabled.newValue);
    }
});

const isWhitelisted = (hostname, whitelist) => {
    const normalizedHostname = hostname.toLowerCase().trim();
    // Use .some for efficient iteration. It stops as soon as a match is found.
    return whitelist.some(domain => {
        const cleanDomain = domain.toLowerCase().trim();
        if (!cleanDomain) return false;
        // Check for exact match or subdomain match.
        return (normalizedHostname === cleanDomain || normalizedHostname.endsWith(`.${cleanDomain}`));
    });
};

// The logic for restoring Service Worker functionality on whitelisted domains.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    // Only proceed if the tab is loading and has a valid web URL.
    if (changeInfo.status !== 'loading' || !tab.url?.startsWith('http')) {
        return;
    }

    try {
        const data = await chrome.storage.local.get(['isEnabled', 'whitelist']);

        // Do not restore if the extension is disabled. The pacifier will remain active.
        if (data.isEnabled === false) {
            return;
        }

        const hostname = new URL(tab.url).hostname;
        const whitelist = (data.whitelist || '').split('\n').filter(Boolean);

        if (isWhitelisted(hostname, whitelist)) {
            // This domain is whitelisted. Inject the restorer script.
            await chrome.scripting.executeScript({
                target: { tabId: tabId, allFrames: true },
                world: 'MAIN', // Execute in the page's own context to access window.__SW_ORIGINALS__
                func: restoreServiceWorkers,
            });
        }
    } catch (err) {
        // This can happen if the tab is closed, navigated away, or is a restricted URL.
        // It's generally safe to ignore these errors as they are transient.
        if (!err.message.includes('No tab with id') && !err.message.includes('Cannot access')) {
            console.warn(`Could not process tab ${tabId} for ${tab.url}:`, err);
        }
    }
});

// This function is injected into whitelisted pages to restore the original Service Worker functionality.
// It must be self-contained and have no external dependencies.
function restoreServiceWorkers() {
    if (window.__SW_ORIGINALS__ && navigator.serviceWorker) {
        const swContainer = navigator.serviceWorker.constructor.prototype;
        // Use Object.defineProperties to precisely restore the original methods.
        Object.defineProperties(swContainer, {
            register: { value: window.__SW_ORIGINALS__.register, writable: true, configurable: true },
            getRegistration: { value: window.__SW_ORIGINALS__.getRegistration, writable: true, configurable: true },
            getRegistrations: { value: window.__SW_ORIGINALS__.getRegistrations, writable: true, configurable: true }
        });
        // Clean up the global scope after restoration.
        delete window.__SW_ORIGINALS__;
    }
}
