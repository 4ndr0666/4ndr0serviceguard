# 4ndr0serviceguard

<p align="center">
  <img src="https://raw.githubusercontent.com/4ndr0666/4ndr0serviceguard/refs/heads/main/icons/4ndr0serviceguard.png" alt="4ndr0serviceguard Project Banner" width="50%">
</p>

[![version](https://img.shields.io/badge/version-7.0.0-blue.svg)](https://github.com/4ndr0666/4ndr0serviceguard)  
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

For power users, developers, and security professionals, having control over this layer is critical.

---

## The Solution: The Ghost Protocol

`4ndr0serviceguard` enforces a **default-deny Service Worker policy**. All registration attempts are intercepted and nullified unless the domain is explicitly whitelisted.

The **Ghost Protocol** (current implementation in `ghost_core_v7.js`) is a stealthy, proxy-based interception system that replaces `navigator.serviceWorker` with a controlled interface. It returns dynamically generated, convincing fake `ServiceWorkerRegistration` objects when blocking.

- Everyday users gain faster, cleaner, and more private browsing.
- Red Team operators can surgically dismantle Service Worker protections, reveal hidden endpoints, bypass client-side controls, and force legacy application paths.

---

## Features

### Core Features
- 🛡️ **Ghost Protocol v7**: Advanced stealthy proxy-based Service Worker nullification
- ✍️ **Intelligent Whitelist**: Domain + automatic subdomain support
- 🤫 **Dynamic API Mocking**: Returns realistic fake objects to minimize breakage and detection
- ⚡ **Instant Execution**: Injected at `document_start` in the MAIN world
- ✅ **Live Validation & Approval UI**: Modern Electric-Glassmorphism popup with real-time blocked attempt monitoring
- 🔄 **One-Click Approval**: Allow individual registration attempts directly from the popup
- ✨ **Manifest V3**: Modern, secure, and asynchronous architecture

### Operator Enhancements (v6–v7)
- **Dual-Layer Hooking**: Both `navigator.serviceWorker` and `ServiceWorkerContainer.prototype.register`
- **CSP Resilience**: Prototype-level hooking + `securitypolicyviolation` listener
- **Live Blocked Attempts**: Real-time visibility into intercepted registrations and WebSocket attempts
- **Tri-Mode Integration**: One-click piping of current page + blocked data into the tri-mode editor
- **Violentmonkey Companion**: Full-featured userscript version available

---

## How It Works

### Ghost Core (ghost_core_v7.js)
- Injected at `document_start` in the **MAIN** world.
- Replaces `navigator.serviceWorker` with a proxy.
- Intercepts `register()` calls and returns fake registrations by default.
- Includes a secondary prototype-level hook for increased CSP resistance.
- Listens for CSP violations related to workers.

### WebSocket Handling
- Full phantom WebSocket implementation with DDoS-Guard fast-path exemption.
- Gatekept via the same permission system.

### Background Controller
- Maintains whitelist state.
- Handles interactive permission prompts (`prompt.html`).
- Logs detailed attempt telemetry.

### Popup UI
- Electric-Glassmorphism design.
- Master Ghost Protocol toggle.
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

---

## Usage

1. Click the extension icon to open the control popup.
2. Toggle **Ghost Protocol** (default: enabled = default-deny).
3. Add trusted domains to the whitelist (one per line). Subdomains are matched automatically.
4. Reload target tabs after making changes.

For quick personal use, the Violentmonkey companion script is also available.

---

## Tactical Notes

- The extension applies default-deny immediately upon injection.
- Use the whitelist surgically during engagements.
- The popup shows live blocked attempts for rapid decision-making.
- The tri-mode integration allows quick inspection and modification of intercepted data.

---

## Mechanism of Action (v7)

- **Dual-Layer Interception**: `navigator.serviceWorker` + `ServiceWorkerContainer.prototype.register`
- **Dynamic Mocking**: Returns rich fake registration objects
- **CSP Awareness**: Prototype hook + violation event listener
- **Surgical Restoration**: Whitelist-based re-injection of original API
- **Event Emission**: Real-time telemetry of blocked attempts

---

## Customization

No build step required. Edit `ghost_core_v7.js`, `popup.js`, or `background.js` directly and reload the extension.

---

## Version History (Relevant)

- **v7.0.0** — Final revision with prototype-level hooking and CSP violation handling
- **v6.0.0** — Major UI overhaul (Electric-Glassmorphism), live blocked attempts, tri-mode integration
- Earlier versions used the older "pacifier" naming and Nullifier Protocol

---

## Contributing

Pull requests and issues are welcome. Focus areas include further CSP hardening, additional API coverage, and UI/UX improvements.

---

## License

Licensed under the MIT License. See [LICENSE](LICENSE).
