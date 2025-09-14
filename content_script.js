// The Infiltrator: Deploys the pacification protocol based on orders from the Cortex.

(function() {
    const safeStorageGet = (keys, callback) => {
        chrome.storage.local.get(keys, (result) => {
            if (chrome.runtime.lastError) {
                console.error('[Nullifier] Storage error:', chrome.runtime.lastError.message);
                callback({});
                return;
            }
            callback(result);
        });
    };

    const validateDomain = (domain) => {
        const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9](?:\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])*$/;
        return domainRegex.test(domain);
    };
    const isWhitelisted = (hostname, whitelist) => {
        // Validate hostname input
        if (!hostname || typeof hostname !== 'string') {
            return false;
        }
        
        const normalizedHostname = hostname.toLowerCase().trim();
        
        return whitelist.some(domain => {
            const cleanDomain = domain.toLowerCase().trim();
            
            // Skip empty or invalid domains
            if (!cleanDomain || cleanDomain.length === 0) {
                return false;
            }
            
            // Validate domain format using the validateDomain function
            if (!validateDomain(cleanDomain)) {
                console.warn(`[Nullifier] Invalid domain format in whitelist: ${cleanDomain}`);
                return false;
            }
            
            // Exact match
            if (normalizedHostname === cleanDomain) {
                return true;
            }
            
            // Subdomain match (e.g., sub.example.com matches example.com)
            if (normalizedHostname.endsWith('.' + cleanDomain)) {
                return true;
            }
            
            return false;
        });
    };

    const applyPacification = (whitelistStr) => {
        const whitelist = whitelistStr ? whitelistStr.split('\n').map(d => d.trim()).filter(Boolean) : [];
        const currentHostname = window.location.hostname;

        if (isWhitelisted(currentHostname, whitelist)) {
            console.log(`[Nullifier] Pacification bypassed for whitelisted domain: ${currentHostname}`);
            return;
        }

        if (navigator.serviceWorker) {
            // Override the register method to block service worker registration
            const originalRegister = navigator.serviceWorker.register;
            navigator.serviceWorker.register = (scriptURL, options) => {
                console.log(`[Nullifier] BLOCKED Service Worker registration: ${scriptURL}`);
                console.log(`[Nullifier] Options:`, options);
                
                // Return a rejected promise with detailed error
                return Promise.reject(new DOMException(
                    'Service Worker registration disabled by Nullifier Protocol.',
                    'SecurityError'
                ));
            };
            
            // Also block getRegistration and getRegistrations to be thorough
            navigator.serviceWorker.getRegistration = () => {
                console.log(`[Nullifier] BLOCKED Service Worker getRegistration`);
                return Promise.resolve(undefined);
            };
            
            navigator.serviceWorker.getRegistrations = () => {
                console.log(`[Nullifier] BLOCKED Service Worker getRegistrations`);
                return Promise.resolve([]);
            };
        }
    };

    // Only run in main frame for most cases
    if (window === window.top) {
        safeStorageGet(['isEnabled', 'whitelist'], (result) => {
            // Default to enabled if not explicitly disabled
            const isEnabled = result.isEnabled !== false;
            
            if (isEnabled) {
                applyPacification(result.whitelist || '');
            }
        });
    }
})();
