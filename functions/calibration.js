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
// Symmetric: a probe can read too low (station2's drain) or too high (its feed
// probe reads almost exactly double, needing a factor of ~0.48).
// 0.2 rather than 0.25: station1's EC asks for ~0.23 three days running, and a
// repeatable figure is a gain error, not noise. A one-off wild value is caught
// by the `unstable` check instead.
const EC_FACTOR_MIN = 0.2;
const EC_FACTOR_MAX = 4;
const PH_OFFSET_MAX = 2;
const SMOOTH_DAYS = 5;         // days averaged into the applied correction
const UNSTABLE_PCT = 25;       // today vs. the average → flagged, not applied

const isNum = (v) => Number.isFinite(Number(v)) && Number(v) !== 0;
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

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
  for (const [key, stored] of Object.entries(val)) {
    if (!stored || typeof stored !== "object") continue;
    // The correction is always derived from what the probe itself said, never
    // from a value that already carries an earlier correction.
    const item = rawView(stored);
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
const FLAT_TOLERANCE = 0.002; // 0.2% of the value over the window
function spread(rows, at, field) {
  const vals = rows
      .filter((r) => Math.abs(r.t - at) <= STUCK_WINDOW_MS)
      .map((r) => Number(r.item[field]))
      .filter((v) => Number.isFinite(v));
  if (vals.length < 5) return null;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  return {min, max, range: max - min};
}
// Not moving AT ALL is a dead reading. A small movement is not: a feed line is
// held at a setpoint, so a probe that sits near-flat may simply be measuring a
// stable solution — that case is flagged (`flat`) and still calibrated.
function stuckState(rows, at, field) {
  const sp = spread(rows, at, field);
  if (!sp) return {stuck: false, flat: false};
  return {
    stuck: sp.range === 0,
    flat: sp.range <= Math.abs(sp.max) * FLAT_TOLERANCE,
    range: round(sp.range, 3),
  };
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
function smooth(history, field, kind, todayValue, since) {
  const vals = [todayValue];
  for (const day of history) {
    // A replaced probe's corrections say nothing about the new one.
    if (since && day && day.date < since) break;
    const s = day && day.samples && day.samples[field];
    // Only corrections that were accepted: a sample refused as out of range,
    // stuck or unstable must not be averaged back in -- that is how station2's
    // ph1 got an applied +2.0 on 08/09 from a day whose own offset was 1.87.
    if (!s || s.status !== "ok") continue;
    const v = s[kind];
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
      // A station off its plot (on the bench, being rebuilt) measures
      // something other than the solution the workers sample; calibrating it
      // against them would store a meaningless correction. The flag lives in
      // RTDB so it can be cleared the day the station goes back out.
      const paused = (await db
          .ref(`berries/${stationId}/control/calibrationPaused`).get()).val();
      if (paused) {
        result.notes.push("calibration paused: station not in the field");
        out[stationId] = result;
        continue;
      }
      const mapSnap = await db
          .ref(`berries/${stationId}/control/calibrationMap`).get();
      const map = mapSnap.val() || DEFAULT_MAP[stationId] || {};
      const probes = await stationProbes(db, stationId);
      const manual = await fetchManual(PLOT_BY_STATION[stationId], day);
      if (!manual.length) {
        result.notes.push("no manual measurement today");
        out[stationId] = result;
        continue;
      }
      const rows = await fetchStationReadings(db, stationId, day);
      if (!rows.length) {
        result.notes.push("station sent nothing today");
        out[stationId] = result;
        continue;
      }

      // Previous days, newest first, for the smoothing window.
      const histSnap = await db.ref(`berries/${stationId}/calibration`)
          .orderByKey().endAt(day).limitToLast(SMOOTH_DAYS + 1).get();
      const history = Object.entries(histSnap.val() || {})
          .filter(([k]) => /^\d{4}-\d{2}-\d{2}$/.test(k) && k < day)
          .sort((a, b) => b[0].localeCompare(a[0]))
          .map(([, v]) => v);

      const applied = {};
      for (const [field, manualField] of Object.entries(map)) {
        // The morning round often skips pH (saved as 0), so each sensor takes
        // the day's first measurement that carries its value — and if the probe
        // was down at that hour (station2's ec reads 0 from ~09:00 to 16:00),
        // the next measurement of the day is tried instead of giving up.
        const candidates = manual.filter((r) => isNum(r[manualField]));
        const sample = {manualField};
        if (!candidates.length) {
          result.samples[field] = {...sample, status: "no manual value"};
          continue;
        }
        let chosen = null;
        let fallback = null;
        for (const rec of candidates) {
          const at = ilToDate(rec.performedAt, day);
          const match = matchReading(rows, at);
          if (!match) continue;
          const cand = {rec, at, match, raw: Number(match.r.item[field])};
          if (!fallback) fallback = cand;
          if (isNum(cand.raw)) { chosen = cand; break; }
        }
        const use = chosen || fallback;
        if (!use) {
          result.samples[field] = {
            ...sample,
            manualAt: candidates[0].performedAt,
            status: `no station reading within ${MATCH_WINDOW_MIN} min`,
          };
          continue;
        }
        const ref = Number(use.rec[manualField]);
        const raw = use.raw;
        const state = stuckState(rows, use.at, field);
        Object.assign(sample, {
          ref, raw,
          manualAt: use.rec.performedAt,
          stationKey: use.match.r.key,
          dtMin: round(use.match.dtMin, 1),
          flow: !!use.match.r.flow,
          attempt: candidates.indexOf(use.rec) + 1,
          windowRange: state.range,
          flat: !!state.flat,
        });
        if (state.stuck) {
          sample.status = "sensor stuck";
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
            const sm = smooth(history, field, "offset", offset,
                probes[field] && probes[field].since);
            sample.status = Math.abs(offset - sm) > PH_OFFSET_MAX / 2 ?
              "unstable" : "ok";
            sample.applied = round(clamp(sm, -PH_OFFSET_MAX, PH_OFFSET_MAX), 3);
            applied[field + "Offset"] = sample.applied;
          }
        } else {
          const factor = ref / (raw / 1000);
          sample.factor = round(factor, 4);
          if (factor < EC_FACTOR_MIN || factor > EC_FACTOR_MAX) {
            sample.status = "factor out of range";
          } else {
            const sm = smooth(history, field, "factor", factor,
                probes[field] && probes[field].since);
            sample.status =
              Math.abs(factor - sm) / sm * 100 > UNSTABLE_PCT ?
                "unstable" : "ok";
            sample.applied =
              round(clamp(sm, EC_FACTOR_MIN, EC_FACTOR_MAX), 4);
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

// ── Calibration applied at ingest ───────────────────────────────────────────
// Readings are stored ALREADY corrected, as if the probe had been calibrated
// against a 1413 µS/cm buffer: ec/ec2 hold true µS/cm, ph1/ph2 true pH. What
// the probe actually sent is kept beside it as ecRaw/ec2Raw/ph1Raw/ph2Raw, and
// `cal` records the coefficients used, so a reading can always be recomputed.
// A reading WITHOUT `cal` predates this and is still raw.
const CAL_FIELDS = ["ec", "ec2", "ph1", "ph2"];
const CAL_LOOKBACK_DAYS = 30;
const CAL_CACHE_MS = 10 * 60 * 1000;
const calCache = {};

/** Stored reading → the raw view the probe sent. */
function rawView(item) {
  if (!item.cal) return item;
  const out = {...item};
  for (const f of CAL_FIELDS) {
    if (item[f + "Raw"] !== undefined) out[f] = item[f + "Raw"];
  }
  return out;
}

// Probe swaps. A coefficient belongs to the probe it was measured on: once a
// probe is replaced, everything calibrated before `since` is the old probe's
// and must neither be applied nor averaged into the new probe's correction.
// `ecFactor` is the new probe's starting factor until it earns its own: the
// Agrinovo RS485 probes report true µS/cm (station1's read 1439 in 1413
// buffer at 28 °C), so 1 -- not the ×2 the old analog probes needed.
// Overridable per station at berries/{stationId}/control/probes.
const DEFAULT_PROBES = {
  station1: {
    ec: {since: "2026-09-16", ecFactor: 1},
    ph1: {since: "2026-09-16"},
  },
};

async function stationProbes(db, stationId) {
  const snap = await db.ref(`berries/${stationId}/control/probes`).get();
  return snap.val() || DEFAULT_PROBES[stationId] || {};
}

/** Calibration days of a station that carry applied values, oldest first. */
function appliedDays(calVal) {
  return Object.entries(calVal || {})
      .filter(([k, v]) => /^\d{4}-\d{2}-\d{2}$/.test(k) && v && v.applied)
      .sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * Coefficients in force on `day` (null = latest), per field. Each field takes
 * its own most recent applied value: a day where only some probes calibrated
 * (the pH cup skipped, a probe unstable) must not throw the others back to the
 * defaults, which is what calibration/current alone would do. Values from
 * before the field's probe was installed are skipped.
 */
function coefficientsAt(days, probes, day) {
  const coef = {};
  for (const [date, v] of days) {
    if (day && date > day) break;
    for (const [k, x] of Object.entries(v.applied)) {
      const field = k.replace(/(Factor|Offset)$/, "");
      const since = probes[field] && probes[field].since;
      if (since && date < since) continue;
      if (Number.isFinite(Number(x))) coef[k] = {value: Number(x), date};
    }
  }
  return coef;
}

async function currentCoefficients(stationId) {
  const hit = calCache[stationId];
  if (hit && Date.now() - hit.at < CAL_CACHE_MS) return hit;
  const db = admin.database();
  const [snap, probes] = await Promise.all([
    db.ref(`berries/${stationId}/calibration`)
        .orderByKey().limitToLast(CAL_LOOKBACK_DAYS + 1).get(),
    stationProbes(db, stationId),
  ]);
  const coef = coefficientsAt(appliedDays(snap.val()), probes, null);
  calCache[stationId] = {at: Date.now(), coef, probes};
  return calCache[stationId];
}

/**
 * Correct `item` in place from its raw values: sets field, fieldRaw and `cal`.
 * Shared by ingest and the backfill so both follow one rule.
 */
function calibrateFields(item, coef, probes) {
  const cal = {};
  for (const f of CAL_FIELDS) {
    const src = item[f + "Raw"] !== undefined ? item[f + "Raw"] : item[f];
    const raw = Number(src);
    // 0 / missing is a probe that isn't reporting; leave it visibly so.
    if (!isNum(raw)) continue;
    item[f + "Raw"] = src;
    if (f.startsWith("ph")) {
      const c = coef[f + "Offset"];
      const offset = c ? c.value : 0;
      item[f] = round(raw + offset, 2);
      cal[f + "Offset"] = offset;
      if (c) cal[f + "Date"] = c.date;
    } else {
      const c = coef[f + "Factor"];
      const p = probes[f];
      const factor = c ? c.value :
        (p && Number.isFinite(p.ecFactor) ? p.ecFactor : EC_FACTOR_DEFAULT);
      item[f] = Math.round(raw * factor);
      cal[f + "Factor"] = factor;
      if (c) cal[f + "Date"] = c.date;
    }
  }
  if (Object.keys(cal).length) item.cal = cal;
  else delete item.cal;
  return item;
}

/**
 * Correct payload in place. Never throws: a calibration lookup that fails
 * falls back to the defaults (×2 EC, no pH offset), which is exactly what the
 * dashboard showed before, so ingest cannot be lost to it.
 */
async function applyCalibration(stationId, payload) {
  let coef = {};
  let probes = DEFAULT_PROBES[stationId] || {};
  try {
    ({coef, probes} = await currentCoefficients(stationId));
  } catch (e) {
    logger.error("calibration lookup failed", {stationId, error: e.message});
  }
  return calibrateFields(payload, coef, probes);
}

module.exports = {
  runCalibration, applyCalibration, rawView, calibrateFields, coefficientsAt,
  appliedDays, stationProbes, EC_FACTOR_DEFAULT, DEFAULT_MAP,
};
