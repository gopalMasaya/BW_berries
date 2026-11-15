/**
 * Station health monitor.
 *
 * Every few hours (healthCheck in index.js) each registered station's last
 * 24 h of readings is scanned and a verdict stored at health/{stationId}:
 * online?, coverage vs. the 5-minute rhythm, gaps, WiFi/API failures,
 * reboots, sensors that stopped reporting, frozen sensors and the offline
 * queue (station3 firmware). Each problem becomes an `issues` entry with a
 * Hebrew text and a suggested fix, so the dashboard -- or Claude, through
 * tools/health-report.js -- can report it.
 *
 * Fields seen per station are remembered in health/{id}/fieldsSeen (last time
 * each numeric field appeared), so "stopped reporting" needs only the last
 * 24 h of data, not a week.
 */

const EXPECTED_INTERVAL_MIN = 5;
const GAP_MIN = 20;                    // a longer silence counts as a gap
const OFFLINE_WARN_MIN = 20;
const OFFLINE_CRIT_MIN = 120;
const MISSING_AFTER_H = 6;             // field silent this long = stopped
const FIELD_MEMORY_DAYS = 7;           // ...if it was seen within this window
const STUCK_WINDOW_H = 3;
const STUCK_FIELDS = ["ec", "ec2", "ph1", "ph2", "vpd", "air_temp", "air_rh"];
// Fields that are counters/status, not sensors: never "stopped reporting".
const NOT_SENSORS = new Set([
  "uptime", "wifiFails", "apiFails", "modemFails", "resetReason", "csq",
  "rssi", "wifi_rssi", "queued", "queueDropped", "ageSec", "voltage",
  "waterIn", "waterOut", "spoon1_l", "spoon2_l", "spoon1_tips", "spoon2_tips",
  "tension1_v", "weight_kg",
]);

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function ilParts(t) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(t).reduce((a, x) => (a[x.type] = x.value, a), {});
}
const fmtIL = (t) => {
  const p = ilParts(new Date(t));
  return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
};

/** Readings of the last `ms`, oldest first: [{t, item}]. */
async function fetchRecent(db, stationId, now, ms) {
  const from = new Date(now - ms - DAY);  // slack: device keys are IL time
  const months = [];
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (cur <= now) {
    months.push({
      mk: String(cur.getUTCMonth() + 1).padStart(2, "0") + cur.getUTCFullYear(),
      first: cur.getUTCFullYear() === from.getUTCFullYear() &&
        cur.getUTCMonth() === from.getUTCMonth(),
    });
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  const out = [];
  await Promise.all(months.map(async ({mk, first}) => {
    let q = db.ref(`berries/${stationId}/${mk}`).orderByKey();
    if (first) q = q.startAt(String(from.getUTCDate()).padStart(2, "0"));
    const val = (await q.get()).val() || {};
    for (const item of Object.values(val)) {
      if (!item || typeof item !== "object" || !item.serverTimestamp) continue;
      const t = Date.parse(item.serverTimestamp);
      if (Number.isFinite(t) && t >= now - ms && t <= now) out.push({t, item});
    }
  }));
  return out.sort((a, b) => a.t - b.t);
}

/** Time of the newest reading in the last 3 month nodes (null = none). */
async function lastReadingTime(db, stationId) {
  const d = new Date();
  for (let i = 0; i < 3; i++) {
    const mk = String(d.getUTCMonth() + 1).padStart(2, "0") + d.getUTCFullYear();
    const val = (await db.ref(`berries/${stationId}/${mk}`)
        .orderByKey().limitToLast(5).get()).val() || {};
    const ts = Object.values(val).map((x) => Date.parse(x && x.serverTimestamp))
        .filter(Number.isFinite);
    if (ts.length) return Math.max(...ts);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return null;
}

/** Sum of a counter's increases (a drop = reboot, counts from the new value). */
function counterDelta(rows, field) {
  let prev = null;
  let sum = 0;
  let seen = false;
  for (const {item} of rows) {
    const v = Number(item[field]);
    if (!Number.isFinite(v)) continue;
    seen = true;
    if (prev !== null) sum += v >= prev ? v - prev : v;
    prev = v;
  }
  return seen ? sum : null;
}

/**
 * One station's verdict.
 * @param {object} prev the stored health/{id} from the previous run
 */
function assess(stationId, rows, prev, now) {
  const issues = [];
  const add = (level, code, text, fix) => issues.push({level, code, text, fix});

  const fieldsSeen = {...((prev && prev.fieldsSeen) || {})};
  for (const [f, t] of Object.entries(fieldsSeen)) {
    if (now - t > FIELD_MEMORY_DAYS * DAY) delete fieldsSeen[f];
  }
  for (const {t, item} of rows) {
    for (const [f, v] of Object.entries(item)) {
      if (typeof v === "number" && Number.isFinite(v) &&
          !(fieldsSeen[f] >= t)) fieldsSeen[f] = t;
    }
  }

  const last = rows.length ? rows[rows.length - 1] : null;
  const lastSeen = last ? last.t : (prev && prev.lastSeen) || null;
  const silentMin = lastSeen ? Math.round((now - lastSeen) / 60000) : null;

  // ---- online ----
  if (silentMin == null) {
    add("crit", "offline", "התחנה לא שידרה בכלל ב-3 החודשים האחרונים",
        "לבדוק חשמל/סוללה ותקשורת באתר (נורות, חיבור לרשת).");
  } else if (silentMin >= OFFLINE_CRIT_MIN) {
    add("crit", "offline",
        `התחנה לא משדרת כבר ${silentMin >= 1440 ? Math.round(silentMin / 1440) + " ימים" : Math.round(silentMin / 60) + " שעות"} (אחרון: ${fmtIL(lastSeen)})`,
        "לבדוק חשמל/סוללה ותקשורת באתר; אם הלוח דולק — לחבר USB ולקרוא את ה-Serial.");
  } else if (silentMin >= OFFLINE_WARN_MIN) {
    add("warn", "late", `אין קריאה כבר ${silentMin} דקות`, "לעקוב — ייתכן ניתוק תקשורת קצר.");
  }

  // ---- coverage and gaps (24 h) ----
  const expected = Math.round(24 * 60 / EXPECTED_INTERVAL_MIN);
  const live = rows.filter((r) => !r.item.calMode);
  const coverage = rows.length / expected;
  const gaps = [];
  for (let i = 1; i < rows.length; i++) {
    const g = (rows[i].t - rows[i - 1].t) / 60000;
    if (g > GAP_MIN) gaps.push({from: rows[i - 1].t, min: Math.round(g)});
  }
  const longest = gaps.reduce((a, g) => (!a || g.min > a.min ? g : a), null);
  const lateRows = rows.filter((r) => r.item.ageSec).length;

  const wifiFails24h = counterDelta(rows, "wifiFails");
  const apiFailsMax = rows.reduce((a, r) =>
    Math.max(a, Number(r.item.apiFails) || 0), 0);
  let reboots = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = Number(rows[i - 1].item.uptime);
    const b = Number(rows[i].item.uptime);
    if (Number.isFinite(a) && Number.isFinite(b) && b < a) reboots++;
  }

  if (rows.length && silentMin < OFFLINE_CRIT_MIN) {
    if (coverage < 0.9) {
      const commFail = (wifiFails24h || 0) > 50 || apiFailsMax > 0;
      add(coverage < 0.5 ? "crit" : "warn", "coverage",
          `רק ${Math.round(coverage * 100)}% מהקריאות הצפויות הגיעו ב-24 ש׳ ` +
          `(${rows.length}/${expected}); ${gaps.length} פערים מעל ${GAP_MIN} דק׳` +
          (longest ? `, הארוך ${longest.min} דק׳ מ-${fmtIL(longest.from)}` : ""),
          commFail ?
            "ניתוקי תקשורת: לבדוק את הנתב/נקודת הגישה (יציבות, חשמל בלילה); " +
            "קושחה עם תור לא-מקוון ממלאת פערים קצרים." :
            "התחנה לא דיווחה על כשלי תקשורת — לבדוק אתחולים/חשמל.");
    }
  }
  if ((wifiFails24h || 0) > 50) {
    add("warn", "wifi", `${wifiFails24h} ניסיונות חיבור WiFi כושלים ב-24 ש׳`,
        "לבדוק את הנתב: מרחק/הפרעות, כיבוי לילי, עומס. אם העוצמה טובה — הבעיה בנתב או באינטרנט שלו.");
  }
  if (reboots > 0) {
    add(reboots > 2 ? "warn" : "info", "reboot", `${reboots} אתחולים של הבקר ב-24 ש׳`,
        "לבדוק יציבות ספק כוח / watchdog; אם חוזר — לקרוא Serial אחרי אתחול.");
  }

  // ---- sensors that stopped reporting ----
  const missing = Object.entries(fieldsSeen)
      .filter(([f, t]) => !NOT_SENSORS.has(f) && !/Raw$|_dSm$|Date$/.test(f) &&
        now - t > MISSING_AFTER_H * HOUR && (!lastSeen || lastSeen - t > MISSING_AFTER_H * HOUR))
      .map(([f, t]) => ({field: f, since: t}));
  if (missing.length && rows.length) {
    add("warn", "missing",
        "חיישנים שהפסיקו לשדר (התחנה עצמה משדרת): " +
        missing.map((m) => `${m.field} (מאז ${fmtIL(m.since)})`).join(", "),
        "לבדוק חיבור/חשמל של החיישן (RS485: A/B, הזנה, כתובת). הקושחה שולחת שדה רק כשהקריאה תקינה.");
  }

  // ---- frozen sensors ----
  const stuck = [];
  const recent = live.filter((r) => now - r.t <= STUCK_WINDOW_H * HOUR);
  for (const f of STUCK_FIELDS) {
    const vals = recent.map((r) => Number(r.item[f + "Raw"] ?? r.item[f]))
        .filter(Number.isFinite);
    if (vals.length >= 20 && Math.max(...vals) === Math.min(...vals)) {
      stuck.push({field: f, value: vals[0]});
    }
  }
  if (stuck.length) {
    add("warn", "stuck",
        `ערך קפוא ${STUCK_WINDOW_H} שעות: ` +
        stuck.map((s) => `${s.field}=${s.value}`).join(", "),
        "חיישן שלא זז בכלל כנראה מנותק או תקוע — לבדוק/לנקות את הגשש.");
  }

  // ---- offline queue (firmware with ageSec) ----
  const queued = last ? Number(last.item.queued) : NaN;
  const queueDropped24h = counterDelta(rows, "queueDropped");
  if ((queueDropped24h || 0) > 0) {
    add("warn", "queue-drop", `${queueDropped24h} קריאות נזרקו מהתור הלא-מקוון (התור התמלא)`,
        "הניתוק ארוך מ-3 שעות — לטפל ביציבות הרשת או להגדיל את התור.");
  }

  const level = issues.some((i) => i.level === "crit") ? "crit" :
    issues.some((i) => i.level === "warn") ? "warn" : "ok";
  return {
    stationId, checkedAt: now, status: level,
    lastSeen, silentMin,
    readings24h: rows.length, expected24h: expected,
    coverage: Math.round(coverage * 1000) / 10,
    gaps24h: gaps.length, longestGapMin: longest ? longest.min : 0,
    longestGapFrom: longest ? longest.from : null,
    gapList: [...gaps].sort((a, b) => b.min - a.min).slice(0, 10),
    lateReadings24h: lateRows,
    wifiFails24h, apiFailsMax, reboots24h: reboots,
    queued: Number.isFinite(queued) ? queued : null,
    queueDropped24h,
    missing, stuck, issues, fieldsSeen,
  };
}

/** Check every station; write health/* unless write === false. */
async function runHealthCheck(db, {write = true} = {}) {
  const now = Date.now();
  const registry = (await db.ref("stations").get()).val() || {};
  const prevAll = (await db.ref("health/stations").get()).val() || {};
  const ids = Object.keys(registry).sort();
  const out = {};
  for (const id of ids) {
    try {
      const rows = await fetchRecent(db, id, now, DAY);
      let prev = prevAll[id];
      // First run for this station: learn its fields from a week back once,
      // so a sensor that died before the monitor existed is still caught.
      if (!prev || !prev.fieldsSeen) {
        const week = await fetchRecent(db, id, now, FIELD_MEMORY_DAYS * DAY);
        const fieldsSeen = {};
        for (const {t, item} of week) {
          for (const [f, v] of Object.entries(item)) {
            if (typeof v === "number" && Number.isFinite(v)) fieldsSeen[f] = t;
          }
        }
        const lastSeen = week.length ? week[week.length - 1].t :
          await lastReadingTime(db, id);
        prev = {...(prev || {}), fieldsSeen, lastSeen};
      }
      out[id] = assess(id, rows, prev, now);
    } catch (e) {
      out[id] = {stationId: id, checkedAt: now, status: "error", error: String(e.message || e)};
    }
  }
  // Stations silent at the same moment share a cause: the site's network or
  // power, not one station's hardware.
  const list = Object.values(out).filter((h) => h.gapList);
  for (const h of list) {
    const shared = [];
    for (const g of h.gapList.filter((x) => x.min >= 30)) {
      const others = list.filter((o) => o !== h && o.gapList.some((x) =>
        x.min >= 30 && Math.abs(x.from - g.from) <= 10 * 60000)).map((o) => o.stationId);
      if (others.length) shared.push(`${fmtIL(g.from)} (${g.min} דק׳, גם ${others.join(", ")})`);
    }
    if (shared.length) {
      h.issues.push({level: "info", code: "shared-outage",
        text: "נפילה בו-זמנית עם תחנות אחרות: " + shared.join("; "),
        fix: "סיבה משותפת — רשת/אינטרנט/חשמל באתר, לא התחנה עצמה. לבדוק את הנתב ואת מקור החשמל שלו."});
    }
  }

  if (write) {
    const p = ilParts(new Date(now));
    const histKey = `${p.year}-${p.month}-${p.day}_${p.hour}`;
    const updates = {"health/lastRun": now};
    for (const [id, h] of Object.entries(out)) {
      updates[`health/stations/${id}`] = h;
      updates[`health/history/${id}/${histKey}`] = {
        status: h.status, coverage: h.coverage ?? null,
        wifiFails24h: h.wifiFails24h ?? null, gaps24h: h.gaps24h ?? null,
        issues: (h.issues || []).map((i) => i.code).join(",") || null,
      };
    }
    await db.ref().update(updates);
  }
  return out;
}

module.exports = {runHealthCheck, assess};
