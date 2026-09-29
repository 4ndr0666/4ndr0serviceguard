// prompt.js — 4ndr0serviceguard Gatekeeper Prompt v7.2 (3lectric-Glass)
// Resolves exactly once per prompt window; closing the window denies.
// v7.2.0: the BLACKLIST DOMAIN button settles the request as a denial AND
// grants the background an optional blacklist add for the prompted domain
// (resolvePermission's blacklist field) — one click, permanent prohibition.

document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const reqId = urlParams.get('id');
  const reqType = urlParams.get('type');
  const reqUrl = urlParams.get('url');
  const reqOrigin = urlParams.get('origin');

  document.getElementById('conn-type').textContent = reqType || 'UNKNOWN';
  document.getElementById('conn-url').textContent = reqUrl || 'UNKNOWN';

  let reqDomain = '';
  const domainEl = document.getElementById('conn-domain');
  if (domainEl) {
    let domain = 'UNKNOWN';
    try {
      domain = (new URL(reqUrl).hostname) || (new URL(reqOrigin).hostname) || 'UNKNOWN';
    } catch (e) { /* keep UNKNOWN */ }
    domainEl.textContent = domain;
    reqDomain = domain === 'UNKNOWN' ? '' : domain;
  }

  let resolved = false;

  function resolve(allowed, blacklist) {
    if (resolved) return; // single-settlement guard (fixes double-resolve race)
    resolved = true;
    try {
      const message = {
        action: 'resolvePermission',
        id: reqId,
        allowed: allowed
      };
      if (blacklist === true && reqDomain) {
        message.blacklist = true;   // v7.2.0: permanent prohibition grant
        message.domain = reqDomain;
      }
      chrome.runtime.sendMessage(message, () => {
        void chrome.runtime.lastError; // read to suppress unchecked-error noise
      });
    } catch (e) {
      console.debug('[Ψ-Prompt] resolve failed:', e);
    }
    window.close();
  }

  document.getElementById('btn-allow').addEventListener('click', () => resolve(true, false));
  document.getElementById('btn-deny').addEventListener('click', () => resolve(false, false));
  document.getElementById('btn-blacklist').addEventListener('click', () => resolve(false, true));
  window.addEventListener('beforeunload', () => resolve(false, false));
});
