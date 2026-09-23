// FlowAccess Popup — minimal, no technical details shown to user

document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;

// Check if Flow tab is open
chrome.tabs.query({}, (tabs) => {
  const flowOpen = tabs.some(t => t.url && t.url.includes('flow.google.com'));
  const sessionEl = document.getElementById('sessionStatus');
  
  if (flowOpen) {
    sessionEl.innerHTML = '<span class="dot dot-green"></span> Active';
  } else {
    sessionEl.innerHTML = '<span class="dot dot-red"></span> Inactive';
  }
});

// Dashboard button
document.getElementById('dashBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'http://localhost:5500/website/dashboard.html' });
  window.close();
});
