// auth.mjs — Firebase Phone Authentication + RTDB CRUD — ES Module

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import {
  getAuth,
  signOut,
  onAuthStateChanged,
  RecaptchaVerifier,
  signInWithPhoneNumber
  
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

  // Clear any existing reCAPTCHA
  if (window._recaptchaVerifier) {
    try { window._recaptchaVerifier.clear(); } catch (_) {}
  }

  window._recaptchaVerifier = new RecaptchaVerifier(auth, recaptchaContainerId, {
    size: "invisible"
  });

  const confirmationResult = await signInWithPhoneNumber(auth, normalized, window._recaptchaVerifier);
  return confirmationResult;
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

// ── Allowed Phones CRUD (pre-registration) ──────────────────

/** Register a phone number with a role (manager only) */
export async function registerPhone(phone, profile) {
  const key = phoneKey(phone);
  await set(ref(db, `allowedPhones/${key}`), {
    name: profile.name || "",
    role: profile.role || "worker",
    phone: normalizePhone(phone),
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
    await update(ref(db, `users/${uid}`), {
      name: phoneProfile.name,
      role: phoneProfile.role,
      phone: phoneProfile.phone,
      serialNumber: phoneProfile.serialNumber || "",
      updatedAt: new Date().toISOString()
    });
    return { ...existing, name: phoneProfile.name, role: phoneProfile.role, phone: phoneProfile.phone, serialNumber: phoneProfile.serialNumber || "" };
  }

  const profile = {
    name: phoneProfile.name,
    role: phoneProfile.role,
    phone: phoneProfile.phone,
    serialNumber: phoneProfile.serialNumber || "",
    createdAt: new Date().toISOString()
  };
  await set(ref(db, `users/${uid}`), profile);
  return profile;
}

// ── Re-exports for consumers ────────────────────────────────

export { ref, push, set, onValue, off, update, get };
