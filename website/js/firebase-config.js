import { initializeApp } from "https://www.gstatic.com/firebasejs/11.4.0/firebase-app.js";
import { getAuth, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/11.4.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.4.0/firebase-firestore.js";

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

setPersistence(auth, browserLocalPersistence);

export { app, auth, db };
