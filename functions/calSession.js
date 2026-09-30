/**
 * Buffer calibration of a station's EC/pH probes, run from the settings page.
 *
 * The technician starts a session; the station learns of it on its next
 * /watering fetch ("cal":1) and switches to sending every ~30 s. Readings that
 * arrive during the session are stamped `calMode` at ingest, so they never
 * reach the graphs, the compare page or the daily calibration -- the probes are
 * in a buffer, not in the drain. For each buffer the technician confirms a
 * point: the median of the last few raw readings, checked for stability,
 * against the value printed on the bottle (chosen in the page, so any buffer
 * the farm has works). Finishing fits the coefficients and stores them as that
 * day's calibration, the one ingest applies from then on:
 *
 *   EC  -> factor, least squares through the origin (one or more buffers).
 *   pH  -> one buffer: offset on top of the slope in force;
 *          two or more: slope + offset by linear regression.
 *
 * State lives at berries/{stationId}/control/calSession. A session that is
 * never finished expires on its own, and the station drops back to its normal
 * 5-minute cycle.
 */

const admin = require("firebase-admin");
const {
  coefficientsAt, appliedDays, stationProbes, rawView, currentCoefficients,
  CAL_FIELDS, EC_FACTOR_DEFAULT,
} = require("./calibration");

const SESSION_MAX_MS = 90 * 60 * 1000;
const POINT_WINDOW_MS = 4 * 60 * 1000;  // readings a point is taken from
const POINT_MIN_READINGS = 3;
const STABLE_EC_PCT = 3;                // max spread / median
const STABLE_PH = 0.05;                 // max spread, pH units
const EC_FACTOR_MIN = 0.2;
const EC_FACTOR_MAX = 4;
const PH_SLOPE_MIN = 0.7;
const PH_SLOPE_MAX = 1.3;
const PH_OFFSET_MAX = 2;

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const ilParts = (d) => Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit",
  day: "2-digit",
}).formatToParts(d).map((x) => [x.type, x.value]));
const ilDay = (d) => {
  const p = ilParts(d);
  return `${p.year}-${p.month}-${p.day}`;
};
const monthKey = (d) => {
  const p = ilParts(d);
  return `${p.month}${p.year}`;
};
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const sessionRef = (stationId) =>
  admin.database().ref(`berries/${stationId}/control/calSession`);

/** The session, if one is running right now. */
function activeSession(s, now = Date.now()) {
  return s && s.status === "active" && now < Number(s.expiresAt) ? s : null;
}

async function getSession(stationId) {
  return (await sessionRef(stationId).get()).val();
}

async function start(stationId, who) {
  const cur = activeSession(await getSession(stationId));
  if (cur) return cur;
  const now = Date.now();
  const s = {
    id: String(now),
    status: "active",
    startedAt: now,
    expiresAt: now + SESSION_MAX_MS,
    startedBy: who || "",
  };
  await sessionRef(stationId).set(s);
  return s;
}

/** The session's recent raw readings of one field, newest last. */
async function recentValues(stationId, session, field) {
  const now = new Date();
  // A session can straddle midnight at the month's end; read both months.
  const months = [...new Set([monthKey(new Date(now - POINT_WINDOW_MS)),
    monthKey(now)])];
  const rows = [];
  for (const mk of months) {
    const snap = await admin.database().ref(`berries/${stationId}/${mk}`)
        .orderByKey().limitToLast(12).get();
    for (const item of Object.values(snap.val() || {})) {
      if (!item || item.calMode !== session.id) continue;
      const t = Date.parse(item.serverTimestamp);
      if (!(now - t <= POINT_WINDOW_MS)) continue;
      const v = Number(rawView(item)[field]);
      if (Number.isFinite(v) && v !== 0) rows.push({t, v});
    }
  }
  return rows.sort((a, b) => a.t - b.t).map((r) => r.v);
}

/**
 * Record one buffer point. `ref` is the bottle's value in display units:
 * mS/cm for EC, pH for pH. Refused while the probe is still settling unless
 * `force` is set.
 */
async function addPoint(stationId, field, ref, force) {
  const session = activeSession(await getSession(stationId));
  if (!session) throw new Error("no active calibration session");
  if (!CAL_FIELDS.includes(field)) throw new Error("unknown field");
  const isPh = field.startsWith("ph");
  if (!Number.isFinite(ref) || ref <= 0 || (isPh && ref > 14)) {
    throw new Error("bad buffer value");
  }
  const vals = (await recentValues(stationId, session, field)).slice(-4);
  if (vals.length < POINT_MIN_READINGS) {
    return {ok: false, error: "not-enough", values: vals};
  }
  const med = median(vals);
  const spread = Math.max(...vals) - Math.min(...vals);
  const stable = isPh ? spread <= STABLE_PH :
    spread / med * 100 <= STABLE_EC_PCT;
  if (!stable && !force) {
    return {ok: false, error: "not-stable", values: vals};
  }
  const point = {
    field, raw: med, n: vals.length, stable, at: Date.now(),
    // Stored in the probe's own unit: µS/cm for EC.
    ref: isPh ? ref : ref * 1000,
  };
  const r = sessionRef(stationId).child("points").push();
  await r.set(point);
  return {ok: true, id: r.key, point};
}

async function removePoint(stationId, pointId) {
  await sessionRef(stationId).child(`points/${pointId}`).remove();
}

/** Coefficients from the session's points; nothing is stored. */
function fit(points, coefNow, probes) {
  const byField = {};
  for (const p of points) (byField[p.field] = byField[p.field] || []).push(p);
  const applied = {};
  const detail = {};
  const errors = [];
  for (const [field, pts] of Object.entries(byField)) {
    if (field.startsWith("ph")) {
      let slope;
      let offset;
      const refs = new Set(pts.map((p) => p.ref));
      if (refs.size >= 2) {
        const n = pts.length;
        const mx = pts.reduce((a, p) => a + p.raw, 0) / n;
        const my = pts.reduce((a, p) => a + p.ref, 0) / n;
        const sxx = pts.reduce((a, p) => a + (p.raw - mx) ** 2, 0);
        const sxy = pts.reduce((a, p) => a + (p.raw - mx) * (p.ref - my), 0);
        slope = sxy / sxx;
        offset = my - slope * mx;
      } else {
        const cs = coefNow[field + "Slope"];
        slope = cs ? cs.value : 1;
        offset = pts.reduce((a, p) => a + p.ref - slope * p.raw, 0) /
          pts.length;
      }
      detail[field] = {slope: round(slope, 4), offset: round(offset, 3),
        points: pts.length};
      // Judge the offset where it matters, around the working pH.
      if (slope < PH_SLOPE_MIN || slope > PH_SLOPE_MAX) {
        errors.push(`${field}: slope ${round(slope, 3)} out of range`);
      } else if (Math.abs(slope * 7 + offset - 7) > PH_OFFSET_MAX) {
        errors.push(`${field}: correction at pH 7 exceeds ${PH_OFFSET_MAX}`);
      } else {
        applied[field + "Slope"] = round(slope, 4);
        applied[field + "Offset"] = round(offset, 3);
      }
    } else {
      const sxy = pts.reduce((a, p) => a + p.raw * p.ref, 0);
      const sxx = pts.reduce((a, p) => a + p.raw * p.raw, 0);
      const factor = sxy / sxx;
      const cf = coefNow[field + "Factor"];
      const p0 = probes[field];
      detail[field] = {
        factor: round(factor, 4), points: pts.length,
        before: cf ? cf.value :
          (p0 && Number.isFinite(p0.ecFactor) ? p0.ecFactor :
            EC_FACTOR_DEFAULT),
      };
      if (factor < EC_FACTOR_MIN || factor > EC_FACTOR_MAX) {
        errors.push(`${field}: factor ${round(factor, 3)} out of range`);
      } else {
        applied[field + "Factor"] = round(factor, 4);
      }
    }
  }
  return {applied, detail, errors};
}

async function finish(stationId, who) {
  const db = admin.database();
  const session = activeSession(await getSession(stationId));
  if (!session) throw new Error("no active calibration session");
  const points = Object.values(session.points || {});
  if (!points.length) throw new Error("no points recorded");

  const now = new Date();
  const day = ilDay(now);
  const [calSnap, probes] = await Promise.all([
    db.ref(`berries/${stationId}/calibration`)
        .orderByKey().endAt(day).limitToLast(31).get(),
    stationProbes(db, stationId),
  ]);
  const coefNow = coefficientsAt(appliedDays(calSnap.val()), probes, day);
  const {applied, detail, errors} = fit(points, coefNow, probes);
  if (errors.length) {
    // Nothing applied: a wild fit is a wrong bottle or a dirty probe.
    return {ok: false, errors, detail};
  }

  const dayRef = db.ref(`berries/${stationId}/calibration/${day}`);
  const prev = (await dayRef.get()).val() || {};
  const computedAt = now.toISOString();
  await dayRef.set({
    ...prev,
    date: day,
    station: stationId,
    source: "buffer",
    applied: {...(prev.applied || {}), ...applied},
    buffer: {sessionId: session.id, by: who || "", points, detail,
      computedAt},
    computedAt,
  });
  await db.ref(`berries/${stationId}/calibration/current`).update({
    date: day, computedAt, ...applied,
  });
  // From now on the manual cups only check this calibration.
  await db.ref(`berries/${stationId}/control/calibrationSource`).set("buffer");
  await sessionRef(stationId).update({
    status: "done", finishedAt: now.getTime(), result: {applied, detail},
  });
  await currentCoefficients(stationId, now.getTime() + 1);
  return {ok: true, applied, detail};
}

async function cancel(stationId) {
  const s = await getSession(stationId);
  if (s && s.status === "active") {
    await sessionRef(stationId).update({status: "cancelled",
      finishedAt: Date.now()});
  }
}

module.exports = {
  activeSession, getSession, start, addPoint, removePoint, finish, cancel,
  fit,
};
