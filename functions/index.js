const {onRequest} = require("firebase-functions/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const express = require("express");
const sql = require("mssql");
const https = require("https");

admin.initializeApp();

const app = express();
app.use(express.json());

const DEVICE_SECRETS = {
  station1: "s0001mh0001",
  station2: "s0002mh0002",
};

function isAuthorizedQuery(req) {
  const stationId = String(req.query.stationId || "");
  const deviceSecret = String(req.query.deviceSecret || "");
  const expectedSecret = DEVICE_SECRETS[stationId] || "";

  logger.info("AUTH CHECK", {
    stationId,
    querySecretLen: deviceSecret.length,
    expectedSecretLen: expectedSecret.length,
  });

  return !!stationId && !!deviceSecret && deviceSecret === expectedSecret;
}

// The device already converts to Israel local time and sends it as
// payload.time in "DDMMYYYY_HHMMSS" format (same format we use for tsKey).
// Prefer it so stored keys reflect local time, not the function's UTC clock.
//
// Guard: only trust the device clock if its date is within ~2 days of the
// server clock. A failed NTP/RTC sync returns time_t = -1 (0xFFFFFFFF), which
// renders as 2106-02-07 and was filing data under a bogus "022106" month node
// the dashboard never reads (so the station showed as Offline). When the device
// date is implausible we return null and fall back to buildKeysFromDate(now).
function buildKeysFromDeviceTime(timeStr, now) {
  if (typeof timeStr !== "string" || !/^\d{8}_\d{6}$/.test(timeStr)) {
    return null;
  }
  const dd = Number(timeStr.slice(0, 2));
  const mm = Number(timeStr.slice(2, 4));
  const yyyy = Number(timeStr.slice(4, 8));
  const devDate = new Date(yyyy, mm - 1, dd);
  if (Math.abs(devDate.getTime() - now.getTime()) > 2 * 864e5) {
    logger.warn("device time rejected (implausible date)", {timeStr});
    return null;
  }
  return {monthKey: `${timeStr.slice(2, 4)}${timeStr.slice(4, 8)}`, tsKey: timeStr};
}

// Fallback when the device time is missing/malformed: use the server clock but
// render it in Israel local time. Cloud Functions run in UTC, and getHours()
// would therefore be 2-3h behind; Intl with timeZone handles DST automatically.
function buildKeysFromDate(now) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now).reduce((a, x) => {
    a[x.type] = x.value;
    return a;
  }, {});

  return {
    monthKey: `${p.month}${p.year}`,
    tsKey: `${p.day}${p.month}${p.year}_${p.hour}${p.minute}${p.second}`,
  };
}

app.post("/ingest", async (req, res) => {
  try {
    if (!isAuthorizedQuery(req)) {
      return res.status(403).json({ok: false, error: "unauthorized"});
    }

    const stationId = String(req.query.stationId || "");
    const payload = req.body;

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return res.status(400).json({ok: false, error: "invalid json body"});
    }

    const now = new Date();
    // Prefer the device's Israel-local time; fall back to server time
    // rendered in Israel local if the device didn't send a valid time.
    const {monthKey, tsKey} =
        buildKeysFromDeviceTime(payload.time, now) || buildKeysFromDate(now);

    payload.serverTimestamp = now.toISOString();
    payload.stationId = stationId;

    await admin.database()
        .ref(`/berries/${stationId}/${monthKey}/${tsKey}`)
        .set(payload);

    return res.status(200).json({
      ok: true,
      stationId,
      monthKey,
      tsKey,
    });
  } catch (err) {
    logger.error("ingest failed", err);
    return res.status(500).json({ok: false, error: "server error"});
  }
});

app.get("/watering", async (req, res) => {
  try {
    if (!isAuthorizedQuery(req)) {
      return res.status(403).json({ok: false, error: "unauthorized"});
    }

    const stationId = String(req.query.stationId || "");
    const [waterSnap, configSnap] = await Promise.all([
      admin.database().ref(`/berries/${stationId}/control/watering`).get(),
      admin.database().ref(`/berries/${stationId}/control/wateringConfig`).get(),
    ]);

    const config = configSnap.val() || {};

    return res.status(200).json({
      ok: true,
      stationId,
      watering: !!waterSnap.val(),
      monitorOnly: config.monitorOnly ?? false,
      wateringEnabled: config.wateringEnabled ?? true,
      soil1Threshold: config.soil1Threshold ?? 60,
      soil2RiseToStop: config.soil2RiseToStop ?? 5,
      noRiseTimeoutMin: config.noRiseTimeoutMin ?? 10,
      maxWateringMin: config.maxWateringMin ?? 25,
      postWateringWaitMin: config.postWateringWaitMin ?? 20,
    });
  } catch (err) {
    logger.error("watering failed", err);
    return res.status(500).json({ok: false, error: "server error"});
  }
});

exports.api = onRequest({cors: true}, app);

// ===================== GALCON PROXY =====================
// Sensors + controllers/zones come from the on-premise MSSQL (still flowing).
// Valve events come from Galcon's Galileo Cloud API (the SQL ValveData feed
// stopped on 2026-04-13 when Galcon switched to cloud-only valve reporting).

const GALCON_SQL_CONFIG = {
  server: "45.83.43.235",
  port: 14445,
  user: "gopal",
  password: "1a@S3d$F",
  database: "Tal_Irrigation",
  options: {
    encrypt: false,
    trustServerCertificate: true,
    requestTimeout: 30000,
    connectionTimeout: 15000,
  },
};

const GALILEO_CONFIG = {
  host: "galileo_api.galcon-smart.com",
  userName: "Liatefi@gmail.com",
  password: "123456",
  key: "GCX6KN4KSU10KC78",
};

let galconPool = null;

async function getGalconPool() {
  if (galconPool && galconPool.connected) return galconPool;
  galconPool = await sql.connect(GALCON_SQL_CONFIG);
  return galconPool;
}

function fmtGalileoDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.000`;
}

// Galileo's external-api requires GET + JSON body (per their docs),
// which Node's fetch refuses — use raw https.request.
function galileoGet(path, fromDate, toDate) {
  const body = JSON.stringify({
    externalUserInfo: {
      userName: GALILEO_CONFIG.userName,
      password: GALILEO_CONFIG.password,
    },
    from: fmtGalileoDate(fromDate),
    to: fmtGalileoDate(toDate),
    key: GALILEO_CONFIG.key,
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: GALILEO_CONFIG.host,
      path,
      method: "GET",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "accept": "application/json",
      },
      timeout: 55000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(text)); } catch (e) {
            reject(new Error("galileo bad json: " + e.message));
          }
        } else {
          reject(new Error(`galileo HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("galileo timeout")));
    req.write(body);
    req.end();
  });
}

// "2026-05-13 08:00" / "2026-05-13 08:00:00.000" → "2026-05-13T08:00:00" so
// `new Date(...)` parses it as local time on the client (same as old SQL behavior).
function normalizeGalileoDate(s) {
  if (!s) return null;
  const parts = s.split(" ");
  if (parts.length !== 2) return s;
  const [d, t] = parts;
  return t.split(":").length === 2 ? `${d}T${t}:00` : `${d}T${t}`;
}

// ===================== GALCON APP API (live dashboard) =====================
// The external-api above only exposes finished-irrigation events. The live
// fertigation-center EC/pH ("שולחן דישון") and tank sensors live in the web
// app's own API (same host, see /swagger/docs/v1), reached by logging in.
// NOTE: the account enforces a SINGLE session — calling this logs out any
// interactive Galcon login on the same user (and vice-versa). Use a dedicated
// integration user to avoid the tug-of-war. Mevo Horon = serial 000169.
const GALILEO_APP = {
  host: "galileo_api.galcon-smart.com",
  userName: "Liatefi@gmail.com",
  password: "123456",
};

let appToken = null; // "Bearer <token>", cached per warm instance
let mevoConfigId = null; // resolved Mevo Horon configID, cached

function appRequest(method, path, {body, token} = {}) {
  const data = body ? JSON.stringify(body) : null;
  const headers = {accept: "application/json"};
  if (token) headers["Authorization"] = token;
  if (data) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(data);
  }
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: GALILEO_APP.host, path, method, headers, timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* non-JSON */ }
        resolve({status: res.statusCode, text, json});
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("galileo app timeout")));
    if (data) req.write(data);
    req.end();
  });
}

// Log in; if a session is already active, take it over via the tempSession.
// Token must be sent as the "Bearer <token>" Authorization header.
async function appLogin() {
  const creds = {
    userName: GALILEO_APP.userName,
    password: GALILEO_APP.password,
    isMobile: false,
  };
  const login = await appRequest("POST", "/auth/login", {body: creds});
  let token = login.json && login.json.body && login.json.body.accountToken;
  if (!token) {
    const tempSession = login.json && login.json.body && login.json.body.tempSessionId;
    if (!tempSession) throw new Error("galileo login: no token / tempSession");
    const sess = await appRequest("POST", "/auth/session", {
      body: Object.assign({tempSession}, creds),
    });
    token = sess.json && sess.json.body && sess.json.body.accountToken;
  }
  if (!token) throw new Error("galileo login failed");
  return "Bearer " + token;
}

async function appGet(path) {
  if (!appToken) appToken = await appLogin();
  let r = await appRequest("GET", path, {token: appToken});
  if (r.status === 401) {
    appToken = await appLogin();
    r = await appRequest("GET", path, {token: appToken});
  }
  return r;
}

async function getMevoConfigId() {
  if (mevoConfigId) return mevoConfigId;
  const proj = await appGet("/controllers-dashboard/user-projects");
  const projectId = proj.json.body.activeProjectID;
  const ctrls = await appGet(
      `/project/${projectId}/controllers-dashboard?page=1&step=50`);
  const list = (ctrls.json.body && ctrls.json.body.controllers) || [];
  const mevo = list.find((c) => String(c.serialNumber || "").includes("000169"));
  if (!mevo) throw new Error("Mevo Horon (000169) not found");
  mevoConfigId = mevo.configID;
  return mevoConfigId;
}

function fmtAppDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Resolve any controller serial → its Galileo configID. Cached per serial per
// warm instance. Matches on the full serial or on a trailing fragment (e.g.
// "000169") so callers can pass either form.
const configIdBySerial = {};
let controllerList = null; // [{serial, configId}], cached per warm instance
async function listControllers() {
  if (controllerList) return controllerList;
  const proj = await appGet("/controllers-dashboard/user-projects");
  const projectId = proj.json.body.activeProjectID;
  const ctrls = await appGet(
      `/project/${projectId}/controllers-dashboard?page=1&step=50`);
  const list = (ctrls.json.body && ctrls.json.body.controllers) || [];
  controllerList = list.map((c) => ({
    serial: String(c.serialNumber || "").trim(),
    configId: c.configID,
  }));
  for (const c of controllerList) configIdBySerial[c.serial] = c.configId;
  return controllerList;
}

async function getConfigIdForSerial(serial) {
  const s = String(serial || "").trim();
  if (!s) throw new Error("serial required");
  if (configIdBySerial[s]) return configIdBySerial[s];
  const list = await listControllers();
  const found = list.find((c) => c.serial === s) ||
                list.find((c) => c.serial.includes(s));
  if (!found) throw new Error("controller not found: " + s);
  configIdBySerial[s] = found.configId;
  return found.configId;
}

// The controllers report wall-clock time in Israel local time, and the app API
// expects its from/to query in that same local time — but Cloud Functions run in
// UTC, so every conversion here is pinned to Asia/Jerusalem explicitly.
const IL_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jerusalem",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
// epoch ms → "YYYY-MM-DDTHH:mm:ss" Israel wall time (the shape the report's
// `new Date(...)` parses as local time, matching the old external-api strings).
function ilStamp(ms) {
  if (ms == null) return null;
  const p = {};
  for (const part of IL_FMT.formatToParts(ms)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

const galconApp = express();
galconApp.use(express.json());

// Accept Firebase ID tokens from this project (plantstracker-f1274) AND from the
// qrCode project (song-cd1cd), whose irrigation report embeds Galcon data per
// station. verifyIdToken validates the JWT signature against Google's public
// certs and checks the audience against the app's projectId — no service-account
// credential is needed — so a credential-less named app is enough to verify the
// other project's tokens.
let qrAuthApp = null;
function qrAuth() {
  if (!qrAuthApp) {
    qrAuthApp = admin.initializeApp({projectId: "song-cd1cd"}, "qrcode");
  }
  return admin.auth(qrAuthApp);
}
async function verifyAnyProject(idToken) {
  try {
    return await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return await qrAuth().verifyIdToken(idToken);
  }
}

// Firebase Auth middleware
galconApp.use(async (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ok: false, error: "missing auth token"});
  }
  try {
    const token = auth.split("Bearer ")[1];
    req.user = await verifyAnyProject(token);
    next();
  } catch (e) {
    return res.status(401).json({ok: false, error: "invalid token"});
  }
});

galconApp.get("/overview", async (req, res) => {
  try {
    const pool = await getGalconPool();

    const to = new Date();
    const from = new Date(to.getTime() - 30 * 86400000);

    const [galData, groups] = await Promise.all([
      galileoGet("/external-api/get-valve-finish-irrigation-info", from, to),
      pool.request().query(`
        SELECT DISTINCT Sensor_Group_Name as name
        FROM dbo.PCS_ID
        WHERE Sensor_Group_Name != ''
        ORDER BY Sensor_Group_Name
      `),
    ]);

    const galControllers = galData && galData.body && galData.body.controllers || [];
    const controllers = galControllers.map((c) => ({
      SerialNumber: c.serialNumber == null ? "" : String(c.serialNumber).trim(),
    }));
    const valveStats = galControllers.map((c) => {
      const events = c.valves || [];
      let lastEvent = null;
      for (const v of events) {
        const t = v.dateTimeStopValve || v.dateTimeStartValve;
        if (t && (!lastEvent || t > lastEvent)) lastEvent = t;
      }
      return {
        SerialNumber: c.serialNumber == null ? "" : String(c.serialNumber).trim(),
        totalEvents: events.length,
        lastEvent: normalizeGalileoDate(lastEvent),
      };
    });

    return res.json({
      ok: true,
      controllers,
      sensorGroups: groups.recordset.map((r) => r.name),
      valveStats,
    });
  } catch (err) {
    logger.error("galcon overview failed", err);
    return res.status(500).json({ok: false, error: err.message || "server error"});
  }
});

// Finished-irrigation events.
//
// These used to come from /external-api/get-valve-finish-irrigation-info, but on
// 2026-07 that endpoint started answering HTTP 402 "This key has been expired,
// please contact Galcon" — which surfaced to the report as a 500. The same raw
// controller log is available through the app API as log type 5
// (FinishIrrigation), so that is the source now. Verified row-for-row against the
// last data the external-api produced (2026-06-14, controller C): identical stop
// times, programs, volumes, durations, EC and pH — and the app API even fills in
// flow rates the external endpoint sometimes reported as 0.
//
// Field shape below is kept EXACTLY as the external-api version emitted it, so
// the qrCode report needs no change. Differences worth knowing:
//   • the log carries a single EC/pH per event (ecLast/phLast) rather than
//     min/med/max, so all three are set to that one value;
//   • the log timestamps the END of the irrigation, so the start is derived as
//     stop − duration;
//   • one event can open several valves together (program with valveA..valveE),
//     and the log meters the group as a whole. The external-api used to report a
//     per-valve figure; it split the group's water and flow in proportion to each
//     valve's nominalFlow, so that is reproduced here — verified against the last
//     external data (2026-06-14, controller A): program 4 metered 21.49 m³ over
//     valves 4/8/9 (nominalFlow 15/24.4/18) and the external-api reported
//     5.6/9.2/6.7 m³ and 14.3/23.3/17.2 m³/h, which is exactly this split.
//     ValveCount/ValveGroup are carried along so a consumer can still tell the
//     event was shared.
const LOG_TYPE_FINISH_IRRIGATION = 5;

async function fetchFinishIrrigation(configId, fromLocal, toLocal) {
  const r = await appGet(
      `/config/${configId}/log-types/${LOG_TYPE_FINISH_IRRIGATION}/logs` +
      `?from=${encodeURIComponent(fromLocal)}&to=${encodeURIComponent(toLocal)}`);
  if (r.status !== 200) {
    throw new Error(`galileo app HTTP ${r.status}: ${String(r.text).slice(0, 200)}`);
  }
  const body = (r.json && r.json.body) || {};
  return Array.isArray(body) ? body : (body.items || []);
}

// valve number → nominalFlow (m³/h), per controller. Cached per warm instance;
// this is setup data that only changes when the grower re-plumbs a valve.
const nominalFlowByConfig = {};
async function getNominalFlows(configId) {
  if (nominalFlowByConfig[configId]) return nominalFlowByConfig[configId];
  const r = await appGet(`/config/${configId}/element-group/valve-setup`);
  const body = (r.json && r.json.body) || {};
  const items = Array.isArray(body) ? body : (body.items || []);
  const map = {};
  for (const v of items) {
    if (v && v.number != null) map[v.number] = Number(v.nominalFlow) || 0;
  }
  nominalFlowByConfig[configId] = map;
  return map;
}

// Share of the group's water that belongs to each valve. Falls back to an even
// split when the controller has no nominalFlow for the valves involved, so a
// missing setup value degrades to "divide by N" rather than to zero.
function valveShares(group, nominalFlows) {
  const flows = group.map((n) => Number(nominalFlows[n]) || 0);
  const total = flows.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return group.map(() => 1 / group.length);
  return flows.map((f) => f / total);
}

// Flow rate for one valve of an event.
//   • single-valve event — the log's measureFlow IS that valve's flow, and it
//     reproduces the old external-api value closely, so use it as-is.
//   • multi-valve event — measureFlow is a line-level reading that does not
//     divide cleanly (on controller D it ran ~2× the per-valve figure even after
//     splitting), so derive the average flow from the valve's own share of the
//     water instead: volume ÷ hours.
// Scored against the last external-api data (2026-06-14, 45 valves): this
// hybrid averages 0.49 m³/h off, versus 0.81 for split-measureFlow and 1.10 for
// always-derived.
function valveFlow(groupSize, measureFlow, valveVolume, durationMin) {
  if (groupSize === 1) {
    const f = Number(measureFlow);
    return isNaN(f) ? null : f;
  }
  if (!(durationMin > 0)) return null;
  return valveVolume / (durationMin / 60);
}

const round2 = (n) => (n == null || isNaN(n) ? n : Math.round(n * 100) / 100);

galconApp.get("/valves", async (req, res) => {
  try {
    const fromStr = req.query.from || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const toStr = req.query.to || new Date().toISOString().slice(0, 10);
    const filterSerial = req.query.controllerSerial ?
      String(req.query.controllerSerial).trim() : null;

    const fromLocal = `${fromStr} 00:00:00`;
    const toLocal = `${toStr} 23:59:59`;

    const all = await listControllers();
    const targets = filterSerial ?
      all.filter((c) => c.serial === filterSerial) : all;
    logger.info("valves filter", {
      filterSerial, controllerSerials: all.map((c) => c.serial),
    });

    const perController = await Promise.all(targets.map(async (c) => {
      const [items, nominalFlows] = await Promise.all([
        fetchFinishIrrigation(c.configId, fromLocal, toLocal),
        getNominalFlows(c.configId),
      ]);
      const out = [];
      let empty = 0;
      for (const row of items) {
        const durMin = Number(row.lastTime) || 0;
        const volume = Number(row.lastWater) || 0;
        const stopMs = row.time == null ? null : Number(row.time);
        const startMs = (stopMs != null && durMin > 0) ?
          stopMs - Math.round(durMin * 60000) : stopMs;

        const group = [0, 1, 2, 3, 4]
            .map((i) => row["valve" + i])
            .filter((n) => n != null && Number(n) > 0)
            .map(Number);
        // A row with no valve at all carries nothing the report can place.
        if (!group.length) { empty++; continue; }

        const shares = group.length > 1 ?
          valveShares(group, nominalFlows) : [1];

        group.forEach((valveNo, i) => {
          const valveVolume = round2(volume * shares[i]);
          out.push({
            SerialNumber: c.serial,
            DateTimeStartValve: ilStamp(startMs),
            DateTimeStopValve: ilStamp(stopMs),
            ValveNo: valveNo,
            ProgNum: row.programNumber,
            DurationValve: row.lastTime,
            FlowRateM3h: round2(
                valveFlow(group.length, row.measureFlow, valveVolume, durMin)),
            VolumeM3Valve: valveVolume,
            PhMin: row.phLast, PhMed: row.phLast, PhMax: row.phLast,
            EcMin: row.ecLast, EcMed: row.ecLast, EcMax: row.ecLast,
            EcRequired: row.ecRequired, PhRequired: row.phRequired,
            ValveCount: group.length, // >1 → volume/flow are this valve's share
            ValveGroup: group,
          });
        });
      }
      logger.info("valves loaded", {
        serial: c.serial, rows: items.length, events: out.length, skippedEmpty: empty,
      });
      return out;
    }));

    const valves = perController.flat();
    valves.sort((a, b) => (b.DateTimeStartValve || "").localeCompare(a.DateTimeStartValve || ""));

    return res.json({ok: true, valves});
  } catch (err) {
    logger.error("galcon valves failed", err);
    return res.status(500).json({ok: false, error: err.message || "server error"});
  }
});

galconApp.get("/sensors", async (req, res) => {
  try {
    const pool = await getGalconPool();
    const group = req.query.group || "";
    const from = req.query.from || new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const to = req.query.to || new Date().toISOString().slice(0, 10);

    if (!group) {
      return res.status(400).json({ok: false, error: "group parameter required"});
    }

    const request = pool.request();
    request.input("group", sql.NVarChar, group);
    request.input("from", sql.DateTime, new Date(from));
    request.input("to", sql.DateTime, new Date(to + "T23:59:59"));

    const result = await request.query(`
      SELECT p.Sensor_Label as label, v.Time, v.Value
      FROM dbo.PCS_Value v
      JOIN dbo.PCS_ID p ON v.PcsId = p.PcsId
      WHERE p.Sensor_Group_Name = @group
        AND v.Time >= @from AND v.Time <= @to
      ORDER BY v.Time, p.Sensor_Label
    `);

    const drainResult = await request.query(`
      SELECT v.Time, v.Value
      FROM dbo.PCS_Value_Drain_Percent v
      JOIN dbo.PCS_ID p ON v.Drain_PcsId = p.PcsId
      WHERE p.Sensor_Group_Name = @group
        AND p.Sensor_Label = 'Drain'
        AND v.Time >= @from AND v.Time <= @to
      ORDER BY v.Time
    `);

    return res.json({
      ok: true,
      sensors: result.recordset,
      drainPercent: drainResult.recordset,
    });
  } catch (err) {
    logger.error("galcon sensors failed", err);
    return res.status(500).json({ok: false, error: "server error"});
  }
});

// Live fertigation centers ("שולחנות דישון") + sensor list for a controller.
// Pass ?serial=<controllerSerial> for a specific controller (e.g. B = 001399);
// with no serial it defaults to Mevo Horon (A) for backward compatibility.
// Tank live values (level/pH) are not REST-exposed (real-time socket only),
// so we return the sensor NAMES here; numeric values come in a later phase.
galconApp.get("/dosing", async (req, res) => {
  try {
    const serial = String(req.query.serial || "").trim();
    const cfg = serial ?
      await getConfigIdForSerial(serial) : await getMevoConfigId();
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 86400000);
    const range = `startDate=${encodeURIComponent(fmtAppDate(from))}` +
                  `&endDate=${encodeURIComponent(fmtAppDate(to))}`;

    const [c1, c2, sensorsRes] = await Promise.all([
      appGet(`/config/${cfg}/dashboard/ecph-widget-info?fertCenterNumber=1&${range}`),
      appGet(`/config/${cfg}/dashboard/ecph-widget-info?fertCenterNumber=2&${range}`),
      appGet(`/config/${cfg}/dashboard/active-data-collection-sensors`),
    ]);

    const lastPoint = (r) => {
      const arr = (r.json && r.json.body) || [];
      return Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null;
    };
    const fertCenter = (p, num) => {
      if (!p) return {number: num, name: `שולחן דישון ${num}`, hasData: false};
      return {
        number: p.fertCenterNum || num,
        name: (p.fertCenterName || `שולחן דישון ${num}`).trim(),
        currentEC: p.currAverageEC,
        currentPH: p.currAveragePH,
        requiredEC: p.currRequiredEC,
        requiredPH: p.currRequiredPH,
        waterFlow: p.averageWaterFlow,
        time: p.time || p.receivedDate || null,
        hasData: true,
      };
    };

    const sensors = (((sensorsRes.json && sensorsRes.json.body) || []))
        .map((s) => ({
          number: s.number,
          name: (s.name || "").trim(),
          unit: s.unit,
          sensorType: s.sensorType,
          id: s.id,
        }));

    return res.json({
      ok: true,
      controllerName: serial ? serial : "מבוא חורון",
      serial: serial || null,
      configId: cfg,
      fertCenters: [fertCenter(lastPoint(c1), 1), fertCenter(lastPoint(c2), 2)],
      sensors,
    });
  } catch (err) {
    logger.error("galcon dosing failed", err);
    return res.status(500).json({ok: false, error: err.message || "server error"});
  }
});

// Irrigation method ("שיטת השקיה") — the per-cycle water-dose percentages the
// user configures in Galcon ("שינוי מנת המים באחוזים לפי מספר מחזור").
// changeWaterByCycleItems is a flat list of {number, irrigationMethodNumber,
// changeWaterByCycle, waterMultiplyForCycle}: `number` is the group/row (1→A…),
// `irrigationMethodNumber` is the cycle (1-10), waterMultiplyForCycle is the %.
galconApp.get("/irrigation-method", async (req, res) => {
  try {
    const serial = String(req.query.serial || "").trim();
    if (!serial) return res.status(400).json({ok: false, error: "serial required"});
    const cfg = await getConfigIdForSerial(serial);
    const r = await appGet(`/config/${cfg}/program/irrigation-method`);
    const body = (r.json && r.json.body) || {};
    return res.json({
      ok: true,
      serial,
      configId: cfg,
      changeWaterByCycle: body.changeWaterByCycleItems || [],
    });
  } catch (err) {
    logger.error("galcon irrigation-method failed", err);
    return res.status(500).json({ok: false, error: err.message || "server error"});
  }
});

// Irrigation programs for a controller — exposes each program's base water dose
// (waterProgAmount). A valve event's percentage = its VolumeM3Valve / the base
// dose of its program (ProgNum) × 100, so the report can label each irrigation.
galconApp.get("/programs", async (req, res) => {
  try {
    const serial = String(req.query.serial || "").trim();
    if (!serial) return res.status(400).json({ok: false, error: "serial required"});
    const cfg = await getConfigIdForSerial(serial);
    const r = await appGet(`/config/${cfg}/program/irrigation-program-multi-programs`);
    const items = (r.json && r.json.body && r.json.body.items) || [];
    const programs = items.map((p) => ({
      number: p.number,
      name: (p.name || "").trim(),
      waterProgAmount: p.waterProgAmount,
      waterUnit: p.waterUnit,
      cyclePerDay: p.cyclePerDay,
      valveA: p.valveA,
      valves: [p.valveA, p.valveB, p.valveC, p.valveD, p.valveE].filter((x) => x != null),
    }));
    return res.json({ok: true, serial, configId: cfg, programs});
  } catch (err) {
    logger.error("galcon programs failed", err);
    return res.status(500).json({ok: false, error: err.message || "server error"});
  }
});

exports.galcon = onRequest({cors: true, timeoutSeconds: 60}, galconApp);