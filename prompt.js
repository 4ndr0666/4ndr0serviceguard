// prompt.js — 4ndr0serviceguard Gatekeeper Prompt v7.4 (3lectric-Glass)
// Resolves exactly once per prompt window; closing the window denies.
//
// v7.3.0: three-way action model — AUTHORIZE (real connection), SPOOF
// (pacify: the phantom stays OPEN and swallows sends) and DENY
// (native-faithful handshake failure). The secondary row settles the chosen
// action AND records a remembered site rule: ALWAYS AUTHORIZE SITE →
// whitelist, ALWAYS SPOOF SITE → spooflist, BLACKLIST SITE → blacklist.
//
// Scope fix (field report: "blacklisting does not stop the persistent
// popup"): remembered grants now target the PAGE ORIGIN host instead of the
// WS endpoint host, so one grant covers every endpoint and Service Worker
// on the site. v7.2's endpoint-host grants remain available per-attempt in
// the toolbar popup (textarea + ALLOW/SPOOF/BLOCK buttons).
//
// v7.2.0 compat: the BLACKLIST button still settles as a denial AND grants
// the background a blacklist add (resolvePermission's domain field) — one
// click, permanent prohibition, now site-scoped.

document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const reqId = urlParams.get('id');
  const reqType = urlParams.get('type');
  const reqUrl = urlParams.get('url');
  const reqOrigin = urlParams.get('origin');

  document.getElementById('conn-type').textContent = reqType || 'UNKNOWN';
  document.getElementById('conn-url').textContent = reqUrl || 'UNKNOWN';

  // v7.3.0: the SITE row is the page origin (what a remembered grant keys
  // on); the TARGET row stays the full connection URL.
  function hostnameOf(value) {
    try { return (new URL(value)).hostname || ''; } catch (e) { return ''; }
  }
  const siteHost = hostnameOf(reqOrigin) || hostnameOf(reqUrl) || 'UNKNOWN';
  document.getElementById('conn-site').textContent = siteHost;

  let resolved = false;

  // decision: 'allow' | 'spoof' | 'deny'; remember: false | 'site'
  // The decision key is named `decision` (not `action`) to avoid colliding
  // with the router's dispatch key in the message envelope.
  function resolve(action, remember, domain) {
    if (resolved) return; // single-settlement guard (fixes double-resolve race)
    resolved = true;
    try {
      const message = {
        action: 'resolvePermission',
        id: reqId,
        allowed: action === 'allow',
        decision: action
      };
      if (remember === 'site' && domain && domain !== 'UNKNOWN') {
        message.remember = 'site';
        message.domain = domain;
      } else if (remember === true && domain && domain !== 'UNKNOWN') {
        // v7.2.0 legacy grant shape (blacklist-only) — still honored.
        message.blacklist = true;
        message.domain = domain;
      }
      chrome.runtime.sendMessage(message, () => {
        void chrome.runtime.lastError; // read to suppress unchecked-error noise
      });
    } catch (e) {
      console.debug('[Ψ-Prompt] resolve failed:', e);
    }
    window.close();
  }

  document.getElementById('btn-allow').addEventListener('click', () => resolve('allow', false));
  document.getElementById('btn-spoof').addEventListener('click', () => resolve('spoof', false));
  document.getElementById('btn-deny').addEventListener('click', () => resolve('deny', false));
  document.getElementById('btn-allow-site').addEventListener('click', () => resolve('allow', 'site', siteHost));
  document.getElementById('btn-spoof-site').addEventListener('click', () => resolve('spoof', 'site', siteHost));
  // v7.2.0 semantics preserved: settle as denial AND blacklist the domain.
  document.getElementById('btn-blacklist').addEventListener('click', () => resolve('deny', 'site', siteHost));

  // v7.3.0: keyboard parity with the Quick Bar — A/S/D actions, Enter
  // authorize (the v7.2 default-focus doctrine), Esc deny. Genuine keys only.
  document.addEventListener('keydown', (e) => {
    if (e.isTrusted === false) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName || ''))) return;
    const k = String(e.key || '').toLowerCase();
    if (k === 'a') { e.preventDefault(); resolve('allow', false); }
    else if (k === 's') { e.preventDefault(); resolve('spoof', false); }
    else if (k === 'd') { e.preventDefault(); resolve('deny', false); }
    else if (e.key === 'Enter') { e.preventDefault(); resolve('allow', false); }
    else if (e.key === 'Escape') { e.preventDefault(); resolve('deny', false); }
  });

  // v7.2.0: closing the window settles a one-time denial.
  window.addEventListener('beforeunload', () => resolve('deny', false));
});
