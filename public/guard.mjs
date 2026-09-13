// guard.mjs — Auth guard for protected pages

import { waitForAuth, getUserProfile, logout, db, getPhoneProfile, getPhoneProfileByEmail, ensureUserProfile } from "./auth.mjs";
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
    // Fallback: recover from allowedPhones — by phone for an SMS login, and by
    // email for an email+password login, which carries no phone number at all
    // (without this, an SMS-free sign-in bounces straight back to login).
    try {
      const phoneProf = user.phoneNumber
        ? await getPhoneProfile(user.phoneNumber)
        : await getPhoneProfileByEmail(user.email || "");
      if (phoneProf) {
        try {
          profile = await ensureUserProfile(user.uid, phoneProf);
        } catch (e3) {
          // The profile write can be refused by the DB rules; the sign-in is
          // still legitimate, so run the session on the allowedPhones record.
          console.warn("guard: profile sync refused, using allowedPhones record", e3);
          profile = phoneProf;
        }
      }
    } catch (e2) {
      console.error("guard: fallback profile lookup failed", e2);
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
