// 4ndr0serviceguard Background Controller – Gatekeeper Synthesis v5.1
// Patched for DDoS-Guard compatibility — Auto-allow challenge domains

let whitelistCache = new Map();
let cacheExpiry = 0;
const CACHE_REFRESH_MS = 30000;
let blockLog = {};
const DEBOUNCE_MS = 250;

// Pending permission IPC Map
let pendingRequests = {};
let nextRequestId = 1;

/**
 * DDoS-Guard Challenge Detector
 */
function isDDoSGuardChallenge(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  return u.includes('ddos-guard.net') || 
         u.includes('check.ddos-guard') ||
         u.includes('pacifier_v5') ||
         u.includes('/.well-known/ddos-guard/');
}

/**
 * Throttles execution to prevent DOM update thrashing
 */
function debounce(fn, delay) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
}

/**
 * Strips Punycode/IDN for deterministic subdomain matching
 */
function normalizeDomain(domain) {
  return domain.toLowerCase().replace(/xn--/g, '');
}

/**
 * Loads and caches the operational whitelist
 */
async function getWhitelist() {
  const now = Date.now();
  if (now - cacheExpiry > CACHE_REFRESH_MS) {
    try {
      const result = await chrome.storage.sync.get(["whitelist"]);
      const lines = (result.whitelist || "").split("\n").map(l => l.trim().toLowerCase()).filter(Boolean);
      whitelistCache.clear();
      lines.forEach(line => whitelistCache.set(normalizeDomain(line), true));
      cacheExpiry = now;
    } catch (e) {
      console.error("[Ψ-Core] Whitelist sync failed:", e);
    }
  }
  return Array.from(whitelistCache.keys());
}

/**
 * Evaluates target url against the cached whitelist matrix
 */
async function isWhitelisted(url) {
  try {
    const domain = normalizeDomain(new URL(url).hostname);
    const lines = await getWhitelist();
    return lines.some(line => domain === line || domain.endsWith('.' + line));
  } catch (e) {
    return false; 
  }
}

/**
 * Records domain-level blockage into local telemetry storage
 */
async function logBlock(domain) {
  blockLog[domain] = (blockLog[domain] || 0) + 1;
  await chrome.storage.local.set({ swBlocks: blockLog });
}

/**
 * Restores functionality to whitelisted targets via dynamic payload injection
 */
const debouncedRestore = debounce(async (tabId, url) => {
  if (await isWhitelisted(url)) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['pacifier_v5.js']
      });
      console.log(`[Ψ-Core] Whitelist restore executed for tab: ${tabId}`);
    } catch (e) {
      console.error(`[Ψ-Core] Injection failed on ${url}:`, e);
    }
  }
}, DEBOUNCE_MS);

/**
 * Intercepts tab navigation states to enforce the Ghost Protocol
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url && tab.status === 'loading') {
    const url = changeInfo.url;
    if (url.startsWith('chrome://') || url.startsWith('about:') || url.startsWith('edge://')) return;

    try {
      const domain = new URL(url).hostname;
      if (!(await isWhitelisted(url))) {
        logBlock(domain);
      } else {
        debouncedRestore(tabId, url);
      }
    } catch (e) {}
  }
});

/**
 * Command & Control Message Router
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'toggle') {
    chrome.storage.sync.set({ enabled: request.enabled }, () => {
      sendResponse({ status: 'toggled', state: request.enabled });
    });
    return true; 
    
  } else if (request.action === 'addWhitelist') {
    chrome.storage.sync.get(["whitelist"], (result) => {
      const lines = (result.whitelist || "").split("\n");
      const targetDomain = normalizeDomain(request.domain);
      
      if (!lines.includes(targetDomain)) {
        lines.push(targetDomain);
        chrome.storage.sync.set({ whitelist: lines.join("\n") }, () => {
          whitelistCache.set(targetDomain, true); 
          sendResponse({ status: 'added', domain: targetDomain });
        });
      } else {
        sendResponse({ status: 'exists', domain: targetDomain });
      }
    });
    return true;
    
  } else if (request.action === 'getLogs') {
    chrome.storage.local.get(['swBlocks', 'detailedAttempts'], (result) => {
      sendResponse({ 
        logs: result.swBlocks || {},
        attempts: result.detailedAttempts || []
      });
    });
    return true;
    
  } else if (request.action === 'swAttemptLog') {
    const attemptData = {
      timestamp: Date.now(),
      scriptURL: request.scriptURL,
      context: request.context || 'Unknown',
      origin: sender.tab ? sender.tab.url : 'unknown',
      tabId: sender.tab ? sender.tab.id : null
    };
    
    chrome.storage.local.get(['detailedAttempts'], (result) => {
      let attempts = result.detailedAttempts || [];
      attempts.push(attemptData);
      if (attempts.length > 1000) attempts = attempts.slice(-1000); 
      chrome.storage.local.set({ detailedAttempts: attempts });
    });
    
    sendResponse({ status: 'telemetry_recorded' });
    return true;

  // --- GATEKEEPER IPC INTERCEPT (Patched for DDoS-Guard) ---
  } else if (request.action === 'requestPermission') {
    const reqId = nextRequestId++;
    const targetUrl = request.url || '';

    // AUTO-ALLOW DDoS-Guard challenge domains
    if (isDDoSGuardChallenge(targetUrl)) {
      console.log(`[Ψ-Core] Auto-allowing DDoS-Guard challenge: ${targetUrl}`);
      sendResponse({ allowed: true });
      return true;
    }

    // Normal interactive flow for everything else
    pendingRequests[reqId] = sendResponse;
    
    chrome.windows.create({
      url: `prompt.html?id=${reqId}&type=${encodeURIComponent(request.type)}&url=${encodeURIComponent(targetUrl)}`,
      type: 'popup',
      width: 380,
      height: 260,
      focused: true
    });
    
    return true; // Keep channel open

  } else if (request.action === 'resolvePermission') {
    const resolver = pendingRequests[request.id];
    if (resolver) {
      resolver({ allowed: request.allowed });
      delete pendingRequests[request.id];
    }
    if (sender.tab && sender.tab.windowId) {
      chrome.windows.remove(sender.tab.windowId);
    }
    sendResponse({ status: 'resolved' });
    return true;
  }
  
  return false;
});
