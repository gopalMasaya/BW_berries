/**
 * Probe drift check against Galcon's own feed EC/pH, with no one in the field.
 *
 * Every irrigation Galcon logs the EC/pH of the solution it sent to the valve.
 * The station's drain probes see that same solution come back through the
 * substrate. Drain EC/pH is not feed EC/pH -- the substrate concentrates salts
 * and buffers pH, and both move with the weather and the drain fraction -- so
 * the check does not expect equality. It looks for two things only:
 *
 *   1. Values no working probe produces: drain EC well below the feed (the
 *      substrate does not remove salt, but a fouled or drying EC cell reads
 *      low), or an extreme drain/feed pH gap.
 *   2. A sustained shift of the drain/feed relationship away from where it sat
 *      right after the last buffer calibration. Only then is there a trusted
 *      baseline; while the manual cups still move the coefficients daily, the
 *      relationship moves with them and a shift means nothing.
 *
 * Both must hold RECENT_DAYS days running before the alert is raised: one odd
 * day is weather. The verdict is advice ("check / recalibrate"), never a
 * correction -- nothing here changes a stored value.
 *
 * Output: berries/{stationId}/drift/{YYYY-MM-DD} (the day's pairs, medians)
 * and berries/{stationId}/drift/status (the current verdict, read by the
 * dashboard, settings and compare pages).
 */

const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");
const {plotOn, stationProbes} = require("./calibration");

// Controller letter of a plot code → Galcon serial (see galcon_controllers).
const SERIAL_BY_LETTER = {
  A: "GAL0000000000169", B: "GAL0000000001399",
  C: "GAL0000000001638", D: "GAL0000000001771",
};

const DRAIN_WINDOW_MS = 40 * 60 * 1000;   // drain keeps coming after the valve
const PRE_MS = 10 * 60 * 1000;
const MIN_EVENTS = 3;          // irrigations needed for a day to count
const RECENT_DAYS = 3;         // consecutive days a rule must hold
const BASELINE_DAYS = 5;
// Bounds no healthy probe should cross, as drain vs. feed.
const RATIO_MIN = 0.8;
const RATIO_MAX = 4;
const PH_DIFF_MIN = -1;
const PH_DIFF_MAX = 1.5;
// Shift from the post-calibration baseline.
const RATIO_SHIFT = 0.35;      // ±35 %
const PH_SHIFT = 0.4;

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** The station fields on the drain line, from the plot's calibration map. */
function drainFields(plot) {
  const map = plot.map || {};
  const ec = Object.keys(map).find((f) => map[f] === "drainEc") || null;
  const ph = Object.keys(map).find((f) => map[f] === "drainPh") || null;
  return {ec, ph};
}

/** The station's readings for an Israel day, oldest first, with flow deltas. */
async function stationDay(stationId, day) {
  const [y, m, d] = day.split("-");
  const snap = await admin.database().ref(`berries/${stationId}/${m}${y}`)
      .orderByKey().startAt(d).endAt(d + "").get();
  const rows = Object.values(snap.val() || {})
      .filter((it) => it && it.serverTimestamp)
      .map((it) => ({t: Date.parse(it.serverTimestamp), item: it}))
      .filter((r) => Number.isFinite(r.t))
      .sort((a, b) => a.t - b.t);
  let prev = null;
  for (const r of rows) {
    r.dOut = prev ? (Number(r.item.waterOut) || 0) -
      (Number(prev.item.waterOut) || 0) : 0;
    prev = r;
  }
  return rows;
}

/**
 * Pair one day's irrigations with the drain readings they produced and store
 * the result. `fetchValveEvents(serial, day)` → [{valve, startMs, stopMs,
 * ec, ph}] comes from the Galcon app API in index.js.
 */
async function computeDay(stationId, day, fetchValveEvents) {
  const plot = plotOn(stationId, day);
  const letter = plot.code[0];
  const valve = parseInt(plot.code.slice(1), 10);
  const {ec: ecF, ph: phF} = drainFields(plot);
  const out = {date: day, plot: plot.code, valve, pairs: [], notes: []};
  if (!ecF && !phF) {
    out.notes.push("no drain probe at this plot");
    return out;
  }
  const serial = SERIAL_BY_LETTER[letter];
  const events = (await fetchValveEvents(serial, day))
      .filter((e) => e.valve === valve && Number(e.ec) > 0);
  const rows = await stationDay(stationId, day);

  for (const e of events) {
    // Drain that actually flowed, from just before the valve opened until the
    // tail has drained. Buffer-calibration readings are not drain.
    const drain = rows.filter((r) => r.t >= e.startMs - PRE_MS &&
      r.t <= e.stopMs + DRAIN_WINDOW_MS && r.dOut > 0 && !r.item.calMode);
    const ecs = ecF ? drain.map((r) => Number(r.item[ecF]))
        .filter((v) => v > 0).map((v) => v / 1000) : [];
    const phs = phF ? drain.map((r) => Number(r.item[phF]))
        .filter((v) => v > 0) : [];
    if (!ecs.length && !phs.length) continue;
    const p = {startMs: e.startMs, feedEc: e.ec, feedPh: e.ph};
    if (ecs.length) {
      p.drainEc = round(mean(ecs), 3);
      p.ratio = round(p.drainEc / e.ec, 3);
    }
    if (phs.length && Number(e.ph) > 0) {
      p.drainPh = round(mean(phs), 2);
      p.phDiff = round(p.drainPh - e.ph, 2);
    }
    out.pairs.push(p);
  }
  if (!events.length) out.notes.push("no Galcon irrigation with EC for this valve");
  else if (!out.pairs.length) out.notes.push("no drain flow seen during irrigations");

  const ratios = out.pairs.map((p) => p.ratio).filter(Number.isFinite);
  const phd = out.pairs.map((p) => p.phDiff).filter(Number.isFinite);
  out.n = out.pairs.length;
  if (ratios.length) {
    out.ratio = round(median(ratios), 3);
    out.feedEc = round(median(out.pairs.map((p) => p.feedEc)), 2);
    out.drainEc = round(median(out.pairs.filter((p) => p.drainEc)
        .map((p) => p.drainEc)), 2);
  }
  if (phd.length) out.phDiff = round(median(phd), 2);
  out.computedAt = new Date().toISOString();
  await admin.database().ref(`berries/${stationId}/drift/${day}`).set(out);
  return out;
}

/** Recompute the verdict from the stored days up to `day`. */
async function evaluate(stationId, day) {
  const db = admin.database();
  const [driftSnap, srcSnap, calSnap, probes] = await Promise.all([
    db.ref(`berries/${stationId}/drift`).orderByKey().endAt(day)
        .limitToLast(45).get(),
    db.ref(`berries/${stationId}/control/calibrationSource`).get(),
    db.ref(`berries/${stationId}/calibration`).orderByKey().endAt(day)
        .limitToLast(60).get(),
    stationProbes(db, stationId),
  ]);
  const days = Object.entries(driftSnap.val() || {})
      .filter(([k, v]) => /^\d{4}-\d{2}-\d{2}$/.test(k) && v &&
        (v.n || 0) >= MIN_EVENTS)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, v]) => v);

  // Baseline: the first days after the last buffer calibration (or probe
  // install, whichever is later), and only in buffer mode.
  const plot = plotOn(stationId, day);
  const {ec: ecF, ph: phF} = drainFields(plot);
  const since = [ecF, phF].map((f) => f && probes[f] && probes[f].since)
      .filter(Boolean).sort().pop() || "";
  const lastBuffer = Object.entries(calSnap.val() || {})
      .filter(([k, v]) => /^\d{4}-\d{2}-\d{2}$/.test(k) && v &&
        v.source === "buffer")
      .map(([k]) => k).sort().pop() || "";
  const bufferMode = srcSnap.val() === "buffer";
  // Days from before the station reached its current plot compare a
  // different valve and a different drain.
  const plotFrom = plot.from || "";
  const baseFrom = [since, lastBuffer, plotFrom].sort().pop();
  const eligible = days.filter((d) => d.date >= baseFrom &&
    d.plot === plot.code);
  const base = bufferMode && lastBuffer ?
    eligible.slice(0, BASELINE_DAYS) : [];
  const baseline = base.length >= RECENT_DAYS ? {
    from: base[0].date, to: base[base.length - 1].date,
    ratio: round(median(base.map((d) => d.ratio).filter(Number.isFinite)), 3),
    phDiff: round(median(base.map((d) => d.phDiff).filter(Number.isFinite)), 2),
  } : null;

  const recent = eligible.slice(-RECENT_DAYS);
  const reasons = [];
  if (recent.length === RECENT_DAYS) {
    const all = (fn) => recent.every(fn);
    const has = (k) => (d) => Number.isFinite(d[k]);
    if (all(has("ratio")) && all((d) => d.ratio < RATIO_MIN)) {
      reasons.push({code: "ecLow", text: "EC הנקז נמוך מה-EC שהגלקון שולח — חשד לחיישן מלוכלך או יבש"});
    }
    if (all(has("ratio")) && all((d) => d.ratio > RATIO_MAX)) {
      reasons.push({code: "ecHigh", text: `EC הנקז גבוה פי ${RATIO_MAX}+ מההזנה — חשד לסחיפה או הצטברות מלח`});
    }
    if (all(has("phDiff")) &&
        (all((d) => d.phDiff < PH_DIFF_MIN) || all((d) => d.phDiff > PH_DIFF_MAX))) {
      reasons.push({code: "phOut", text: "פער pH חריג בין הנקז להזנה — חשד לסחיפת אלקטרודת pH"});
    }
    if (baseline && recent.every((d) => d.date > baseline.to)) {
      if (Number.isFinite(baseline.ratio) && all(has("ratio"))) {
        const rel = recent.map((d) => d.ratio / baseline.ratio - 1);
        if (rel.every((r) => r > RATIO_SHIFT) || rel.every((r) => r < -RATIO_SHIFT)) {
          reasons.push({code: "ecShift", text: `יחס EC נקז/הזנה זז ${Math.round(median(rel) * 100)}% מאז הכיול, ${RECENT_DAYS} ימים ברצף`});
        }
      }
      if (Number.isFinite(baseline.phDiff) && all(has("phDiff"))) {
        const dd = recent.map((d) => d.phDiff - baseline.phDiff);
        if (dd.every((x) => x > PH_SHIFT) || dd.every((x) => x < -PH_SHIFT)) {
          reasons.push({code: "phShift", text: `פער ה-pH מול ההזנה זז ${round(median(dd), 2)} מאז הכיול, ${RECENT_DAYS} ימים ברצף`});
        }
      }
    }
  }

  const status = {
    alert: reasons.length > 0,
    reasons,
    day,
    plot: plot.code,
    baseline,
    bufferMode,
    recent: recent.map((d) => ({date: d.date, n: d.n, ratio: d.ratio ?? null,
      phDiff: d.phDiff ?? null, feedEc: d.feedEc ?? null,
      drainEc: d.drainEc ?? null})),
    note: recent.length < RECENT_DAYS ?
      `צריך ${RECENT_DAYS} ימים עם ${MIN_EVENTS}+ השקיות מזוהות` :
      (!baseline ? "בדיקת גבולות בלבד — אין עדיין בסיס השוואה מכיול בתמיסות" : ""),
    checkedAt: new Date().toISOString(),
  };
  await db.ref(`berries/${stationId}/drift/status`).set(status);
  return status;
}

/** Compute + evaluate every station for one day. */
async function runDrift(day, stationIds, fetchValveEvents) {
  const out = {};
  for (const stationId of stationIds) {
    try {
      const d = await computeDay(stationId, day, fetchValveEvents);
      const s = await evaluate(stationId, day);
      out[stationId] = {day: d, status: s};
    } catch (e) {
      logger.error("drift failed", {stationId, day, error: e.message});
      out[stationId] = {error: e.message};
    }
  }
  return out;
}

module.exports = {runDrift, computeDay, evaluate, SERIAL_BY_LETTER};
