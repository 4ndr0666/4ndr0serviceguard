# 4ndr0serviceguard

<p align="center">
  <img src="https://raw.githubusercontent.com/4ndr0666/4ndr0serviceguard/refs/heads/main/icons/4ndr0serviceguard.svg" alt="4ndr0serviceguard Project Banner" width="100%">
</p>

[![version](https://img.shields.io/badge/version-7.1.1-blue.svg)](https://github.com/4ndr0666/4ndr0serviceguard)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**A dual-purpose Chrome Extension:**

- For **everyday users**: proactively disable Service Workers to improve browser performance, reduce tracking, and gain predictability.
- For **Red Team operators and penetration testers**: a tactical tool to neutralize client-side Service Worker defenses and expose hidden application logic.

---

## The Problem

Service Workers enable offline caching, push notifications, background sync, and request interception. While powerful, they introduce several issues:

- **Stale Content**: Aggressive caching can hide fresh data.
- **Unwanted Notifications & Background Activity**: Persistent prompts and silent network requests.
- **Performance & Battery Overhead**: Additional CPU and resource consumption.
- **Privacy Erosion**: Background execution without clear user visibility.
- **Security Obfuscation**: Client-side validation, request manipulation, and hidden API surface.
- **Persistence**: blocking *new* registrations is not enough — previously registered workers keep running and keep their caches (see the [reference technique](https://www.bugbugnow.net/2020/03/Reject-to-register-a-ServiceWorker.html)).

For power users, developers, and security professionals, having control over this layer is critical.

---

## The Solution: The Ghost Protocol

`4ndr0serviceguard` enforces a **default-deny Service Worker policy**. All registration attempts are intercepted and nullified unless the domain is explicitly whitelisted — and pre-existing registrations (plus their CacheStorage) are purged on load.

The **Ghost Protocol** (`ghost_core_v7.js`) is a stealthy, Proxy-based interception system that replaces `navigator.serviceWorker` with a controlled interface. It returns dynamically generated, convincing fake `ServiceWorkerRegistration` objects when blocking, so `toString()` checks, property identity, and instance checks all stay native-looking.

- Everyday users gain faster, cleaner, and more private browsing.
- Red Team operators can surgically dismantle Service Worker protections, reveal hidden endpoints, bypass client-side controls, and force legacy application paths.

---

## Features

### Core Features
- 🛡️ **Ghost Protocol v7.1**: Stealthy Proxy-based Service Worker nullification (`toString()`-transparent hooks)
- 🧹 **Purge-on-Load**: unregisters pre-existing Service Workers and clears CacheStorage on protected origins
- ✍️ **Enforced Whitelist**: domain + automatic subdomain support — whitelisted origins get real Service Workers, no prompts
- 🤫 **Dynamic API Mocking**: identity-stable fake objects minimize breakage and detection
- ⚡ **Instant Execution**: injected at `document_start` in the MAIN world (plus an ISOLATED-world bootstrap bridge)
- ✅ **Live Validation & Approval UI**: Electric-Glassmorphism popup with real-time blocked-attempt monitoring
- 🔄 **One-Click Approval**: allow individual attempts or the whole origin directly from the popup
- 🎚️ **Functional Master Toggle**: default-deny ↔ pass-through, reflected in the toolbar icon
- ✨ **Manifest V3**: modern, asynchronous architecture with restart-safe state

### Operator Enhancements (v6–v7.1)
- **Dual-Layer Hooking**: both `navigator.serviceWorker` and `ServiceWorkerContainer.prototype.register`
- **CSP Resilience**: prototype-level hooking + `securitypolicyviolation` listener
- **Live Blocked Attempts**: real-time visibility into intercepted Service Worker, WebSocket and SharedWorker attempts
- **WebSocket Firewall**: full phantom WebSocket with DDoS-Guard fast-path exemption and live property forwarding
- **Tri-Mode Integration**: one-click piping of the current page + blocked data into the tri-mode editor (URL hash + clipboard payload)
- **Violentmonkey Companion**: Service-Worker-focused userscript version (`ghost_core_v7.user.js`)

See [MITIGATION_LOG.md](MITIGATION_LOG.md) for the full v7.0 → v7.1 → v7.1.1 gap-closure record (v7.1.1: field-report hardening — failure-isolated IPC response delivery, lastError-safe prompt teardown, tab-close state eviction).

---

## How It Works

### Two-World Injection (v7.1)
MAIN-world scripts cannot use `chrome.*` APIs, so the extension runs two content scripts at `document_start`:

1. `ghost_bridge.js` (**ISOLATED** world) — publishes the extension ID into the DOM.
2. `ghost_core_v7.js` (**MAIN** world) — installs all hooks synchronously, then reaches the background through the `externally_connectable` messaging stub (`chrome.runtime.sendMessage(extensionId, …)`).

### Ghost Core (`ghost_core_v7.js`)
- Replaces `navigator.serviceWorker` with a memoized, identity-stable phantom container.
- Intercepts `register()` through Proxies over the native functions — stealth-faithful `toString()`, `name`, and `length`.
- Returns rich fake registrations by default; real registrations only after authorization.
- **Purges pre-existing registrations and clears CacheStorage** on protected origins (bugbugnow.net technique).
- Includes a secondary prototype-level hook for increased CSP resistance.
- Listens for CSP violations related to workers.

### WebSocket Handling
- Full phantom WebSocket implementation (buffered sends, live event/property forwarding) with DDoS-Guard fast-path exemption.
- Gatekept via the same permission system.

### Background Controller (`background.js`)
- Unified router: internal extension pages (`onMessage`) + the Ghost Core (`onMessageExternal`, action-restricted and rate-limited).
- Enforcement order per gate request: rate limit → master toggle → DDoS-Guard → whitelist → interactive prompt.
- Prompt lifecycle is fully managed (dedup, per-tab caps, close-to-deny, restart-safe request IDs).
- Maintains whitelist and toggle state in `chrome.storage.sync`; telemetry in `chrome.storage.local` with serialized writes.

### Popup UI
- Electric-Glassmorphism design.
- Master Ghost Protocol toggle (icon follows state).
- Live blocked attempts list with per-item approval.
- Whitelist management.
- Direct "Send to tri-mode" integration.

---

## Red Team Operational Scenarios

### 1. Bypassing Client-Side Validation
Disable Service Workers on targets that use them for request signing, token injection, or payload encryption. Raw traffic becomes visible to interception proxies.

### 2. De-cloaking Hidden Endpoints
Many modern applications route all API calls through a Service Worker. Nullifying it often forces the application to fall back to direct requests, exposing real backend infrastructure.

### 3. Forcing Legacy Fallback Paths
Complex PWAs frequently contain older, less hardened code paths that only activate when Service Workers are absent. This can surface legacy vulnerabilities.

---

## Installation

Not available on the Chrome Web Store. Load unpacked:

```bash
git clone https://github.com/4ndr0666/4ndr0serviceguard.git
```

1. Navigate to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the project folder

Requires Chrome 111+ (`"world": "MAIN"` support).

---

## Usage

1. Click the extension icon to open the control popup.
2. Toggle **Ghost Protocol** (default: enabled = default-deny). The toolbar icon follows the state.
3. Add trusted domains to the whitelist (one per line). Subdomains are matched automatically.
4. Reload target tabs after making changes.
5. When a page attempts a Service Worker / WebSocket / SharedWorker connection, the Gatekeeper prompt appears: **AUTHORIZE** (one-shot allow) or **DENY (SPOOF)**. The popup's live list offers permanent per-domain approval.

For quick personal use, the Violentmonkey companion script (`ghost_core_v7.user.js`) is also available — it enforces Service-Worker blocking with purge + cache clearing and uses `@exclude` lines as its whitelist.

---

## Tactical Notes

- The extension applies default-deny immediately upon injection.
- Use the whitelist surgically during engagements.
- The popup shows live blocked attempts for rapid decision-making.
- The tri-mode integration pipes the current page and blocked-attempt data through the URL hash and the clipboard.
- The `externally_connectable` surface is restricted to three actions (`ghostStatus`, `requestPermission`, `swAttemptLog`), rate-limited per tab; page scripts cannot forge an allow — every allow still requires your consent or an explicit whitelist entry.

---

## Mechanism of Action (v7.1)

- **Dual-Layer Interception**: `navigator.serviceWorker` + `ServiceWorkerContainer.prototype.register`
- **Proxy Camouflage**: all hooks are Proxies over native functions — `toString()`, `name`, `length` stay native
- **Dynamic Mocking**: identity-stable fake registrations with functional event targets
- **Purge-on-Load**: pre-existing registrations unregistered, CacheStorage cleared
- **CSP Awareness**: prototype hook + violation event listener
- **Surgical Restoration**: whitelisted origins pass through to the real API
- **Event Emission**: real-time telemetry of blocked and allowed attempts

---

## Customization

No build step required. Edit `ghost_core_v7.js`, `popup.js`, or `background.js` directly and reload the extension.

---

## Version History (Relevant)

- **v7.1.0** — Gap-mitigation release: purge-on-load + cache clearing, enforced whitelist, functional master toggle, working popup/background IPC, restart-safe telemetry, Proxy camouflage, live WebSocket property forwarding, userscript companion, LICENSE, 50-item gap closure (see [MITIGATION_LOG.md](MITIGATION_LOG.md))
- **v7.0.0** — Prototype-level hooking and CSP violation handling
- **v6.0.0** — Major UI overhaul (Electric-Glassmorphism), live blocked attempts, tri-mode integration
- Earlier versions used the older "pacifier" naming and Nullifier Protocol

---

## Contributing

Pull requests and issues are welcome. Focus areas include further CSP hardening, additional API coverage, and UI/UX improvements.

---

## License

Licensed under the MIT License. See [LICENSE](LICENSE).
