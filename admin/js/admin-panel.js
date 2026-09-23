import { db } from './admin-auth.js';
import { 
  collection, getDocs, getDoc, doc, updateDoc, 
  deleteDoc, setDoc, query, orderBy, limit, addDoc, serverTimestamp, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// --- UI Utils ---
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'fadeOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function showConfirm(title, message, onConfirm) {
  const modal = document.getElementById('confirm-modal');
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = message;
  modal.classList.remove('hidden');
  
  const okBtn = document.getElementById('confirm-ok');
  const cancelBtn = document.getElementById('confirm-cancel');
  
  const handleOk = () => {
    cleanup();
    onConfirm();
  };
  const handleCancel = () => cleanup();
  
  const cleanup = () => {
    modal.classList.add('hidden');
    okBtn.removeEventListener('click', handleOk);
    cancelBtn.removeEventListener('click', handleCancel);
  };
  
  okBtn.addEventListener('click', handleOk);
  cancelBtn.addEventListener('click', handleCancel);
}

// Navigation
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', (e) => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view-section').forEach(s => s.classList.add('hidden'));
    
    e.target.classList.add('active');
    document.getElementById(e.target.dataset.target).classList.remove('hidden');
  });
});

// --- Encryption Utils (AES-256-GCM) ---
async function getMasterKeyHex() {
  const docSnap = await getDoc(doc(db, 'config', 'encryption'));
  if (docSnap.exists() && docSnap.data().masterKey) {
    return docSnap.data().masterKey;
  }
  // Generate and store if not exists
  const keyBuffer = crypto.getRandomValues(new Uint8Array(32));
  const hexKey = Array.from(keyBuffer).map(b => b.toString(16).padStart(2, '0')).join('');
  await setDoc(doc(db, 'config', 'encryption'), { masterKey: hexKey });
  return hexKey;
}

function hexToBuffer(hex) {
  const bytes = new Uint8Array(Math.ceil(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

function bufferToBase64(buffer) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(buffer)));
}

function base64ToBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function getCryptoKey(hexKey) {
  return await crypto.subtle.importKey(
    "raw", hexToBuffer(hexKey),
    { name: "AES-GCM", length: 256 },
    false, ["encrypt", "decrypt"]
  );
}

async function encrypt(plaintext, keyHex) {
  const key = await getCryptoKey(keyHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv },
    key, encoded
  );
  
  return {
    ciphertext: bufferToBase64(ciphertext),
    iv: bufferToBase64(iv)
  };
}

async function decrypt(ciphertextBase64, ivBase64, keyHex) {
  const key = await getCryptoKey(keyHex);
  const ciphertext = base64ToBuffer(ciphertextBase64);
  const iv = base64ToBuffer(ivBase64);
  
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv },
    key, ciphertext
  );
  
  return new TextDecoder().decode(decrypted);
}

// --- Data Fetching & Rendering ---
let masterKeyHex = null;
let sessionsUnsubscribe = null;

document.addEventListener('admin-authenticated', async () => {
  masterKeyHex = await getMasterKeyHex();
  loadDashboard();
  loadUsers();
  loadEndpoints();
  loadSessions();
});

// 1. Dashboard
async function loadDashboard() {
  try {
    const usersSnap = await getDocs(collection(db, 'users'));
    document.getElementById('stat-total-users').textContent = usersSnap.size;

    const sessionsSnap = await getDocs(collection(db, 'sessions'));
    document.getElementById('stat-total-sessions').textContent = sessionsSnap.size;

    let activeSessions = 0;
    let todaySessions = 0;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    sessionsSnap.forEach(doc => {
      const data = doc.data();
      if (data.status === 'Active') activeSessions++;
      
      const startTime = data.startTime?.toMillis ? data.startTime.toMillis() : data.startTime;
      if (startTime > todayStart) todaySessions++;
    });

    document.getElementById('stat-active-sessions').textContent = activeSessions;
    document.getElementById('stat-sessions-today').textContent = todaySessions;

    // Recent Activity (faked from recent sessions for now)
    const recentQ = query(collection(db, 'sessions'), orderBy('startTime', 'desc'), limit(10));
    const recentSnap = await getDocs(recentQ);
    const tbody = document.getElementById('recent-activity-tbody');
    tbody.innerHTML = '';
    
    recentSnap.forEach(doc => {
      const d = doc.data();
      const time = d.startTime?.toDate ? d.startTime.toDate().toLocaleString() : new Date(d.startTime).toLocaleString();
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${time}</td>
        <td>${d.userEmail || 'Unknown'}</td>
        <td>Session ${d.status}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch(e) {
    console.error("Dashboard error", e);
  }
}

// 2. Users
const FIREBASE_API_KEY = 'AIzaSyBDuvhx4Uj4K0lmDZbUO8iRNb3FNK-qI7w';

async function loadUsers() {
  try {
    const tbody = document.getElementById('users-tbody');
    tbody.innerHTML = '<tr><td colspan="7">Loading...</td></tr>';
    
    const snap = await getDocs(collection(db, 'users'));
    tbody.innerHTML = '';
    
    snap.forEach(docSnap => {
      const u = docSnap.data();
      const tr = document.createElement('tr');
      const isBanned = u.isBanned === true;
      const created = u.createdAt?.toDate ? u.createdAt.toDate().toLocaleDateString() : 'N/A';
      const timeLimit = u.timeLimitMinutes || 180;
      
      tr.innerHTML = `
        <td>${u.email || 'N/A'}</td>
        <td>${u.displayName || 'N/A'}</td>
        <td>${created}</td>
        <td>
          <span class="badge badge-active" style="cursor:pointer;" onclick="window.editTimeLimit('${docSnap.id}', ${timeLimit})" title="Click to edit">
            ${timeLimit} min
          </span>
        </td>
        <td>${u.totalUsageMinutes || 0}</td>
        <td><span class="badge ${isBanned ? 'badge-banned' : 'badge-active'}">${isBanned ? 'Banned' : 'Active'}</span></td>
        <td class="actions-cell">
          <button class="btn btn-sm btn-secondary" onclick="window.editTimeLimit('${docSnap.id}', ${timeLimit})">⏱️</button>
          <button class="btn btn-sm ${isBanned ? 'btn-primary' : 'btn-danger'}" onclick="window.toggleUserBan('${docSnap.id}', ${isBanned})">
            ${isBanned ? 'Unban' : 'Ban'}
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });
    
    if (snap.empty) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color: var(--text-muted);">No users yet. Create one!</td></tr>';
    }
  } catch(e) {
    console.error("Users error:", e);
    showToast('Error loading users: ' + e.message, 'error');
  }
}

document.getElementById('refresh-users').addEventListener('click', loadUsers);

// Ban/Unban toggle
window.toggleUserBan = async (uid, currentIsBanned) => {
  const action = currentIsBanned ? 'Unban' : 'Ban';
  showConfirm(`${action} User`, `Are you sure you want to ${action.toLowerCase()} this user?`, async () => {
    try {
      await updateDoc(doc(db, 'users', uid), { isBanned: !currentIsBanned });
      showToast(`User ${action.toLowerCase()}ned successfully`, 'success');
      loadUsers();
    } catch(e) {
      showToast(`Failed to ${action.toLowerCase()} user`, 'error');
    }
  });
};

// --- Create User ---
const createUserModal = document.getElementById('create-user-modal');
document.getElementById('create-user-btn').addEventListener('click', () => {
  document.getElementById('create-user-form').reset();
  document.getElementById('new-user-time-limit').value = 180;
  createUserModal.classList.remove('hidden');
});
document.getElementById('create-user-cancel').addEventListener('click', () => {
  createUserModal.classList.add('hidden');
});

document.getElementById('create-user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const name = document.getElementById('new-user-name').value.trim();
  const email = document.getElementById('new-user-email').value.trim();
  const password = document.getElementById('new-user-password').value;
  const timeLimit = parseInt(document.getElementById('new-user-time-limit').value) || 180;
  
  try {
    showToast('Creating user...', 'info');
    
    // Create user via Firebase Auth REST API (doesn't affect current admin session)
    const signUpResp = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true })
      }
    );
    
    const signUpData = await signUpResp.json();
    
    if (signUpData.error) {
      throw new Error(signUpData.error.message);
    }
    
    const newUid = signUpData.localId;
    
    // Create user profile in Firestore
    await setDoc(doc(db, 'users', newUid), {
      email: email,
      displayName: name,
      createdAt: serverTimestamp(),
      isBanned: false,
      totalUsageMinutes: 0,
      timeLimitMinutes: timeLimit,
      role: 'user'
    });
    
    showToast(`✅ User created: ${email} (${timeLimit} min limit)`, 'success');
    createUserModal.classList.add('hidden');
    loadUsers();
    loadDashboard();
    
  } catch (error) {
    console.error('Create user error:', error);
    let msg = error.message;
    if (msg.includes('EMAIL_EXISTS')) msg = 'This email is already registered!';
    if (msg.includes('WEAK_PASSWORD')) msg = 'Password must be at least 6 characters!';
    if (msg.includes('INVALID_EMAIL')) msg = 'Invalid email address!';
    showToast('❌ Error: ' + msg, 'error');
  }
});

// --- Edit Time Limit ---
const editTimeModal = document.getElementById('edit-time-modal');

window.editTimeLimit = (uid, currentLimit) => {
  document.getElementById('edit-time-uid').value = uid;
  document.getElementById('edit-time-value').value = currentLimit;
  editTimeModal.classList.remove('hidden');
};

document.getElementById('edit-time-cancel').addEventListener('click', () => {
  editTimeModal.classList.add('hidden');
});

document.getElementById('edit-time-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const uid = document.getElementById('edit-time-uid').value;
  const newLimit = parseInt(document.getElementById('edit-time-value').value);
  
  try {
    await updateDoc(doc(db, 'users', uid), { timeLimitMinutes: newLimit });
    showToast(`✅ Time limit updated to ${newLimit} minutes`, 'success');
    editTimeModal.classList.add('hidden');
    loadUsers();
  } catch (error) {
    showToast('❌ Error updating time limit', 'error');
  }
});

// 3. Endpoints
async function loadEndpoints() {
  try {
    const tbody = document.getElementById('endpoints-tbody');
    tbody.innerHTML = '<tr><td colspan="5">Loading...</td></tr>';
    
    const snap = await getDocs(collection(db, 'endpoints'));
    tbody.innerHTML = '';
    
    snap.forEach(docSnap => {
      const e = docSnap.data();
      const tr = document.createElement('tr');
      const updated = e.updatedAt?.toDate ? e.updatedAt.toDate().toLocaleString() : 'N/A';
      
      const encUrlTrunc = e.encryptedUrl ? e.encryptedUrl.substring(0, 20) + '...' : 'N/A';
      
      tr.innerHTML = `
        <td>${e.name || 'N/A'}</td>
        <td title="${e.encryptedUrl}">${encUrlTrunc}</td>
        <td><span class="badge ${e.isActive ? 'badge-active' : 'badge-inactive'}">${e.isActive ? 'Active' : 'Inactive'}</span></td>
        <td>${updated}</td>
        <td class="actions-cell">
          <button class="btn btn-sm btn-secondary" onclick="window.editEndpoint('${docSnap.id}')">Edit</button>
          <button class="btn btn-sm btn-secondary" onclick="window.toggleEndpoint('${docSnap.id}', ${e.isActive})">Toggle</button>
          <button class="btn btn-sm btn-danger" onclick="window.deleteEndpoint('${docSnap.id}')">Delete</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch(err) {
    showToast('Error loading endpoints', 'error');
  }
}

const endpointModal = document.getElementById('endpoint-modal');
document.getElementById('add-endpoint-btn').addEventListener('click', () => {
  document.getElementById('endpoint-form').reset();
  document.getElementById('endpoint-id').value = '';
  document.getElementById('endpoint-modal-title').textContent = 'Add Endpoint';
  endpointModal.classList.remove('hidden');
});

document.getElementById('endpoint-cancel').addEventListener('click', () => {
  endpointModal.classList.add('hidden');
});

document.getElementById('endpoint-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('endpoint-id').value;
  const name = document.getElementById('endpoint-name').value;
  const url = document.getElementById('endpoint-url').value;
  const isActive = document.getElementById('endpoint-active').checked;
  
  try {
    const encrypted = await encrypt(url, masterKeyHex);
    
    const data = {
      name,
      encryptedUrl: encrypted.ciphertext,
      iv: encrypted.iv,
      isActive,
      updatedAt: serverTimestamp()
    };

    if (id) {
      await updateDoc(doc(db, 'endpoints', id), data);
      showToast('Endpoint updated', 'success');
    } else {
      data.createdAt = serverTimestamp();
      await addDoc(collection(db, 'endpoints'), data);
      showToast('Endpoint added', 'success');
    }
    
    endpointModal.classList.add('hidden');
    loadEndpoints();
  } catch (error) {
    console.error(error);
    showToast('Error saving endpoint', 'error');
  }
});

window.editEndpoint = async (id) => {
  try {
    const docSnap = await getDoc(doc(db, 'endpoints', id));
    if (docSnap.exists()) {
      const data = docSnap.data();
      const url = await decrypt(data.encryptedUrl, data.iv, masterKeyHex);
      
      document.getElementById('endpoint-id').value = id;
      document.getElementById('endpoint-name').value = data.name;
      document.getElementById('endpoint-url').value = url;
      document.getElementById('endpoint-active').checked = data.isActive;
      
      document.getElementById('endpoint-modal-title').textContent = 'Edit Endpoint';
      endpointModal.classList.remove('hidden');
    }
  } catch (error) {
    showToast('Error decrypting endpoint', 'error');
  }
};

window.toggleEndpoint = async (id, currentState) => {
  try {
    await updateDoc(doc(db, 'endpoints', id), { isActive: !currentState, updatedAt: serverTimestamp() });
    showToast('Endpoint status toggled', 'success');
    loadEndpoints();
  } catch (error) {
    showToast('Error toggling status', 'error');
  }
};

window.deleteEndpoint = (id) => {
  showConfirm('Delete Endpoint', 'Are you sure you want to delete this endpoint?', async () => {
    try {
      await deleteDoc(doc(db, 'endpoints', id));
      showToast('Endpoint deleted', 'success');
      loadEndpoints();
    } catch (error) {
      showToast('Error deleting endpoint', 'error');
    }
  });
};

// 4. Sessions
function loadSessions() {
  if (sessionsUnsubscribe) sessionsUnsubscribe();
  
  const q = query(collection(db, 'sessions'), orderBy('startTime', 'desc'), limit(50));
  
  sessionsUnsubscribe = onSnapshot(q, (snapshot) => {
    const tbody = document.getElementById('sessions-tbody');
    tbody.innerHTML = '';
    
    snapshot.forEach(docSnap => {
      const s = docSnap.data();
      const tr = document.createElement('tr');
      
      const start = s.startTime?.toDate ? s.startTime.toDate().toLocaleString() : new Date(s.startTime).toLocaleString();
      const end = s.endTime ? (s.endTime?.toDate ? s.endTime.toDate().toLocaleString() : new Date(s.endTime).toLocaleString()) : '-';
      
      let durationStr = '-';
      if (s.startTime && s.endTime) {
        const startMs = s.startTime?.toDate ? s.startTime.toDate().getTime() : new Date(s.startTime).getTime();
        const endMs = s.endTime?.toDate ? s.endTime.toDate().getTime() : new Date(s.endTime).getTime();
        const diffMins = Math.floor((endMs - startMs) / 60000);
        durationStr = `${diffMins} min`;
      }
      
      let badgeClass = 'badge-active';
      if (s.status === 'Completed') badgeClass = 'badge-completed';
      if (s.status === 'Expired') badgeClass = 'badge-banned';
      
      tr.innerHTML = `
        <td>${s.userEmail || 'Unknown'}</td>
        <td>${start}</td>
        <td>${end}</td>
        <td>${durationStr}</td>
        <td><span class="badge ${badgeClass}">${s.status}</span></td>
      `;
      tbody.appendChild(tr);
    });
  }, (error) => {
    console.error("Sessions error", error);
    showToast('Error loading sessions', 'error');
  });
}

document.getElementById('refresh-sessions').addEventListener('click', loadSessions);
