import { auth, db } from './firebase-config.js';
import { 
  createUserWithEmailAndPassword, 
  signInWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged,
  sendEmailVerification
} from "https://www.gstatic.com/firebasejs/11.4.0/firebase-auth.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.4.0/firebase-firestore.js";

// Only real Gmail addresses may register.
export function isGmailAddress(email) {
  return typeof email === 'string' && /@(gmail|googlemail)\.com$/i.test(email.trim());
}

export async function registerUser(name, email, password) {
  try {
    if (!isGmailAddress(email)) {
      throw new Error('Please register with a Gmail address (@gmail.com).');
    }
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;
    
    // Free verification email sent by Firebase itself (link, not code).
    try { await sendEmailVerification(user); } catch (e) { console.warn('Verification email failed:', e); }

    await setDoc(doc(db, "users", user.uid), {
      email: user.email,
      displayName: name,
      createdAt: serverTimestamp(),
      isBanned: false,
      totalUsageMinutes: 0
    });
    
    return user;
  } catch (error) {
    // Our own validation errors have no Firebase code — keep their message.
    throw new Error(error.code ? getFriendlyErrorMessage(error.code) : (error.message || 'An error occurred.'));
  }
}

export async function loginUser(email, password) {
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    return userCredential.user;
  } catch (error) {
    throw new Error(getFriendlyErrorMessage(error.code));
  }
}

export async function logoutUser() {
  try {
    await signOut(auth);
  } catch (error) {
    throw new Error("Failed to sign out");
  }
}

export function getCurrentUser() {
  return auth.currentUser;
}

// Re-send the Firebase verification email to the signed-in user.
export async function resendVerificationEmail() {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in.');
  try {
    await sendEmailVerification(user);
  } catch (error) {
    throw new Error(getFriendlyErrorMessage(error.code));
  }
}

export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

function getFriendlyErrorMessage(code) {
  switch (code) {
    case 'auth/email-already-in-use':
      return 'This email is already registered.';
    case 'auth/invalid-email':
      return 'Please enter a valid email address.';
    case 'auth/weak-password':
      return 'Password should be at least 6 characters.';
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return 'Invalid email or password.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please wait a bit and try again.';
    default:
      return 'An error occurred. Please try again.';
  }
}
