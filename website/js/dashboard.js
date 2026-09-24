import { auth, db } from './firebase-config.js';
import { logoutUser, onAuthChange } from './auth.js';
import { decryptCookies } from './cookie-crypto.js';
import { 
  collection, query, where, getDocs, doc, setDoc, addDoc, updateDoc, 
  serverTimestamp, orderBy, getDoc 
} from "https://www.gstatic.com/firebasejs/11.4.0/firebase-firestore.js";

// === STATE ===
const DEFAULT_TIME_MS = 3 * 60 * 60 * 1000;
let maxTimeMs = DEFAULT_TIME_MS;
let currentUser = null;
let currentSessionId = null;
let remainingTimeMs = DEFAULT_TIME_MS;
let timerInterval = null;
let isExtensionReady = false;
let isPaused = false;
// Liveness tracking: the dataset beacon only proves the extension was
// present at page load — uninstalling does NOT clear it from this page,
// so we re-verify with a PING every few seconds.
let extensionAlive = false;
let extensionConfirmedOnce = false;
let activeEndpointUrl = null;
let activeCookies = null; // direct cookie set from Firebase (preferred over endpoint)

// === DOM ELEMENTS ===
const userEmailEl = document.getElementById('userEmail');
const userNameEl = document.getElementById('userName');
const logoutBtn = document.getElementById('logoutBtn');
const extensionStatusEl = document.getElementById('extensionStatus');
const startFlowBtn = document.getElementById('startFlowBtn');
const pauseFlowBtn = document.getElementById('pauseFlowBtn');
const resumeFlowBtn = document.getElementById('resumeFlowBtn');
const timeRemainingEl = document.getElementById('timeRemaining');
const progressCircle = document.getElementById('progressCircle');
const historyTableBody = document.getElementById('historyTableBody');
const toastContainer = document.getElementById('toastContainer');

// === AUTH STATE ===
onAuthChange(async (user) => {
  if (!user) {
    window.location.href = 'index.html';
    return;
  }
  currentUser = user;
  userEmailEl.innerText = user.email;
  
  try {
    const userDoc = await getDoc(doc(db, 'users', user.uid));
    if (userDoc.exists()) {
      const userData = userDoc.data();
      userNameEl.innerText = userData.displayName || user.email;
      
      // Ban check
      if (userData.isBanned) {
        showToast("Your account has been suspended.", "error");
        await logoutUser();
        return;
      }
      
      // Per-user time limit from admin
      const timeLimitMin = userData.timeLimitMinutes || 180;
      maxTimeMs = timeLimitMin * 60 * 1000;
      remainingTimeMs = maxTimeMs;
      updateTimerUI();
      
      // Show limit info
      const timerLabel = document.querySelector('.timer-container p');
      if (timerLabel) timerLabel.textContent = `Remaining time (${timeLimitMin} min limit per 24hr)`;
    }
  } catch(e) {
    console.error("Error loading user profile:", e);
  }
  
  // Load active endpoint from Firestore
  await loadActiveEndpoint();

  // Check extension
  checkExtension();

  // Watch for mid-session extension removal (uninstall/disable)
  setInterval(monitorExtension, 10000);

  // Saved projects (from extension storage)
  loadSavedProjects();

  // Load usage data & adjust timer
  await loadUsageData();
});

// === LOGOUT ===
logoutBtn.addEventListener('click', async () => {
  if (currentSessionId && !isPaused) {
    await pauseSession();
  }
  await logoutUser();
});

// === TOAST ===
function showToast(message, type = 'error') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerText = message;
  toastContainer.appendChild(toast);
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// === EXTENSION DETECTION ===
function checkExtension() {
  const beacon = document.documentElement.dataset.flowAccessExtension === 'true';
  extensionAlive = beacon;
  extensionConfirmedOnce = beacon;
  if (beacon) {
    setExtensionReady();
  } else {
    updateExtensionStatusUI(false, false);
  }
  document.addEventListener('FLOW_ACCESS_EXTENSION_READY', setExtensionReady);
}

function setExtensionReady() {
  isExtensionReady = true;
  extensionAlive = true;
  extensionConfirmedOnce = true;
  updateExtensionStatusUI(true, false);
  hideExtensionLostOverlay();
  updateButtonStates();
}

function updateExtensionStatusUI(ready, removed) {
  if (ready) {
    extensionStatusEl.innerHTML = `
      <div class="status-badge green">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"></path></svg>
        Extension Ready
      </div>
    `;
  } else {
    extensionStatusEl.innerHTML = `
      <div class="status-badge red">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"></path></svg>
        ${removed ? 'Extension Removed' : 'Extension Not Detected'}
      </div>
      <p class="ext-instruction">${removed
        ? 'The extension was removed or disabled. Re-install it and reload this page.'
        : 'Please install and enable the FlowAccess extension.'}</p>
    `;
  }
}

// === EXTENSION LIVENESS MONITOR ===
// Uninstalling/disabling the extension gives it no shutdown hook —
// Chrome runs zero extension code after removal, so cookies can't be
// wiped and Flow tabs can't be closed at that point. The dashboard
// therefore PINGs the extension every 10s; a true→false transition
// means it was removed mid-session, and we immediately invalidate the
// session server-side (timer stops, resume blocked until reinstall).
function verifyExtensionAlive() {
  return Promise.race([
    requestFromExtension('PING', {}).then(res => !!(res && res.installed === true)),
    new Promise(resolve => setTimeout(() => resolve(false), 2500))
  ]);
}

async function monitorExtension() {
  const alive = await verifyExtensionAlive();
  if (alive === extensionAlive) return;
  extensionAlive = alive;
  if (alive) {
    // Restored (rare on the same page — content scripts don't re-inject
    // until reload — but handle it anyway)
    extensionConfirmedOnce = true;
    setExtensionReady();
  } else if (extensionConfirmedOnce) {
    onExtensionRemoved();
  } else {
    isExtensionReady = false;
    updateExtensionStatusUI(false, false);
    updateButtonStates();
  }
}

async function onExtensionRemoved() {
  isExtensionReady = false;
  updateExtensionStatusUI(false, true);

  // Invalidate any running session server-side. NOTE: WIPE_COOKIES /
  // CLOSE_FLOW_TAB are impossible here — there is no extension left to
  // receive them. The session is frozen as Paused so no further time
  // accrues and Resume stays blocked until the extension is back.
  if (currentSessionId && !isPaused) {
    try {
      isPaused = true;
      if (timerInterval) clearInterval(timerInterval);
      stopHeartbeat();
      const sessionRef = doc(db, 'sessions', currentSessionId);
      const sessionDoc = await getDoc(sessionRef);
      let durationMs = 0;
      if (sessionDoc.exists() && sessionDoc.data().startedAt) {
        durationMs = Math.max(0, Date.now() - sessionDoc.data().startedAt.toDate().getTime());
      }
      await updateDoc(sessionRef, {
        status: 'Paused',
        durationMs: durationMs,
        pausedAt: serverTimestamp(),
        pausedReason: 'extension_removed'
      });
      console.log('[Dashboard] Session auto-paused: extension removed');
    } catch(e) {
      console.error('[Dashboard] Auto-pause on extension removal failed:', e);
    }
  }

  updateButtonStates();
  if (currentSessionId) showExtensionLostOverlay();
  else showToast("⚠️ FlowAccess extension was removed or disabled.", "error");
}

let extLostOverlay = null;
function showExtensionLostOverlay() {
  if (extLostOverlay) { extLostOverlay.style.display = 'flex'; return; }
  extLostOverlay = document.createElement('div');
  extLostOverlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.72);backdrop-filter:blur(4px);';
  extLostOverlay.innerHTML = `
    <div style="background:#1f2937;color:#f9fafb;border:1px solid #374151;border-radius:16px;padding:32px 36px;max-width:430px;margin:16px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5);font-family:inherit;">
      <div style="font-size:44px;margin-bottom:12px;">🧩</div>
      <h2 style="margin:0 0 10px;font-size:20px;">Extension Removed</h2>
      <p style="margin:0 0 8px;color:#d1d5db;font-size:14px;line-height:1.6;">
        The FlowAccess extension was removed or disabled, so your session has been
        <b>paused</b> and the timer stopped.
      </p>
      <p style="margin:0 0 20px;color:#9ca3af;font-size:13px;line-height:1.6;">
        Re-install / re-enable the extension, then reload this page and press Resume.
      </p>
      <button id="fa-ext-lost-reload" style="background:#3b82f6;color:#fff;border:none;border-radius:10px;padding:12px 28px;font-size:15px;font-weight:600;cursor:pointer;">↻ Reload Dashboard</button>
    </div>`;
  document.body.appendChild(extLostOverlay);
  extLostOverlay.querySelector('#fa-ext-lost-reload').addEventListener('click', () => location.reload());
}

function hideExtensionLostOverlay() {
  if (extLostOverlay) extLostOverlay.style.display = 'none';
}

// === LOAD ACTIVE ACCESS CONFIG ===
// Reads the published access config from config/public (readable by all
// signed-in users). Prefers a directly-stored cookie set; falls back to
// the external endpoint URL. Raw collections stay admin-only.
async function loadActiveEndpoint() {
  try {
    const pubDoc = await getDoc(doc(db, 'config', 'public'));
    if (pubDoc.exists()) {
      const data = pubDoc.data();
      if (data.activeEndpointUrl) {
        try { activeEndpointUrl = atob(data.activeEndpointUrl); }
        catch(e) { activeEndpointUrl = data.activeEndpointUrl; }
      }
      // Encrypted cookie set first (AES-256), legacy plaintext second
      if (data.activeCookiesEncrypted) {
        try {
          activeCookies = await decryptCookies(data.activeCookiesEncrypted);
        } catch(e) {
          console.error("Cookie decrypt failed — secret mismatch?", e);
          showToast("❌ Cookie decrypt failed. Contact admin.", "error");
        }
      } else if (Array.isArray(data.activeCookies) && data.activeCookies.length) {
        activeCookies = data.activeCookies;
      }
    }
    console.log('[Dashboard] Access config loaded:',
      activeCookies ? `cookies (${activeCookies.length})` : (activeEndpointUrl ? 'endpoint' : 'NONE'));
  } catch(e) {
    console.error("Error loading access config:", e);
  }
}

// Inject Flow access: direct Firebase cookies first, endpoint fetch second.
function injectAccessCookies() {
  if (activeCookies && activeCookies.length) {
    sendToExtension('INJECT_COOKIES', {
      cookies: activeCookies,
      sessionId: currentSessionId
    });
    return true;
  }
  if (activeEndpointUrl) {
    sendToExtension('FETCH_AND_INJECT', {
      endpointUrl: activeEndpointUrl,
      sessionId: currentSessionId
    });
    return true;
  }
  return false;
}

// === LOAD USAGE DATA ===
async function loadUsageData() {
  try {
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    
    const q = query(collection(db, 'sessions'), where('userId', '==', currentUser.uid));
    const snapshot = await getDocs(q);
    let totalUsedMs = 0;
    
    historyTableBody.innerHTML = '';
    
    // Filter last 24h client-side, skip AdminReset sessions
    const sessions = [];
    snapshot.forEach(d => {
      const data = d.data();
      if (data.status === 'AdminReset') return; // Skip admin-reset sessions
      const startMs = data.startedAt?.toMillis ? data.startedAt.toMillis() : 0;
      if (startMs > twentyFourHoursAgo.getTime()) {
        sessions.push({ id: d.id, data, startMs });
      }
    });
    sessions.sort((a, b) => b.startMs - a.startMs);
    
    sessions.forEach(({ id, data }) => {
      let durationMs = data.durationMs || 0;

      // Active session — check liveness via heartbeat before resuming timer
      if (data.status === 'Active' && data.startedAt) {
        if (isSessionStale(data, now)) {
          // Browser was closed / dashboard gone — freeze it as Expired
          expireStaleSession(id, data, now);
          durationMs = data.durationMs || (now.getTime() - startMs);
        } else {
          const started = data.startedAt.toDate();
          durationMs = now.getTime() - started.getTime();
          currentSessionId = id;
          isPaused = false;
          startTimer();
          startHeartbeat();
        }
      }
      
      // Paused session — show paused state
      if (data.status === 'Paused') {
        currentSessionId = id;
        isPaused = true;
      }
      
      totalUsedMs += durationMs;
      
      const tr = document.createElement('tr');
      const dateStr = data.startedAt ? data.startedAt.toDate().toLocaleString() : 'N/A';
      const durStr = formatTime(durationMs);
      const status = data.status || (data.endedAt ? 'Completed' : 'Active');
      tr.innerHTML = `
        <td>${dateStr}</td>
        <td>${durStr}</td>
        <td><span class="status-${status.toLowerCase()}">${status}</span></td>
      `;
      historyTableBody.appendChild(tr);
    });
    
    remainingTimeMs = Math.max(0, maxTimeMs - totalUsedMs);
    updateTimerUI();
    updateButtonStates();
    
    if (sessions.length === 0) {
      historyTableBody.innerHTML = '<tr><td colspan="3" class="text-center">No sessions in the last 24 hours</td></tr>';
    }
  } catch (error) {
    console.error("Error loading usage:", error);
    updateTimerUI();
    updateButtonStates();
  }
}

// === SESSION HEARTBEAT & STALE RECONCILIATION ===
// While a session is Active, the dashboard writes a heartbeat every
// 60s. If the browser was closed without pausing, the next dashboard
// load finds a stale heartbeat and freezes the session as Expired
// instead of letting wall-clock usage accrue forever.

const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const STALE_AFTER_MS = 10 * 60 * 1000;
let heartbeatInterval = null;

function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(async () => {
    if (!currentSessionId || isPaused) return;
    try {
      await updateDoc(doc(db, 'sessions', currentSessionId), {
        lastHeartbeat: serverTimestamp()
      });
    } catch(e) {
      console.warn('[Dashboard] Heartbeat failed:', e.message);
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = null;
}

function heartbeatAgeMs(data, now) {
  const hb = data.lastHeartbeat;
  const hbMs = hb && hb.toMillis ? hb.toMillis() : 0;
  return hbMs ? now.getTime() - hbMs : Infinity;
}

function isSessionStale(data, now) {
  const age = heartbeatAgeMs(data, now);
  if (age !== Infinity) return age > STALE_AFTER_MS;
  // Legacy sessions without heartbeat: stale if started > 30 min ago
  const startMs = data.startedAt && data.startedAt.toMillis ? data.startedAt.toMillis() : 0;
  return startMs ? (now.getTime() - startMs) > 30 * 60 * 1000 : false;
}

async function expireStaleSession(id, data, now) {
  try {
    const startMs = data.startedAt && data.startedAt.toMillis ? data.startedAt.toMillis() : now.getTime();
    const durationMs = Math.max(0, now.getTime() - startMs);
    await updateDoc(doc(db, 'sessions', id), {
      status: 'Expired',
      endedAt: serverTimestamp(),
      endTime: serverTimestamp(),
      durationMs: durationMs,
      expiredReason: 'stale-heartbeat'
    });
    console.log('[Dashboard] Expired stale session:', id);
  } catch(e) {
    console.warn('[Dashboard] Could not expire stale session:', e.message);
  }
}

// === BUTTON STATES ===
function updateButtonStates() {
  // Extension missing — nothing session-related can work, so never
  // offer Start/Pause/Resume (this also covers "resume shown after
  // the extension was removed").
  if (!isExtensionReady) {
    startFlowBtn.style.display = '';
    pauseFlowBtn.style.display = 'none';
    resumeFlowBtn.style.display = 'none';
    startFlowBtn.disabled = true;
    startFlowBtn.innerText = "⚠️ Extension Required";
    startFlowBtn.style.background = '#6b7280';
    return;
  }

  startFlowBtn.style.display = '';
  pauseFlowBtn.style.display = 'none';
  resumeFlowBtn.style.display = 'none';

  if (remainingTimeMs <= 0) {
    // Time expired
    startFlowBtn.disabled = true;
    startFlowBtn.innerText = "⏰ Daily Limit Reached";
    startFlowBtn.style.background = '#ef4444';
  } else if (currentSessionId && !isPaused) {
    // Active session — show pause button
    startFlowBtn.style.display = 'none';
    pauseFlowBtn.style.display = 'block';
  } else if (currentSessionId && isPaused) {
    // Paused session — show resume button
    startFlowBtn.style.display = 'none';
    resumeFlowBtn.style.display = 'block';
  } else {
    // No session — show start button
    startFlowBtn.disabled = false;
    startFlowBtn.innerText = "▶ Access Flow";
    startFlowBtn.style.background = '';
  }
}

// === TIMER ===
function formatTime(ms) {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function updateTimerUI() {
  timeRemainingEl.innerText = formatTime(remainingTimeMs);
  const percent = Math.max(0, Math.min(100, (remainingTimeMs / maxTimeMs) * 100));
  const offset = 282.74 - (percent / 100) * 282.74;
  progressCircle.style.strokeDashoffset = offset;
  
  if (remainingTimeMs < 60000) {
    progressCircle.style.stroke = '#ef4444';
    timeRemainingEl.style.color = '#ef4444';
  } else if (remainingTimeMs < maxTimeMs * 0.2) {
    progressCircle.style.stroke = '#eab308';
    timeRemainingEl.style.color = '#eab308';
  } else {
    progressCircle.style.stroke = '';
    timeRemainingEl.style.color = '';
  }
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  
  timerInterval = setInterval(async () => {
    if (isPaused) return;
    
    remainingTimeMs = Math.max(0, remainingTimeMs - 1000);
    updateTimerUI();
    
    if (remainingTimeMs <= 0) {
      clearInterval(timerInterval);
      
      // Time expired — end session, wipe cookies, close Flow
      await endSession('Expired');
      
      // Wipe cookies (logout from Flow)
      sendToExtension('WIPE_COOKIES', {});
      
      // Close Flow tab
      sendToExtension('CLOSE_FLOW_TAB', {});
      
      showToast("⏰ Time limit reached! Flow session ended.", "error");
      updateButtonStates();
      
      setTimeout(() => loadUsageData(), 1000);
    }
  }, 1000);
}

// === EXTENSION COMMUNICATION ===
// Messages are posted to our own origin only; the content-script
// bridge additionally checks the origin against its allowlist.
function sendToExtension(action, payload) {
  window.postMessage({
    source: 'FLOW_ACCESS_WEB',
    id: action + '-' + Date.now(),
    action: action,
    payload: payload || {}
  }, window.location.origin);
}

// Request/response variant: resolves with the extension's reply payload.
const pendingExtensionRequests = {};
function requestFromExtension(action, payload) {
  return new Promise((resolve) => {
    const id = action + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    pendingExtensionRequests[id] = resolve;
    window.postMessage({
      source: 'FLOW_ACCESS_WEB',
      id: id,
      action: action,
      payload: payload || {}
    }, window.location.origin);
    setTimeout(() => {
      if (pendingExtensionRequests[id]) {
        delete pendingExtensionRequests[id];
        resolve({ success: false, error: 'Extension not responding' });
      }
    }, 8000);
  });
}

// Listen for extension replies
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data) return;
  if (event.data.source !== 'FLOW_ACCESS_EXTENSION_REPLY') return;

  const { id, payload } = event.data;
  if (id && pendingExtensionRequests[id]) {
    pendingExtensionRequests[id](payload);
    delete pendingExtensionRequests[id];
    return;
  }

  if (payload && payload.success) {
    console.log('[Dashboard] Extension response:', payload);
  } else if (payload && payload.error) {
    console.warn('[Dashboard] Extension error:', payload.error);
  }
});

// === SAVED PROJECTS (max 3, stored by the extension) ===
const savedProjectsListEl = document.getElementById('savedProjectsList');
const savedProjectsCountEl = document.getElementById('savedProjectsCount');

async function loadSavedProjects() {
  const res = await requestFromExtension('GET_SAVED_PROJECTS', {});
  if (res && res.success && Array.isArray(res.projects)) {
    renderSavedProjects(res.projects);
  } else {
    savedProjectsCountEl.textContent = '0/3';
    savedProjectsListEl.innerHTML =
      '<p style="color: var(--text-muted); font-size: 0.875rem;">Install the FlowAccess extension to save projects.</p>';
  }
}

function renderSavedProjects(projects) {
  savedProjectsCountEl.textContent = projects.length + '/3';
  if (!projects.length) {
    savedProjectsListEl.innerHTML =
      '<p style="color: var(--text-muted); font-size: 0.875rem;">No saved projects yet.</p>';
    return;
  }
  savedProjectsListEl.innerHTML = '';
  projects.forEach((url) => {
    const m = url.match(/\/project\/([a-zA-Z0-9_\-]+)/);
    const label = m ? m[1] : url;
    const row = document.createElement('div');
    row.className = 'saved-project-row';

    const nameEl = document.createElement('span');
    nameEl.className = 'saved-project-id';
    nameEl.title = url;
    nameEl.textContent = label.length > 14 ? label.slice(0, 14) + '…' : label;

    const openBtn = document.createElement('button');
    openBtn.className = 'btn btn-primary btn-sm';
    openBtn.textContent = 'Open';
    openBtn.addEventListener('click', () => window.open(url, '_blank', 'noopener'));

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm';
    delBtn.textContent = '✕';
    delBtn.style.cssText = 'background: transparent; border: 1px solid var(--glass-border); color: #f87171;';
    delBtn.title = 'Remove';
    delBtn.addEventListener('click', async () => {
      const res = await requestFromExtension('REMOVE_SAVED_PROJECT', { url });
      if (res && res.success) renderSavedProjects(res.projects || []);
      else showToast('❌ Could not remove project', 'error');
    });

    row.appendChild(nameEl);
    row.appendChild(openBtn);
    row.appendChild(delBtn);
    savedProjectsListEl.appendChild(row);
  });
}

// ========================================
// START SESSION
// ========================================
startFlowBtn.addEventListener('click', async () => {
  try {
    startFlowBtn.disabled = true;
    startFlowBtn.innerText = "⏳ Connecting...";

    const hasAccess = (activeCookies && activeCookies.length) || activeEndpointUrl;
    if (!hasAccess) {
      showToast("❌ Service unavailable. Contact admin.", "error");
      startFlowBtn.disabled = false;
      startFlowBtn.innerText = "▶ Access Flow";
      return;
    }

    // 0. Verify the extension is really alive (the load-time beacon can't
    //    detect a mid-session uninstall) — never create a session without it
    startFlowBtn.innerText = "⏳ Verifying extension...";
    const extAlive = await verifyExtensionAlive();
    if (!extAlive) {
      isExtensionReady = false;
      extensionAlive = false;
      updateExtensionStatusUI(false, true);
      updateButtonStates();
      showToast("❌ FlowAccess extension not detected. Install/enable it and reload this page.", "error");
      return;
    }
    
    // 1. Create session in Firestore
    const sessionRef = await addDoc(collection(db, 'sessions'), {
      userId: currentUser.uid,
      userEmail: currentUser.email,
      startedAt: serverTimestamp(),
      startTime: serverTimestamp(),
      endedAt: null,
      endTime: null,
      durationMs: 0,
      lastHeartbeat: serverTimestamp(),
      status: 'Active'
    });
    
    currentSessionId = sessionRef.id;
    isPaused = false;
    
    // 2. Tell extension to setup access and open Flow (all behind the scenes)
    injectAccessCookies();
    
    // 3. Start countdown timer + heartbeat
    showToast("✅ Session started! Opening Flow...", "success");
    startTimer();
    startHeartbeat();
    updateButtonStates();
    
  } catch (error) {
    console.error("Error starting flow:", error);
    showToast("❌ Failed to start. Try again.", "error");
    startFlowBtn.disabled = false;
    startFlowBtn.innerText = "▶ Access Flow";
  }
});

// ========================================
// PAUSE SESSION
// ========================================
pauseFlowBtn.addEventListener('click', async () => {
  await pauseSession();
});

async function pauseSession() {
  if (!currentSessionId) return;
  
  try {
    isPaused = true;
    if (timerInterval) clearInterval(timerInterval);
    stopHeartbeat();
    
    // Update session status in Firestore
    const sessionRef = doc(db, 'sessions', currentSessionId);
    const sessionDoc = await getDoc(sessionRef);
    if (sessionDoc.exists()) {
      const data = sessionDoc.data();
      const started = data.startedAt.toDate();
      const now = new Date();
      const durationMs = now.getTime() - started.getTime();
      
      await updateDoc(sessionRef, {
        status: 'Paused',
        durationMs: durationMs,
        pausedAt: serverTimestamp()
      });
    }
    
    // Wipe cookies — logout from Flow
    sendToExtension('WIPE_COOKIES', {});
    
    // Close Flow tab
    sendToExtension('CLOSE_FLOW_TAB', {});
    
    showToast("⏸ Session paused.", "success");
    updateButtonStates();
    
  } catch(e) {
    console.error("Pause error:", e);
    showToast("Error pausing session", "error");
  }
}

// ========================================
// RESUME SESSION
// ========================================
resumeFlowBtn.addEventListener('click', async () => {
  try {
    resumeFlowBtn.disabled = true;
    resumeFlowBtn.innerText = "🔄 Resuming...";

    const hasAccess = (activeCookies && activeCookies.length) || activeEndpointUrl;
    if (!hasAccess) {
      showToast("❌ No active access config.", "error");
      resumeFlowBtn.disabled = false;
      resumeFlowBtn.innerText = "▶ Resume Session";
      return;
    }

    // 0. Never resume without a live extension — otherwise the cookie
    //    inject goes nowhere but a session + timer would still start
    resumeFlowBtn.innerText = "🔍 Verifying...";
    const extAlive = await verifyExtensionAlive();
    if (!extAlive) {
      isExtensionReady = false;
      extensionAlive = false;
      updateExtensionStatusUI(false, true);
      updateButtonStates();
      showToast("❌ FlowAccess extension not detected. Install/enable it and reload this page.", "error");
      return;
    }

    // 1. Re-inject cookies and open Flow
    injectAccessCookies();
    
    // 2. Create new session (old one was paused with duration saved)
    const sessionRef = await addDoc(collection(db, 'sessions'), {
      userId: currentUser.uid,
      userEmail: currentUser.email,
      startedAt: serverTimestamp(),
      startTime: serverTimestamp(),
      endedAt: null,
      endTime: null,
      durationMs: 0,
      lastHeartbeat: serverTimestamp(),
      status: 'Active',
      resumedFrom: currentSessionId
    });
    
    currentSessionId = sessionRef.id;
    isPaused = false;
    
    // 3. Restart timer + heartbeat
    startTimer();
    startHeartbeat();
    updateButtonStates();
    
    showToast("▶ Session resumed! Opening Flow...", "success");
    
  } catch(e) {
    console.error("Resume error:", e);
    showToast("Error resuming", "error");
    resumeFlowBtn.disabled = false;
    resumeFlowBtn.innerText = "▶ Resume Session";
  }
});

// ========================================
// END SESSION
// ========================================
async function endSession(status = 'Completed') {
  if (!currentSessionId) return;
  
  try {
    const sessionRef = doc(db, 'sessions', currentSessionId);
    const sessionDoc = await getDoc(sessionRef);
    if (sessionDoc.exists()) {
      const data = sessionDoc.data();
      const started = data.startedAt.toDate();
      const now = new Date();
      const durationMs = now.getTime() - started.getTime();
      
      await updateDoc(sessionRef, {
        endedAt: serverTimestamp(),
        endTime: serverTimestamp(),
        durationMs: durationMs,
        status: status
      });
    }
    
    currentSessionId = null;
    if (timerInterval) clearInterval(timerInterval);
    stopHeartbeat();
    updateButtonStates();
    
  } catch (error) {
    console.error("Error ending session:", error);
  }
}
