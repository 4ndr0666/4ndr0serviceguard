# Mitigation Log — v7.0.0 → v7.1.0 → v7.1.1 → v7.2.0 → v7.3.0

Baseline: commit `602c1c4` ("Bumped to version 7.0"). Candidate: v7.3.0
(v7.1.0 = commit `67253b1`, superseded by the field-report hardening below;
v7.1.1 baseline = commit `104c844` "created helper script for GUP audit";
v7.2.0 = commit `264fa5b`, the blacklist/completion release — and the baseline
for this cycle's superset verification).
Reference: https://www.bugbugnow.net/2020/03/Reject-to-register-a-ServiceWorker.html
(and, "not limited to": Chrome extension platform documentation, MV3 lifecycle
semantics, and the repository's own historical design intent).

Superset protocol: every baseline behavioral guarantee is preserved or
strengthened. Where a baseline mechanism was broken-by-construction (dead file
references, dead IPC, inverted logic), the *intent* of the feature is preserved
and re-implemented on a working mechanism.

---

## P0 — Load-blocking defects

| Gap | Resolution |
|-----|------------|
| G-01 `manifest.json` referenced nonexistent `ghost_core_v6.js` — extension could not load | Content script renamed `pacifier_v7.js` → `ghost_core_v7.js` (matches README), manifest now references the real file. |
| G-02 `"permissions": ["windows"]` is not a valid Chrome permission — manifest load error | Removed. `chrome.windows` requires no permission. Unused `webNavigation`, `scripting` and `host_permissions` also removed (dead surface; the scripting API was only used by the broken restore injection). |
| G-03 Manifest version `6.0.0` vs README/commit `7.0` | Version unified to `7.1.0`; description updated to Ghost Protocol v7. `minimum_chrome_version: 111` added (requirement for `"world": "MAIN"`). |

## P0 — Architecture

| Gap | Resolution |
|-----|------------|
| G-04 MAIN-world script called `chrome.runtime.sendMessage` — unavailable in the MAIN world; every interactive feature (prompts, whitelist, toggle, telemetry) has been dead since v5 | Two-world design: `ghost_bridge.js` (ISOLATED world) publishes the extension ID into the DOM at `document_start`; `ghost_core_v7.js` (MAIN world) reaches the background through the `externally_connectable` page stub (`chrome.runtime.sendMessage(extensionId, …)`), with the internal form as forward-compatible fallback. The stub is captured at document_start (immune to later page shadowing). |
| G-05 `debouncedRestore` injected nonexistent `pacifier_v5.js` into whitelisted tabs, and injecting the *blocker* into whitelisted tabs is inverted logic | Restore re-implemented with identical intent on a working mechanism: the gate itself auto-allows whitelisted origins (`requestPermission` step 4), so whitelisted pages get real Service Workers with zero script injection. |
| G-06 Whitelist was never enforced — `requestPermission` never consulted it | Whitelist check added to the gate (page origin and resolved target origin), with auto-allow and `whitelist` telemetry source. |
| G-07 Master toggle (`enabled`) was stored but read by nothing | `ghostStatus` IPC + gate step 2 enforce it globally; popup toggle drives the same flag; action icon reflects state. |
| G-08 Popup↔background protocol mismatch (`type:` vs `action:` keys, four unhandled message kinds) | Popup rewritten against the canonical router: `toggle`, `addWhitelist`, `setWhitelist`, `getLogs`. All baseline background actions preserved. |
| G-09 Storage split-brain (local array vs sync string; `ghostActive` vs `enabled`) | Canonical state: `chrome.storage.sync` `enabled` + `whitelist` (newline string). One-time legacy migration in `onInstalled` (and idempotent popup fallback). |

## P1 — Telemetry

| Gap | Resolution |
|-----|------------|
| G-10 `swAttemptLog` schema mismatch (stored `scriptURL`/`context` as `undefined`) | Unified schema `{type, target, origin, pageUrl, tabId, timestamp, allowed, source, detail?}` with legacy-field fallbacks. |
| G-11 Blocked Service Worker registrations were never logged | `emitBlockedAttempt` wired into the blocked path of both SW hook layers. |
| G-12 Denied WebSockets were never logged (v5 regression) | Denied/allowed WebSocket outcomes both logged with the `allowed` flag. |
| G-13 `new URL(attempt.target \|\| '')` threw and crashed the popup render | `safePath()`/`hostOf()` helpers resolve against a dummy base and never throw. |
| G-14 innerHTML built from page-controlled URLs (XSS into extension page) | All rendering uses `createElement` + `textContent`. |
| G-15 "CURRENT PAGE — BLOCKED" listed attempts from every origin | Renders are filtered by active tab origin, with graceful fallback. |
| G-16 Read-modify-write race on `detailedAttempts` | All telemetry writes serialized through a single storage queue. |

## P1 — IPC & lifecycle

| Gap | Resolution |
|-----|------------|
| G-17 Prompt closed unanswered leaked the response channel; `register()` hung forever | `chrome.windows.onRemoved` settles pending requests as deny; ghost-side 120 s last-resort timeout auto-denies. |
| G-18 MV3 SW restart wiped `swBlocks` (in-memory map overwritten storage) | `logBlock` performs serialized read-merge-write against storage. |
| G-19 `nextRequestId` reset on restart (ID collisions) | Seeded from `Date.now()` — monotonic across restarts. |
| G-20 prompt.js double-resolve race (beforeunload after button click) | Single-settlement `resolved` guard; `settleRequest` is idempotent. |
| G-21 `chrome.windows.create` failure hung the gate | Failure path settles the request as deny. |
| G-22 Identical requests spammed prompt windows | Dedup by `type+target+origin` (chained resolvers) + per-tab concurrent prompt cap. |
| G-23 No rate limiting on page-originated messages | Per-tab sliding-window limits for gate (40/min) and telemetry (60/min); external channel restricted to three safe actions. |

## P1 — Feature fidelity (bugbugnow.net techniques and beyond)

| Gap | Resolution |
|-----|------------|
| G-24 Pre-existing Service Workers kept running (article: unregister them) | `purgeExistingWorkers()` on every active page load: `getRegistrations()` → `unregister()`. |
| G-25 CacheStorage never cleared (article: clear after unregister) | Caches cleared only when registrations existed, exactly per the article's spec. |
| G-26 New fake container object on every access — identity detection vector | Memoized singleton container; `navigator.serviceWorker === navigator.serviceWorker` now holds. |
| G-27 Hooks were not `toString()`-transparent | All replacement points are Proxies over the native functions — `toString()`, `name`, `length` stay native (article v0.3.0 technique). |
| G-28 Fake container `addEventListener`/`dispatchEvent` were no-ops (controllerchange was dead theater) | Functional event target on container, registrations and active workers; `on*` accessors wired. |
| G-29 WebSocket phantom did not live-forward `on*`, `binaryType`, `protocol`, `extensions`, `bufferedAmount` | Accessor-based live forwarding to the real socket; `binaryType` transfers on connect. |
| G-30 Phantom lacked `removeEventListener`/`dispatchEvent` | Implemented with buffer-consistent semantics. |
| G-31 `WebSocket.CONNECTING/OPEN/CLOSING/CLOSED` statics were lost | Proxy construct trap forwards all statics to the native constructor. |
| G-32 SharedWorker ignored its own gate result — always threw even when allowed | Ghost-inactive origins construct real SharedWorkers; an AUTHORIZE verdict latches page-lifetime allow, so retries succeed; deny path still throws the baseline `SecurityError`. |
| G-33 SharedWorker attempts unlogged | Telemetry wired. |
| G-34 Fake registration: unresolved scriptURL, unstable identity, ignored `options.scope` | Absolute resolution, memoized instances (`update()` returns the same object), scope honored. |
| G-35 `getRegistration(s)`/`ready`/`controller` always faked, even for inactive origins | All pass through to the real container when the ghost is inactive for the origin. |
| G-49 Allowed registrations were gated twice (fake → `realSW.register` → prototype hook) | The container calls the *captured original* register directly — exactly one gate evaluation per registration. |

## P2 — Integration & UX

| Gap | Resolution |
|-----|------------|
| G-36 Tri-mode pipe was a `console.log` stub | Payload is delivered via URL hash (`#sGuardData=…`, 32 KB bound) and clipboard (async API + `execCommand` fallback), with status feedback. |
| G-37 Popup performed the initial attempt load twice | Single bootstrap load after tab resolution. |
| G-38 Popup ALLOW buttons had no backend handler | Event-delegated `addWhitelist` calls with button state feedback. |
| G-39 `disabled16/48/128.png` orphaned icons | Wired to `chrome.action.setIcon` for the disabled state (applied at boot, on toggle, and on storage change). |
| G-40 README linked a nonexistent LICENSE | MIT `LICENSE` file created (matches the README badge). |
| G-41 README claimed a Violentmonkey companion that did not exist | `ghost_core_v7.user.js` created: article-faithful (purge + cache clear + `exportFunction` fallback + Proxy replacement) with 4ndr0 stealth fakes and `@exclude` whitelist. |
| G-42 Stale branding ("SERVICE GUARD v2", "Ghost Protocol v6") | Unified to v7 across popup and manifest. |
| G-43 Dead manifest surface (`webNavigation`, `scripting`, `host_permissions`) | Removed with the broken injection path (see G-02/G-05). |
| G-44 Empty catch blocks | Every catch is specific and debug/error-logged per the scoped-interceptor rule. |
| G-45 No `onInstalled` defaults/migration | Defaults set, legacy keys migrated and cleaned. |
| G-46 `whitelistCache` invalidated only by a 30 s TTL | `storage.onChanged` invalidation added. |
| G-47 Relative scriptURL broke `isWhitelisted` URL parsing | Gate resolves targets against the sender page origin before matching. |
| G-48 Action icon never reflected state | See G-39. |
| G-50 Late binding of the `chrome` global could be shadowed by the page | Runtime stub captured at document_start. |

## Baseline behaviors intentionally preserved (superset verification set)

- Default-deny policy with stealth fake registrations (never rejections).
- `debounce()` utility — preserved byte-identical to the baseline (GUP verdict
  UNCHANGED) and given a live role: batching toolbar-icon updates when the
  master toggle is flipped rapidly (its original anti-thrash intent).
- Dual-layer SW hooking (instance property + prototype level).
- DDoS-Guard WebSocket fast path with the exact four-pattern heuristic
  (`pacifier_v5` there matches DDoS-Guard's challenge script path — it is a URL
  heuristic, not a file reference).
- CSP `securitypolicyviolation` telemetry.
- WebSocket phantom buffering semantics and the 40 ms denied-event cadence.
- `controllerchange` dispatch 25 ms after a blocked registration.
- `SharedWorker` deny message text and `SecurityError` type.
- `addWhitelist` / `getLogs` / `swAttemptLog` / `requestPermission` /
  `resolvePermission` / `toggle` IPC actions and response shapes.
- `swBlocks` + `detailedAttempts` storage keys and the 1000-entry bound.
- Electric-Glassmorphism UI design, fonts, glyph and layout.
- `window._4ndr0ghostV7` guard flag, `noise()` configurability jitter (12%),
  subdomain whitelist matching, punycode normalization.

---

# v7.1.1 — Field-report hardening (`background.js:505`)

**Report:** after deploying v7.1.0, Chrome's extension error page showed an
entry attributed to `background.js:505 (anonymous function)`.

**Root cause:** line 505 is the `console.error` inside the D6
`unhandledrejection` boundary — meaning a *real* promise rejection was leaking
somewhere in the service worker and the boundary (working exactly as designed)
was surfacing it. The leak was in the unified router: when a handler rejected
(storage quota, sync write limit, or context invalidated during extension
reload/teardown) **and** the message port was already dead (popup closed, page
navigated), the `.catch` callback's `sendResponse` call itself threw
("Attempting to use a disconnected port object"). That throw escaped the
callback with no downstream handler → unhandled rejection → D6 boundary logged
it at line 505, and Chrome's error collector attributes `console.error` call
sites as `source:line (function)` — hence the reported entry.

| Gap | Resolution |
|-----|------------|
| G-51 Router leaked unhandled rejections when response delivery failed on a dead port / invalidated context (the reported 505 entry) | New `safeRespond()` helper: every `sendResponse` call (success, error, and sync-exception paths) is wrapped in a scoped try/catch that logs at debug level; a terminal `.catch` on the router chain adds defense in depth. It is now structurally impossible for the router to emit an unhandled rejection. |
| G-52 `chrome.windows.remove(windowId)` was callback-less — the prompt page's own `window.close()` races the background's removal, producing "Unchecked runtime.lastError: No window with id" error-page entries | Removal now carries a lastError-reading callback (`void chrome.runtime.lastError`), mirroring Chrome callback hygiene everywhere else. |
| G-53 `tabs.onUpdated` read `tab.status` unguarded — Chrome can deliver teardown-race events with no tab object → uncaught TypeError in an anonymous listener | `changeInfo && tab` guard added; normal events still record navigation telemetry identically. |
| G-54 `rateWindows` / `promptCountByTab` were never evicted for closed tabs — unbounded state growth across the service worker's lifetime and stale prompt-cap counts | New `chrome.tabs.onRemoved` listener evicts both Maps per closed tab (no additional permission required). Verified safe against in-flight prompts: `settleRequest` already tolerates missing entries. |
| G-55 `handleAddWhitelist` compared raw stored lines against the normalized domain — mixed-case legacy entries (`Example.COM`) duplicated instead of deduping | Stored lines are normalized before the dedupe check; the `exists` path never rewrites storage; rewrites canonicalize to the same normalized form `setWhitelist` produces. |
| G-56 Popup rendered fake success when the background failed (send resolves `null` on dead channel; `{status:'error'}` on handler rejection) and three chrome callbacks (`storage.sync.get`, `tabs.query` ×2, `tabs.create`) skipped the `runtime.lastError` read | Every callback now reads `void chrome.runtime.lastError`; toggle / addWhitelist / setWhitelist / clear callers branch on null/error results and surface an explicit failure status instead of success text. |

**Validation:** behavioral harness extended from 79 to 99 cases, including a
faithful reproduction of the field report (handler rejection + dead port →
assert zero unhandled rejections at the host level), dead-port delivery
isolation with router survival, window-remove race, undefined-tab teardown
event, tab-close state eviction (rate window + prompt cap), mixed-case
whitelist dedupe, and D6-boundary backstop semantics. Static consistency gate
PASS; GUP certification PASS against **both** reference versions (v7.0
baseline `602c1c4` and v7.1.0 predecessor `67253b1`): 0 MISSING units, 28/28
background units carrying semantic verdicts.

---

# v7.2.0 — Blacklist enforcement, helper-userscript completion, 3lectric-Glass alignment

Reference: the golden-unit-protocol v5.3.1 execution contract, the
4NDR0666OS "3lectric-Glass" UI/UX specification (glm repo, /resources), and
the 4ndr0666 branding glyph. Superset protocol: every v7.1.1 behavioral
guarantee is preserved or strengthened; nothing is removed.

## P0 — Helper userscript completion (`userscript/4ndr0tools - 4ndr0serviceguarder.user.js`)

The unfinished draft (v6.0.0) was non-functional as a page-context guard:

| Gap | Resolution |
|-----|------------|
| G-57 Whitelisted SW registration recursed infinitely — the fake `register` called `navigator.serviceWorker.register`, which resolved back to its own fake getter (stack overflow; whitelisted domains could never actually register) | The original `register` is captured once before any hook; the pass-through path calls the captured original, never the live (possibly hooked) property. |
| G-58 Hooks landed in the userscript-manager sandbox — `window.WebSocket = ...` patched the sandbox window, not the page (no `unsafeWindow` grant) | `@grant unsafeWindow` added; every hook targets the page window passed as the IIFE argument. |
| G-59 Non-stealth hooks: plain-function `WebSocket` replacement (`toString()`-dumpable, statics lost — `WebSocket.CONNECTING === undefined`) and a new fake container object on every `navigator.serviceWorker` access (identity-detection vector) | Full Ghost Core v7 doctrine ported: Proxy construct trap (statics, `name`, `length`, `toString()` forward to the native constructor), memoized identity-stable phantom container, `Symbol.toStringTag` fidelity. |
| G-60 No purge-on-load, no SharedWorker gate, no CSP violation listener, no master toggle, no blacklist | All ported from `ghost_core_v7.js` with local-policy equivalents: `purgeExistingWorkers()`, SharedWorker `SecurityError` gate, `securitypolicyviolation` listener, `enabled` GM-storage toggle, blacklist registry. |
| G-61 DDoS-Guard heuristic matched only 1 of the 4 baseline patterns | Full four-pattern check (`ddos-guard.net`, `check.ddos-guard`, `pacifier_v5`, `/.well-known/ddos-guard/`). |
| G-62 Stale `@downloadURL`/`@updateURL` pointing at a different repository and a nonexistent filename | Both point at the canonical location in this repository (`userscript/…user.js` on `refs/heads/main`). |
| G-63 Menu commands registered in every iframe (registration spam on framed pages) | Menus register in the top frame only (`win.top === win`, cross-origin safe); hooks still cover all frames. |
| G-64 Extension/userscript double gating (both would hook `WebSocket`/`register` and both would prompt) | Companion-mode doctrine: if the extension's guard flag is set at install time, the helper installs no hooks (utility layer only); if the helper installed first, every hook lazily detects the flag at call time and becomes a transparent conduit — the extension's Gatekeeper runs exactly once in either injection order. |
| G-65 No visible control surface while browsing | 3lectric-Glass status HUD (menu command "Show status HUD (Ψ)"): closed shadow root (page CSS cannot leak in or out), Ψ glyph, Orbitron/JetBrains Mono local font stacks, per-session AbortController listener reclamation, whitelist/blacklist/purge quick actions. |
| G-66 Baseline whitelist user data would be lost on upgrade | The GM storage key `4ndr0guard_whitelist_v6` is preserved verbatim (legacy array or string accepted). |

## P0 — Blacklist enforcement (extension)

| Gap | Resolution |
|-----|------------|
| G-67 No blacklist — the whitelist was the only explicit policy surface | `blacklist` sync-storage key + cached registry (same TTL/TTL-invalidation discipline as the whitelist). Gate order is now rate limit → **blacklist hard-deny** → master toggle → DDoS-Guard → whitelist → prompt. A blacklisted target or page origin is denied absolutely — before pass-through mode and before any allow path. |
| G-68 Whitelist and blacklist could silently disagree (domain on both lists) | Single-domain adds are mutually exclusive: `addWhitelist` prunes the conflicting blacklist entry and vice versa. Bulk saves replace exactly one list; a domain on both lists after independent bulk edits resolves to deny (blacklist first). |
| G-69 Page scripts could forge prohibitions via the external channel | `addBlacklist`/`setBlacklist` are internal-channel actions only — the external action set stays restricted to `ghostStatus`, `requestPermission`, `swAttemptLog`. |
| G-70 The Gatekeeper prompt could only deny once (the same attempt would re-prompt) | New BLACKLIST DOMAIN button (destructive-styled): settles the request as a denial AND permanently blacklists the prompted domain (`resolvePermission`'s optional `blacklist`+`domain` grant; a failed blacklist write never swallows the settlement). |
| G-71 The popup offered approval but no prohibition path for observed attempts | Per-item BLOCK buttons (destructive-styled) alongside ALLOW, plus a dedicated blacklist textarea with SAVE/CLEAR and failure-surfaced status messages. |
| G-72 Ghost Core was unaware of blacklisted origins (`ghostStatus` response had no blacklist signal) | `handleGhostStatus` returns `blacklisted`; the Ghost Core keeps a blacklisted origin guarded even when the master toggle is off or the origin is whitelisted — matching the background gate's order exactly. |

## P1 — Stealth & architecture hardening

| Gap | Resolution |
|-----|------------|
| G-73 Phantom container's `constructor` resolved to `Object` — an identity-detection vector (`navigator.serviceWorker.constructor !== ServiceWorkerContainer`), and layered companions capturing the container second would hook `Object.prototype` | Constructor fidelity in both `ghost_core_v7.js` and the helper userscript: the phantom container reports the real `ServiceWorkerContainer` constructor. |
| G-74 Helper userscript's denied WebSocket surfaced CLOSED immediately after construction (native handshakes stay CONNECTING) and fired error events even after page-initiated `close()` | The phantom stays CONNECTING for the 40 ms cadence window (sends buffer, native semantics), then settles CLOSED with error+close; a page-initiated `close()` yields close-only (native behavior). |
| G-75 HUD listeners accumulated across open/close cycles | Per-session `AbortController` — `closeHud()` aborts both document listeners unconditionally (D4). |
| G-76 Deny notifications, if ever enabled, could spam unboundedly | Bounded and throttled: max 20 per session, min 8 s between notifications, off by default (stealth doctrine). |

## P2 — 3lectric-Glass specification alignment

| Gap | Resolution |
|-----|------------|
| G-77 Typography: Roboto Mono everywhere; spec mandates JetBrains Mono (system/data) + Orbitron 700 (display titles); Cinzel Decorative is glyph-only | Google Fonts payload swapped to JetBrains Mono + Orbitron + Cinzel Decorative; HUD uses local font stacks (no remote fetch from host pages). |
| G-78 Glass levels: popup panel at rgba(10,19,26,0.25) — spec levels are 0.72 (window) / 0.65 (menu-popup) / 0.55 (panel-input) / 0.95 (header) | All surfaces remapped to the spec glass levels; body uses the Matrix Deep Base rgb(10,19,26). |
| G-79 Transitions: 300ms — spec mandates 150ms ease-in-out on all state changes | Global 150ms ease-in-out across popup, prompt and HUD. |
| G-80 No destructive-action surfaces — DENY/CLEAR/BLOCK were styled like standard controls despite triggering irreversible prohibitions | Spec 4.5 destructive styling (#ff0055 border/text, rgba(255,0,85,0.3) hover wash, 25px glow, white active text) applied to DENY-adjacent controls, blacklist textareas, CLEAR and BLOCK buttons. |
| G-81 Idle buttons had transparent borders — spec 4.4 mandates 1px solid rgba(0,229,255,0.4) cyan terminals, radius 0 (rectangular brutalism) | Full spec 4.4 button topology: glass-level-2 idle background, cyan idle border, hover cyan wash + 20px glow, active 0.3 wash + white text, radius 0. |
| G-82 Scrollbars unstyled — spec 4.8 mandates subdued troughs with #00E5FF sliders (0 radius, 6px minimum) | WebKit scrollbar styling + Firefox `scrollbar-width`/`scrollbar-color` equivalents on the blocked list. |
| G-83 Headerbar was translucent — spec 4.3 anchors it near-opaque (0.95) with a 2px cyan termination line | Headerbars rebuilt on the solid-header token with the hard termination line; titles Orbitron 700 #67E8F9; subtitles rgba(0,229,255,0.7). |

## Version unification

| Gap | Resolution |
|-----|------------|
| G-84 Version fragmentation: manifest 7.1.1, `ghost_core_v7.user.js` 7.1.0, helper userscript 6.0.0, README badge 7.1.1 | Unified bump to **7.2.0** across manifest, README badge, both userscripts, every file header, the popup subtitle and version chip, and the HUD subtitle. |

**Validation:** all files pass `node --check`; the manifest parses and its
description stays within Chrome's 132-character bound (119). Behavioral
harness: gate-order verification (blacklist before toggle and whitelist,
including the blacklisted+toggle-off and blacklisted+whitelisted cases),
mutual-exclusion pruning in both directions, prompt-blacklist settlement,
external-channel forgery rejection, rate limiting, telemetry bounds,
dead-port delivery isolation, ghost-status blacklist propagation, and the
helper userscript's standalone gate matrix (deny default, whitelist allow,
blacklist override, DDoS-Guard fast path, extension-active deferral,
denied-event cadence). GUP v5.3.1 proof chain executed against the v7.1.1
baseline `104c844`: atomization + SHA-256 unit comparison, per-unit semantic
superset verdicts, bidirectional dependency/capability alignment, inventory,
and the mandatory validation gate. See the GUP evidence bundle.

**Baseline behaviors intentionally preserved (superset verification set,
v7.2.0 additions in bold): the full v7.1.1 set above, plus** the helper
userscript's baseline guarantees (GM storage whitelist key and format, list
matching semantics, menu-command UX with prompt/confirm dialogs,
@match/@run-at coverage, the Ψ @icon and the `__4ndr0ghostUserV7` guard
flag) — re-implemented on working, stealth-faithful mechanisms.

---

# v7.3.0 — Quick-Decision Cycle (field report)

Field report: *"The goal with the 'blacklist' was to stop the annoying popup
on sites I already know I want to spoof by default but that does not seem to
be working. The popup action itself is the undesirable part… When I wrote
the userscript I had convenience of selecting to deny or authorize a wss://
or ws:// connection that much more conveniently or quickly. If that can also
be implemented at the app level that would be ideal."*

Root-cause analysis identified six compounding defects (G-85…G-89, G-96);
one of them (G-85) reproduces the report exactly: the user blacklisted sites
through the userscript's menus while the extension governed the page — the
edit landed in GM-local storage, the extension never learned of it, and its
prompt kept firing.

## P0 — Field-report root causes

| Gap | Resolution |
|-----|------------|
| G-85 Split-brain policy stores: on extension-governed pages the helper userscript's Whitelist/Blacklist menu commands wrote GM-local lists only — the extension never learned, so its prompt persisted (the exact reported symptom) | **Policy bridge**: the userscript now posts a `policyRequest` window message; `ghost_bridge.js` answers with a CONFIRM bar (3lectric-Glass, `isTrusted`-gated) and only a genuine click writes the REAL extension list over the internal channel. Local GM lists stay intact for standalone pages; the HUD explains the routing. |
| G-86 `prompt.js` computed the BLACKLIST grant from the *WS endpoint host* (`new URL(reqUrl).hostname`), not the page origin — one grant covered a single endpoint, every other endpoint/SW on the site re-prompted | Remembered grants are **site-scoped by default**: `remember:'site'` keys the page-origin host. Endpoint granularity remains available via the Quick Bar's scope selector and the popup's per-attempt buttons. The v7.2 button's deny+blacklist settlement semantics are preserved (now site-scoped). |
| G-87 `normalizeDomain` only lowercased + stripped punycode markers — an entry like `https://example.com/` NEVER matched a hostname (the userscript already normalized correctly; pasted URLs silently no-oped) | Robust normalization: scheme, protocol-relative slashes, path, query, fragment, port and boundary dots are stripped; bare domains normalize identically to v7.2 (superset). |
| G-88 No silent auto-spoof list existed — the user's "sites I spoof by default" had no surface; v7.2 offered only allow-list and kill-list | **Spooflist** (`chrome.storage.sync` key + cached registry + gate step 2.5 + GM sibling key in the userscript): spooflisted targets/origins settle `action:'spoof'` with NO interactive decision — pacified sockets, zero prompts. |
| G-89 The prompt was a focus-stealing OS window (`chrome.windows.create` `focused:true`) — the intrusive part of the report — and the dedup key included the full URL, so token-bearing sockets (`wss://host/ws?token=…`) were distinct every load | **In-page Quick Bar** (default surface): bottom-right 3lectric-Glass bar in a closed shadow root, one click / one key, 30 s auto-deny countdown, no OS focus stealing. Dedup canon is now `scheme://host:port/path` (query/fragment stripped). The prompt window is preserved verbatim as fallback and as the explicit `promptMode:'window'` preference. |

## P1 — Three-way action model

| Gap | Resolution |
|-----|------------|
| G-90 The gate protocol was boolean — there was no way to express "pacify" at the extension level; DENY killed sockets, and sites that hard-require a live socket nag, retry or fall back to noisier channels | **AUTHORIZE / SPOOF / DENY** actions end-to-end: gate responses carry `action`; `resolvePermission` settles with an action; the Ghost Core's phantom pacifies on `spoof` (CONNECTING→OPEN at the 40 ms cadence, synthetic open, sends swallowed silently, `bufferedAmount` 0, `close()` honored with a clean code-1000 close) and preserves v7.2's error+close denial verbatim on `deny`. |
| G-91 SharedWorker semantics for the new action were undefined | Doctrine fixed and mirrored in both components: both `deny` and `spoof` keep the baseline SecurityError (MessagePort-surface pacification out of scope; documented in code and README). |
| G-92 Settlement protocol had no forward-compatible shape | New shape `{decision:'allow'\|'spoof'\|'deny', remember, domain}` with full v7.2 backward compatibility: `{allowed, blacklist:true, domain}` still settles AND blacklists; boolean-only messages coerce to allow/deny. The decision key is deliberately named `decision` — `action` is the router's dispatch key, and a duplicate-key collision there would silently misroute the settlement (the harness caught exactly this during development: 11 red → fixed in background, bridge and prompt before release). |

## P1 — Quick Bar security & lifecycle

| Gap | Resolution |
|-----|------------|
| G-93 An in-page decision UI rendered in the MAIN world would be forgeable (the page could synthesize its own AUTHORIZE click) | The Quick Bar is rendered by `ghost_bridge.js` in the ISOLATED world (extension code): closed shadow root, every handler rejects `isTrusted === false` events, and settlement travels over the INTERNAL `chrome.runtime` channel — the external channel still rejects `resolvePermission`. A page cannot press its own authorize button. |
| G-94 An in-page bar that failed to render would hang the gate until the 120 s last-resort timeout | Synchronous render acknowledgment (`{status:'shown'}`); on miss (no DOM, frame gone, queue full) the background falls back to the v7.2 prompt window within 1.6 s. Cross-surface settlements dispatch `ghostQuickDismiss` so a superseded bar always leaves the screen. |
| G-95 The policy bridge's request surface is page-forgeable — a hostile page could spam CONFIRM bars | Contained: session cap (6), minimum show interval (1.5 s), queue cap (2), 12 s auto-IGNORE, `isTrusted`-gated CONFIRM, and kind whitelist (`whitelist`/`spooflist`/`blacklist`/`reset`/`toggle` only). Timeout NEVER confirms. |

## P2 — App-level convenience (the explicit request)

| Gap | Resolution |
|-----|------------|
| G-96 No fast authorize/deny at the app level — the convenience the user praised in their original userscript existed only in Tampermonkey menus | The Quick Bar (in-page, one key) + the toolbar popup's **CURRENT SITE panel** (live policy badges + one-click AUTHORIZE / SPOOF / BLOCK / ASK AGAIN via `getSitePolicy`/`removeDomain`) + per-attempt SPOOF buttons join ALLOW/BLOCK. |
| G-97 No spooflist management surface in the popup | Spooflist textarea (SAVE/CLEAR, failure-surfaced status), amber-accented 3lectric-Glass controls, live badge, HUD row, userscript menu pair (add + edit + clear). |
| G-98 The prompt window had no keyboard path | A/S/D + Enter (authorize, the v7.2 default-focus doctrine) + Esc (deny) in both the prompt window and the Quick Bar, with hint legends. |
| G-99 No user preference for the decision surface | `promptMode` sync setting (`inline` default / `window`), segmented control in the popup, TTL-cached in the background, storage-reactive. |

## Version unification

| Gap | Resolution |
|-----|------------|
| G-100 Version fragmentation across the suite after the v7.2.0 release | Unified bump to **7.3.0**: manifest, README badge, both userscripts, every file header, popup subtitle + version chip, HUD subtitle. |

**Validation:** all files pass `node --check`; the manifest parses with a
130-character description (≤132 bound). Behavioral harness extended and
re-run: the full v7.2.0 matrix (gate order incl. blacklist-before-toggle and
blacklist-before-whitelist, mutual exclusion both directions, prompt-blacklist
settlement, external-channel forgery rejection, rate limits, telemetry bounds,
dead-port isolation, tab-close eviction, storage invalidation) — plus the
v7.3.0 matrix: spooflist gate position (after blacklist, before toggle),
action propagation (allow/spoof/deny) through gate responses and
settlements, site-scope grant computation, v7.2 settlement-shape
compatibility, three-way mutual exclusion, removeDomain, getSitePolicy,
promptMode dispatch with window fallback, query-stripped dedup, robust
normalization (schemes/paths/ports/boundary dots), Quick-Bar dismiss on
external settlement, and the userscript's spooflist decide matrix, pacified
phantom (open cadence, swallowed sends, clean close) and policyRequest
emission. GUP v5.3.1 proof chain executed against the v7.2.0 baseline
(`264fa5b`): atomization + SHA-256 unit comparison, per-unit semantic
superset verdicts, bidirectional alignment, inventory, and the mandatory
validation gate. See the GUP evidence bundle.

**Baseline behaviors intentionally preserved (superset verification set,
v7.2.0 → v7.3.0): the full v7.2.0 set above, plus** the v7.2.0 blacklist
doctrine (absolute, pre-toggle, mutually exclusive), the prompt window path
(now fallback + preference, behavior verbatim), the v7.2 settlement message
shape, the deny-cadence phantom (error+close at 40 ms), ghostStatus flags
(additive), the helper userscript's GM key set (additive sibling for the
spooflist) and its deferral doctrine — with the policy bridge as the only
crossing between the two stores, gated by a genuine click.
