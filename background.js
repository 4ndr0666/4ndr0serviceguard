// The Cortex: Manages the global state of the Nullifier Protocol.

// Set initial state on first install
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get(['isEnabled', 'whitelist'], (result) => {
        const defaults = {};
        if (result.isEnabled === undefined) {
            defaults.isEnabled = true;
        }
        if (result.whitelist === undefined) {
            defaults.whitelist = '';
        }
        if (Object.keys(defaults).length > 0) {
            chrome.storage.local.set(defaults);
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
