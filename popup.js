document.addEventListener('DOMContentLoaded', () => {
    const masterSwitch = document.getElementById('masterSwitch');
    const whitelist = document.getElementById('whitelist');

    // Load initial state from storage
    chrome.storage.local.get(['isEnabled', 'whitelist'], (result) => {
        masterSwitch.checked = result.isEnabled !== false; // Default to on
        whitelist.value = result.whitelist || '';
    });

    // Save state on change
    masterSwitch.addEventListener('change', () => {
        chrome.storage.local.set({ isEnabled: masterSwitch.checked });
    });

    whitelist.addEventListener('input', () => {
        chrome.storage.local.set({ whitelist: whitelist.value });
    });
});
