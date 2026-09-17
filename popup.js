// popup.js — 4NDR0666 ServiceGuard v7.1.1 (Electric-Glass Control Surface)
// Wired to the Ψ-Core router: action-keyed messages, canonical sync storage,
// live blocked attempts via storage listener + getLogs, one-click domain
// approval, XSS-safe DOM rendering, and a functional tri-mode data pipe.
// v7.1.1: every chrome callback reads runtime.lastError (no unchecked-error
// noise) and every send() result surfaces failures instead of fake success.

document.addEventListener('DOMContentLoaded', () => {
  const masterToggle = document.getElementById('masterToggle');
  const toggleLabel = document.getElementById('toggleLabel');
  const whitelistInput = document.getElementById('whitelistInput');
  const blockedList = document.getElementById('blockedList');
  const statusText = document.getElementById('statusText');
  const refreshBlocked = document.getElementById('refreshBlocked');
  const allowAllCurrent = document.getElementById('allowAllCurrent');
  const saveWhitelist = document.getElementById('saveWhitelist');
  const clearWhitelist = document.getElementById('clearWhitelist');
  const openTriMode = document.getElementById('openTriMode');

  const TRI_MODE_URL = 'https://sm1therz.github.io/apps/html-tidy/tri-mode';
  const TRI_MODE_HASH_LIMIT = 32768;

  let currentTabOrigin = null;

  function setStatus(text) { statusText.textContent = text; }

  function send(action, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(Object.assign({ action: action }, payload || {}), (response) => {
          void chrome.runtime.lastError; // read to suppress unchecked-error noise
          resolve(response || null);
        });
      } catch (e) {
        console.debug('[4NDR] message send failed:', e);
        resolve(null);
      }
    });
  }

  function updateToggleLabel() {
    toggleLabel.textContent = masterToggle.checked
      ? 'ACTIVE — DEFAULT DENY'
      : 'DISABLED — PASS-THROUGH';
    toggleLabel.style.color = masterToggle.checked ? 'var(--accent-cyan)' : 'var(--text-secondary)';
  }

  // --- state bootstrap (canonical: chrome.storage.sync) ---
  chrome.storage.sync.get(['enabled', 'whitelist'], (result) => {
    void chrome.runtime.lastError; // read to suppress unchecked-error noise
    result = result || {};
    masterToggle.checked = result.enabled !== false;
    updateToggleLabel();
    if (typeof result.whitelist === 'string') {
      whitelistInput.value = result.whitelist;
    }
  });

  masterToggle.addEventListener('change', () => {
    send('toggle', { enabled: masterToggle.checked }).then((r) => {
      if (!r || r.status === 'error') {
        setStatus('Toggle not confirmed — service worker busy, verify and retry');
        return;
      }
      updateToggleLabel();
      setStatus(masterToggle.checked
        ? 'Ghost Protocol armed — default deny'
        : 'Ghost Protocol disabled — pass-through (reload pages)');
    });
  });

  // --- URL helpers (never throw — fixed render crash on missing targets) ---
  function safePath(target) {
    try { return new URL(String(target), 'https://invalid.invalid').pathname; }
    catch (e) { return String(target || '').slice(0, 48); }
  }

  function hostOf(target) {
    try { return new URL(String(target), 'https://invalid.invalid').hostname; }
    catch (e) { return ''; }
  }

  // --- live blocked attempts (XSS-safe DOM building, current-page filter) ---
  function renderBlockedAttempts(attempts) {
    blockedList.textContent = '';
    if (!Array.isArray(attempts) || attempts.length === 0) {
      appendEmpty('No recent attempts');
      return;
    }

    const blocked = attempts.filter((a) => a && a.allowed !== true);
    const relevant = currentTabOrigin
      ? blocked.filter((a) => {
          const o = String(a.origin || a.pageUrl || '');
          return !o || o === 'unknown' || o.startsWith(currentTabOrigin);
        })
      : blocked;
    const view = (relevant.length ? relevant : blocked).slice(-8).reverse();

    if (!view.length) {
      appendEmpty(currentTabOrigin ? 'No blocked attempts on this page' : 'No blocked attempts');
      return;
    }

    view.forEach((attempt) => {
      const type = attempt.type || attempt.context || 'SW';
      const target = attempt.target || attempt.scriptURL || '';
      const detail = attempt.detail ? ' (' + attempt.detail + ')' : '';

      const div = document.createElement('div');
      div.className = 'blocked-item';

      const scope = document.createElement('span');
      scope.className = 'scope';
      scope.textContent = type + ' — ' + safePath(target) + detail;

      const btn = document.createElement('button');
      btn.className = 'hud-button small allow-btn';
      const host = hostOf(target);
      btn.dataset.target = target;
      btn.dataset.domain = host;
      btn.textContent = 'ALLOW';
      if (!host) {
        btn.disabled = true;
        btn.title = 'No domain to whitelist';
      }

      div.appendChild(scope);
      div.appendChild(btn);
      blockedList.appendChild(div);
    });
  }

  function appendEmpty(message) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = message;
    blockedList.appendChild(empty);
  }

  // Event delegation — one listener for every allow button.
  blockedList.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.allow-btn') : null;
    if (!btn || btn.disabled) return;
    const domain = btn.dataset.domain;
    if (!domain) return;
    send('addWhitelist', { domain: domain }).then((r) => {
      if (!r || r.status === 'error') {
        setStatus('Whitelist add failed — service worker busy, retry');
        return;
      }
      btn.textContent = (r && r.status === 'exists') ? 'TRUSTED' : 'ALLOWED';
      btn.disabled = true;
      setStatus('Domain added to whitelist — reload page');
    });
  });

  function loadAttempts() {
    send('getLogs').then((r) => {
      renderBlockedAttempts(r && r.attempts ? r.attempts : []);
    });
  }

  refreshBlocked.addEventListener('click', () => { loadAttempts(); });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.detailedAttempts) {
      renderBlockedAttempts(changes.detailedAttempts.newValue || []);
    }
  });

  // --- origin approval ---
  allowAllCurrent.addEventListener('click', () => {
    if (!currentTabOrigin) { setStatus('No active tab to approve'); return; }
    const domain = hostOf(currentTabOrigin);
    if (!domain) { setStatus('Cannot resolve current tab domain'); return; }
    send('addWhitelist', { domain: domain }).then((r) => {
      if (!r || r.status === 'error') {
        setStatus('Origin approval failed — service worker busy, retry');
        return;
      }
      setStatus(((r && r.status === 'exists') ? 'Origin already trusted' : 'Origin approved') +
        ' — reload page');
    });
  });

  // --- whitelist management (canonical sync string) ---
  saveWhitelist.addEventListener('click', () => {
    const lines = whitelistInput.value.split('\n')
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean);
    send('setWhitelist', { whitelist: lines }).then((r) => {
      setStatus((!r || r.status === 'error')
        ? 'Whitelist save failed — retry (storage quota or sync write limit)'
        : 'Whitelist saved (' + lines.length + ' domains)');
    });
  });

  clearWhitelist.addEventListener('click', () => {
    whitelistInput.value = '';
    send('setWhitelist', { whitelist: [] }).then((r) => {
      setStatus((!r || r.status === 'error')
        ? 'Whitelist clear failed — retry'
        : 'Whitelist cleared');
    });
  });

  // --- tri-mode pipe (functional: URL hash + clipboard payload) ---
  openTriMode.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      void chrome.runtime.lastError; // read to suppress unchecked-error noise
      if (!tabs || !tabs[0] || !tabs[0].url) { setStatus('No active tab'); return; }
      send('getLogs').then((r) => {
        const data = {
          url: tabs[0].url,
          origin: currentTabOrigin,
          blockedAttempts: (r && r.attempts) || []
        };
        const json = JSON.stringify(data);
        const encoded = encodeURIComponent(json);
        const url = encoded.length <= TRI_MODE_HASH_LIMIT
          ? TRI_MODE_URL + '#sGuardData=' + encoded
          : TRI_MODE_URL;
        chrome.tabs.create({ url: url }, () => {
          void chrome.runtime.lastError; // read to suppress unchecked-error noise
        });
        copyToClipboard(json).then((ok) => {
          setStatus(ok
            ? 'Tri-mode opened — payload in URL hash + clipboard'
            : 'Tri-mode opened — payload in URL hash');
        });
      });
    });
  });

  function copyToClipboard(text) {
    return new Promise((resolve) => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(
            () => resolve(true),
            () => resolve(legacyCopy(text))
          );
          return;
        }
      } catch (e) { /* fall through to legacy path */ }
      resolve(legacyCopy(text));
    });
  }

  function legacyCopy(text) {
    // Synchronous fallback for contexts where the async clipboard API fails.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      console.debug('[4NDR] clipboard fallback failed:', e);
      return false;
    }
  }

  // --- bootstrap: resolve current tab first so the first render is filtered ---
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    void chrome.runtime.lastError; // read to suppress unchecked-error noise
    if (tabs && tabs[0] && tabs[0].url) {
      try { currentTabOrigin = new URL(tabs[0].url).origin; }
      catch (e) { currentTabOrigin = null; }
    }
    loadAttempts();
  });
});
