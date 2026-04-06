// sidebar.mjs — Shared sidebar navigation for sub-pages (workers, etc.)

import { logout } from "./auth.mjs";

const NAV_ITEMS = [
  { label: "מפת תחנות",    icon: "🗺️", href: "index.html",    roles: ["manager","worker","contractor"] },
  { label: "גלקון",         icon: "💧", href: "galcon.html",   roles: ["manager"] },
  { label: "ניהול משתמשים", icon: "👥", href: "workers.html",  roles: ["manager"] },
  { label: "הגדרות השקיה",  icon: "⚙️", href: "settings.html", roles: ["manager"] },
];

const ROLE_LABELS = { manager: "מנהל", worker: "עובד", contractor: "קבלן" };

export function initSidebar(profile) {
  const currentPage = location.pathname.split("/").pop() || "index.html";
  const role = profile.role;
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;

  let navHtml = "";
  for (const item of NAV_ITEMS) {
    if (!item.roles.includes(role)) continue;
    const isActive = item.href === currentPage;
    navHtml += `
      <a class="nav-item${isActive ? " active" : ""}" href="${item.href}">
        <span class="nav-icon">${item.icon}</span>
        <span class="nav-label">${item.label}</span>
      </a>`;
  }

  sidebar.innerHTML = `
    <div class="sidebar-header">
      <span class="sidebar-logo">🌱</span>
      <span class="sidebar-title">Plants Tracker</span>
    </div>
    <div class="sidebar-nav">${navHtml}</div>
    <div class="sidebar-user">
      <div class="user-info">
        <div class="user-avatar">${(profile.name || "?")[0]}</div>
        <div>
          <div class="user-name">${profile.name || "—"}</div>
          <div class="user-role">${ROLE_LABELS[role] || role}</div>
        </div>
      </div>
      <button class="logout-btn" id="sidebarLogout">יציאה</button>
    </div>
  `;

  document.getElementById("sidebarLogout").addEventListener("click", async () => {
    await logout();
    location.replace("login.html");
  });

  // Mobile toggle
  const hamburger = document.getElementById("hamburgerBtn");
  const overlay = document.getElementById("sidebarOverlay");

  if (hamburger) {
    hamburger.addEventListener("click", () => {
      sidebar.classList.toggle("open");
      if (overlay) overlay.classList.toggle("open");
    });
  }

  if (overlay) {
    overlay.addEventListener("click", () => {
      sidebar.classList.remove("open");
      overlay.classList.remove("open");
    });
  }

  sidebar.querySelectorAll(".nav-item").forEach(a => {
    a.addEventListener("click", () => {
      sidebar.classList.remove("open");
      if (overlay) overlay.classList.remove("open");
    });
  });
}
