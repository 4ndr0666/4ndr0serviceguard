// popup.js — 4NDR0666 ServiceGuard v6 (U+ Final Polish)
// Live blocked attempts via storage listener + one-click approval + tri-mode pipe

document.addEventListener('DOMContentLoaded', () => {
  const masterToggle = document.getElementById('masterToggle');
  const toggleLabel = document.getElementById('toggleLabel');
  const whitelistInput = document.getElementById('whitelistInput');
  const blockedList = document.getElementById('blockedList');
  const statusText = document.getElementById('statusText');

  // Load state
  chrome.storage.local.get(['ghostActive', 'whitelist'], (result) => {
    masterToggle.checked = result.ghostActive !== false;
    updateToggleLabel();
    if (result.whitelist) whitelistInput.value = result.whitelist.join('\n');
  });

  function updateToggleLabel() {
    toggleLabel.textContent = masterToggle.checked 
      ? 'ACTIVE — DEFAULT DENY' 
      : 'DISABLED — PASS-THROUGH';
    toggleLabel.style.color = masterToggle.checked ? 'var(--accent-cyan)' : 'var(--text-secondary)';
  }

  masterToggle.addEventListener('change', () => {
    chrome.storage.local.set({ ghostActive: masterToggle.checked });
    updateToggleLabel();
    chrome.runtime.sendMessage({ type: 'TOGGLE_GHOST', active: masterToggle.checked });
  });

  // Live blocked attempts listener (U+)
  function renderBlockedAttempts(attempts) {
    blockedList.innerHTML = '';
    if (!attempts || attempts.length === 0) {
      blockedList.innerHTML = '<div class="empty-state">No recent attempts</div>';
      return;
    }

    // Show latest 8
    attempts.slice(-8).reverse().forEach(attempt => {
      const div = document.createElement('div');
      div.className = 'blocked-item';
      div.innerHTML = `
        <span class="scope">${attempt.type || 'SW'} — ${new URL(attempt.target || attempt.scriptURL || '').pathname}</span>
        <button class="hud-button small allow-btn" data-target="${attempt.target || attempt.scriptURL}">ALLOW</button>
      `;
      blockedList.appendChild(div);
    });

    blockedList.querySelectorAll('.allow-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.target;
        chrome.runtime.sendMessage({ 
          type: 'APPROVE_TARGET', 
          target: target 
        });
        btn.textContent = 'ALLOWED';
        btn.disabled = true;
      });
    });
  }

  // Initial + live listener
  chrome.storage.local.get(['detailedAttempts'], (result) => {
    renderBlockedAttempts(result.detailedAttempts || []);
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.detailedAttempts) {
      renderBlockedAttempts(changes.detailedAttempts.newValue || []);
    }
  });

  document.getElementById('refreshBlocked').addEventListener('click', () => {
    chrome.storage.local.get(['detailedAttempts'], (result) => {
      renderBlockedAttempts(result.detailedAttempts || []);
    });
  });

  document.getElementById('allowAllCurrent').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      chrome.runtime.sendMessage({ 
        type: 'APPROVE_ORIGIN', 
        origin: new URL(tabs[0].url).origin 
      });
      statusText.textContent = 'Origin approved — reload page';
    });
  });

  // Whitelist
  document.getElementById('saveWhitelist').addEventListener('click', () => {
    const lines = whitelistInput.value.split('\n').map(l => l.trim()).filter(Boolean);
    chrome.storage.local.set({ whitelist: lines });
    chrome.runtime.sendMessage({ type: 'UPDATE_WHITELIST', whitelist: lines });
    statusText.textContent = 'Whitelist saved';
  });

  document.getElementById('clearWhitelist').addEventListener('click', () => {
    whitelistInput.value = '';
    chrome.storage.local.set({ whitelist: [] });
    chrome.runtime.sendMessage({ type: 'UPDATE_WHITELIST', whitelist: [] });
  });

  // Tri-mode pipe (U+)
  document.getElementById('openTriMode').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      chrome.storage.local.get(['detailedAttempts'], (result) => {
        const data = {
          url: tabs[0].url,
          blockedAttempts: result.detailedAttempts || []
        };
        const triModeUrl = 'https://sm1therz.github.io/apps/html-tidy/tri-mode';
        chrome.tabs.create({ url: triModeUrl }, (newTab) => {
          // Optional: could postMessage the data once tri-mode supports it
          console.log('[4NDR] Data ready for tri-mode:', data);
        });
      });
    });
  });

  // Initial blocked load
  chrome.storage.local.get(['detailedAttempts'], (result) => {
    renderBlockedAttempts(result.detailedAttempts || []);
  });
});
