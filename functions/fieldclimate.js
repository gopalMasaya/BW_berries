/**
 * FieldClimate (METOS) API v2 client, plus the VPD decision.
 *
 * WHY THIS LIVES HERE AND NOT ON THE STATION
 * ------------------------------------------
 * The Mega/MKR pair cannot reach api.fieldclimate.com: the MKR's trust list
 * holds only GTS Root R1 (FieldClimate chains to ISRG Root X1), its HTTP layer
 * cannot attach the Authorization/Request-Date headers HMAC needs, there is no
 * SHA-256 on either board, and the link caps a response body at 300 bytes.
 * So the station keeps asking us the one question it cares about -- "should the
 * valve be allowed to open?" -- and we do the talking to FieldClimate.
 *
 * RATE LIMITS ARE REAL
 * --------------------
 * Tier 1 is 48 requests per station per day, i.e. one every 30 minutes. The
 * station wakes far more often than that during a watering cycle, so every
 * reading is cached in RTDB and re-served until MIN_INTERVAL_SEC has passed.
 * Never call fetchVpd() straight from a request handler; go through readVpd().
 */

const https = require("https");
const crypto = require("crypto");
const logger = require("firebase-functions/logger");

const HOST = "api.fieldclimate.com";
const BASE = "/v2";

// One reading per 30 min keeps us inside tier 1 (48/day) with headroom.
const MIN_INTERVAL_SEC = Number(process.env.FC_MIN_INTERVAL_SEC || 1800);

// Past this age a cached reading is not a fact about the weather any more.
const MAX_STALE_SEC = Number(process.env.FC_MAX_STALE_SEC || 3 * 3600);

// ---------------------------------------------------------------- HMAC ------

// The signature covers method + path + date + publicKey, SHA-256 keyed with the
// private key. The same date string must ride along in Request-Date, or the
// server recomputes over different bytes and answers 401.
function signedHeaders(method, signPath, date, pub, priv) {
  const content = method + signPath + date + pub;
  const sig = crypto.createHmac("sha256", priv).update(content).digest("hex");
  return {
    "Accept": "application/json",
    "Request-Date": date,
    "Authorization": "hmac " + pub + ":" + sig,
  };
}

function rawGet(urlPath, signPath, pub, priv) {
  const date = new Date().toUTCString();
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: HOST,
      path: urlPath,
      method: "GET",
      headers: signedHeaders("GET", signPath, date, pub, priv),
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({status: res.statusCode, body}));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("fieldclimate timeout")));
    req.end();
  });
}

// Whether the signed path carries the "/v2" prefix is not stated in the docs.
// We probe once per container and remember; FC_SIGN_STYLE pins it if you
// already know the answer from tools/fc-discover.js.
let signStyle = process.env.FC_SIGN_STYLE || null;

async function apiGet(route) {
  const pub = process.env.FC_PUBLIC_KEY || "";
  const priv = process.env.FC_PRIVATE_KEY || "";
  if (!pub || !priv) throw new Error("FC_PUBLIC_KEY / FC_PRIVATE_KEY not set");

  const urlPath = BASE + route;
  const styles = signStyle ? [signStyle] : ["bare", "prefixed"];

  let last = null;
  for (const style of styles) {
    const signPath = style === "bare" ? route : urlPath;
    const res = await rawGet(urlPath, signPath, pub, priv);
    last = res;
    if (res.status === 200) {
      if (!signStyle) {
        signStyle = style;
        logger.info("fieldclimate HMAC style", {style, signPath});
      }
      return JSON.parse(res.body);
    }
    if (res.status !== 401 && res.status !== 403) break;
  }
  throw new Error("GET " + route + " -> " + last.status + ": " +
                  last.body.slice(0, 200));
}

// ----------------------------------------------------------------- VPD ------

// Saturation vapour pressure (Tetens), then the deficit. Both kPa.
function computeVpd(tempC, rhPct) {
  const svp = 0.6108 * Math.exp((17.27 * tempC) / (tempC + 237.3));
  return svp * (1 - rhPct / 100);
}

// VPD does not appear anywhere in the published v2 OpenAPI schema, but station
// 03111DA4 reports it on a calculated channel (ch 501, code 25, kPa) all the
// same. So the schema is not a reliable guide to what a given station exposes:
// fetchVpd() reads the channel when it is there and derives VPD from air
// temperature and relative humidity when it is not.
//
// Channels are pinned by env (FC_VPD_CODE/CH, FC_TEMP_CODE/CH, FC_RH_CODE/CH)
// when known. When
// they are not, fall back to matching on unit plus name, which is what
// tools/fc-discover.js reports so you can pin them properly.
function pickChannel(sensors, wantUnit, hints, code, ch) {
  for (const s of sensors) {
    if (code && String(s.code) === String(code) &&
        (!ch || String(s.ch) === String(ch))) return s;
  }
  if (code) return null;   // pinned but absent: do not silently use something else
  for (const s of sensors) {
    const unit = String(s.unit || "").replace("°", "");
    if (unit === wantUnit && hints.test(String(s.name || ""))) return s;
  }
  return null;
}

function lastAvg(sensor) {
  const vals = (sensor.values || {}).avg;
  if (!Array.isArray(vals)) return typeof vals === "number" ? vals : null;
  for (let i = vals.length - 1; i >= 0; i--) {
    if (typeof vals[i] === "number") return vals[i];
  }
  return null;
}

async function fetchVpd(fcStationId) {
  const data = await apiGet("/data/" + fcStationId + "/hourly/last/2");
  const sensors = Array.isArray(data.data) ? data.data : [];
  const dates = Array.isArray(data.dates) ? data.dates : [];
  const stationTime = dates.length ? dates[dates.length - 1] : null;

  // Air temperature and RH are read either way: they are what makes a VPD
  // number reviewable in the dashboard, and they are the fallback source.
  const tempSensor = pickChannel(sensors, "C", /air.*temp|temp.*air|^temperature$/i,
      process.env.FC_TEMP_CODE, process.env.FC_TEMP_CH);
  const rhSensor = pickChannel(sensors, "%", /humidit|relative|\brh\b/i,
      process.env.FC_RH_CODE, process.env.FC_RH_CH);
  const tempC = tempSensor ? lastAvg(tempSensor) : null;
  const rh = rhSensor ? lastAvg(rhSensor) : null;

  // The station computes VPD itself on a dedicated channel (kPa). It is absent
  // from the published v2 schema but present on this hardware, and it is the
  // number the FieldClimate dashboard shows -- so prefer it, and only fall back
  // to deriving from temp/RH when the channel is missing or empty. The two
  // agreed to 0.003 kPa when checked on 2026-09-08, so a fallback is not a
  // change of units or of definition, just a change of source.
  const vpdSensor = pickChannel(sensors, "kPa", /^vpd$/i,
      process.env.FC_VPD_CODE, process.env.FC_VPD_CH);
  const stationVpd = vpdSensor ? lastAvg(vpdSensor) : null;

  if (stationVpd !== null) {
    return {vpd: Number(stationVpd.toFixed(3)), tempC, rh, source: "station", stationTime};
  }

  if (tempC === null || rh === null) {
    throw new Error("no VPD channel on " + fcStationId + " and no temp/RH to " +
                    "derive it from (run tools/fc-discover.js and pin " +
                    "FC_VPD_* or FC_TEMP_* / FC_RH_*)");
  }

  return {
    vpd: Number(computeVpd(tempC, rh).toFixed(3)),
    tempC,
    rh,
    source: "derived",
    stationTime,
  };
}

/**
 * Cached read. Returns {vpd, tempC, rh, fetchedAt, stationTime, stale, ok}.
 * Never throws: a FieldClimate outage must not take the watering endpoint down
 * with it, so failures degrade to the cached value, then to ok:false.
 */
async function readVpd(db, stationId, fcStationId) {
  const cacheRef = db.ref("/berries/" + stationId + "/fieldclimate/last");
  const nowSec = Math.floor(Date.now() / 1000);

  let cached = null;
  try {
    cached = (await cacheRef.get()).val();
  } catch (err) {
    logger.warn("vpd cache read failed", {stationId, err: err.message});
  }

  const age = cached && cached.fetchedAt ? nowSec - cached.fetchedAt : Infinity;
  if (cached && age < MIN_INTERVAL_SEC) {
    return Object.assign({}, cached, {ok: true, stale: false, ageSec: age});
  }

  try {
    const fresh = await fetchVpd(fcStationId);
    fresh.fetchedAt = nowSec;
    await cacheRef.set(fresh);
    return Object.assign({}, fresh, {ok: true, stale: false, ageSec: 0});
  } catch (err) {
    logger.error("fieldclimate fetch failed", {stationId, fcStationId, err: err.message});
    if (cached && age < MAX_STALE_SEC) {
      return Object.assign({}, cached, {ok: true, stale: true, ageSec: age});
    }
    return {ok: false, stale: true, ageSec: age, error: err.message};
  }
}

/**
 * Turn a VPD reading into a relay decision, with hysteresis.
 *
 * Above onKpa the relay latches on; it only releases once VPD falls back below
 * offKpa. Without that band a VPD hovering on the threshold would open and shut
 * a solenoid every wake-up. The latch lives in RTDB because the station sleeps
 * between calls and cannot remember anything itself.
 */
async function decideVpd(db, stationId, reading, cfg) {
  // Defaults sized from a week of station 03111DA4 (2026-09-01..08): VPD falls
  // to ~0 overnight and peaks at 2.0-3.6 kPa midday. 2.0 kPa is true for about
  // 4.5 h/day -- the hot part of the afternoon -- and 1.5 kPa releases it. A
  // textbook 1.5/1.2 would have been true a third of every day, including
  // mornings, which is not a "the air is dry" signal at this site.
  const onKpa = Number(cfg.vpdOnKpa ?? 2.0);
  const offKpa = Number(cfg.vpdOffKpa ?? 1.5);

  if (!reading.ok || typeof reading.vpd !== "number") return {high: false, fire: false};

  const stateRef = db.ref("/berries/" + stationId + "/control/vpdState");
  let prev = {};
  try {
    prev = (await stateRef.get()).val() || {};
  } catch (err) {
    logger.warn("vpd state read failed", {stationId, err: err.message});
  }

  const wasHigh = !!prev.on;
  let high = wasHigh;
  if (reading.vpd >= onKpa) high = true;
  else if (reading.vpd <= offKpa) high = false;
  // Between offKpa and onKpa the previous state stands -- that is the hysteresis.

  // "high" is a level and answers gate mode's question: is the air dry right
  // now? "fire" is an event and answers trigger mode's: should a watering start
  // right now? They must be separate. If trigger mode read the level it would
  // restart a watering on every single wake-up for as long as VPD stayed up --
  // which at this site is several hours a day.
  const now = Date.now();
  const repeatMs = Math.max(0, Number(cfg.vpdRepeatMin ?? 180)) * 60000;
  const sinceTrigger = prev.lastTriggerAt ? now - prev.lastTriggerAt : Infinity;
  const fire = high && sinceTrigger >= repeatMs;

  const next = {
    on: high,
    vpd: reading.vpd,
    changedAt: high === wasHigh ? (prev.changedAt || now) : now,
  };
  // Dropping below the release threshold clears the timer, so the next time VPD
  // climbs back through the ON threshold it fires immediately rather than
  // waiting out a gap that started during the previous hot spell.
  if (high) next.lastTriggerAt = fire ? now : (prev.lastTriggerAt || null);

  // Only the station's own /watering call reaches this function, so recording
  // the trigger here means "the device has been told to water" -- the dashboard
  // reading VPD cannot consume a trigger.
  if (next.on !== prev.on || next.lastTriggerAt !== prev.lastTriggerAt ||
      next.vpd !== prev.vpd) {
    try {
      await stateRef.set(next);
    } catch (err) {
      logger.warn("vpd state write failed", {stationId, err: err.message});
    }
  }

  return {high, fire};
}

module.exports = {computeVpd, fetchVpd, readVpd, decideVpd, apiGet};
