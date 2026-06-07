/**
 * Galcon real-time worker — Mevo Horon (000169).
 *
 * Galcon's live fertigation-center EC/pH and tank sensors are NOT in the REST
 * API; they are pushed over a Socket.IO v2 server (galileo_onlineserver:3008).
 * This worker holds ONE persistent socket, registers the controller, and writes
 * the live values into Firebase RTDB so the dashboard can read them instantly.
 *
 *   socket: connect → on 'server_ready' → emit('register', ['GALILEO_<commUnitID>'])
 *           → receive 'events' (array). EC=3 = fert centers, EC=5 = sensors.
 *
 * The socket itself needs NO auth. A Galcon login is only used (optionally) to
 * (a) read sensor names/decimals once and (b) POST the run-events triggers that
 * force a fresh snapshot. Use a DEDICATED Galcon user for that to avoid the
 * single-session tug-of-war with interactive logins.
 *
 * Env:
 *   GOOGLE_APPLICATION_CREDENTIALS  path to a Firebase service-account JSON (required unless DRY_RUN)
 *   GALCON_USER / GALCON_PASS       Galcon creds for metadata + triggers (optional)
 *   TRIGGER_INTERVAL_MS             how often to force a snapshot (default 600000 = 10 min; 0 = never)
 *   DRY_RUN=1                       log writes instead of touching RTDB
 */
const io = require("socket.io-client"); // v2
const https = require("https");

const SOCKET_URL = "https://galileo_onlineserver.galcon-smart.com:3008";
const API_HOST = "galileo_api.galcon-smart.com";
const RTDB_URL = "https://plantstracker-f1274-default-rtdb.firebaseio.com/";
const RTDB_BASE = "galcon/mevoHoron";

const MEVO = { serial: "GAL0000000000169", configId: 160377, commUnitID: 210202 };
const USER = process.env.GALCON_USER || "Liatefi@gmail.com";
const PASS = process.env.GALCON_PASS || "123456";
const TRIGGER_INTERVAL_MS = process.env.TRIGGER_INTERVAL_MS != null ?
  Number(process.env.TRIGGER_INTERVAL_MS) : 10 * 60 * 1000;
const DRY_RUN = process.env.DRY_RUN === "1";

// Fallback names/decimals for the tanks so values are labelled even before the
// metadata fetch (number → { name, dec }). dec = decimal places (formatValue).
const FALLBACK_SENSORS = {
  1: {name: "גובה מיכל רחוק", dec: 1}, 2: {name: "גובה מיכל קרוב", dec: 1},
  3: {name: "PH מיכל רחוק", dec: 2}, 4: {name: "PH מיכל קרוב", dec: 2},
  19: {name: "PH מיכל 3", dec: 2}, 25: {name: "גובה מיכל 3", dec: 1},
};
const FERT_CENTER_NAMES = {1: "שולחן דישון ראשי", 2: "שולחן דשן 2"};

let sensorMeta = Object.assign({}, FALLBACK_SENSORS); // number → { name, dec, unit }

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

async function loadSensorMeta() {
  const r = await apiGet(`/config/${MEVO.configId}/dashboard/active-data-collection-sensors`);
  const arr = (r.json && r.json.body) || [];
  for (const s of arr) {
    sensorMeta[s.number] = {name: (s.name || "").trim(), dec: s.formatValue, unit: s.unit};
  }
  console.log(`loaded metadata for ${arr.length} sensors`);
}

async function fireTriggers() {
  const nums = Object.keys(sensorMeta).map(Number);
  await apiGet(`/config/${MEVO.configId}/dashboard/run-real-time-events`);
  await apiReq("POST", `/config/${MEVO.configId}/element-group/data-collection-sensor/run-events`,
      {token: apiToken, body: {numbers: nums}});
  console.log("triggers fired for", nums.length, "sensors");
}

// ───────────────────────── event handling ─────────────────────────
function handleEvent(ev) {
  const de = ev && ev.DataEvent;
  if (!de) return;
  const ts = Date.now();

  // EC=5 → data-collection sensor reading { Index, Value }
  if (ev.EC === 5 && de.Index != null && de.Value != null) {
    const num = de.Index;
    const meta = sensorMeta[num] || {name: "חיישן " + num, dec: 0};
    const value = de.Value / Math.pow(10, meta.dec || 0);
    rtdbSet(`${RTDB_BASE}/sensors/${num}`, {
      number: num, name: meta.name, value, raw: de.Value, unit: meta.unit ?? null, ts,
    }).catch((e) => console.error("rtdb sensor", e.message));
    return;
  }

  // EC=3 → group-type status. Fert centers are the ones carrying ECActual/PHActual.
  if (ev.EC === 3 && de.ECActual != null && de.PHActual != null && de.Number != null) {
    const num = de.Number;
    rtdbSet(`${RTDB_BASE}/fertCenters/${num}`, {
      number: num,
      name: FERT_CENTER_NAMES[num] || ("שולחן דישון " + num),
      ec: de.ECActual / 100, ph: de.PHActual / 100,
      reqEc: (de.RequiredEC || 0) / 100, reqPh: (de.RequiredPH || 0) / 100,
      status: de.Status, ts,
    }).catch((e) => console.error("rtdb fert", e.message));
  }
}

// ───────────────────────── socket lifecycle ─────────────────────────
function connect() {
  const socket = io(SOCKET_URL, {
    query: {clientTime: Date.now()},
    rejectUnauthorized: false,
    transports: ["polling", "websocket"],
    reconnection: true,
    reconnectionDelay: 3000,
  });

  socket.on("connect", () => console.log("socket connected", socket.id));
  socket.on("connect_error", (e) => console.log("connect_error", e && e.message));
  socket.on("disconnect", (r) => console.log("disconnect", r));
  socket.on("server_ready", () => {
    console.log("server_ready → register GALILEO_" + MEVO.commUnitID);
    socket.emit("register", ["GALILEO_" + MEVO.commUnitID]);
    if (TRIGGER_INTERVAL_MS) fireTriggers().catch((e) => console.error("trigger", e.message));
  });
  socket.on("events", (payload) => {
    for (const ev of (Array.isArray(payload) ? payload : [payload])) handleEvent(ev);
  });
  return socket;
}

(async () => {
  console.log(`Galcon worker starting (DRY_RUN=${DRY_RUN}, trigger=${TRIGGER_INTERVAL_MS}ms)`);
  if (TRIGGER_INTERVAL_MS) {
    try { await loadSensorMeta(); } catch (e) { console.warn("metadata fetch failed, using fallback:", e.message); }
  }
  connect();
  if (TRIGGER_INTERVAL_MS) {
    setInterval(() => fireTriggers().catch((e) => console.error("trigger", e.message)), TRIGGER_INTERVAL_MS);
  }
  // heartbeat
  setInterval(() => rtdbSet(`${RTDB_BASE}/updatedAt`, Date.now()).catch(() => {}), 30000);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
