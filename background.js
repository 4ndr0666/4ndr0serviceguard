// background.js — 4ndr0serviceguard Ψ-Core v7.1.1 (Background Service Worker)
//
// Unified command & control router. Two channels:
//   chrome.runtime.onMessage        → internal extension pages (popup, prompt)
//   chrome.runtime.onMessageExternal → MAIN-world Ghost Core via the
//                                      externally_connectable page stub
//
// Enforcement order for every gate request:
//   1. per-tab rate limit   2. master toggle   3. DDoS-Guard fast path
//   4. whitelist auto-allow 5. interactive prompt (deduped, capped, settled)
//
// Superset contract over the v7.0 baseline: whitelist auto-allow, toggle
// enforcement, DDoS-Guard auto-allow, prompt.html interactive flow, addWhitelist
// and getLogs IPC shapes, swBlocks/detailedAttempts telemetry and the 1000-entry
// bound are all preserved; broken paths (the restore injection into whitelisted
// tabs, the dead 'enabled' flag, schema-mismatched telemetry) are replaced by
// working equivalents with identical intent. See MITIGATION_LOG.md.
//
// v7.1.1 hardening (field report: background.js:505 — the D6 boundary was
// logging a real rejection): response delivery is now failure-isolated
// (safeRespond) so a dead message port or a context invalidated during
// service-worker teardown can never leak an unhandled rejection; prompt window
// removal reads runtime.lastError; per-tab rate/prompt state is evicted on tab
// close; whitelist adds normalize stored lines before dedup.

const CACHE_REFRESH_MS = 30000;
const DEBOUNCE_MS = 250;          // icon-update batching window (baseline utility, live role)
const MAX_ATTEMPTS = 1000;        // telemetry bound (baseline)
const GATE_RATE_PER_MIN = 40;     // external gate requests per tab per minute
const TELEMETRY_RATE_PER_MIN = 60;// external telemetry messages per tab per minute
const MAX_PROMPTS_PER_TAB = 3;    // concurrent interactive prompts per tab

let whitelistCache = new Map();
let cacheExpiry = 0;

let storageQueue = Promise.resolve(); // serializes read-modify-write cycles

const pendingRequests = new Map();   // reqId -> {resolvers, key, tabId, windowId}
const promptByKey = new Map();       // dedupKey -> reqId
const promptCountByTab = new Map();  // tabId -> live prompt count
const rateWindows = new Map();       // tabId -> {gate:{t,n}, telemetry:{t,n}}

// Restart-safe monotonic seed — survives MV3 service-worker termination.
let nextRequestId = Date.now();

// === UTILITIES ===

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

function isDDoSGuardChallenge(url) {
  if (!url) return false;
  const u = String(url).toLowerCase();
  return u.includes('ddos-guard.net') ||
         u.includes('check.ddos-guard') ||
         u.includes('pacifier_v5') ||
         u.includes('/.well-known/ddos-guard/');
}

function normalizeDomain(domain) {
  return String(domain || '').toLowerCase().replace(/xn--/g, '');
}

function resolveUrl(target, base) {
  try { return new URL(String(target), base || undefined); } catch (e) { return null; }
}

function enqueueStorage(op) {
  storageQueue = storageQueue.then(op).catch((e) => {
    console.error('[Ψ-Core] storage queue failure:', e);
  });
  return storageQueue;
}

function rateAllow(tabId, bucket, limit) {
  const now = Date.now();
  let rec = rateWindows.get(tabId);
  if (!rec) {
    rec = { gate: { t: now, n: 0 }, telemetry: { t: now, n: 0 } };
    rateWindows.set(tabId, rec);
  }
  const w = rec[bucket];
  if (now - w.t > 60000) { w.t = now; w.n = 0; }
  w.n += 1;
  return w.n <= limit;
}

function senderOrigin(sender) {
  try { return (sender && sender.url) ? new URL(sender.url).origin : null; }
  catch (e) { return null; }
}

function senderPageUrl(sender) {
  return (sender && sender.url) || null;
}

function senderTabId(sender) {
  return (sender && sender.tab && typeof sender.tab.id === 'number') ? sender.tab.id : null;
}

// === STATE ===

async function isEnabled() {
  try {
    const r = await chrome.storage.sync.get(['enabled']);
    return r.enabled !== false; // default-deny until explicitly disabled
  } catch (e) {
    console.error('[Ψ-Core] enabled-state read failed:', e);
    return true;
  }
}

async function getWhitelist() {
  const now = Date.now();
  if (now - cacheExpiry > CACHE_REFRESH_MS) {
    try {
      const result = await chrome.storage.sync.get(['whitelist']);
      const lines = (result.whitelist || '').split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean);
      whitelistCache.clear();
      lines.forEach((line) => whitelistCache.set(normalizeDomain(line), true));
      cacheExpiry = now;
    } catch (e) {
      console.error('[Ψ-Core] Whitelist sync failed:', e);
    }
  }
  return Array.from(whitelistCache.keys());
}

async function isWhitelisted(url, base) {
  try {
    const u = resolveUrl(url, base);
    if (!u) return false;
    const domain = normalizeDomain(u.hostname);
    const lines = await getWhitelist();
    return lines.some((line) => domain === line || domain.endsWith('.' + line));
  } catch (e) {
    console.debug('[Ψ-Core] whitelist evaluation failed:', e);
    return false;
  }
}

async function applyIcon(enabled) {
  const path = enabled
    ? { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' }
    : { 16: 'icons/disabled16.png', 48: 'icons/disabled48.png', 128: 'icons/disabled128.png' };
  try { await chrome.action.setIcon({ path }); }
  catch (e) { console.debug('[Ψ-Core] setIcon failed:', e); }
}

// Live debounce role: batches icon updates when the toggle is flipped rapidly
// (toggle handler + storage.onChanged fire in quick succession).
const applyIconDebounced = debounce(applyIcon, DEBOUNCE_MS);

// === TELEMETRY (serialized read-modify-write; restart-safe) ===

function appendAttempt(entry) {
  return enqueueStorage(async () => {
    const result = await chrome.storage.local.get(['detailedAttempts']);
    let attempts = Array.isArray(result.detailedAttempts) ? result.detailedAttempts : [];
    attempts.push(entry);
    if (attempts.length > MAX_ATTEMPTS) attempts = attempts.slice(-MAX_ATTEMPTS);
    await chrome.storage.local.set({ detailedAttempts: attempts });
  });
}

function logTelemetry(type, target, opts, sender) {
  const o = opts || {};
  return appendAttempt({
    type: String(type || 'Unknown'),
    target: String(target || 'unknown'),
    origin: o.origin || senderOrigin(sender) || 'unknown',
    pageUrl: senderPageUrl(sender) || 'unknown',
    tabId: senderTabId(sender),
    timestamp: Date.now(),
    allowed: o.allowed === true,
    source: o.source || 'auto'
  });
}

function logBlock(domain) {
  return enqueueStorage(async () => {
    const result = await chrome.storage.local.get(['swBlocks']);
    const log = result.swBlocks || {};
    log[domain] = (log[domain] || 0) + 1;
    await chrome.storage.local.set({ swBlocks: log });
  });
}

// === PROMPT LIFECYCLE ===

function settleRequest(reqId, allowed) {
  const pending = pendingRequests.get(reqId);
  if (!pending) return;
  pendingRequests.delete(reqId);
  if (pending.key && promptByKey.get(pending.key) === reqId) promptByKey.delete(pending.key);
  if (pending.tabId !== null) {
    const live = (promptCountByTab.get(pending.tabId) || 1) - 1;
    if (live > 0) promptCountByTab.set(pending.tabId, live);
    else promptCountByTab.delete(pending.tabId);
  }
  if (pending.windowId !== null) {
    try {
      chrome.windows.remove(pending.windowId, () => {
        void chrome.runtime.lastError; // window may already be closing (prompt self-close race)
      });
    } catch (e) { console.debug('[Ψ-Core] prompt window remove failed:', e); }
  }
  pending.resolvers.forEach((res) => {
    try { res(allowed); }
    catch (e) { console.debug('[Ψ-Core] resolver failed:', e); }
  });
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [reqId, pending] of pendingRequests) {
    if (pending.windowId === windowId) {
      settleRequest(reqId, false); // closing the prompt = deny
      break;
    }
  }
});

// === ACTION HANDLERS ===

async function handleToggle(request) {
  const enabled = request.enabled !== false;
  await chrome.storage.sync.set({ enabled });
  applyIconDebounced(enabled);
  return { status: 'toggled', state: enabled };
}

async function handleAddWhitelist(request) {
  const result = await chrome.storage.sync.get(['whitelist']);
  // v7.1.1: normalize stored lines so mixed-case entries dedupe correctly.
  const lines = (result.whitelist || '').split('\n').map((l) => normalizeDomain(l)).filter(Boolean);
  const targetDomain = normalizeDomain(request.domain);
  if (targetDomain && !lines.includes(targetDomain)) {
    lines.push(targetDomain);
    await chrome.storage.sync.set({ whitelist: lines.join('\n') });
    whitelistCache.set(targetDomain, true);
    return { status: 'added', domain: targetDomain };
  }
  return { status: 'exists', domain: targetDomain };
}

async function handleSetWhitelist(request) {
  const lines = Array.isArray(request.whitelist)
    ? request.whitelist.map((l) => normalizeDomain(String(l || '').trim())).filter(Boolean)
    : [];
  const unique = Array.from(new Set(lines));
  await chrome.storage.sync.set({ whitelist: unique.join('\n') });
  whitelistCache.clear();
  cacheExpiry = 0;
  return { status: 'saved', count: unique.length };
}

async function handleGetLogs() {
  const result = await chrome.storage.local.get(['swBlocks', 'detailedAttempts']);
  return {
    logs: result.swBlocks || {},
    attempts: Array.isArray(result.detailedAttempts) ? result.detailedAttempts : []
  };
}

async function handleResolvePermission(request) {
  const reqId = Number(request.id);
  if (!Number.isFinite(reqId)) return { status: 'invalid_id' };
  settleRequest(reqId, request.allowed === true);
  return { status: 'resolved' };
}

async function handleGhostStatus(sender) {
  const enabled = await isEnabled();
  const pageOrigin = senderOrigin(sender);
  const whitelisted = pageOrigin ? await isWhitelisted(pageOrigin) : false;
  return { status: 'ok', active: enabled, whitelisted: whitelisted };
}

async function handleSwAttemptLog(request, sender) {
  const tabId = senderTabId(sender);
  if (tabId !== null && !rateAllow(tabId, 'telemetry', TELEMETRY_RATE_PER_MIN)) {
    return { status: 'rate_limited' };
  }
  const entry = {
    type: String(request.type || 'Unknown'),
    target: String(request.target || request.scriptURL || 'unknown'),
    origin: String(request.origin || senderOrigin(sender) || 'unknown'),
    pageUrl: senderPageUrl(sender) || 'unknown',
    tabId: tabId,
    timestamp: Number(request.timestamp) || Date.now(),
    allowed: request.allowed === true,
    source: String(request.source || 'gate')
  };
  if (request.detail) entry.detail = String(request.detail);
  await appendAttempt(entry);
  return { status: 'telemetry_recorded' };
}

async function handleRequestPermission(request, sender) {
  const tabId = senderTabId(sender);
  const pageOrigin = senderOrigin(sender);

  // 1. Per-tab rate limit (external flood guard).
  if (tabId !== null && !rateAllow(tabId, 'gate', GATE_RATE_PER_MIN)) {
    return { allowed: false, reason: 'rate_limited' };
  }

  // 2. Master toggle — global pass-through when disabled.
  if (!(await isEnabled())) {
    logTelemetry('Gate', request.url, { allowed: true, source: 'toggle-off' }, sender);
    return { allowed: true, reason: 'disabled' };
  }

  // 3. DDoS-Guard fast path (baseline auto-allow, centralized here as well).
  if (isDDoSGuardChallenge(request.url)) {
    console.log('[Ψ-Core] Auto-allowing DDoS-Guard challenge:', request.url);
    logTelemetry('Gate', request.url, { allowed: true, source: 'ddos-guard' }, sender);
    return { allowed: true, reason: 'ddos-guard' };
  }

  // 4. Whitelist — auto-allow (the whitelist is finally enforced).
  const target = resolveUrl(request.url, pageOrigin);
  const targetWhitelisted = target ? await isWhitelisted(target.href) : false;
  const originWhitelisted = pageOrigin ? await isWhitelisted(pageOrigin) : false;
  if (targetWhitelisted || originWhitelisted) {
    logTelemetry('Gate', request.url, { allowed: true, source: 'whitelist' }, sender);
    return { allowed: true, reason: 'whitelisted' };
  }

  // 5. Interactive prompt (deduped, capped, window-tracked).
  const type = String(request.type || 'Unknown');
  const key = type + '|' + (target ? target.href : String(request.url || '')) + '|' + (pageOrigin || '');

  if (promptByKey.has(key)) {
    const existing = pendingRequests.get(promptByKey.get(key));
    if (existing) {
      return new Promise((resolve) => {
        existing.resolvers.push((allowed) => resolve({ allowed: allowed, reason: 'dedup' }));
      });
    }
  }

  if (tabId !== null && (promptCountByTab.get(tabId) || 0) >= MAX_PROMPTS_PER_TAB) {
    return { allowed: false, reason: 'prompt_cap' };
  }

  const reqId = nextRequestId++;
  const pending = { resolvers: [], key: key, tabId: tabId, windowId: null };
  pendingRequests.set(reqId, pending);
  promptByKey.set(key, reqId);
  if (tabId !== null) {
    promptCountByTab.set(tabId, (promptCountByTab.get(tabId) || 0) + 1);
  }

  const promptUrl = 'prompt.html?id=' + reqId +
    '&type=' + encodeURIComponent(type) +
    '&url=' + encodeURIComponent(target ? target.href : String(request.url || '')) +
    '&origin=' + encodeURIComponent(pageOrigin || 'unknown');

  return new Promise((resolve) => {
    pending.resolvers.push((allowed) => resolve({ allowed: allowed, reason: 'prompt' }));
    chrome.windows.create({
      url: promptUrl,
      type: 'popup',
      width: 380,
      height: 320,
      focused: true
    }, (win) => {
      if (chrome.runtime.lastError || !win) {
        console.error('[Ψ-Core] prompt window failed:',
          chrome.runtime.lastError && chrome.runtime.lastError.message);
        settleRequest(reqId, false);
        return;
      }
      pending.windowId = win.id;
    });
  });
}

// === UNIFIED ROUTER ===

const INTERNAL_ACTIONS = new Set([
  'toggle', 'addWhitelist', 'setWhitelist', 'getLogs', 'resolvePermission',
  'ghostStatus', 'requestPermission', 'swAttemptLog'
]);
const EXTERNAL_ACTIONS = new Set(['ghostStatus', 'requestPermission', 'swAttemptLog']);

async function routeAsync(request, sender, channel) {
  const action = request && request.action;
  if (typeof action !== 'string') return { status: 'invalid_request' };
  if (channel === 'external' && !EXTERNAL_ACTIONS.has(action)) {
    return { status: 'forbidden' };
  }
  if (channel === 'internal' && !INTERNAL_ACTIONS.has(action)) {
    return { status: 'unknown_action' };
  }

  switch (action) {
    case 'toggle':             return handleToggle(request);
    case 'addWhitelist':       return handleAddWhitelist(request);
    case 'setWhitelist':       return handleSetWhitelist(request);
    case 'getLogs':            return handleGetLogs();
    case 'resolvePermission':  return handleResolvePermission(request);
    case 'ghostStatus':        return handleGhostStatus(sender);
    case 'swAttemptLog':       return handleSwAttemptLog(request, sender);
    case 'requestPermission':  return handleRequestPermission(request, sender);
    default:                   return { status: 'unknown_action' };
  }
}

// v7.1.1: a dead message port (popup closed, page navigated, service worker
// torn down for restart/update) makes sendResponse itself throw — the classic
// "Attempting to use a disconnected port object". Every delivery now goes
// through safeRespond so no router path can leak an unhandled rejection into
// the D6 boundary (the reported background.js:505 entry).
function safeRespond(sendResponse, resp) {
  try { sendResponse(resp || { status: 'noop' }); }
  catch (e) { console.debug('[Ψ-Core] response undeliverable (port closed):', e && e.message); }
}

function handleMessage(request, sender, sendResponse, channel) {
  let handled = false;
  try {
    routeAsync(request, sender, channel)
      .then((resp) => {
        if (!handled) { handled = true; safeRespond(sendResponse, resp); }
      })
      .catch((e) => {
        console.error('[Ψ-Core] router failure:', e);
        if (!handled) { handled = true; safeRespond(sendResponse, { status: 'error', error: String(e && e.message || e) }); }
      })
      .catch((e) => {
        // Terminal boundary — nothing above may reject (defense in depth).
        console.debug('[Ψ-Core] router boundary:', e);
      });
  } catch (e) {
    console.error('[Ψ-Core] router exception:', e);
    if (!handled) { handled = true; safeRespond(sendResponse, { status: 'error', error: String(e && e.message || e) }); }
  }
  return true; // keep the channel open for the async response
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  return handleMessage(request, sender, sendResponse, 'internal');
});

chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
  return handleMessage(request, sender, sendResponse, 'external');
});

// === NAVIGATION TELEMETRY (baseline behavior; broken restore injection replaced
// by whitelist auto-allow inside the gate — same intent, working mechanism) ===

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // v7.1.1: Chrome can deliver a teardown-race event with no tab object.
  if (changeInfo && tab && changeInfo.url && tab.status === 'loading') {
    const url = changeInfo.url;
    if (url.startsWith('chrome://') || url.startsWith('about:') || url.startsWith('edge://')) return;
    try {
      const domain = new URL(url).hostname;
      isWhitelisted(url).then((listed) => {
        if (!listed) logBlock(domain);
      });
    } catch (e) {
      console.debug('[Ψ-Core] navigation telemetry skipped:', e);
    }
  }
});

// v7.1.1: evict per-tab state when tabs close so rate windows and prompt caps
// never leak stale entries across the service worker's lifetime.
chrome.tabs.onRemoved.addListener((tabId) => {
  rateWindows.delete(tabId);
  promptCountByTab.delete(tabId);
});

// === REACTIVITY ===

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.whitelist) {
    whitelistCache.clear();
    cacheExpiry = 0;
  }
  if (changes.enabled) {
    applyIconDebounced(changes.enabled.newValue !== false);
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    const sync = await chrome.storage.sync.get(['enabled', 'whitelist']);
    const local = await chrome.storage.local.get(['whitelist', 'ghostActive']);
    const patch = {};

    if (sync.enabled === undefined) patch.enabled = true;
    if (sync.enabled === undefined && local.ghostActive !== undefined) {
      patch.enabled = local.ghostActive !== false; // legacy toggle migration
    }
    if (sync.whitelist === undefined && Array.isArray(local.whitelist) && local.whitelist.length) {
      patch.whitelist = local.whitelist
        .map((l) => normalizeDomain(String(l).trim()))
        .filter(Boolean)
        .join('\n'); // legacy local array -> canonical sync string
    }

    if (Object.keys(patch).length) await chrome.storage.sync.set(patch);
    if (Array.isArray(local.whitelist) || local.ghostActive !== undefined) {
      await chrome.storage.local.remove(['whitelist', 'ghostActive']);
    }

    const effective = (patch.enabled !== undefined ? patch.enabled : sync.enabled) !== false;
    await applyIcon(effective);
    console.log('[Ψ-Core] installed:', details && details.reason);
  } catch (e) {
    console.error('[Ψ-Core] onInstalled failed:', e);
  }
});

// === BOOT ===

(async function boot() {
  try {
    await applyIcon(await isEnabled());
  } catch (e) {
    console.error('[Ψ-Core] boot failed:', e);
  }
})();

// Top-level loop exception boundary (D6).
self.addEventListener('unhandledrejection', (e) => {
  console.error('[Ψ-Core] unhandled rejection:', e.reason);
  e.preventDefault();
});
