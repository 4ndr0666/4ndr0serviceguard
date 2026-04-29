// 4ndr0serviceguard Popup Controller – Ghost Protocol Synthesis v4.0
// Handles real-time telemetry extraction and matrix configuration

document.addEventListener('DOMContentLoaded', () => {
  const toggleBtn = document.getElementById('toggle-btn');
  const statusDiv = document.getElementById('status');
  const domainInput = document.getElementById('domain-input');
  const addBtn = document.getElementById('add-whitelist');
  const logBtn = document.getElementById('toggle-log');
  const logPanel = document.getElementById('log-panel');
  const logList = document.getElementById('log-list');

  // Initialize toggle state from secure storage
  chrome.storage.sync.get(['enabled'], (result) => {
    const isEnabled = result.enabled !== false; // Default to true
    toggleBtn.checked = isEnabled;
    updateStatus(isEnabled);
  });

  // Toggle Global Guard Status
  toggleBtn.addEventListener('change', (e) => {
    const enabled = e.target.checked;
    chrome.runtime.sendMessage({ action: 'toggle', enabled }, (response) => {
      if (response && response.status === 'toggled') {
        updateStatus(response.state);
      }
    });
  });

  // Inject Whitelist Rules
  addBtn.onclick = () => {
    const domain = domainInput.value.trim();
    if (domain) {
      chrome.runtime.sendMessage({ action: 'addWhitelist', domain }, (res) => {
        if (res && res.status === 'added') {
          domainInput.value = '';
          domainInput.placeholder = 'MATRIX UPDATED';
          setTimeout(() => domainInput.placeholder = 'Target domain to whitelist...', 2000);
        } else if (res && res.status === 'exists') {
          domainInput.value = '';
          domainInput.placeholder = 'ALREADY WHITELISTED';
          setTimeout(() => domainInput.placeholder = 'Target domain to whitelist...', 2000);
        }
      });
    }
  };

  // Extract and Display Telemetry
  logBtn.onclick = () => {
    logPanel.style.display = logPanel.style.display === 'none' ? 'block' : 'none';
    if (logPanel.style.display === 'block') loadLogs();
  };

  async function loadLogs() {
    chrome.runtime.sendMessage({ action: 'getLogs' }, (response) => {
      if (!response) return;
      logList.innerHTML = '';
      
      // Render Global Block Metrics
      const blockHeader = document.createElement('li');
      blockHeader.className = 'section-header';
      blockHeader.innerHTML = '<strong>[ GLOBAL BLOCK METRICS ]</strong>';
      logList.appendChild(blockHeader);
      
      const blockEntries = Object.entries(response.logs || {});
      if (blockEntries.length === 0) {
        logList.innerHTML += '<li>No navigation blocks recorded.</li>';
      } else {
        blockEntries.forEach(([domain, count]) => {
          logList.innerHTML += `<li>${domain} <span class="count">[${count}]</span></li>`;
        });
      }

      // Render Deep SW/WS Interception Telemetry
      const attemptHeader = document.createElement('li');
      attemptHeader.className = 'section-header';
      attemptHeader.innerHTML = '<strong>[ INTERCEPTION TELEMETRY ]</strong>';
      logList.appendChild(attemptHeader);

      if (response.attempts && response.attempts.length > 0) {
        // Render the 15 most recent interceptions
        const recent = response.attempts.slice(-15).reverse();
        recent.forEach(att => {
          const time = new Date(att.timestamp).toLocaleTimeString();
          logList.innerHTML += `
            <li>
              <span class="telemetry-time">[${time}]</span> 
              <span class="telemetry-origin">[${att.context}]</span>
              <span class="telemetry-target">-> ${att.scriptURL}</span>
            </li>`;
        });
      } else {
        logList.innerHTML += '<li>No advanced telemetry recorded.</li>';
      }
    });
  }

  // UI State Updater
  function updateStatus(enabled) {
    statusDiv.textContent = enabled ? 'GUARD ACTIVE' : 'GUARD INACTIVE';
    statusDiv.style.color = enabled ? '#15FFFF' : '#ff3333';
  }
});

