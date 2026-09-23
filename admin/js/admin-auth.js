import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { 
  getAuth, 
  signInWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { 
  getFirestore, 
  doc, 
  getDoc 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBDuvhx4Uj4K0lmDZbUO8iRNb3FNK-qI7w",
  authDomain: "flow-access-1f022.firebaseapp.com",
  projectId: "flow-access-1f022",
  storageBucket: "flow-access-1f022.firebasestorage.app",
  messagingSenderId: "1047778033297",
  appId: "1:1047778033297:web:6d58852e9116c3979fc930",
  measurementId: "G-859KQS47TP"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { app, auth, db };

const loginScreen = document.getElementById('login-screen');
const mainApp = document.getElementById('main-app');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const currentAdminEmail = document.getElementById('current-admin-email');
const logoutBtn = document.getElementById('logout-btn');
const globalLoader = document.getElementById('global-loader');

function showLoader() { if (globalLoader) globalLoader.classList.remove('hidden'); }
function hideLoader() { if (globalLoader) globalLoader.classList.add('hidden'); }

// ========================================
// ADMIN CHECK — Hardcoded fallback + Firestore
// ========================================
const FALLBACK_ADMIN_EMAILS = ['hussain@gmail.com'];

async function checkIsAdmin(email) {
  const emailLower = (email || '').toLowerCase().trim();
  console.log('[Admin Auth] Checking admin for:', emailLower);
  
  // 1. Always allow hardcoded admins
  if (FALLBACK_ADMIN_EMAILS.includes(emailLower)) {
    console.log('[Admin Auth] ✅ Matched hardcoded admin:', emailLower);
    return true;
  }
  
  // 2. Also check Firestore for additional admins
  try {
    const adminDoc = await getDoc(doc(db, 'config', 'admin'));
    if (adminDoc.exists()) {
      const data = adminDoc.data();
      const adminEmails = (data.adminEmails || []).map(e => e.toLowerCase().trim());
      console.log('[Admin Auth] Firestore adminEmails:', adminEmails);
      return adminEmails.includes(emailLower);
    } else {
      console.log('[Admin Auth] config/admin doc does not exist, using fallback only');
    }
  } catch (error) {
    console.warn('[Admin Auth] Firestore read error (using fallback):', error.message);
  }
  
  return false;
}

// ========================================
// LOGIN FORM
// ========================================
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('admin-email').value.trim();
  const password = document.getElementById('admin-password').value;
  
  loginError.classList.add('hidden');
  showLoader();

  try {
    console.log('[Admin Auth] Signing in:', email);
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;
    console.log('[Admin Auth] Sign-in success, UID:', user.uid, 'Email:', user.email);
    
    const isAdmin = await checkIsAdmin(user.email);
    console.log('[Admin Auth] isAdmin result:', isAdmin);
    
    if (!isAdmin) {
      await signOut(auth);
      loginError.textContent = "Access Denied: Not an administrator.";
      loginError.classList.remove('hidden');
    }
    // If admin, onAuthStateChanged will handle the UI switch
  } catch (error) {
    console.error('[Admin Auth] Login error:', error);
    let msg = error.message;
    if (error.code === 'auth/invalid-credential') msg = 'Invalid email or password.';
    if (error.code === 'auth/user-not-found') msg = 'No account found with this email.';
    if (error.code === 'auth/wrong-password') msg = 'Incorrect password.';
    loginError.textContent = msg;
    loginError.classList.remove('hidden');
  } finally {
    hideLoader();
  }
});

// ========================================
// LOGOUT
// ========================================
logoutBtn.addEventListener('click', async () => {
  showLoader();
  try {
    await signOut(auth);
  } catch (error) {
    console.error("Logout error", error);
  } finally {
    hideLoader();
  }
});

// ========================================
// AUTH STATE OBSERVER
// ========================================
onAuthStateChanged(auth, async (user) => {
  console.log('[Admin Auth] Auth state changed:', user ? user.email : 'null');
  
  if (user) {
    showLoader();
    const isAdmin = await checkIsAdmin(user.email);
    console.log('[Admin Auth] onAuthStateChanged isAdmin:', isAdmin);
    
    if (isAdmin) {
      loginScreen.classList.add('hidden');
      mainApp.classList.remove('hidden');
      currentAdminEmail.textContent = user.email;
      // Trigger event to load admin panel data
      document.dispatchEvent(new Event('admin-authenticated'));
    } else {
      await signOut(auth);
      loginScreen.classList.remove('hidden');
      mainApp.classList.add('hidden');
    }
    hideLoader();
  } else {
    loginScreen.classList.remove('hidden');
    mainApp.classList.add('hidden');
    hideLoader();
  }
});
