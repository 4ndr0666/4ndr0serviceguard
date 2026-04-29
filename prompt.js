// 4ndr0serviceguard UI Controller – Gatekeeper Prompt v5.0

document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const reqId = urlParams.get('id');
  const reqType = urlParams.get('type');
  const reqUrl = urlParams.get('url');

  document.getElementById('conn-type').textContent = reqType || 'UNKNOWN';
  document.getElementById('conn-url').textContent = reqUrl || 'UNKNOWN';

  function resolve(allowed) {
    chrome.runtime.sendMessage({
      action: 'resolvePermission',
      id: reqId,
      allowed: allowed
    });
  }

  document.getElementById('btn-allow').addEventListener('click', () => resolve(true));
  document.getElementById('btn-deny').addEventListener('click', () => resolve(false));

  // Default to DENY if the window is closed without interaction
  window.addEventListener('beforeunload', () => {
    resolve(false);
  });
});
