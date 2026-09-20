/**
 * Store the calibration INTO historical readings, the way ingest does for new
 * ones -- same code (calibrateFields in ../calibration.js), same rule.
 *
 *   cd "C:\Users\Admin\Documents\js coding\plantsTracker\functions"
 *   node tools/cal-backfill.js                     dry run, raw readings only
 *   node tools/cal-backfill.js --write             store it
 *
 *   --recompute        also redo readings that already carry `cal`, from their
 *                      *Raw values (after a probe swap or a coefficient fix)
 *   --station station1 only that station
 *   --from 2026-09-16  only readings on or after that day
 *
 * Each reading gets the coefficients in force on ITS OWN day (per field, the
 * latest applied value on or before that day, from the current probe only; none
 * yet → the probe's starting factor, else ×2 EC / no pH offset). The probe's
 * values are kept as ecRaw/ec2Raw/ph1Raw/ph2Raw, so this is reversible.
 */

const path = require("path");
const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.cert(require(path.join(__dirname, "..", "..",
      "plantstracker-f1274-firebase-adminsdk-fbsvc-2684501475.json"))),
  databaseURL: "https://plantstracker-f1274-default-rtdb.firebaseio.com/",
});

const {calibrateFields, coefficientsAt, appliedDays, stationProbes} =
  require("../calibration");

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const WRITE = process.argv.includes("--write");
const RECOMPUTE = process.argv.includes("--recompute");
const FROM = arg("--from");
const STATIONS = arg("--station") ? [arg("--station")] :
  ["station1", "station2"];
const FIELDS = ["ec", "ec2", "ph1", "ph2"];
const KEYS = [...FIELDS, ...FIELDS.map((f) => f + "Raw")];

/** tsKey "DDMMYYYY_HHMMSS" → "YYYY-MM-DD" (the day as stored). */
const dayOf = (k) => `${k.slice(4, 8)}-${k.slice(2, 4)}-${k.slice(0, 2)}`;

async function main() {
  const db = admin.database();
  for (const stationId of STATIONS) {
    const days = appliedDays(
        (await db.ref(`berries/${stationId}/calibration`).get()).val());
    const probes = await stationProbes(db, stationId);
    const memo = new Map();
    const coefAt = (day) => {
      if (!memo.has(day)) memo.set(day, coefficientsAt(days, probes, day));
      return memo.get(day);
    };

    const top = (await db.ref(`berries/${stationId}`).get()).val() || {};
    const months = Object.keys(top).filter((k) => /^\d{6}$/.test(k));
    let seen = 0;
    let changed = 0;
    const samples = [];
    for (const mk of months) {
      const updates = {};
      for (const [tsKey, item] of Object.entries(top[mk] || {})) {
        if (!item || typeof item !== "object") continue;
        if (!/^\d{8}_\d{6}$/.test(tsKey)) continue;
        const day = dayOf(tsKey);
        if (FROM && day < FROM) continue;
        if (item.cal && !RECOMPUTE) continue;
        seen++;
        const next = calibrateFields({...item}, coefAt(day), probes);
        const base = `berries/${stationId}/${mk}/${tsKey}/`;
        let diff = false;
        for (const k of KEYS) {
          if (next[k] !== undefined && next[k] !== item[k]) {
            updates[base + k] = next[k];
            diff = true;
          }
        }
        if (!next.cal) continue;
        const cal = {...next.cal};
        if (item.cal && item.cal.backfilled) cal.backfilled = true;
        if (!item.cal) cal.backfilled = true;
        if (diff || JSON.stringify(cal) !== JSON.stringify(item.cal)) {
          updates[base + "cal"] = cal;
          changed++;
          if (samples.length < 4) {
            samples.push({tsKey, before: pick(item), after: pick(next), cal});
          }
        }
      }
      if (WRITE && Object.keys(updates).length) {
        // Multi-path update, chunked to stay well under RTDB request limits.
        const entries = Object.entries(updates);
        for (let i = 0; i < entries.length; i += 5000) {
          await db.ref().update(Object.fromEntries(entries.slice(i, i + 5000)));
        }
      }
    }
    console.log(`${stationId}: ${seen} readings examined, ${changed} ${WRITE ?
      "updated" : "would change"}`);
    for (const s of samples) console.log("  ", JSON.stringify(s));
  }
  if (!WRITE) console.log("\nDry run. Re-run with --write to store it.");
}

function pick(item) {
  const o = {};
  for (const f of ["ec", "ph1"]) if (item[f] !== undefined) o[f] = item[f];
  return o;
}

main().then(() => process.exit(0), (e) => {
  console.error(e);
  process.exit(1);
});
