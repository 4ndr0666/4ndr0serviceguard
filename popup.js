// A simple utility to manage the validation message display.
const validationMessage = document.getElementById('validationMessage');
const showValidation = (message) => {
    validationMessage.textContent = message;
};

// A robust regex for domain validation. It's not perfect for all TLDs but covers the vast majority.
const isValidDomain = (domain) => {
    const domainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
    return domainRegex.test(domain);
};

// Main logic wrapped in an async IIFE (Immediately Invoked Function Expression) to allow top-level await.
(async () => {
    // Wait for the DOM to be fully loaded before manipulating it.
    await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve));

    const masterSwitch = document.getElementById('masterSwitch');
    const switchLabel = document.querySelector('.switch[role="switch"]');
    const whitelist = document.getElementById('whitelist');
    let saveTimeout;

    // Load initial state from storage using modern async/await.
    try {
        const data = await chrome.storage.local.get(['isEnabled', 'whitelist']);
        // Default to 'true' if isEnabled is not set.
        masterSwitch.checked = data.isEnabled !== false;
        switchLabel.setAttribute('aria-checked', masterSwitch.checked);
        whitelist.value = data.whitelist || '';
    } catch (error) {
        console.error('Error loading initial state:', error);
        showValidation('Error loading settings.');
    }

    // Save master switch state on change.
    masterSwitch.addEventListener('change', async () => {
        try {
            await chrome.storage.local.set({ isEnabled: masterSwitch.checked });
            switchLabel.setAttribute('aria-checked', masterSwitch.checked);
        } catch (error) {
            console.error('Error saving master switch state:', error);
            showValidation('Error saving setting.');
        }
    });

    // Validate and save whitelist on input, using a debounce timeout.
    whitelist.addEventListener('input', () => {
        clearTimeout(saveTimeout);
        const text = whitelist.value;
        const domains = text.split('\n').map(d => d.trim()).filter(Boolean);
        const invalidDomains = domains.filter(domain => !isValidDomain(domain));

        if (invalidDomains.length > 0) {
            showValidation(`Invalid domain(s): ${invalidDomains.join(', ')}`);
            return; // Don't save if validation fails.
        }
        
        showValidation(''); // Clear validation message if all are valid.

        // Debounce the save operation to avoid excessive writes to storage.
        saveTimeout = setTimeout(async () => {
            try {
                await chrome.storage.local.set({ whitelist: text });
            } catch (error) {
                console.error('Error saving whitelist:', error);
                showValidation('Error saving whitelist.');
            }
        }, 500); // 500ms delay
    });
})();
