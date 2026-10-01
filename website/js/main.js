import { loginUser, registerUser, resetPassword, onAuthChange } from './auth.js';

const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const loginTab = document.getElementById('loginTab');
const registerTab = document.getElementById('registerTab');
const loginFormSection = document.getElementById('loginForm');
const registerFormSection = document.getElementById('registerForm');
const toastContainer = document.getElementById('toastContainer');
const infoModal = document.getElementById('infoModal');
const closeModalBtn = document.getElementById('closeModalBtn');

// While a registration is in progress the auth state also flips to
// signed-in — but redirecting right then would abort registerUser()'s
// Firestore write. The submit handler redirects explicitly once
// registration has fully finished.
let registering = false;
onAuthChange(user => {
  if (user && !registering) {
    window.location.href = 'dashboard.html';
  }
});

// First-visit Quick Note — shown unless the extension's Google-login check pre-empts it.
function showQuickNote() {
  if (!localStorage.getItem('flowAccess_visited')) {
    infoModal.classList.add('show');
    localStorage.setItem('flowAccess_visited', 'true');
  }
}

closeModalBtn.addEventListener('click', () => {
  infoModal.classList.remove('show');
});

// === Google-login detection via the Tool extension ===
// If the extension finds the user's own Google login cookies in THIS browser
// profile, show a strong "use a new Chrome profile" popup on every visit.
// Clean state (extension present, no Google login) → no popup at all.
// No extension / check failed → fall back to the first-visit Quick Note.
(function googleLoginCheck() {
  try {
    if (document.documentElement.dataset.flowAccessExtension !== 'true') { showQuickNote(); return; }
    const id = 'fa-login-check-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    const decide = (res) => {
      try {
        if (!res || res.success !== true) { showQuickNote(); return; }
        if (res.loggedIn && !res.sessionActive) {
          const modal = document.getElementById('profileModal');
          if (!modal) { showQuickNote(); return; }
          infoModal.classList.remove('show');
          // Android has no Chrome profiles — point to Firefox instead.
          if (/Android/i.test(navigator.userAgent)) {
            const pt = document.getElementById('profileModalText');
            if (pt) pt.textContent = "You're signed in to Google in this browser. FlowAccess sessions can't run reliably here — please install Firefox, open this website there without signing in to Google, and continue there.";
          }
          modal.classList.add('show');
          document.getElementById('profileModalBtn').addEventListener('click', () => modal.classList.remove('show'));
          return;
        }
        // clean profile or session already running: stay quiet
      } catch (e) { /* never break the page */ }
    };
    const timer = setTimeout(() => decide(null), 2500);
    const onMsg = (event) => {
      if (event.source !== window) return;
      const d = event.data;
      if (!d || d.source !== 'FLOW_ACCESS_EXTENSION_REPLY' || d.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
      decide(d.response || null);
    };
    window.addEventListener('message', onMsg);
    window.postMessage({ source: 'FLOW_ACCESS_WEB', id, action: 'CHECK_GOOGLE_LOGIN', payload: {} }, '*');
  } catch (e) { showQuickNote(); }
})();

// === Mobile browser extension-support check ===
// On EVERY visit from a mobile browser that cannot run extensions, show a
// note with a button to install Firefox (extension-capable).
// Browsers with real extension support are left alone.
// Research (2026): Firefox Android = full add-ons; Edge Android (EdgA) =
// curated extensions; Kiwi / Yandex = Chrome extensions incl. unpacked.
// No support: Chrome Android, Safari/iOS (Apple restriction), Samsung
// Internet (content-blockers only), Opera, Vivaldi, in-app webviews.
(function mobileExtCheck() {
  try {
    const ua = navigator.userAgent || '';
    if (!/Android|iPhone|iPad|iPod/i.test(ua)) return;           // desktop: skip
    const isIOS = /iPhone|iPad|iPod/i.test(ua);
    const extCapable = /FxiOS|Firefox|EdgA|EdgiOS|Kiwi|YaBrowser/i.test(ua);
    if (extCapable && !isIOS) return;                            // supported: no popup

    const modal = document.getElementById('mobileExtModal');
    const text = document.getElementById('mobileExtText');
    const installBtn = document.getElementById('installFirefoxBtn');
    if (isIOS) {
      text.textContent = "Apple doesn't allow browser extensions on iPhone/iPad, so FlowAccess sessions can't run here. Please open this site on an Android device or a computer instead.";
      installBtn.style.display = 'none';
    } else {
      text.textContent = "This browser doesn't support extensions — and a Google sign-in in this browser breaks FlowAccess sessions. Install Firefox (free), open this site there WITHOUT signing in to Google, and install the extension.";
      installBtn.style.display = '';
    }
    infoModal.classList.remove('show');   // don't stack with the Quick Note
    modal.classList.add('show');
    const dismiss = () => modal.classList.remove('show');
    document.getElementById('mobileExtDismiss').addEventListener('click', dismiss);
    installBtn.addEventListener('click', dismiss);
  } catch (e) { /* never break the page over this check */ }
})();

loginTab.addEventListener('click', () => {
  loginTab.classList.add('active');
  registerTab.classList.remove('active');
  loginFormSection.classList.add('active');
  registerFormSection.classList.remove('active');
});

registerTab.addEventListener('click', () => {
  registerTab.classList.add('active');
  loginTab.classList.remove('active');
  registerFormSection.classList.add('active');
  loginFormSection.classList.remove('active');
});

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

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = e.target.email.value;
  const password = e.target.password.value;
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  btn.innerText = 'Logging in...';
  
  try {
    await loginUser(email, password);
    showToast('Login successful!', 'success');
  } catch (error) {
    showToast(error.message, 'error');
    btn.disabled = false;
    btn.innerText = 'Login';
  }
});

const forgotPasswordLink = document.getElementById('forgotPasswordLink');
forgotPasswordLink.addEventListener('click', async (e) => {
  e.preventDefault();
  const email = loginForm.email.value.trim();
  if (!email) {
    showToast('Please enter your email address first.', 'error');
    return;
  }
  forgotPasswordLink.style.pointerEvents = 'none';
  try {
    await resetPassword(email);
    showToast('Password reset email sent — check your inbox.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    forgotPasswordLink.style.pointerEvents = '';
  }
});

registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = e.target.name.value;
  const email = e.target.email.value;
  const password = e.target.password.value;
  const confirmPassword = e.target.confirmPassword.value;
  
  if (password !== confirmPassword) {
    showToast('Passwords do not match', 'error');
    return;
  }
  
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  btn.innerText = 'Registering...';
  
  registering = true;
  try {
    await registerUser(name, email, password);
    showToast('Account created! Verification email sent — check your inbox.', 'success');
    // registerUser() fully finished (Firestore profile saved) — safe to go.
    window.location.href = 'dashboard.html';
  } catch (error) {
    showToast(error.message, 'error');
    btn.disabled = false;
    btn.innerText = 'Create Account';
  } finally {
    registering = false;
  }
});
