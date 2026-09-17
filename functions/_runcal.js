const admin = require("firebase-admin");
const key = require("C:/Users/Admin/Documents/js coding/plantsTracker/plantstracker-f1274-firebase-adminsdk-fbsvc-2684501475.json");
admin.initializeApp({credential: admin.credential.cert(key), databaseURL: "https://plantstracker-f1274-default-rtdb.firebaseio.com"});
const {runCalibration} = require("./calibration");
(async () => {
  for (const d of ["2026-09-11","2026-09-14","2026-09-15","2026-09-16","2026-09-17"]) {
    const out = await runCalibration(d);
    for (const [st, r] of Object.entries(out)) {
      console.log(d, st, r.notes && r.notes.length ? r.notes.join(";") : "",
        r.error || "", "dt=" + (r.dtMin ?? "-"), "flow=" + r.flow,
        JSON.stringify(r.samples), "applied=" + JSON.stringify(r.applied || {}));
    }
  }
  process.exit(0);
})();
