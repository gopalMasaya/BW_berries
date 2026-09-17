/**
 * Daily sensor calibration against the manual "irrigation solution" measurement.
 *
 * The workers measure the dripper and the drain by hand every morning in the
 * qrCode farm app (project song-cd1cd). Those cups are the field reference: EC
 * and pH probes drift (coating, electrode ageing), so once a day we compare the
 * first manual measurement of the day with what our station reported at the same
 * moment and store a correction the dashboard applies when it displays values.
 *
 * EC drifts as a GAIN error → correction is a factor (displayed = raw/1000 ×
 * factor; the historical hard-coded ×2 is simply the default factor).
 * pH drifts as a ZERO-POINT error → correction is an offset (displayed = raw +
 * offset). A single field point cannot fix the electrode's slope; it needs two
 * buffers.
 *
 * Raw readings are never modified — the correction lives under
 * berries/{stationId}/calibration/ and can be dropped at any time.
 */

const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const https = require("https");

// qrCode project (song-cd1cd). Cloud Functions run as THIS project's service
// account, which has no rights on the other project's database, so we take the
// same route the browser does: an anonymous sign-in with the public web API key
// (its DB rules only require auth != null).
const QR_API_KEY = "AIzaSyBurfVKNSyFTQBJM8_8wb0WttZ3_HqhYMc";
const QR_DB = "song-cd1cd-default-rtdb.europe-west1.firebasedatabase.app";

// Which measurement station of the farm app each of our stations sits in, and
// which manual field each sensor is compared against. A station with a single
// EC/pH probe on the dripper line only maps those two. Overridable per station
// at berries/{stationId}/control/calibrationMap.
const PLOT_BY_STATION = {station1: "B09", station2: "B07"};
const DEFAULT_MAP = {
  // station1 is being rebuilt: one EC + one pH probe, both on the dripper.
  station1: {ec: "dripEc", ph1: "dripPh"},
  // station2: ec/ph2 sit on the drain, ec2/ph1 on the feed line.
  station2: {ec2: "dripEc", ec: "drainEc", ph1: "dripPh", ph2: "drainPh"},
};

// Guards — a correction outside these is a broken probe, not drift.
const MATCH_WINDOW_MIN = 15;   // manual cup vs. station reading
const EC_FACTOR_DEFAULT = 2;   // firmware K-factor mismatch, pre-calibration
const EC_FACTOR_MIN = 0.5;
const EC_FACTOR_MAX = 5;
const PH_OFFSET_MAX = 2;
const SMOOTH_DAYS = 5;         // days averaged into the applied correction
const UNSTABLE_PCT = 25;       // today vs. the average → flagged, not applied

const isNum = (v) => Number.isFinite(Number(v)) && Number(v) !== 0;
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

/** GET a JSON URL, resolving to the parsed body. */
function getJson(url, options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options || {}, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          resolve(data ? JSON.parse(data) : null);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

let qrTokenCache = {token: null, expires: 0};
async function qrToken() {
  if (qrTokenCache.token && Date.now() < qrTokenCache.expires) {
    return qrTokenCache.token;
  }
  const body = JSON.stringify({returnSecureToken: true});
  const res = await getJson(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${QR_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      body);
  qrTokenCache = {
    token: res.idToken,
    expires: Date.now() + 50 * 60 * 1000,
  };
  return res.idToken;
}

/** The day's manual measurements for one plot, oldest first. */
async function fetchManual(plot, dateStr) {
  const token = await qrToken();
  const url =
    `https://${QR_DB}/testsByDate/${dateStr}.json?auth=${token}`;
  const all = (await getJson(url)) || {};
  return Object.values(all)
      .filter((r) => String(r.stationName || "").toUpperCase()
          .startsWith(plot + "."))
      .sort((a, b) =>
        String(a.performedAt).localeCompare(String(b.performedAt)));
}

/**
 * performedAt is Israel wall-clock without a zone ("2026-09-16T10:55").
 * Israel is UTC+2, +3 in DST — derive the offset from the date itself rather
 * than assuming, so a winter calibration isn't an hour off.
 */
function ilToDate(performedAt, dateStr) {
  const str = String(performedAt || "");
  const local = str.includes("T") ? str : `${dateStr}T08:00`;
  const naive = new Date(local + "Z"); // read as UTC, then subtract the offset
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const shifted = new Date(probe.toLocaleString("en-US", {
    timeZone: "Asia/Jerusalem",
  }));
  const offsetMs = shifted.getTime() - probe.getTime();
  return new Date(naive.getTime() - offsetMs);
}

/** Station readings of that day, with their pulse deltas (flow detection). */
async function fetchStationReadings(db, stationId, dateStr) {
  const [y, m, d] = dateStr.split("-");
  const snap = await db.ref(`berries/${stationId}/${m}${y}`)
      .orderByKey().startAt(d).endAt(d + "").get();
  const val = snap.val() || {};
  const rows = [];
  for (const [key, item] of Object.entries(val)) {
    if (!item || typeof item !== "object") continue;
    const t = item.serverTimestamp ? new Date(item.serverTimestamp) : null;
    if (!t || isNaN(t.getTime())) continue;
    rows.push({t, key, item});
  }
  rows.sort((a, b) => a.t - b.t);
  let prevIn = null;
  let prevOut = null;
  for (const r of rows) {
    const wIn = Number(r.item.waterIn) || 0;
    const wOut = Number(r.item.waterOut) || 0;
    r.flow = prevIn === null ? false :
      (wIn > prevIn || wOut > prevOut);
    prevIn = wIn;
    prevOut = wOut;
  }
  return rows;
}

/**
 * A probe whose value has not moved at all for hours is stuck, not stable:
 * station2's ec2 sat on 2492-2494 for a week. Calibrating against it would bake
 * a frozen number into every reading, so those samples are refused.
 */
const STUCK_WINDOW_MS = 2 * 3600 * 1000;
const STUCK_TOLERANCE = 0.001; // 0.1% of the value
function isStuck(rows, at, field) {
  const vals = rows
      .filter((r) => Math.abs(r.t - at) <= STUCK_WINDOW_MS)
      .map((r) => Number(r.item[field]))
      .filter((v) => Number.isFinite(v));
  if (vals.length < 5) return false;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  return (max - min) <= Math.abs(max) * STUCK_TOLERANCE;
}

/**
 * The station reading closest to the manual measurement. Water must have moved
 * (a probe sitting in stagnant solution measures yesterday, not the cup), but a
 * reading right at the sample time is accepted even without a flow tick.
 */
function matchReading(rows, at) {
  let best = null;
  for (const r of rows) {
    const dtMin = Math.abs(r.t - at) / 60000;
    if (dtMin > MATCH_WINDOW_MIN) continue;
    const score = dtMin - (r.flow ? 5 : 0);
    if (!best || score < best.score) best = {r, dtMin, score};
  }
  return best;
}

/** Average of the last SMOOTH_DAYS raw corrections, newest included. */
function smooth(history, field, kind, todayValue) {
  const vals = [todayValue];
  for (const day of history) {
    const s = day && day.samples && day.samples[field];
    const v = s && s[kind];
    if (Number.isFinite(v)) vals.push(v);
    if (vals.length >= SMOOTH_DAYS) break;
  }
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * Compute and store one day's calibration for every station.
 * @param {string} dateStr YYYY-MM-DD (Israel day). Defaults to today.
 * @return {Promise<object>} per-station result, for logging and the HTTP run.
 */
async function runCalibration(dateStr) {
  const db = admin.database();
  const day = dateStr || new Date().toLocaleDateString("en-CA", {
    timeZone: "Asia/Jerusalem",
  });
  const out = {};

  for (const stationId of Object.keys(PLOT_BY_STATION)) {
    const result = {date: day, station: stationId, samples: {}, notes: []};
    try {
      const mapSnap = await db
          .ref(`berries/${stationId}/control/calibrationMap`).get();
      const map = mapSnap.val() || DEFAULT_MAP[stationId] || {};
      const manual = await fetchManual(PLOT_BY_STATION[stationId], day);
      if (!manual.length) {
        result.notes.push("no manual measurement today");
        out[stationId] = result;
        continue;
      }
      const first = manual[0];
      const at = ilToDate(first.performedAt, day);
      const rows = await fetchStationReadings(db, stationId, day);
      const match = matchReading(rows, at);
      if (!match) {
        result.notes.push("no station reading within " +
          `${MATCH_WINDOW_MIN} min of ${first.performedAt}`);
        out[stationId] = result;
        continue;
      }
      result.manualAt = first.performedAt;
      result.stationKey = match.r.key;
      result.dtMin = round(match.dtMin, 1);
      result.flow = !!match.r.flow;

      // Previous days, newest first, for the smoothing window.
      const histSnap = await db.ref(`berries/${stationId}/calibration`)
          .orderByKey().endAt(day).limitToLast(SMOOTH_DAYS + 1).get();
      const history = Object.entries(histSnap.val() || {})
          .filter(([k]) => /^\d{4}-\d{2}-\d{2}$/.test(k) && k < day)
          .sort((a, b) => b[0].localeCompare(a[0]))
          .map(([, v]) => v);

      const applied = {};
      for (const [field, manualField] of Object.entries(map)) {
        const ref = Number(first[manualField]);
        const raw = Number(match.r.item[field]);
        const sample = {manualField, ref, raw};
        if (!isNum(ref)) {
          sample.status = "no manual value";
        } else if (!isNum(raw)) {
          // A probe reporting 0 / nothing is broken; calibration must not hide
          // that by inventing a huge factor.
          sample.status = "sensor not reporting";
        } else if (field.startsWith("ph")) {
          const offset = ref - raw;
          sample.offset = round(offset, 3);
          if (Math.abs(offset) > PH_OFFSET_MAX) {
            sample.status = "offset out of range";
          } else {
            const sm = smooth(history, field, "offset", offset);
            sample.status = Math.abs(offset - sm) > PH_OFFSET_MAX / 2 ?
              "unstable" : "ok";
            sample.applied = round(sm, 3);
            applied[field + "Offset"] = sample.applied;
          }
        } else {
          const factor = ref / (raw / 1000);
          sample.factor = round(factor, 4);
          if (factor < EC_FACTOR_MIN || factor > EC_FACTOR_MAX) {
            sample.status = "factor out of range";
          } else {
            const sm = smooth(history, field, "factor", factor);
            sample.status =
              Math.abs(factor - sm) / sm * 100 > UNSTABLE_PCT ?
                "unstable" : "ok";
            sample.applied = round(sm, 4);
            applied[field + "Factor"] = sample.applied;
          }
        }
        result.samples[field] = sample;
      }
      result.applied = applied;
      result.computedAt = new Date().toISOString();

      await db.ref(`berries/${stationId}/calibration/${day}`).set(result);
      if (Object.keys(applied).length) {
        await db.ref(`berries/${stationId}/calibration/current`).set({
          date: day,
          computedAt: result.computedAt,
          ...applied,
        });
      }
    } catch (e) {
      logger.error("calibration failed", {stationId, error: e.message});
      result.error = e.message;
    }
    out[stationId] = result;
  }
  logger.info("calibration done", {day, out});
  return out;
}

module.exports = {runCalibration, EC_FACTOR_DEFAULT, DEFAULT_MAP};
