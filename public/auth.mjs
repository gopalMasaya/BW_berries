// auth.mjs — Firebase Phone Authentication + RTDB CRUD — ES Module

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import {
  getAuth,
  signOut,
  onAuthStateChanged,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  signInWithEmailAndPassword,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";
import {
  getDatabase, ref, get, set, update, remove, onValue, off, push
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyDPARUw3kGIyg1piZwjsVZOktBJ79CgICM",
  authDomain: "plantstracker-f1274.firebaseapp.com",
  databaseURL: "https://plantstracker-f1274-default-rtdb.firebaseio.com/",
  projectId: "plantstracker-f1274",
  storageBucket: "plantstracker-f1274.firebasestorage.app",
  messagingSenderId: "979362379595",
  appId: "1:979362379595:web:6bdae62b701467f92c5ace",
  measurementId: "G-GW43ZW0CQ4"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
export const db = getDatabase(app);

// ── Auth state ──────────────────────────────────────────────

/** Returns a promise that resolves to the Firebase User or null */
export function waitForAuth() {
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, (user) => {
      unsub();
      resolve(user);
    });
  });
}

/** Returns the current user synchronously (may be null if auth not settled) */
export function currentUser() {
  return auth.currentUser;
}

/** Sign out */
export async function logout() {
  await signOut(auth);
}

// ── Phone Auth ──────────────────────────────────────────────

/**
 * Normalize an Israeli phone number to E.164 format.
 * "050-1234567" or "0501234567" → "+972501234567"
 * Already E.164 "+972..." → returned as-is
 */
export function normalizePhone(input) {
  let phone = input.replace(/[\s\-()]/g, "");
  if (phone.startsWith("+")) return phone;
  if (phone.startsWith("0")) phone = "+972" + phone.slice(1);
  else phone = "+" + phone;
  return phone;
}

/** Returns the key used in /allowedPhones/ — digits only, no + sign */
export function phoneKey(phone) {
  return normalizePhone(phone).replace(/\D/g, "");
}

/**
 * Set up invisible reCAPTCHA and send OTP.
 * @param {string} phoneNumber - raw phone input
 * @param {string|HTMLElement} recaptchaContainerId - DOM id for reCAPTCHA
 * @returns {ConfirmationResult} — call .confirm(code) to verify
 */
export async function sendOTP(phoneNumber, recaptchaContainerId) {
  const normalized = normalizePhone(phoneNumber);

  // Fully tear down any previous reCAPTCHA. Calling .clear() alone is not
  // enough: when Firebase can't load reCAPTCHA Enterprise it falls back to
  // reCAPTCHA v2 and renders a widget into the container DOM. grecaptcha then
  // refuses to render a second widget into an element it has already used,
  // throwing "reCAPTCHA has already been rendered in this element" on every
  // later send — so the second attempt fails no matter what. Give it a
  // brand-new child element each time.
  if (window._recaptchaVerifier) {
    try { window._recaptchaVerifier.clear(); } catch (_) {}
    window._recaptchaVerifier = null;
  }

  const wrapper = typeof recaptchaContainerId === "string"
    ? document.getElementById(recaptchaContainerId)
    : recaptchaContainerId;

  let target = recaptchaContainerId;
  if (wrapper) {
    wrapper.innerHTML = "";
    const fresh = document.createElement("div");
    wrapper.appendChild(fresh);
    target = fresh;
  }

  window._recaptchaVerifier = new RecaptchaVerifier(auth, target, {
    size: "invisible"
  });

  try {
    return await signInWithPhoneNumber(auth, normalized, window._recaptchaVerifier);
  } catch (error) {
    // Firebase recommends resetting reCAPTCHA after a failed phone-auth
    // request, so the next attempt starts from a clean verifier.
    try { window._recaptchaVerifier?.clear(); } catch (_) {}
    window._recaptchaVerifier = null;
    throw error;
  }
}

/**
 * Verify the OTP code.
 * @param {ConfirmationResult} confirmationResult - from sendOTP
 * @param {string} code - 6-digit code
 * @returns {UserCredential}
 */
export async function verifyOTP(confirmationResult, code) {
  return await confirmationResult.confirm(code);
}

// ── Email + Password Sign-In (SMS-free fallback) ─────────────
// For a user who can't receive an SMS at all (blocked number, reCAPTCHA that
// won't load on their phone). The manager creates the account in Firebase Auth
// and puts the same address on the user's allowedPhones entry, so the profile
// can be resolved by email — no phone, no SMS, no reCAPTCHA.

/**
 * Sign in with email + password.
 * @param {string} email
 * @param {string} password
 * @returns {UserCredential}
 */
export async function signInWithEmail(email, password) {
  return await signInWithEmailAndPassword(auth, String(email || "").trim(), password);
}

/**
 * Send a password-reset ("set your password") email. Firebase only sends it if
 * a password account already exists for that address — it can't create one.
 * @param {string} email
 */
export async function sendPasswordReset(email) {
  return await sendPasswordResetEmail(auth, String(email || "").trim());
}

/**
 * Resolve a pre-registered profile by its login email.
 * allowedPhones is keyed by phone, so we scan it; one entry per user makes a
 * full read cheap. Comparison is trimmed and case-insensitive.
 * @param {string} email
 * @returns {object|null} the allowedPhones entry, or null if none matches
 */
export async function getPhoneProfileByEmail(email) {
  const target = String(email || "").trim().toLowerCase();
  if (!target) return null;
  const snap = await get(ref(db, "allowedPhones"));
  const val = snap.val() || {};
  for (const data of Object.values(val)) {
    if (String(data?.email || "").trim().toLowerCase() === target) return data;
  }
  return null;
}

// ── Allowed Phones CRUD (pre-registration) ──────────────────

/** Register a phone number with a role (manager only) */
export async function registerPhone(phone, profile) {
  const key = phoneKey(phone);
  await set(ref(db, `allowedPhones/${key}`), {
    name: profile.name || "",
    role: profile.role || "worker",
    phone: normalizePhone(phone),
    // Optional login email — lets this user sign in with email + password when
    // SMS isn't an option, and be resolved by getPhoneProfileByEmail.
    email: (profile.email || "").trim().toLowerCase(),
    serialNumber: profile.serialNumber || "",
    createdAt: new Date().toISOString()
  });
  return key;
}

/** Get a pre-registered phone profile */
export async function getPhoneProfile(phone) {
  const key = phoneKey(phone);
  const snap = await get(ref(db, `allowedPhones/${key}`));
  return snap.val();
}

/** Get all pre-registered phones */
export async function getAllPhones() {
  const snap = await get(ref(db, "allowedPhones"));
  const val = snap.val() || {};
  return Object.entries(val).map(([key, data]) => ({ key, ...data }));
}

/** Update a pre-registered phone entry */
export async function updatePhone(key, fields) {
  await update(ref(db, `allowedPhones/${key}`), {
    ...fields,
    updatedAt: new Date().toISOString()
  });
}

/** Delete a pre-registered phone entry */
export async function deletePhone(key) {
  await remove(ref(db, `allowedPhones/${key}`));
}

// ── User profile CRUD (RTDB — populated on first sign-in) ───

export async function getUserProfile(uid) {
  const snap = await get(ref(db, `users/${uid}`));
  return snap.val();
}

export async function getAllUsers() {
  const snap = await get(ref(db, "users"));
  const val = snap.val() || {};
  return Object.entries(val).map(([uid, data]) => ({ uid, ...data }));
}

export async function updateUser(uid, fields) {
  await update(ref(db, `users/${uid}`), {
    ...fields,
    updatedAt: new Date().toISOString()
  });
}

export async function deleteUserProfile(uid) {
  await remove(ref(db, `users/${uid}`));
}

/**
 * Create or update a user profile from the allowedPhones entry.
 * Called after successful phone sign-in.
 */
export async function ensureUserProfile(uid, phoneProfile) {
  const existing = await getUserProfile(uid);
  if (existing) {
    const synced = {
      name: phoneProfile.name,
      role: phoneProfile.role,
      phone: phoneProfile.phone,
      email: phoneProfile.email || "",
      serialNumber: phoneProfile.serialNumber || ""
    };
    await update(ref(db, `users/${uid}`), { ...synced, updatedAt: new Date().toISOString() });
    return { ...existing, ...synced };
  }

  const profile = {
    name: phoneProfile.name,
    role: phoneProfile.role,
    phone: phoneProfile.phone,
    email: phoneProfile.email || "",
    serialNumber: phoneProfile.serialNumber || "",
    createdAt: new Date().toISOString()
  };
  await set(ref(db, `users/${uid}`), profile);
  return profile;
}

// ── Re-exports for consumers ────────────────────────────────

export { ref, push, set, onValue, off, update, get };
