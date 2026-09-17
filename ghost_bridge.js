// ghost_bridge.js — 4ndr0serviceguard Bootstrap Bridge v7.1 (ISOLATED world)
// Single responsibility: publish the extension ID into the DOM at document_start
// so the MAIN-world Ghost Core (which has no access to chrome.* APIs) can address
// the background service worker through the externally_connectable messaging
// stub (chrome.runtime.sendMessage(extensionId, ...)).
// The ID is public information (visible in chrome://extensions); it carries no
// privilege by itself. Tampering with the attribute can only degrade the Ghost
// Core's channel, which fails safe (default-deny).

(function () {
  'use strict';

  const ATTR = 'data-4ndr0-ext';
  const MAX_ATTEMPTS = 20;
  const RETRY_MS = 10;

  function publish() {
    try {
      const root = document.documentElement;
      if (root && !root.hasAttribute(ATTR)) {
        root.setAttribute(ATTR, chrome.runtime.id || '');
      }
      return !!(root && root.hasAttribute(ATTR));
    } catch (e) {
      console.debug('[Ψ-Bridge] ID publish failed:', e);
      return false;
    }
  }

  if (publish()) return;

  // documentElement not yet available (rare timing windows) — bounded retry.
  let attempts = 0;
  const timer = setInterval(() => {
    if (publish() || ++attempts >= MAX_ATTEMPTS) clearInterval(timer);
  }, RETRY_MS);
})();
