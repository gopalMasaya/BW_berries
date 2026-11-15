/**
 * Station health report — the same check the healthCheck function runs every
 * 3 hours (../health.js), printed for a person (or Claude) to act on.
 *
 *   cd "C:\Users\Admin\Documents\js coding\plantsTracker\functions"
 *   node tools/health-report.js            check now, print, don't store
 *   node tools/health-report.js --stored   print the last stored verdicts
 *   node tools/health-report.js --write    check now and store (like the schedule)
 *   node tools/health-report.js --json     raw JSON
 */
const path = require("path");
const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.cert(require(path.join(__dirname, "..", "..",
      "plantstracker-f1274-firebase-adminsdk-fbsvc-2684501475.json"))),
  databaseURL: "https://plantstracker-f1274-default-rtdb.firebaseio.com/",
});
const {runHealthCheck} = require("../health");

const fmt = (t) => t ? new Date(t).toLocaleString("en-GB",
    {timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"}) : "—";
const ICON = {ok: "OK  ", warn: "WARN", crit: "CRIT", info: "info", error: "ERR "};

(async () => {
  const db = admin.database();
  let out;
  if (process.argv.includes("--stored")) {
    out = (await db.ref("health/stations").get()).val() || {};
    console.log("stored run:", fmt((await db.ref("health/lastRun").get()).val()));
  } else {
    out = await runHealthCheck(db, {write: process.argv.includes("--write")});
  }
  if (process.argv.includes("--json")) {
    for (const h of Object.values(out)) delete h.fieldsSeen;
    console.log(JSON.stringify(out, null, 2));
  } else {
    for (const h of Object.values(out)) {
      console.log(`\n[${ICON[h.status] || h.status}] ${h.stationId}  last=${fmt(h.lastSeen)}  ` +
        `24h: ${h.readings24h}/${h.expected24h} (${h.coverage}%)  gaps=${h.gaps24h} longest=${h.longestGapMin}m  ` +
        `wifiFails=${h.wifiFails24h ?? "—"} apiFailsMax=${h.apiFailsMax ?? "—"} reboots=${h.reboots24h ?? "—"} ` +
        `late=${h.lateReadings24h ?? 0} queued=${h.queued ?? "—"}`);
      if (h.error) console.log("   error:", h.error);
      for (const i of h.issues || []) console.log(`   - ${ICON[i.level]} ${i.text}\n       → ${i.fix}`);
    }
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
