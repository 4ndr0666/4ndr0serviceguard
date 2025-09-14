// The Infiltrator: Deploys the pacification protocol based on orders from the Cortex.

(function() {
    const applyPacification = (whitelistStr) => {
        const whitelist = whitelistStr ? whitelistStr.split('\n').map(d => d.trim()).filter(Boolean) : [];
        const currentHostname = window.location.hostname;

        if (whitelist.some(domain => currentHostname.includes(domain))) {
            console.log(`[Nullifier] Pacification bypassed for whitelisted domain: ${currentHostname}`);
            return;
        }

        if (navigator.serviceWorker) {
            navigator.serviceWorker.register = (scriptURL, options) => {
                console.log(`[Nullifier] BLOCKED Service Worker registration: ${scriptURL}`);
                return Promise.reject(new Error('Service Worker registration disabled by Nullifier Protocol.'));
            };
        }
    };

    chrome.storage.local.get(['isEnabled', 'whitelist'], (result) => {
        if (result.isEnabled) {
            applyPacification(result.whitelist);
        }
    });
})();
