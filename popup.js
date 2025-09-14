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

    const validationMessage = document.getElementById('validationMessage');

    const validateDomains = (text) => {
        const domains = text.split('\n').map(d => d.trim()).filter(Boolean);
        const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9](?:\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])*$/;
        const invalidDomains = domains.filter(domain => !domainRegex.test(domain));

        if (invalidDomains.length > 0) {
            validationMessage.textContent = `Invalid domain(s): ${invalidDomains.join(', ')}`;
            return false;
        } else {
            validationMessage.textContent = '';
            return true;
        }
    };

    let saveTimeout;
    whitelist.addEventListener('input', () => {
        clearTimeout(saveTimeout);
        if (validateDomains(whitelist.value)) {
            saveTimeout = setTimeout(() => {
                chrome.storage.local.set({ whitelist: whitelist.value });
            }, 500);
        }
    });
});
