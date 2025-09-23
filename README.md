# 4ndr0serviceguard
<p align="center">
  <img src="https://raw.githubusercontent.com/4ndr0666/4ndr0serviceguard/refs/heads/main/icons/4ndr0serviceguard.png" alt="4ndr0serviceguard Project Banner" width="50%">
</p>


[![version](https://img.shields.io/badge/version-1.5.0-blue.svg)](https://github.com/4ndr0666/4ndr0serviceguard)  
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**A dual-purpose Chrome Extension:**  
- For **everyday users**: proactively disable Service Workers to improve browser performance, reduce tracking, and gain predictability.  
- For **Red Team operators and penetration testers**: a tactical tool to neutralize client-side Service Worker defenses and expose hidden application logic.  

---

## The Problem

Service Workers enable offline caching, push notifications, background sync, and request interception. While useful, they can lead to:

- **Stale Content**: Aggressive caching hides fresh content.  
- **Unwanted Notifications**: Persistent prompts and background messages.  
- **Performance Overhead**: Extra CPU and battery usage.  
- **Privacy Concerns**: Silent background requests without user control.  
- **Security Barriers**: Obfuscation of backend APIs and enforced client-side validation.  

For power users, developers, and security professionals, controlling this layer is essential.

---

## The Solution: The Nullifier Protocol

`4ndr0serviceguard` enforces a **default-deny Service Worker policy**, blocking all registrations globally unless explicitly allowed.  

- Everyday users get faster, cleaner, and more private browsing.  
- Operators can surgically dismantle Service Worker protections, revealing hidden endpoints, bypassing client-side validation, and triggering legacy fallbacks.  

This model delivers predictability, privacy, and expanded attack surface visibility.

---

## Features

- 🛡️ **Nullifier Protocol**: Global kill switch for Service Workers.  
- ✍️ **Intelligent Whitelist**: Add trusted domains and their subdomains (e.g., `google.com` covers `docs.google.com`).  
- 🤫 **Stealth API Nullification**: Returns fake registration promises to avoid breakage or detection.  
- ⚡ **Instant Execution**: Injected at `document_start` before page scripts.  
- ✅ **Live Validation**: Input checked in real time via popup.  
- ✨ **Manifest V3**: Modern, asynchronous, and secure codebase.  

Additional operator-level traits:  
- **Surgical Target Enablement**: Per-domain SW restoration.  
- **Zero-Day Race Condition Dominance**: Guaranteed execution before target scripts.  
- **Customizable Source**: No build step; edit scripts directly.  

---

## How It Works

### Stage 1: Pacification
`pacifier.js` injects into the **MAIN world** at `document_start`. It overwrites `navigator.serviceWorker` methods with inert stubs. All registration attempts resolve successfully but no Service Worker is active.

### Stage 2: Restoration
`background.js` checks tab URLs against the whitelist. For trusted domains, it reinjects original API methods with `chrome.scripting.executeScript`, restoring Service Worker functionality.

---

## Red Team Operational Scenarios

### 1. Bypassing Client-Side Validation & Controls
- **Target**: `secure-bank.com` uses SW to add tokens or encrypt payloads.  
- **Action**: Do not whitelist. SW is nullified.  
- **Result**: Intercept proxy sees raw API traffic. Test injection, tampering, bypasses.  

### 2. De-cloaking Hidden Endpoints
- **Target**: `content-delivery.net` proxies all API calls through SW.  
- **Action**: Disable SW.  
- **Result**: App falls back to direct requests, exposing real backend URLs.  

### 3. Forcing Legacy Fallback Modes
- **Target**: `shiny-app.io` with complex PWA logic.  
- **Action**: Nullify SW.  
- **Result**: Legacy app path loads. Older vulnerabilities may be exposed.  

---

## Installation

Not on Chrome Web Store. Load manually:

```bash
git clone https://github.com/4ndr0666/4ndr0serviceguard.git
````

1. Go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the repo folder.
4. Extension icon appears in toolbar.

---

## Usage

Click the icon to open control popup:

* **Nullifier Protocol Switch**: Master on/off toggle.
* **Whitelist Textarea**: Add domains (one per line). Subdomains included automatically. Reload pages after edits.

---

## Tactical Deployment

* Default-deny applied immediately when extension is loaded.
* Use whitelist to scope Service Worker restoration during active engagements.
* Reload the target tab after whitelist changes.

---

## Mechanism of Action (MoA)

1. **MAIN World Injection**: Same privilege as site scripts.
2. **API Monkey-Patching**: Save and overwrite original `navigator.serviceWorker` methods.
3. **Deceptive Resolution**: Return fake `ServiceWorkerRegistration` objects to avoid detection.
4. **Surgical Restoration**: Reinstate originals on whitelisted domains.

---

## Customization

* No build process.
* Modify JS source directly to fit engagement needs.
* Reload via `chrome://extensions` after editing.

---

## Contributing

PRs and issues are welcome. Bug fixes, new features, and operational improvements encouraged.

---

## License

Licensed under the MIT License. See [LICENSE](LICENSE).
