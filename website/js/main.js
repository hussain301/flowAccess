import { loginUser, registerUser, onAuthChange } from './auth.js';

const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const loginTab = document.getElementById('loginTab');
const registerTab = document.getElementById('registerTab');
const loginFormSection = document.getElementById('loginForm');
const registerFormSection = document.getElementById('registerForm');
const toastContainer = document.getElementById('toastContainer');
const infoModal = document.getElementById('infoModal');
const closeModalBtn = document.getElementById('closeModalBtn');

onAuthChange(user => {
  if (user) {
    window.location.href = 'dashboard.html';
  }
});

if (!localStorage.getItem('flowAccess_visited')) {
  infoModal.classList.add('show');
  localStorage.setItem('flowAccess_visited', 'true');
}

closeModalBtn.addEventListener('click', () => {
  infoModal.classList.remove('show');
});

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
  
  try {
    await registerUser(name, email, password);
    showToast('Registration successful!', 'success');
  } catch (error) {
    showToast(error.message, 'error');
    btn.disabled = false;
    btn.innerText = 'Create Account';
  }
});
