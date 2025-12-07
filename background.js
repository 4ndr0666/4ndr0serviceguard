// 4ndr0serviceguard Background – Ghost Protocol v2.0.0
// Whitelist-triggered restore + global deny

let whitelistCache = new Map(); // domain -> true
let cacheExpiry = 0; // ms
const CACHE_REFRESH_MS = 30000; // 30s
let blockLog = {}; // domain -> count
const DEBOUNCE_MS = 250;

function debounce(fn, delay) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
}

// Punycode/IDN rough strip for subdomain matching
function normalizeDomain(domain) {
  return domain.toLowerCase().replace(/xn--/g, '');
}

// Load whitelist from storage (cached)
async function getWhitelist() {
  const now = Date.now();
  if (now - cacheExpiry > CACHE_REFRESH_MS) {
    const result = await chrome.storage.sync.get(["whitelist"]);
    const lines = (result.whitelist || "").split("\n").map(l => l.trim().toLowerCase()).filter(Boolean);
    whitelistCache.clear();
    lines.forEach(line => whitelistCache.set(normalizeDomain(line), true));
    cacheExpiry = now;
  }
  return Array.from(whitelistCache.keys());
}

// Check if domain or subdomain is whitelisted
async function isWhitelisted(url) {
  const domain = normalizeDomain(new URL(url).hostname);
  const lines = await getWhitelist();
  return lines.some(line => domain === line || domain.endsWith('.' + line));
}

// Log block (local storage for perf)
async function logBlock(domain) {
  blockLog[domain] = (blockLog[domain] || 0) + 1;
  await chrome.storage.local.set({ swBlocks: blockLog });
}

// Debounced restore on whitelist match
const debouncedRestore = debounce(async (tabId, url) => {
  if (await isWhitelisted(url)) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['pacifier_v2.js']
    });
  }
}, DEBOUNCE_MS);

// Listen for tab updates (navigation)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url && tab.status === 'loading') { // Fire earlier on 'loading'
    const url = changeInfo.url;
    if (!(await isWhitelisted(url))) {
      logBlock(new URL(url).hostname);
      // Pacifier injected globally at document_start by manifest.json
    } else {
      debouncedRestore(tabId, url);
    }
  }
});

// Popup messages (toggle, whitelist add, logs)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'toggle') {
    // Global toggle logic (e.g., store enabled state)
    chrome.storage.sync.set({ enabled: request.enabled });
    sendResponse({ status: 'toggled' });
  } else if (request.action === 'addWhitelist') {
    chrome.storage.sync.get(["whitelist"], (result) => {
      const lines = (result.whitelist || "").split("\n");
      lines.push(request.domain);
      chrome.storage.sync.set({ whitelist: lines.join("\n") });
      whitelistCache.set(normalizeDomain(request.domain), true); // Immediate cache
      sendResponse({ status: 'added' });
    });
    return true; // Async response
  } else if (request.action === 'getLogs') {
    chrome.storage.local.get(['swBlocks'], (result) => {
      sendResponse({ logs: result.swBlocks || {} });
    });
    return true;
  }
  return false;
});

