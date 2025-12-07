// 4ndr0serviceguard Popup v1.2.0
document.addEventListener('DOMContentLoaded', () => {
  const toggleBtn = document.getElementById('toggle-btn');
  const statusDiv = document.getElementById('status');
  const domainInput = document.getElementById('domain-input');
  const addBtn = document.getElementById('add-whitelist');
  const logBtn = document.getElementById('toggle-log');
  const logPanel = document.getElementById('log-panel');
  const logList = document.getElementById('log-list');

  // Toggle guard
  toggleBtn.onclick = () => {
    chrome.storage.sync.get(['enabled'], (result) => {
      const enabled = !result.enabled;
      chrome.storage.sync.set({ enabled });
      updateStatus(enabled);
    });
  };

  // Add whitelist
  addBtn.onclick = () => {
    const domain = domainInput.value.trim();
    if (domain) {
      chrome.runtime.sendMessage({ action: 'addWhitelist', domain });
      domainInput.value = '';
    }
  };

  // Toggle logs
  logBtn.onclick = () => {
    logPanel.style.display = logPanel.style.display === 'none' ? 'block' : 'none';
    if (logPanel.style.display === 'block') loadLogs();
  };

  async function loadLogs() {
    const response = await chrome.runtime.sendMessage({ action: 'getLogs' });
    logList.innerHTML = Object.entries(response.logs).map(([domain, count]) => 
      `<li>${domain}: ${count} blocked</li>`
    ).join('') || '<li>No blocks logged</li>';
  }

  // Update status
  function updateStatus(enabled) {
    statusDiv.textContent = enabled ? 'Guard Active' : 'Guard Inactive';
    statusDiv.className = `status ${enabled ? 'enabled' : 'disabled'}`;
  }

  // Init
  chrome.storage.sync.get(['enabled'], (result) => {
    updateStatus(result.enabled !== false); // Default on
  });
});
