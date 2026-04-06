// guard.mjs — Auth guard for protected pages

import { waitForAuth, getUserProfile, logout, db, getPhoneProfile, ensureUserProfile } from "./auth.mjs";
import { ref, get } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-database.js";

/**
 * Call at the top of every protected page's <script type="module">.
 * @param {string[]} allowedRoles - e.g. ["manager"]
 * @returns {{ user, profile: { name, role, phone, serialNumber } }}
 * Redirects to login.html if not authenticated or role not allowed.
 */
export async function requireAuth(allowedRoles = []) {
  const user = await waitForAuth();

  if (!user) {
    location.replace("login.html");
    return new Promise(() => {});
  }

  let profile;
  try {
    profile = await getUserProfile(user.uid);
  } catch (e) {
    console.error("guard: failed to read profile", e);
    await logout();
    location.replace("login.html");
    return new Promise(() => {});
  }

  if (!profile || !profile.role) {
    // Fallback: try to recover from allowedPhones using phone number
    if (user.phoneNumber) {
      try {
        const phoneProf = await getPhoneProfile(user.phoneNumber);
        if (phoneProf) {
          profile = await ensureUserProfile(user.uid, phoneProf);
        }
      } catch (e2) {
        console.error("guard: fallback phone lookup failed", e2);
      }
    }

    if (!profile || !profile.role) {
      await logout();
      location.replace("login.html");
      return new Promise(() => {});
    }
  }

  if (allowedRoles.length > 0 && !allowedRoles.includes(profile.role)) {
    const currentPage = location.pathname.split("/").pop();
    if (currentPage === "index.html" || currentPage === "") {
      alert("אין לך הרשאה לגשת לעמוד זה. תפקיד: " + profile.role);
      await logout();
      location.replace("login.html");
    } else {
      location.replace("index.html");
    }
    return new Promise(() => {});
  }

  return { user, profile };
}
