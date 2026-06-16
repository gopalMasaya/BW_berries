/**
 * Galcon real-time worker — all project controllers (A–D).
 *
 * Galcon's live fertigation-center EC/pH and tank sensors are NOT in the REST
 * API; they are pushed over a Socket.IO v2 server (galileo_onlineserver:3008).
 * Each controller (comm unit) is a separate registration, so this worker holds
 * ONE persistent socket PER controller, registers it, and writes the live values
 * into Firebase RTDB so the dashboard can read them instantly.
 *
 *   socket: connect → on 'server_ready' → emit('register', ['GALILEO_<commUnitID>'])
 *           → receive 'events' (array). EC=3 = fert centers, EC=5 = sensors.
 *
 * A single socket carries only the controllers it registered, so per-controller
 * sockets keep each controller's events cleanly separated (no routing guesswork).
 *
 * The socket itself needs NO auth. A Galcon login is only used (optionally) to
 * (a) read sensor names/decimals once, (b) POST the run-events triggers that
 * force a fresh snapshot, and (c) DISCOVER each controller's commUnitID. Use a
 * DEDICATED Galcon user for that to avoid the single-session tug-of-war.
 *
 * Env:
 *   GOOGLE_APPLICATION_CREDENTIALS  path to a Firebase service-account JSON (required unless DRY_RUN)
 *   GALCON_USER / GALCON_PASS       Galcon creds for metadata + triggers + discovery (optional)
 *   GALCON_COMMUNIT_<LETTER>        override/supply a controller's commUnitID (e.g. GALCON_COMMUNIT_B=210555)
 *   TRIGGER_INTERVAL_MS             how often to force a snapshot (default 60000; 0 = never)
 *   DRY_RUN=1                       log writes instead of touching RTDB
 */
const io = require("socket.io-client"); // v2
const https = require("https");

const SOCKET_URL = "https://galileo_onlineserver.galcon-smart.com:3008";
const API_HOST = "galileo_api.galcon-smart.com";
const RTDB_URL = "https://plantstracker-f1274-default-rtdb.firebaseio.com/";

const USER = process.env.GALCON_USER || "Liatefi@gmail.com";
const PASS = process.env.GALCON_PASS || "123456";
const TRIGGER_INTERVAL_MS = process.env.TRIGGER_INTERVAL_MS != null ?
  Number(process.env.TRIGGER_INTERVAL_MS) : 60 * 1000;
const DRY_RUN = process.env.DRY_RUN === "1";

// Fallback names/decimals for the tanks so values are labelled even before the
// metadata fetch (number → { name, dec }). dec = decimal places (formatValue).
// These are Mevo Horon's (A) tanks; other controllers get their names from REST.
const FALLBACK_SENSORS = {
  1: {name: "גובה מיכל רחוק", dec: 1}, 2: {name: "גובה מיכל קרוב", dec: 1},
  3: {name: "PH מיכל רחוק", dec: 2}, 4: {name: "PH מיכל קרוב", dec: 2},
  19: {name: "PH מיכל 3", dec: 2}, 25: {name: "גובה מיכל 3", dec: 1},
};

// All four project controllers. The CAD field plan labels valves by controller
// letter + valve number (e.g. "B9" = controller B / valve 9). Each controller's
// live data is written under galcon/live/<letter>; A is also mirrored to the
// legacy galcon/mevoHoron path that the dosing tab still reads.
//   commUnitID is the socket registration id. These are the values observed from
//   the controllers-dashboard (kept as fallbacks); discoverCommUnits() refreshes
//   them at startup, and GALCON_COMMUNIT_<LETTER> overrides either.
const CONTROLLERS = [
  {letter: "A", serial: "GAL0000000000169", configId: 160377, name: "מבוא חורון", commUnitID: 210202, legacyBase: "galcon/mevoHoron"},
  {letter: "B", serial: "GAL0000000001399", configId: 160673, name: "פטל", commUnitID: 210498},
  {letter: "C", serial: "GAL0000000001638", configId: 160950, name: "פטל מערב", commUnitID: 210775},
  {letter: "D", serial: "GAL0000000001771", configId: 161088, name: "1771", commUnitID: 210913},
];
CONTROLLERS.forEach((c) => {
  const env = process.env["GALCON_COMMUNIT_" + c.letter];
  if (env && !isNaN(Number(env))) c.commUnitID = Number(env);
  c.sensorMeta = Object.assign({}, FALLBACK_SENSORS); // number → { name, dec, unit }
});
const SERIAL_TO_LETTER = {};
CONTROLLERS.forEach((c) => { SERIAL_TO_LETTER[c.serial] = c.letter; });
const liveBase = (c) => `galcon/live/${c.letter}`;

// external-api (separate from the web-app token): GET + JSON body, needs the
// account `key`. Returns finished-irrigation events per valve (last run, water).
const EXTERNAL_KEY = process.env.GALCON_EXTERNAL_KEY || "GCX6KN4KSU10KC78";
const IRR_LOOKBACK_DAYS = Number(process.env.IRR_LOOKBACK_DAYS || 14);
const IRR_POLL_MS = Number(process.env.IRR_POLL_MS || 10 * 60 * 1000);

// ───────────────────────── Firebase RTDB ─────────────────────────
let db = null;
if (!DRY_RUN) {
  const admin = require("firebase-admin");
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    databaseURL: RTDB_URL,
  });
  db = admin.database();
}
async function rtdbSet(path, value) {
  if (DRY_RUN) { console.log("DRY write", path, JSON.stringify(value)); return; }
  await db.ref(path).set(value);
}
async function rtdbUpdate(path, value) {
  if (DRY_RUN) { console.log("DRY update", path, JSON.stringify(value)); return; }
  await db.ref(path).update(value);
}

// ───────────────────────── Galcon REST (optional) ─────────────────────────
function apiReq(method, path, {body, token} = {}) {
  const data = body ? JSON.stringify(body) : null;
  const headers = {accept: "application/json"};
  if (token) headers.Authorization = token;
  if (data) { headers["content-type"] = "application/json"; headers["content-length"] = Buffer.byteLength(data); }
  return new Promise((resolve) => {
    const r = https.request({hostname: API_HOST, path, method, headers, timeout: 30000}, (x) => {
      const c = []; x.on("data", (d) => c.push(d));
      x.on("end", () => { const t = Buffer.concat(c).toString(); let j = null; try { j = JSON.parse(t); } catch {} resolve({status: x.statusCode, json: j}); });
    });
    r.on("error", () => resolve({status: "ERR"}));
    r.on("timeout", () => { r.destroy(); resolve({status: "TO"}); });
    if (data) r.write(data); r.end();
  });
}
let apiToken = null;
async function apiLogin() {
  const creds = {userName: USER, password: PASS, isMobile: false};
  const l = await apiReq("POST", "/auth/login", {body: creds});
  let t = l.json && l.json.body && l.json.body.accountToken;
  if (!t) {
    const ts = l.json && l.json.body && l.json.body.tempSessionId;
    if (!ts) throw new Error("login: no token/tempSession");
    const s = await apiReq("POST", "/auth/session", {body: Object.assign({tempSession: ts}, creds)});
    t = s.json && s.json.body && s.json.body.accountToken;
  }
  if (!t) throw new Error("login failed");
  return "Bearer " + t;
}
async function apiGet(path) {
  if (!apiToken) apiToken = await apiLogin();
  let r = await apiReq("GET", path, {token: apiToken});
  if (r.status === 401) { apiToken = await apiLogin(); r = await apiReq("GET", path, {token: apiToken}); }
  return r;
}

// Per-controller sensor names/decimals (tank labels differ per controller).
async function loadSensorMeta(c) {
  const r = await apiGet(`/config/${c.configId}/dashboard/active-data-collection-sensors`);
  const arr = (r.json && r.json.body) || [];
  for (const s of arr) {
    c.sensorMeta[s.number] = {name: (s.name || "").trim(), dec: s.formatValue, unit: s.unit};
  }
  console.log(`loaded metadata for ${arr.length} sensors (${c.letter})`);
}

// Discover each controller's commUnitID (the socket registration id) from the
// controllers-dashboard. Galcon's exact field name isn't documented here, so we
// scan for the usual suspects and log each record's keys for manual confirmation
// (set GALCON_COMMUNIT_<LETTER> if the field can't be auto-detected).
function pickCommUnit(rec) {
  for (const k of Object.keys(rec)) {
    if (/comm.*unit|communicat|comm_?id|unit_?id/i.test(k)) {
      const v = rec[k];
      if (v != null && !isNaN(Number(v))) return Number(v);
    }
  }
  return null;
}
async function discoverCommUnits() {
  const proj = await apiGet("/controllers-dashboard/user-projects");
  const projectId = proj.json && proj.json.body && proj.json.body.activeProjectID;
  if (!projectId) { console.warn("commUnit discovery: no active project"); return; }
  const r = await apiGet(`/project/${projectId}/controllers-dashboard?page=1&step=50`);
  const list = (r.json && r.json.body && r.json.body.controllers) || [];
  for (const c of CONTROLLERS) {
    const frag = c.serial.replace(/^GAL0+/, "");
    const rec = list.find((x) => String(x.serialNumber || "").trim() === c.serial) ||
                list.find((x) => String(x.serialNumber || "").includes(frag));
    if (!rec) { console.warn(`commUnit ${c.letter} (${c.serial}): not in dashboard`); continue; }
    const cand = pickCommUnit(rec);
    // GALCON_COMMUNIT_<LETTER> (set above) wins; otherwise prefer the live value
    // and fall back to the baked-in default if discovery found nothing.
    if (process.env["GALCON_COMMUNIT_" + c.letter]) {
      console.log(`commUnit ${c.letter}: ${c.commUnitID} (env override; live candidate ${cand})`);
    } else if (cand != null) {
      if (cand !== c.commUnitID) console.log(`commUnit ${c.letter}: ${c.commUnitID} → ${cand} (updated from dashboard)`);
      else console.log(`commUnit ${c.letter}: ${cand} (confirmed)`);
      c.commUnitID = cand;
    } else {
      console.log(`commUnit ${c.letter}: ${c.commUnitID == null ? "UNKNOWN" : c.commUnitID + " (default; not found in dashboard)"}`);
    }
  }
}

// Mirror every controller's valve list (number → Hebrew name) into RTDB so the
// dashboard's field plan can label/identify each valve. Valve definitions rarely
// change, so this runs at startup and on the trigger interval. Live per-valve
// "irrigating" status is NOT in this REST data — it only streams over the socket
// during active irrigation; historical runs need the external-api `key`.
async function loadValveMeta() {
  for (const c of CONTROLLERS) {
    try {
      const r = await apiGet(`/config/${c.configId}/element-group/valve`);
      const arr = (r.json && r.json.body && r.json.body.valveElements) || [];
      // Per-valve update (not a whole-node set) so lastIrr written by
      // loadValveIrrigation isn't clobbered on refresh.
      for (const v of arr) {
        if (!v || v.number == null) continue;
        await rtdbUpdate(`galcon/valves/${c.letter}/${v.number}`,
          {number: v.number, name: (v.name || "").trim(), id: v.id ?? null});
      }
      console.log(`valves ${c.letter} (${c.name}): ${arr.length}`);
    } catch (e) { console.error("valve meta", c.letter, e.message); }
  }
  const meta = {};
  for (const c of CONTROLLERS) meta[c.letter] = {letter: c.letter, name: c.name, serial: c.serial, configId: c.configId};
  await rtdbSet("galcon/controllers", meta);
}

// external-api request: GET with a JSON body (yes, a body on GET — Galcon's API).
function extApiReq(path, body) {
  const data = JSON.stringify(body);
  const headers = {accept: "application/json", "content-type": "application/json", "content-length": Buffer.byteLength(data)};
  return new Promise((resolve) => {
    const r = https.request({hostname: API_HOST, path, method: "GET", headers, timeout: 60000}, (x) => {
      const c = []; x.on("data", (d) => c.push(d));
      x.on("end", () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString()); } catch {} resolve({status: x.statusCode, json: j}); });
    });
    r.on("error", () => resolve({status: "ERR"}));
    r.on("timeout", () => { r.destroy(); resolve({status: "TO"}); });
    r.write(data); r.end();
  });
}
function fmtExtDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth()+1) + "-" + p(d.getDate()) + " " +
    p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()) + ".000";
}

// Pull the latest finished-irrigation event per valve (all controllers) and
// merge it into galcon/valves/<letter>/<number>/lastIrr.
async function loadValveIrrigation() {
  const to = new Date(), from = new Date(Date.now() - IRR_LOOKBACK_DAYS * 864e5);
  const body = {externalUserInfo: {userName: USER, password: PASS}, from: fmtExtDate(from), to: fmtExtDate(to), key: EXTERNAL_KEY};
  const r = await extApiReq("/external-api/get-valve-finish-irrigation-info", body);
  if (r.status !== 200 || !(r.json && r.json.body)) { console.warn("valve irrigation fetch:", r.status); return; }
  for (const c of (r.json.body.controllers || [])) {
    const letter = SERIAL_TO_LETTER[c.serialNumber];
    if (!letter) continue;
    const latest = {};
    for (const v of (c.valves || [])) {
      if (v.valveNo == null) continue;
      const t = Date.parse((v.dateTimeStopValve || v.time || "").replace(" ", "T")) || 0;
      if (!latest[v.valveNo] || t > latest[v.valveNo]._t) latest[v.valveNo] = Object.assign({_t: t}, v);
    }
    for (const num of Object.keys(latest)) {
      const v = latest[num];
      await rtdbUpdate(`galcon/valves/${letter}/${num}`, {lastIrr: {
        time: v.time || null, progNum: v.progNum ?? null,
        start: v.dateTimeStartValve || null, stop: v.dateTimeStopValve || null,
        durationMin: v.durationValve ?? null, flowRateM3h: v.flowRateM3h ?? null,
        volumeM3: v.volumeM3Valve ?? null, ec: v.ecMed ?? v.ecRef ?? null, ph: v.phMed ?? v.phRef ?? null,
      }});
    }
    console.log(`irrigation ${letter}: ${Object.keys(latest).length} valves with events`);
  }
}

async function fireTriggers(c) {
  const nums = Object.keys(c.sensorMeta).map(Number);
  await apiGet(`/config/${c.configId}/dashboard/run-real-time-events`);
  await apiReq("POST", `/config/${c.configId}/element-group/data-collection-sensor/run-events`,
      {token: apiToken, body: {numbers: nums}});
  console.log(`triggers fired for ${nums.length} sensors (${c.letter})`);
}

// ───────────────────────── event handling ─────────────────────────
function handleEvent(c, ev) {
  const de = ev && ev.DataEvent;
  if (!de) return;
  // Each event is tagged with its source controller; ignore anything that isn't
  // this controller's (defends against the server broadcasting all comm units).
  if (ev.ControlUnitID != null && c.commUnitID != null &&
      Number(ev.ControlUnitID) !== Number(c.commUnitID)) return;
  const ts = Date.now();
  const bases = [liveBase(c)].concat(c.legacyBase ? [c.legacyBase] : []);

  // EC=5 → data-collection sensor reading { Index, Value }
  if (ev.EC === 5 && de.Index != null && de.Value != null) {
    const num = de.Index;
    const meta = c.sensorMeta[num] || {name: "חיישן " + num, dec: 0};
    const value = de.Value / Math.pow(10, meta.dec || 0);
    const rec = {number: num, name: meta.name, value, raw: de.Value, unit: meta.unit ?? null, ts};
    for (const b of bases) rtdbSet(`${b}/sensors/${num}`, rec).catch((e) => console.error("rtdb sensor", c.letter, e.message));
    return;
  }

  // EC=3 → group-type status. Fert centers are the ones carrying ECActual/PHActual.
  // Skip unconfigured center slots — all-zero + inactive.
  if (ev.EC === 3 && de.ECActual != null && de.PHActual != null && de.Number != null) {
    if (!de.Status && !de.ECActual && !de.PHActual) return;
    const num = de.Number;
    const rec = {
      number: num,
      name: "שולחן דישון " + num,
      ec: de.ECActual / 100, ph: de.PHActual / 100,
      reqEc: (de.RequiredEC || 0) / 100, reqPh: (de.RequiredPH || 0) / 100,
      status: de.Status, ts,
    };
    for (const b of bases) rtdbSet(`${b}/fertCenters/${num}`, rec).catch((e) => console.error("rtdb fert", c.letter, e.message));
  }
}

// ───────────────────────── socket lifecycle ─────────────────────────
// One socket per controller, registered with only that controller's commUnitID.
function connect(c) {
  const socket = io(SOCKET_URL, {
    query: {clientTime: Date.now()},
    rejectUnauthorized: false,
    transports: ["polling", "websocket"],
    reconnection: true,
    reconnectionDelay: 3000,
  });

  socket.on("connect", () => console.log(`socket ${c.letter} connected`, socket.id));
  socket.on("connect_error", (e) => console.log(`connect_error ${c.letter}`, e && e.message));
  socket.on("disconnect", (r) => console.log(`disconnect ${c.letter}`, r));
  socket.on("server_ready", () => {
    console.log(`server_ready ${c.letter} → register GALILEO_${c.commUnitID}`);
    socket.emit("register", ["GALILEO_" + c.commUnitID]);
    if (TRIGGER_INTERVAL_MS) fireTriggers(c).catch((e) => console.error("trigger", c.letter, e.message));
  });
  socket.on("events", (payload) => {
    for (const ev of (Array.isArray(payload) ? payload : [payload])) handleEvent(c, ev);
  });
  return socket;
}

(async () => {
  console.log(`Galcon worker starting (DRY_RUN=${DRY_RUN}, trigger=${TRIGGER_INTERVAL_MS}ms)`);
  // Resolve commUnitIDs (needs a login). Without it, only controllers with a
  // known/overridden commUnitID (A) get a live socket.
  try { await discoverCommUnits(); } catch (e) { console.warn("commUnit discovery failed:", e.message); }
  if (TRIGGER_INTERVAL_MS) {
    for (const c of CONTROLLERS) {
      if (c.commUnitID == null) continue;
      try { await loadSensorMeta(c); } catch (e) { console.warn(`metadata ${c.letter} failed, using fallback:`, e.message); }
    }
  }
  // Valve names for all 4 controllers (independent of the trigger interval).
  try { await loadValveMeta(); } catch (e) { console.warn("valve meta failed:", e.message); }
  try { await loadValveIrrigation(); } catch (e) { console.warn("valve irrigation failed:", e.message); }

  // One live socket per controller that has a commUnitID.
  const active = CONTROLLERS.filter((c) => c.commUnitID != null);
  const skipped = CONTROLLERS.filter((c) => c.commUnitID == null);
  if (skipped.length) console.warn("no commUnitID (live socket skipped) for:", skipped.map((c) => c.letter).join(",") + " — set GALCON_COMMUNIT_<LETTER>");
  for (const c of active) connect(c);

  if (TRIGGER_INTERVAL_MS) {
    setInterval(() => {
      for (const c of active) fireTriggers(c).catch((e) => console.error("trigger", c.letter, e.message));
    }, TRIGGER_INTERVAL_MS);
  }
  // Refresh valve metadata hourly; per-valve last-irrigation every IRR_POLL_MS.
  setInterval(() => loadValveMeta().catch((e) => console.error("valve meta", e.message)), 60 * 60 * 1000);
  setInterval(() => loadValveIrrigation().catch((e) => console.error("valve irrigation", e.message)), IRR_POLL_MS);
  // heartbeat (per active controller)
  setInterval(() => {
    for (const c of active) {
      rtdbSet(`${liveBase(c)}/updatedAt`, Date.now()).catch(() => {});
      if (c.legacyBase) rtdbSet(`${c.legacyBase}/updatedAt`, Date.now()).catch(() => {});
    }
  }, 30000);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
