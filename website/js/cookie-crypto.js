// ============================================================
// FlowAccess — Cookie Set Encryption (AES-GCM-256 + PBKDF2)
// Cookie sets are encrypted BEFORE being written to Firestore,
// so they never sit in plaintext in the database / console.
//
// SINGLE SHARED LOCATION: both the admin panel and the user
// dashboard import this file, so the secret lives in ONE place.
// You may replace COOKIE_SECRET with your own random 64-hex
// string — just keep this file deployed with both admin/ and
// website/.
//
// What this protects against: Firebase console viewers, database
// backups/exports, and direct DB reads — ciphertext is useless
// without this secret.
// What it does NOT do: it cannot hide cookies from authorized
// users themselves — their browsers must receive usable cookies
// for Flow to work. That is inherent to the product.
// ============================================================

// --- Shared secret (admin: replace with your own if you like) ---
const COOKIE_SECRET = "676f157474c1665660865293d5f956fbbe385730b644d443aafea214ea1ac022";

const SALT = "flowaccess-cookie-salt-v1";
const ITERATIONS = 100000;

async function deriveKey() {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw", enc.encode(COOKIE_SECRET), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode(SALT), iterations: ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function b64encode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64decode(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

/**
 * Encrypt a cookies array -> { iv, data, alg } (all base64, JSON-safe).
 */
export async function encryptCookies(cookies) {
  const key = await deriveKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(cookies));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    alg: "AES-GCM-256-PBKDF2",
    iv: b64encode(iv),
    data: b64encode(new Uint8Array(ct))
  };
}

/**
 * Decrypt { iv, data } back to the cookies array.
 * Throws if the payload is corrupt or the secret changed.
 */
export async function decryptCookies(payload) {
  if (!payload || typeof payload.iv !== "string" || typeof payload.data !== "string") {
    throw new Error("Invalid encrypted payload");
  }
  const key = await deriveKey();
  const iv = b64decode(payload.iv);
  const ct = b64decode(payload.data);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  const arr = JSON.parse(new TextDecoder().decode(pt));
  if (!Array.isArray(arr)) throw new Error("Decrypted payload is not a cookie array");
  return arr;
}
