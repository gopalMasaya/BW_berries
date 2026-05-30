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

const galconApp = express();
galconApp.use(express.json());

// Firebase Auth middleware
galconApp.use(async (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ok: false, error: "missing auth token"});
  }
  try {
    const token = auth.split("Bearer ")[1];
    req.user = await admin.auth().verifyIdToken(token);
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

galconApp.get("/valves", async (req, res) => {
  try {
    const fromStr = req.query.from || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const toStr = req.query.to || new Date().toISOString().slice(0, 10);
    const filterSerial = req.query.controllerSerial ?
      String(req.query.controllerSerial).trim() : null;

    const fromDate = new Date(fromStr + "T00:00:00");
    const toDate = new Date(toStr + "T23:59:59");

    const data = await galileoGet(
        "/external-api/get-valve-finish-irrigation-info",
        fromDate, toDate,
    );

    const valves = [];
    const controllers = data && data.body && data.body.controllers || [];
    logger.info("valves filter", {
      filterSerial,
      controllerSerials: controllers.map((c) => String(c.serialNumber)),
    });
    for (const c of controllers) {
      const cSerial = c.serialNumber == null ? "" : String(c.serialNumber).trim();
      if (filterSerial && cSerial !== filterSerial) continue;
      for (const v of (c.valves || [])) {
        valves.push({
          SerialNumber: c.serialNumber,
          DateTimeStartValve: normalizeGalileoDate(v.dateTimeStartValve),
          DateTimeStopValve: normalizeGalileoDate(v.dateTimeStopValve),
          ValveNo: v.valveNo,
          ProgNum: v.progNum,
          DurationValve: v.durationValve,
          FlowRateM3h: v.flowRateM3h,
          VolumeM3Valve: v.volumeM3Valve,
          PhMin: v.phMin,
          PhMed: v.phMed,
          PhMax: v.phMax,
          EcMin: v.ecMin,
          EcMed: v.ecMed,
          EcMax: v.ecMax,
        });
      }
    }
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

exports.galcon = onRequest({cors: true, timeoutSeconds: 60}, galconApp);