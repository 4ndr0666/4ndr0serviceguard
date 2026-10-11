// popup.js — 4NDR0666 ServiceGuard v7.4.0 (3lectric-Glass Control Surface)
// Wired to the Ψ-Core router: action-keyed messages, canonical sync storage,
// live blocked attempts via storage listener + getLogs, one-click site
// policy (AUTHORIZE / SPOOF / BLOCK / ASK AGAIN), spooflist management,
// decision-surface preference, XSS-safe DOM rendering, and a functional
// tri-mode data pipe.
// v7.1.1: every chrome callback reads runtime.lastError (no unchecked-error
// noise) and every send() result surfaces failures instead of fake success.
// v7.2.0: blacklist management (textarea + setBlacklist IPC), per-item BLOCK
// buttons alongside ALLOW, and blacklist bootstrap from canonical storage.
// v7.3.0: CURRENT SITE quick-action panel (getSitePolicy + one-click list
// writes), spooflist textarea (setSpooflist IPC), per-attempt SPOOF buttons,
// prompt-mode segmented control (inline Quick Bar vs prompt window), and
// badge rendering for the live site policy.
// v7.4.0: version-unification release (sandboxed-frame resilience landed in
// the page-world cores; extension pages are never sandboxed, so this surface
// is behavior-identical to v7.3.0).

document.addEventListener('DOMContentLoaded', () => {
  const masterToggle = document.getElementById('masterToggle');
  const toggleLabel = document.getElementById('toggleLabel');
  const whitelistInput = document.getElementById('whitelistInput');
  const spooflistInput = document.getElementById('spooflistInput');
  const blacklistInput = document.getElementById('blacklistInput');
  const blockedList = document.getElementById('blockedList');
  const statusText = document.getElementById('statusText');
  const refreshBlocked = document.getElementById('refreshBlocked');
  const allowAllCurrent = document.getElementById('allowAllCurrent');
  const saveWhitelist = document.getElementById('saveWhitelist');
  const clearWhitelist = document.getElementById('clearWhitelist');
  const saveSpooflist = document.getElementById('saveSpooflist');
  const clearSpooflist = document.getElementById('clearSpooflist');
  const saveBlacklist = document.getElementById('saveBlacklist');
  const clearBlacklist = document.getElementById('clearBlacklist');
  const openTriMode = document.getElementById('openTriMode');
  const siteOrigin = document.getElementById('siteOrigin');
  const siteBadges = document.getElementById('siteBadges');
  const siteAuthorize = document.getElementById('siteAuthorize');
  const siteSpoof = document.getElementById('siteSpoof');
  const siteBlock = document.getElementById('siteBlock');
  const siteReset = document.getElementById('siteReset');
  const modeInline = document.getElementById('modeInline');
  const modeWindow = document.getElementById('modeWindow');

  const TRI_MODE_URL = 'https://sm1therz.github.io/apps/html-tidy/tri-mode';
  const TRI_MODE_HASH_LIMIT = 32768;

  let currentTabOrigin = null;
  let currentSiteDomain = null;

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
  chrome.storage.sync.get(['enabled', 'whitelist', 'spooflist', 'blacklist', 'promptMode'], (result) => {
    void chrome.runtime.lastError; // read to suppress unchecked-error noise
    result = result || {};
    masterToggle.checked = result.enabled !== false;
    updateToggleLabel();
    if (typeof result.whitelist === 'string') {
      whitelistInput.value = result.whitelist;
    }
    if (typeof result.spooflist === 'string') {
      spooflistInput.value = result.spooflist;
    }
    if (typeof result.blacklist === 'string') {
      blacklistInput.value = result.blacklist;
    }
    setModeButtons(result.promptMode === 'window' ? 'window' : 'inline');
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

  // --- CURRENT SITE panel (v7.3.0) ---
  function badge(label, kind) {
    const b = document.createElement('span');
    b.className = 'badge ' + kind;
    b.textContent = label;
    return b;
  }

  function renderSitePolicy(policy) {
    siteBadges.textContent = '';
    if (!policy || policy.status !== 'ok') {
      siteOrigin.textContent = currentTabOrigin || '—';
      return;
    }
    siteOrigin.textContent = policy.domain || currentTabOrigin || '—';
    if (policy.blacklisted) siteBadges.appendChild(badge('BLOCKED', 'blocked'));
    if (policy.spooflisted) siteBadges.appendChild(badge('SPOOFED', 'spoof'));
    if (policy.whitelisted) siteBadges.appendChild(badge('AUTHORIZED', 'ok'));
    if (!policy.blacklisted && !policy.spooflisted && !policy.whitelisted) {
      siteBadges.appendChild(badge(policy.enabled === false ? 'PASS-THROUGH' : 'ASKING', 'ask'));
    }
    if (policy.enabled === false) siteBadges.appendChild(badge('OFF', 'ask'));
  }

  function loadSitePolicy() {
    if (!currentTabOrigin) {
      siteOrigin.textContent = '—';
      siteBadges.textContent = '';
      return;
    }
    send('getSitePolicy', { origin: currentTabOrigin }).then(renderSitePolicy);
  }

  function siteAction(kind) {
    if (!currentSiteDomain) { setStatus('No active tab site to manage'); return; }
    const action = kind === 'whitelist' ? 'addWhitelist'
      : kind === 'spooflist' ? 'addSpooflist' : 'addBlacklist';
    send(action, { domain: currentSiteDomain }).then((r) => {
      if (!r || r.status === 'error') {
        setStatus('Site rule failed — service worker busy, retry');
        return;
      }
      const verb = kind === 'whitelist' ? 'authorized'
        : kind === 'spooflist' ? 'spoofed (never asks)' : 'blocked';
      setStatus('Site ' + verb + ' — reload page');
      loadSitePolicy();
    });
  }

  siteAuthorize.addEventListener('click', () => siteAction('whitelist'));
  siteSpoof.addEventListener('click', () => siteAction('spooflist'));
  siteBlock.addEventListener('click', () => siteAction('blacklist'));
  siteReset.addEventListener('click', () => {
    if (!currentSiteDomain) { setStatus('No active tab site to manage'); return; }
    send('removeDomain', { domain: currentSiteDomain }).then((r) => {
      if (!r || r.status === 'error') {
        setStatus('Site reset failed — service worker busy, retry');
        return;
      }
      setStatus(r.removed > 0 ? 'Site rules removed — gate asks again' : 'No site rules existed');
      loadSitePolicy();
    });
  });

  // --- decision-surface preference (v7.3.0) ---
  function setModeButtons(mode) {
    modeInline.classList.toggle('on', mode !== 'window');
    modeWindow.classList.toggle('on', mode === 'window');
  }

  function setPromptMode(mode) {
    send('setPromptMode', { promptMode: mode }).then((r) => {
      if (!r || r.status === 'error') {
        setStatus('Prompt-mode save failed — service worker busy, retry');
        return;
      }
      setModeButtons(r.promptMode === 'window' ? 'window' : 'inline');
      setStatus(r.promptMode === 'window'
        ? 'Decisions arrive as prompt windows'
        : 'Decisions arrive as in-page Quick Bars');
    });
  }

  modeInline.addEventListener('click', () => setPromptMode('inline'));
  modeWindow.addEventListener('click', () => setPromptMode('window'));

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

      const host = hostOf(target);

      // v7.3.0: per-attempt SPOOF joins ALLOW and BLOCK — endpoint-level
      // one-click rules for every blocked target.
      const allowBtn = document.createElement('button');
      allowBtn.className = 'hud-button small allow-btn';
      allowBtn.dataset.target = target;
      allowBtn.dataset.domain = host;
      allowBtn.textContent = 'ALLOW';
      if (!host) {
        allowBtn.disabled = true;
        allowBtn.title = 'No domain to whitelist';
      }

      const spoofBtn = document.createElement('button');
      spoofBtn.className = 'hud-button small spoof-btn';
      spoofBtn.dataset.target = target;
      spoofBtn.dataset.domain = host;
      spoofBtn.textContent = 'SPOOF';
      if (!host) {
        spoofBtn.disabled = true;
        spoofBtn.title = 'No domain to spooflist';
      }

      const blockBtn = document.createElement('button');
      blockBtn.className = 'hud-button small block-btn destructive';
      blockBtn.dataset.target = target;
      blockBtn.dataset.domain = host;
      blockBtn.textContent = 'BLOCK';
      if (!host) {
        blockBtn.disabled = true;
        blockBtn.title = 'No domain to blacklist';
      }

      div.appendChild(scope);
      div.appendChild(allowBtn);
      div.appendChild(spoofBtn);
      div.appendChild(blockBtn);
      blockedList.appendChild(div);
    });
  }

  function appendEmpty(message) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = message;
    blockedList.appendChild(empty);
  }

  // Event delegation — one listener for every allow/spoof/block button.
  blockedList.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.allow-btn, .spoof-btn, .block-btn') : null;
    if (!btn || btn.disabled) return;
    const domain = btn.dataset.domain;
    if (!domain) return;
    const isBlock = btn.classList.contains('block-btn');
    const isSpoof = btn.classList.contains('spoof-btn');
    const action = isBlock ? 'addBlacklist' : isSpoof ? 'addSpooflist' : 'addWhitelist';
    const listName = isBlock ? 'Blacklist' : isSpoof ? 'Spooflist' : 'Whitelist';
    send(action, { domain: domain }).then((r) => {
      if (!r || r.status === 'error') {
        setStatus(listName + ' add failed — service worker busy, retry');
        return;
      }
      btn.textContent = (r && r.status === 'exists')
        ? (isBlock ? 'LISTED' : isSpoof ? 'SPOOFED' : 'TRUSTED')
        : (isBlock ? 'BLOCKED' : isSpoof ? 'SPOOFED' : 'ALLOWED');
      btn.disabled = true;
      setStatus('Domain ' + (isBlock ? 'blacklisted' : isSpoof ? 'spooflisted' : 'whitelisted') +
        ' — reload page');
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
    // v7.3.0: keep the CURRENT SITE badges live when lists change anywhere.
    if (area === 'sync' && (changes.whitelist || changes.spooflist || changes.blacklist)) {
      loadSitePolicy();
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
      loadSitePolicy();
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

  // --- spooflist management (v7.3.0; canonical sync string) ---
  saveSpooflist.addEventListener('click', () => {
    const lines = spooflistInput.value.split('\n')
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean);
    send('setSpooflist', { spooflist: lines }).then((r) => {
      setStatus((!r || r.status === 'error')
        ? 'Spooflist save failed — retry (storage quota or sync write limit)'
        : 'Spooflist saved (' + lines.length + ' domains) — never asks, silent spoof');
    });
  });

  clearSpooflist.addEventListener('click', () => {
    spooflistInput.value = '';
    send('setSpooflist', { spooflist: [] }).then((r) => {
      setStatus((!r || r.status === 'error')
        ? 'Spooflist clear failed — retry'
        : 'Spooflist cleared');
    });
  });

  // --- blacklist management (v7.2.0; canonical sync string) ---
  saveBlacklist.addEventListener('click', () => {
    const lines = blacklistInput.value.split('\n')
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean);
    send('setBlacklist', { blacklist: lines }).then((r) => {
      setStatus((!r || r.status === 'error')
        ? 'Blacklist save failed — retry (storage quota or sync write limit)'
        : 'Blacklist saved (' + lines.length + ' domains)');
    });
  });

  clearBlacklist.addEventListener('click', () => {
    blacklistInput.value = '';
    send('setBlacklist', { blacklist: [] }).then((r) => {
      setStatus((!r || r.status === 'error')
        ? 'Blacklist clear failed — retry'
        : 'Blacklist cleared');
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
      if (currentTabOrigin) currentSiteDomain = hostOf(currentTabOrigin);
    }
    loadSitePolicy();
    loadAttempts();
  });
});
