// The Cortex: Manages the global state of the Nullifier Protocol.

// Set initial state and perform cleanup on first install/update
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get(['isEnabled', 'whitelist'], (result) => {
        const toStore = {};
        let needsUpdate = false;

        // Set default state if not present
        if (result.isEnabled === undefined) {
            toStore.isEnabled = true;
            needsUpdate = true;
        }

        // Validate and clean up existing whitelist
        const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9](?:\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])*$/;
        const whitelistStr = result.whitelist || '';
        const domains = whitelistStr.split('\n').map(d => d.trim());
        const validDomains = domains.filter(domain => domainRegex.test(domain) || domain === '');

        const cleanedWhitelist = validDomains.join('\n');

        // Only update storage if the whitelist has changed or is being initialized
        if (result.whitelist === undefined || cleanedWhitelist !== whitelistStr) {
            toStore.whitelist = cleanedWhitelist;
            needsUpdate = true;
        }

        if (needsUpdate) {
            chrome.storage.local.set(toStore);
        }

        // Set icon based on stored or default state
        updateIcon(result.isEnabled !== false);
    });
});

// Function to update the icon based on the enabled state
function updateIcon(isEnabled) {
    const path = isEnabled ? 'icons/icon48.png' : 'icons/disabled48.png';
    chrome.action.setIcon({ path: path });
}

// Listen for state changes from the popup and update the icon
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (changes.isEnabled) {
        updateIcon(changes.isEnabled.newValue);
    }
});
