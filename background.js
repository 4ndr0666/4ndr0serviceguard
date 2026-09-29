// background.js — 4ndr0serviceguard Ψ-Core v7.3.0 (Background Service Worker)
//
// Unified command & control router. Two channels:
//   chrome.runtime.onMessage        → internal extension contexts (popup,
//                                      prompt window, ghost_bridge quick bar)
//   chrome.runtime.onMessageExternal → MAIN-world Ghost Core via the
//                                      externally_connectable page stub
//
// Enforcement order for every gate request:
//   1. per-tab rate limit   2. blacklist hard-deny   3. spooflist auto-spoof
//   4. master toggle        5. DDoS-Guard fast path  6. whitelist auto-allow
//   7. interactive decision (in-page Quick Bar first, prompt window fallback)
//
// v7.3.0 action model — the vision, refined: the user may AUTHORIZE (real
// connection), SPOOF (pacify: a phantom socket that stays OPEN and swallows
// sends — the page believes it has a live connection) or DENY (native-faithful
// handshake failure at the 40 ms cadence). Three silent lists back it:
//   whitelist  → AUTHORIZE silently (never ask)
//   spooflist  → SPOOF silently     (never ask — "sites I spoof by default")
//   blacklist  → DENY silently      (never ask — absolute prohibition)
// All three are mutually exclusive on single-domain adds and are evaluated
// before the master toggle, so an explicit user decision survives
// pass-through mode.
//
// v7.3.0 popup-persistence fixes (field report: "blacklisting does not stop
// the persistent popup on sites I want to spoof by default"):
//   - normalizeDomain now strips schemes, paths, ports and boundary dots, so
//     pasted URLs ("https://example.com/") finally match (v7.2 silently
//     ignored them — the userscript already normalized this way).
//   - Remembered grants from the prompt / quick bar default to the PAGE
//     ORIGIN ("site" scope) instead of the WS endpoint host, so one grant
//     covers every endpoint and Service Worker on that site.
//   - The prompt dedup key strips query strings and fragments, so
//     token-bearing sockets (wss://host/ws?token=… ) no longer defeat dedup
//     and re-prompt on every page load.
//   - Interactive decisions render in-page first (ghost_bridge Quick Bar:
//     one click, keyboard A/S/D, 30 s auto-deny, no OS focus stealing); the
//     v7.2 prompt window remains fully intact as the fallback and as an
//     explicit promptMode preference.
//
// Superset contract over the v7.2.0 baseline: every v7.2.0 behavior is
// preserved — blacklist-before-toggle doctrine, mutual exclusion, bulk saves
// that never destroy the sibling lists, resolvePermission's optional
// blacklist grant (v7.2 message shape still honored), ghostStatus flags,
// addBlacklist/setBlacklist IPC, telemetry bounds, rate limits, prompt cap,
// safeRespond isolation, tab-close eviction, storage reactivity, and the
// onInstalled legacy migration. See MITIGATION_LOG.md (G-85…).
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
const MAX_PROMPTS_PER_TAB = 3;    // concurrent interactive decisions per tab
const QUICK_BAR_ACK_MS = 1600;    // in-page bar render acknowledgment window

let whitelistCache = new Map();
let cacheExpiry = 0;

let blacklistCache = new Map();   // v7.2.0: explicit-prohibition registry
let blacklistExpiry = 0;

let spooflistCache = new Map();   // v7.3.0: silent auto-spoof registry
let spooflistExpiry = 0;

let promptModeCache = { value: 'inline', expiry: 0 }; // v7.3.0: 'inline' | 'window'

let storageQueue = Promise.resolve(); // serializes read-modify-write cycles

const pendingRequests = new Map();   // reqId -> {resolvers, key, tabId, frameId, windowId, inline}
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

// v7.3.0: robust domain normalization. v7.2 only lowercased and stripped the
// punycode marker — an entry like "https://example.com/" NEVER matched a
// hostname, which is one of the two root causes of the popup-persistence
// field report. The userscript already normalized this way; the extension
// now matches that behavior (and remains a superset: bare domains that
// matched under v7.2 normalize identically here).
function normalizeDomain(domain) {
  let s = String(domain || '').toLowerCase().trim();
  s = s.replace(/^[a-z][a-z0-9+.\-]*:\/\//, ''); // scheme (http, https, ws, wss, …)
  s = s.replace(/^\/+/, '');                     // protocol-relative leading slashes
  s = s.split('/')[0];                           // path
  s = s.split('?')[0].split('#')[0];             // query / fragment
  s = s.split(':')[0];                           // port
  s = s.replace(/^\.+/, '').replace(/\.+$/, ''); // boundary dots
  s = s.replace(/xn--/g, '');                    // v7.2 punycode marker behavior
  return s;
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

function senderFrameId(sender) {
  return (sender && typeof sender.frameId === 'number') ? sender.frameId : null;
}

// Coerces any settled verdict into the canonical v7.3.0 action triple.
// Backward compatible: {allowed:true} → allow, {allowed:false} → deny.
function coerceVerdict(verdict) {
  const allowed = !!(verdict && verdict.allowed === true);
  let action = verdict && verdict.action;
  if (action !== 'allow' && action !== 'spoof' && action !== 'deny') {
    action = allowed ? 'allow' : 'deny';
  }
  return { allowed: action === 'allow', action: action };
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

// v7.2.0: blacklist registry — same TTL/cache/storage discipline as the
// whitelist. A read failure falls open here, but the gate's default is still
// deny (prompt), so a storage hiccup can never silently allow a connection.
async function getBlacklist() {
  const now = Date.now();
  if (now - blacklistExpiry > CACHE_REFRESH_MS) {
    try {
      const result = await chrome.storage.sync.get(['blacklist']);
      const lines = (result.blacklist || '').split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean);
      blacklistCache.clear();
      lines.forEach((line) => blacklistCache.set(normalizeDomain(line), true));
      blacklistExpiry = now;
    } catch (e) {
      console.error('[Ψ-Core] Blacklist sync failed:', e);
    }
  }
  return Array.from(blacklistCache.keys());
}

async function isBlacklisted(url, base) {
  try {
    const u = resolveUrl(url, base);
    if (!u) return false;
    const domain = normalizeDomain(u.hostname);
    const lines = await getBlacklist();
    return lines.some((line) => domain === line || domain.endsWith('.' + line));
  } catch (e) {
    console.debug('[Ψ-Core] blacklist evaluation failed:', e);
    return false;
  }
}

// v7.3.0: spooflist registry — the silent auto-spoof list. Identical
// TTL/cache/storage discipline. A spooflisted target or page origin settles
// as action:'spoof' with NO interactive decision: the phantom socket stays
// open and swallows sends, exactly like the userscript pacifier.
async function getSpooflist() {
  const now = Date.now();
  if (now - spooflistExpiry > CACHE_REFRESH_MS) {
    try {
      const result = await chrome.storage.sync.get(['spooflist']);
      const lines = (result.spooflist || '').split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean);
      spooflistCache.clear();
      lines.forEach((line) => spooflistCache.set(normalizeDomain(line), true));
      spooflistExpiry = now;
    } catch (e) {
      console.error('[Ψ-Core] Spooflist sync failed:', e);
    }
  }
  return Array.from(spooflistCache.keys());
}

async function isSpooflisted(url, base) {
  try {
    const u = resolveUrl(url, base);
    if (!u) return false;
    const domain = normalizeDomain(u.hostname);
    const lines = await getSpooflist();
    return lines.some((line) => domain === line || domain.endsWith('.' + line));
  } catch (e) {
    console.debug('[Ψ-Core] spooflist evaluation failed:', e);
    return false;
  }
}

// v7.3.0: interactive-surface preference. 'inline' (default) renders the
// in-page Quick Bar; 'window' uses the v7.2 prompt window directly.
async function getPromptMode() {
  const now = Date.now();
  if (now - promptModeCache.expiry > CACHE_REFRESH_MS) {
    try {
      const r = await chrome.storage.sync.get(['promptMode']);
      promptModeCache.value = r.promptMode === 'window' ? 'window' : 'inline';
      promptModeCache.expiry = now;
    } catch (e) {
      console.error('[Ψ-Core] promptMode read failed:', e);
    }
  }
  return promptModeCache.value;
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

function settleRequest(reqId, verdict) {
  const pending = pendingRequests.get(reqId);
  if (!pending) return;
  pendingRequests.delete(reqId);
  if (pending.key && promptByKey.get(pending.key) === reqId) promptByKey.delete(pending.key);
  if (pending.tabId !== null) {
    const live = (promptCountByTab.get(pending.tabId) || 1) - 1;
    if (live > 0) promptCountByTab.set(pending.tabId, live);
    else promptCountByTab.delete(pending.tabId);
  }
  // v7.3.0: an in-page Quick Bar that is still on screen when the request
  // settles through another surface (window fallback race, tab close) must
  // dismiss itself — best-effort, never blocking the settlement.
  if (pending.inline && pending.tabId !== null) {
    try {
      const options = (typeof pending.frameId === 'number') ? { frameId: pending.frameId } : {};
      chrome.tabs.sendMessage(pending.tabId, { action: 'ghostQuickDismiss', reqId: reqId }, options, () => {
        void chrome.runtime.lastError; // frame may already be gone
      });
    } catch (e) { console.debug('[Ψ-Core] quick-bar dismiss failed:', e); }
  }
  if (pending.windowId !== null) {
    try {
      chrome.windows.remove(pending.windowId, () => {
        void chrome.runtime.lastError; // window may already be closing (prompt self-close race)
      });
    } catch (e) { console.debug('[Ψ-Core] prompt window remove failed:', e); }
  }
  const v = coerceVerdict(verdict);
  pending.resolvers.forEach((res) => {
    try { res(v); }
    catch (e) { console.debug('[Ψ-Core] resolver failed:', e); }
  });
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [reqId, pending] of pendingRequests) {
    if (pending.windowId === windowId) {
      settleRequest(reqId, { allowed: false, action: 'deny' }); // closing the prompt = deny
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

// v7.3.0: unified three-list add with full mutual exclusion. Adding a domain
// to any list prunes it from both siblings (v7.2.0 pruned one sibling; the
// doctrine is unchanged, extended to the spooflist). Bulk saves still replace
// exactly one list and never touch the siblings; domains present on multiple
// lists after independent bulk saves resolve at the gate in gate order
// (blacklist wins over spooflist wins over whitelist).
const POLICY_LISTS = ['whitelist', 'spooflist', 'blacklist'];

function readPolicyLines(value) {
  return String(value || '').split('\n').map((l) => normalizeDomain(l)).filter(Boolean);
}

async function addToList(kind, rawDomain) {
  if (POLICY_LISTS.indexOf(kind) === -1) return { status: 'invalid_kind' };
  const targetDomain = normalizeDomain(rawDomain);
  if (!targetDomain) return { status: 'exists', domain: targetDomain };
  const result = await chrome.storage.sync.get(POLICY_LISTS);
  const state = {};
  POLICY_LISTS.forEach((k) => { state[k] = readPolicyLines(result[k]); });
  const already = state[kind].indexOf(targetDomain) !== -1;
  const conflicted = POLICY_LISTS.some((k) => k !== kind && state[k].indexOf(targetDomain) !== -1);
  if (!already || conflicted) {
    const patch = {};
    if (!already) state[kind].push(targetDomain);
    patch[kind] = state[kind].join('\n');
    POLICY_LISTS.forEach((k) => {
      if (k === kind) return;
      const idx = state[k].indexOf(targetDomain);
      if (idx !== -1) {
        state[k].splice(idx, 1);
        patch[k] = state[k].join('\n');
        if (k === 'whitelist') whitelistCache.delete(targetDomain);
        if (k === 'spooflist') spooflistCache.delete(targetDomain);
        if (k === 'blacklist') blacklistCache.delete(targetDomain);
      }
    });
    await chrome.storage.sync.set(patch);
    if (kind === 'whitelist') whitelistCache.set(targetDomain, true);
    if (kind === 'spooflist') spooflistCache.set(targetDomain, true);
    if (kind === 'blacklist') blacklistCache.set(targetDomain, true);
    return { status: 'added', domain: targetDomain };
  }
  return { status: 'exists', domain: targetDomain };
}

async function handleAddWhitelist(request) {
  // v7.1.1: normalize stored lines so mixed-case entries dedupe correctly.
  // v7.2.0/v7.3.0: single-domain adds keep the lists mutually exclusive.
  return addToList('whitelist', request.domain);
}

// v7.2.0: mirror of handleAddWhitelist for the explicit-prohibition list.
// Internal-channel only: page scripts can never forge a blacklist entry.
async function handleAddBlacklist(request) {
  return addToList('blacklist', request.domain);
}

// v7.3.0: mirror of handleAddWhitelist for the silent auto-spoof list.
// Internal-channel only: page scripts can never forge a spoof grant.
async function handleAddSpooflist(request) {
  return addToList('spooflist', request.domain);
}

// v7.3.0: "ASK AGAIN" — removes a domain from every list at once so the
// gate returns to interactive decisions for it. Internal-channel only.
async function handleRemoveDomain(request) {
  const targetDomain = normalizeDomain(request.domain);
  if (!targetDomain) return { status: 'invalid', domain: targetDomain };
  const result = await chrome.storage.sync.get(POLICY_LISTS);
  const patch = {};
  let removed = 0;
  POLICY_LISTS.forEach((k) => {
    const lines = readPolicyLines(result[k]);
    const next = lines.filter((d) => d !== targetDomain);
    removed += lines.length - next.length;
    patch[k] = next.join('\n');
  });
  if (removed > 0) {
    await chrome.storage.sync.set(patch);
    whitelistCache.delete(targetDomain);
    spooflistCache.delete(targetDomain);
    blacklistCache.delete(targetDomain);
  }
  return { status: 'removed', domain: targetDomain, removed: removed };
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

// v7.2.0: bulk blacklist save. Replaces the blacklist only — a bulk edit must
// never destroy the other lists' user data. Domains present on both lists
// after independent bulk saves resolve to deny at the gate (blacklist wins).
async function handleSetBlacklist(request) {
  const lines = Array.isArray(request.blacklist)
    ? request.blacklist.map((l) => normalizeDomain(String(l || '').trim())).filter(Boolean)
    : [];
  const unique = Array.from(new Set(lines));
  await chrome.storage.sync.set({ blacklist: unique.join('\n') });
  blacklistCache.clear();
  blacklistExpiry = 0;
  return { status: 'saved', count: unique.length };
}

// v7.3.0: bulk spooflist save. Replaces the spooflist only.
async function handleSetSpooflist(request) {
  const lines = Array.isArray(request.spooflist)
    ? request.spooflist.map((l) => normalizeDomain(String(l || '').trim())).filter(Boolean)
    : [];
  const unique = Array.from(new Set(lines));
  await chrome.storage.sync.set({ spooflist: unique.join('\n') });
  spooflistCache.clear();
  spooflistExpiry = 0;
  return { status: 'saved', count: unique.length };
}

// v7.3.0: current-site policy snapshot for the toolbar popup's one-click
// panel (AUTHORIZE SITE / SPOOF SITE / BLOCK SITE / ASK AGAIN).
async function handleGetSitePolicy(request) {
  const origin = String(request.origin || '');
  const u = resolveUrl(origin);
  const domain = u ? normalizeDomain(u.hostname) : normalizeDomain(origin);
  const enabled = await isEnabled();
  const whitelisted = u ? await isWhitelisted(u.href) : false;
  const spooflisted = u ? await isSpooflisted(u.href) : false;
  const blacklisted = u ? await isBlacklisted(u.href) : false;
  const promptMode = await getPromptMode();
  return {
    status: 'ok',
    origin: origin,
    domain: domain,
    enabled: enabled,
    whitelisted: whitelisted,
    spooflisted: spooflisted,
    blacklisted: blacklisted,
    promptMode: promptMode
  };
}

// v7.3.0: interactive-surface preference writer.
async function handleSetPromptMode(request) {
  const mode = request.promptMode === 'window' ? 'window' : 'inline';
  await chrome.storage.sync.set({ promptMode: mode });
  promptModeCache.value = mode;
  promptModeCache.expiry = Date.now();
  return { status: 'saved', promptMode: mode };
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
  // v7.2.0 backward-compatible shape: {id, allowed, blacklist:true, domain}
  // settles the request AND permanently blacklists the prompted domain.
  // v7.3.0 shape: {id, decision:'allow'|'spoof'|'deny', remember:'site'|
  // 'endpoint', domain} — a remembered decision grants the matching list
  // (allow→whitelist, spoof→spooflist, deny→blacklist). The decision key is
  // named `decision` (NOT `action`) because `action` is the router's
  // dispatch key — a collision would silently misroute the settlement.
  // The remember scope chooses WHICH host the caller computed: 'site' =
  // page origin host (the v7.3.0 default — one grant covers every endpoint
  // on the site), 'endpoint' = the connection target host. Grant failure
  // must never swallow the settlement itself (v7.2.0 doctrine).
  const action = (request.decision === 'allow' || request.decision === 'spoof' || request.decision === 'deny')
    ? request.decision
    : (request.allowed === true ? 'allow' : 'deny');
  const remember = (request.remember === 'site' || request.remember === 'endpoint')
    ? request.remember
    : false;
  let grantList = null;
  let grantDomain = null;
  if (request.blacklist === true && request.domain) {
    grantList = 'blacklist';
    grantDomain = request.domain;
  } else if (remember && request.domain) {
    grantList = action === 'allow' ? 'whitelist'
      : (action === 'spoof' ? 'spooflist' : 'blacklist');
    grantDomain = request.domain;
  }
  if (grantList && grantDomain) {
    try {
      await addToList(grantList, grantDomain);
    } catch (e) {
      console.error('[Ψ-Core] prompt ' + grantList + ' grant failed:', e);
    }
  }
  settleRequest(reqId, { allowed: action === 'allow', action: action });
  return { status: 'resolved' };
}

async function handleGhostStatus(sender) {
  const enabled = await isEnabled();
  const pageOrigin = senderOrigin(sender);
  const whitelisted = pageOrigin ? await isWhitelisted(pageOrigin) : false;
  const blacklisted = pageOrigin ? await isBlacklisted(pageOrigin) : false;
  const spooflisted = pageOrigin ? await isSpooflisted(pageOrigin) : false;
  return {
    status: 'ok',
    active: enabled,
    whitelisted: whitelisted,
    blacklisted: blacklisted,
    spooflisted: spooflisted
  };
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

// v7.3.0: in-page Quick Bar render request. The bridge acknowledges
// synchronously ({status:'shown'}) so the gate can fall back to the prompt
// window when the bar cannot render (no DOM yet, frame gone, bar disabled).
function sendQuickBar(tabId, frameId, message) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => finish(false), QUICK_BAR_ACK_MS);
    try {
      const options = (typeof frameId === 'number') ? { frameId: frameId } : {};
      chrome.tabs.sendMessage(tabId, message, options, (response) => {
        void chrome.runtime.lastError; // frame gone / no listener → fallback
        finish(!!(response && response.status === 'shown'));
      });
    } catch (e) {
      console.debug('[Ψ-Core] quick-bar send failed:', e);
      finish(false);
    }
  });
}

// v7.2.0 prompt window — preserved verbatim in behavior; v7.3.0 only widens
// the height for the three-action matrix and settles with the action triple.
function openPromptWindow(reqId, pending, ask) {
  const promptUrl = 'prompt.html?id=' + reqId +
    '&type=' + encodeURIComponent(ask.type) +
    '&url=' + encodeURIComponent(ask.url) +
    '&origin=' + encodeURIComponent(ask.origin || 'unknown');
  try {
    chrome.windows.create({
      url: promptUrl,
      type: 'popup',
      width: 380,
      height: 460, // v7.3.0: three primary actions + three site-grant buttons
      focused: true
    }, (win) => {
      if (chrome.runtime.lastError || !win) {
        console.error('[Ψ-Core] prompt window failed:',
          chrome.runtime.lastError && chrome.runtime.lastError.message);
        settleRequest(reqId, { allowed: false, action: 'deny' });
        return;
      }
      pending.windowId = win.id;
    });
  } catch (e) {
    console.error('[Ψ-Core] prompt window create failed:', e);
    settleRequest(reqId, { allowed: false, action: 'deny' });
  }
}

// v7.3.0: decision dispatch — Quick Bar first (default), prompt window as
// fallback and as the explicit promptMode:'window' preference.
async function dispatchDecision(reqId, pending, ask) {
  try {
    const mode = await getPromptMode();
    if (mode === 'inline' && pending.tabId !== null) {
      const shown = await sendQuickBar(pending.tabId, pending.frameId, ask);
      if (shown) {
        pending.inline = true;
        return;
      }
    }
  } catch (e) {
    console.debug('[Ψ-Core] inline dispatch failed:', e);
  }
  openPromptWindow(reqId, pending, ask);
}

async function handleRequestPermission(request, sender) {
  const tabId = senderTabId(sender);
  const frameId = senderFrameId(sender);
  const pageOrigin = senderOrigin(sender);

  // 1. Per-tab rate limit (external flood guard).
  if (tabId !== null && !rateAllow(tabId, 'gate', GATE_RATE_PER_MIN)) {
    return { allowed: false, action: 'deny', reason: 'rate_limited' };
  }

  const target = resolveUrl(request.url, pageOrigin);

  // 2. Blacklist hard-deny (v7.2.0). An explicit user prohibition is
  //    absolute: it precedes the master toggle, the DDoS-Guard fast path and
  //    the whitelist, and survives pass-through mode.
  const targetBlacklisted = target ? await isBlacklisted(target.href) : false;
  const originBlacklisted = pageOrigin ? await isBlacklisted(pageOrigin) : false;
  if (targetBlacklisted || originBlacklisted) {
    logTelemetry('Gate', request.url, { allowed: false, source: 'blacklist' }, sender);
    return { allowed: false, action: 'deny', reason: 'blacklisted' };
  }

  // 2.5 Spooflist auto-spoof (v7.3.0). An explicit user pacify decision is
  //     just as absolute as a prohibition: silent, never interactive, and it
  //     survives pass-through mode for the same reason (explicit user intent
  //     outranks the global toggle).
  const targetSpooflisted = target ? await isSpooflisted(target.href) : false;
  const originSpooflisted = pageOrigin ? await isSpooflisted(pageOrigin) : false;
  if (targetSpooflisted || originSpooflisted) {
    logTelemetry('Gate', request.url, { allowed: false, source: 'spooflist' }, sender);
    return { allowed: false, action: 'spoof', reason: 'spooflisted' };
  }

  // 3. Master toggle — global pass-through when disabled.
  if (!(await isEnabled())) {
    logTelemetry('Gate', request.url, { allowed: true, source: 'toggle-off' }, sender);
    return { allowed: true, action: 'allow', reason: 'disabled' };
  }

  // 4. DDoS-Guard fast path (baseline auto-allow, centralized here as well).
  if (isDDoSGuardChallenge(request.url)) {
    console.log('[Ψ-Core] Auto-allowing DDoS-Guard challenge:', request.url);
    logTelemetry('Gate', request.url, { allowed: true, source: 'ddos-guard' }, sender);
    return { allowed: true, action: 'allow', reason: 'ddos-guard' };
  }

  // 5. Whitelist — auto-allow (the whitelist is finally enforced).
  const targetWhitelisted = target ? await isWhitelisted(target.href) : false;
  const originWhitelisted = pageOrigin ? await isWhitelisted(pageOrigin) : false;
  if (targetWhitelisted || originWhitelisted) {
    logTelemetry('Gate', request.url, { allowed: true, source: 'whitelist' }, sender);
    return { allowed: true, action: 'allow', reason: 'whitelisted' };
  }

  // 6. Interactive decision (deduped, capped, Quick Bar → window fallback).
  const type = String(request.type || 'Unknown');
  // v7.3.0: the dedup key canon is scheme://host:port/path — query strings
  // and fragments are stripped, so token-bearing sockets no longer defeat
  // dedup and re-prompt for the same endpoint on every page load.
  const canon = target ? (target.protocol + '//' + target.host + target.pathname)
    : String(request.url || '');
  const key = type + '|' + canon + '|' + (pageOrigin || '');

  if (promptByKey.has(key)) {
    const existing = pendingRequests.get(promptByKey.get(key));
    if (existing) {
      return new Promise((resolve) => {
        existing.resolvers.push((verdict) => resolve({
          allowed: verdict.allowed,
          action: verdict.action,
          reason: 'dedup'
        }));
      });
    }
  }

  if (tabId !== null && (promptCountByTab.get(tabId) || 0) >= MAX_PROMPTS_PER_TAB) {
    return { allowed: false, action: 'deny', reason: 'prompt_cap' };
  }

  const reqId = nextRequestId++;
  const pending = {
    resolvers: [],
    key: key,
    tabId: tabId,
    frameId: frameId,
    windowId: null,
    inline: false
  };
  pendingRequests.set(reqId, pending);
  promptByKey.set(key, reqId);
  if (tabId !== null) {
    promptCountByTab.set(tabId, (promptCountByTab.get(tabId) || 0) + 1);
  }

  const ask = {
    action: 'ghostQuickAsk',
    reqId: reqId,
    type: type,
    url: target ? target.href : String(request.url || ''),
    origin: pageOrigin || 'unknown'
  };

  return new Promise((resolve) => {
    pending.resolvers.push((verdict) => resolve({
      allowed: verdict.allowed,
      action: verdict.action,
      reason: 'prompt'
    }));
    dispatchDecision(reqId, pending, ask);
  });
}

// === UNIFIED ROUTER ===

const INTERNAL_ACTIONS = new Set([
  'toggle', 'addWhitelist', 'setWhitelist', 'getLogs', 'resolvePermission',
  'ghostStatus', 'requestPermission', 'swAttemptLog',
  'addBlacklist', 'setBlacklist',
  'addSpooflist', 'setSpooflist', 'removeDomain',      // v7.3.0
  'getSitePolicy', 'setPromptMode'                     // v7.3.0
]);
const EXTERNAL_ACTIONS = new Set(['ghostStatus', 'requestPermission', 'swAttemptLog']);
// v7.2.0/v7.3.0: every list mutation and every settlement stays
// internal-channel only — a page script must never be able to forge a
// prohibition, a grant, or a settlement. The Quick Bar lives in the
// ISOLATED-world bridge (extension code), so it uses the internal channel;
// its buttons are isTrusted-gated so a page cannot synthesize clicks.

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
    case 'addBlacklist':       return handleAddBlacklist(request);
    case 'addSpooflist':       return handleAddSpooflist(request);
    case 'setWhitelist':       return handleSetWhitelist(request);
    case 'setBlacklist':       return handleSetBlacklist(request);
    case 'setSpooflist':       return handleSetSpooflist(request);
    case 'removeDomain':       return handleRemoveDomain(request);
    case 'getSitePolicy':      return handleGetSitePolicy(request);
    case 'setPromptMode':      return handleSetPromptMode(request);
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
  if (changes.blacklist) {
    blacklistCache.clear();
    blacklistExpiry = 0;
  }
  if (changes.spooflist) {
    spooflistCache.clear();
    spooflistExpiry = 0;
  }
  if (changes.promptMode) {
    promptModeCache.value = changes.promptMode.newValue === 'window' ? 'window' : 'inline';
    promptModeCache.expiry = Date.now();
  }
  if (changes.enabled) {
    applyIconDebounced(changes.enabled.newValue !== false);
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    const sync = await chrome.storage.sync.get(['enabled', 'whitelist', 'blacklist', 'spooflist', 'promptMode']);
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
    if (sync.blacklist === undefined) patch.blacklist = ''; // v7.2.0 default
    if (sync.spooflist === undefined) patch.spooflist = '';  // v7.3.0 default
    if (sync.promptMode === undefined) patch.promptMode = 'inline'; // v7.3.0 default

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
