// prompt.js — 4ndr0serviceguard Gatekeeper Prompt v7.1 (Electric-Glass)
// Resolves exactly once per prompt window; closing the window denies.

document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const reqId = urlParams.get('id');
  const reqType = urlParams.get('type');
  const reqUrl = urlParams.get('url');
  const reqOrigin = urlParams.get('origin');

  document.getElementById('conn-type').textContent = reqType || 'UNKNOWN';
  document.getElementById('conn-url').textContent = reqUrl || 'UNKNOWN';

  const domainEl = document.getElementById('conn-domain');
  if (domainEl) {
    let domain = 'UNKNOWN';
    try {
      domain = (new URL(reqUrl).hostname) || (new URL(reqOrigin).hostname) || 'UNKNOWN';
    } catch (e) { /* keep UNKNOWN */ }
    domainEl.textContent = domain;
  }

  let resolved = false;

  function resolve(allowed) {
    if (resolved) return; // single-settlement guard (fixes double-resolve race)
    resolved = true;
    try {
      chrome.runtime.sendMessage({
        action: 'resolvePermission',
        id: reqId,
        allowed: allowed
      }, () => {
        void chrome.runtime.lastError; // read to suppress unchecked-error noise
      });
    } catch (e) {
      console.debug('[Ψ-Prompt] resolve failed:', e);
    }
    window.close();
  }

  document.getElementById('btn-allow').addEventListener('click', () => resolve(true));
  document.getElementById('btn-deny').addEventListener('click', () => resolve(false));
  window.addEventListener('beforeunload', () => resolve(false));
});
