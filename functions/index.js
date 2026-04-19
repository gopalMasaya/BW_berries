const {onRequest} = require("firebase-functions/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const express = require("express");
const sql = require("mssql");

admin.initializeApp();

const app = express();
app.use(express.json());

const DEVICE_SECRETS = {
  station1: "s0001mh0001",
  station2: "PUT_OTHER_SECRET_HERE",
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

function buildKeysFromDate(now) {
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = String(now.getFullYear());
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");

  return {
    monthKey: `${mm}${yyyy}`,
    tsKey: `${dd}${mm}${yyyy}_${hh}${mi}${ss}`,
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
    const {monthKey, tsKey} = buildKeysFromDate(now);

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

// ===================== GALCON MSSQL PROXY =====================

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

let galconPool = null;

async function getGalconPool() {
  if (galconPool && galconPool.connected) return galconPool;
  galconPool = await sql.connect(GALCON_SQL_CONFIG);
  return galconPool;
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

    const [controllers, groups, valveStats] = await Promise.all([
      pool.request().query("SELECT ID, SerialNumber, CreatedDate FROM dbo.Controllers ORDER BY ID"),
      pool.request().query(`
        SELECT DISTINCT Sensor_Group_Name as name
        FROM dbo.PCS_ID
        WHERE Sensor_Group_Name != ''
        ORDER BY Sensor_Group_Name
      `),
      pool.request().query(`
        SELECT ControllerID,
               COUNT(*) as totalEvents,
               MAX(DateTimeStopValve) as lastEvent
        FROM dbo.ValveData
        GROUP BY ControllerID
      `),
    ]);

    return res.json({
      ok: true,
      controllers: controllers.recordset,
      sensorGroups: groups.recordset.map((r) => r.name),
      valveStats: valveStats.recordset,
    });
  } catch (err) {
    logger.error("galcon overview failed", err);
    return res.status(500).json({ok: false, error: "server error"});
  }
});

galconApp.get("/valves", async (req, res) => {
  try {
    const pool = await getGalconPool();
    const from = req.query.from || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const to = req.query.to || new Date().toISOString().slice(0, 10);
    const controllerId = req.query.controllerId ? parseInt(req.query.controllerId) : null;

    const request = pool.request();
    request.input("from", sql.DateTime, new Date(from));
    request.input("to", sql.DateTime, new Date(to + "T23:59:59"));

    let where = "v.DateTimeStartValve >= @from AND v.DateTimeStartValve <= @to";
    if (controllerId) {
      request.input("cid", sql.Int, controllerId);
      where += " AND v.ControllerID = @cid";
    }

    const result = await request.query(`
      SELECT v.ID, c.SerialNumber, v.ControllerID, v.ValveNo, v.ProgNum,
             v.DateTimeStartValve, v.DateTimeStopValve, v.DurationValve,
             v.FlowRateM3h, v.VolumeM3Valve,
             v.PhMin, v.PhMed, v.PhMax,
             v.EcMin, v.EcMed, v.EcMax
      FROM dbo.ValveData v
      JOIN dbo.Controllers c ON v.ControllerID = c.ID
      WHERE ${where}
      ORDER BY v.DateTimeStartValve DESC
    `);

    return res.json({ok: true, valves: result.recordset});
  } catch (err) {
    logger.error("galcon valves failed", err);
    return res.status(500).json({ok: false, error: "server error"});
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

// Each flow-sensor pulse corresponds to 15 ml of water.
const ML_PER_PULSE = 15;

galconApp.get("/irrigations", async (req, res) => {
  try {
    const pool = await getGalconPool();
    const group = req.query.group || "";
    const from = req.query.from || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const to = req.query.to || new Date().toISOString().slice(0, 10);
    // Gap between irrigation pulses that marks the end of an event. Also the
    // drainage tail: drain pulses within this window after the last irrigation
    // pulse are attributed to that event. The controller naturally shuts off
    // ~25–30 min after irrigation ends, so 30 covers both roles.
    const tailMin = Math.max(1, parseInt(req.query.tailMin, 10) || 30);
    const minDurationMin = Math.max(0, parseFloat(req.query.minDurationMin) || 5);

    if (!group) {
      return res.status(400).json({ok: false, error: "group parameter required"});
    }

    const request = pool.request();
    request.input("group", sql.NVarChar, group);
    request.input("from", sql.DateTime, new Date(from));
    request.input("to", sql.DateTime, new Date(to + "T23:59:59"));

    const irrigResult = await request.query(`
      SELECT v.Time, v.Value
      FROM dbo.PCS_Value v
      JOIN dbo.PCS_ID p ON v.PcsId = p.PcsId
      WHERE p.Sensor_Group_Name = @group
        AND p.Sensor_Label = 'Irrigation'
        AND v.Time >= @from AND v.Time <= @to
        AND v.Value > 0
      ORDER BY v.Time
    `);

    // Drain pulses live in PCS_Value under Sensor_Label='Drain'.
    // PCS_Value_Drain_Percent stores a derived drain percentage, not raw pulses.
    const drainResult = await request.query(`
      SELECT v.Time, v.Value
      FROM dbo.PCS_Value v
      JOIN dbo.PCS_ID p ON v.PcsId = p.PcsId
      WHERE p.Sensor_Group_Name = @group
        AND p.Sensor_Label = 'Drain'
        AND v.Time >= @from AND v.Time <= @to
        AND v.Value > 0
      ORDER BY v.Time
    `);

    const gapMs = tailMin * 60 * 1000;

    const events = [];
    let current = null;
    for (const row of irrigResult.recordset) {
      const t = new Date(row.Time);
      const pulses = Number(row.Value) || 0;
      if (!current || (t.getTime() - current.endTime.getTime()) > gapMs) {
        if (current) events.push(current);
        current = {startTime: t, endTime: t, pulsesIn: pulses};
      } else {
        current.endTime = t;
        current.pulsesIn += pulses;
      }
    }
    if (current) events.push(current);

    // Walk drain readings once; for each event sum pulses in [startTime, endTime + tailMin].
    const drainReadings = drainResult.recordset.map((r) => ({
      time: new Date(r.Time),
      pulses: Number(r.Value) || 0,
    }));

    const eventsOut = events.map((e) => {
      const windowEnd = new Date(e.endTime.getTime() + gapMs);
      let pulsesOut = 0;
      let firstDrain = null;
      let lastDrain = null;
      for (const d of drainReadings) {
        if (d.time >= e.startTime && d.time <= windowEnd) {
          pulsesOut += d.pulses;
          if (!firstDrain) firstDrain = d.time;
          lastDrain = d.time;
        }
      }
      const waterInMl = e.pulsesIn * ML_PER_PULSE;
      const waterOutMl = pulsesOut * ML_PER_PULSE;
      const durationMin = (e.endTime.getTime() - e.startTime.getTime()) / 60000;
      return {
        startTime: e.startTime,
        endTime: e.endTime,
        firstDrainTime: firstDrain,
        lastDrainTime: lastDrain,
        durationMin,
        pulsesIn: e.pulsesIn,
        pulsesOut,
        waterInL: waterInMl / 1000,
        waterOutL: waterOutMl / 1000,
        drainPct: waterInMl > 0 ? (waterOutMl / waterInMl) * 100 : null,
      };
    }).filter((e) => e.durationMin >= minDurationMin).reverse();

    return res.json({
      ok: true,
      mlPerPulse: ML_PER_PULSE,
      tailMin,
      minDurationMin,
      events: eventsOut,
    });
  } catch (err) {
    logger.error("galcon irrigations failed", err);
    return res.status(500).json({ok: false, error: "server error"});
  }
});

exports.galcon = onRequest({cors: true, timeoutSeconds: 60}, galconApp);