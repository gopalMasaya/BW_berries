/**
 * One-off FieldClimate discovery tool. Run it once, paste me the output.
 *
 *   cd "C:\Users\Admin\Documents\js coding\plantsTracker\functions"
 *   node tools/fc-discover.js
 *
 * Reads FC_PUBLIC_KEY / FC_PRIVATE_KEY from the environment or from
 * functions/.env (which is already gitignored). It only ever does GETs.
 *
 * It answers the three things the cloud function needs to know:
 *   1. your 8-character FieldClimate station id(s)
 *   2. which sensor channels carry air temperature and relative humidity
 *   3. what a real "last data" response looks like, and the VPD it implies
 *
 * It also settles one ambiguity the docs leave open: whether the signed path
 * includes the "/v2" prefix. It tries without first and falls back to with,
 * then reports which form the server accepted.
 */

const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ---- credentials -----------------------------------------------------------

function loadEnvFile() {
  const p = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnvFile();

const PUBLIC_KEY = process.env.FC_PUBLIC_KEY || "";
const PRIVATE_KEY = process.env.FC_PRIVATE_KEY || "";

if (!PUBLIC_KEY || !PRIVATE_KEY) {
  console.error("Missing FC_PUBLIC_KEY / FC_PRIVATE_KEY.");
  console.error("Put them in functions/.env (see functions/.env.example),");
  console.error("or set them in the shell for one run.");
  process.exit(1);
}

const HOST = "api.fieldclimate.com";
const BASE = "/v2";

// ---- HMAC ------------------------------------------------------------------

// The signature covers method + path + date + publicKey, hashed with SHA-256
// keyed by the private key. That same date string must also travel in the
// Request-Date header, or the server recomputes a different signature.
function signedHeaders(method, signPath, date) {
  const content = method + signPath + date + PUBLIC_KEY;
  const sig = crypto.createHmac("sha256", PRIVATE_KEY).update(content).digest("hex");
  return {
    "Accept": "application/json",
    "Request-Date": date,
    "Authorization": "hmac " + PUBLIC_KEY + ":" + sig,
  };
}

function rawGet(urlPath, signPath) {
  const date = new Date().toUTCString();
  const opts = {
    host: HOST,
    path: urlPath,
    method: "GET",
    headers: signedHeaders("GET", signPath, date),
  };
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({status: res.statusCode, body}));
    });
    req.on("error", reject);
    req.setTimeout(20000, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

// Remembered once the first call works, so we stop probing.
// "bare" signs "/user/stations"; "prefixed" signs "/v2/user/stations".
let signStyle = null;

async function apiGet(route) {
  const urlPath = BASE + route;
  const styles = signStyle ? [signStyle] : ["bare", "prefixed"];

  let last = null;
  for (const style of styles) {
    const signPath = style === "bare" ? route : urlPath;
    const res = await rawGet(urlPath, signPath);
    last = res;
    if (res.status === 200) {
      if (!signStyle) {
        signStyle = style;
        console.log("[auth] HMAC accepted with the " + style +
                    " path form (signed \"" + signPath + "\")\n");
      }
      return JSON.parse(res.body);
    }
    if (res.status !== 401 && res.status !== 403) break;
  }
  throw new Error("GET " + route + " -> " + last.status + ": " +
                  last.body.slice(0, 300));
}

// ---- VPD -------------------------------------------------------------------

// Saturation vapour pressure (Tetens), then the deficit. Both in kPa.
function vpdFrom(tempC, rhPct) {
  const svp = 0.6108 * Math.exp((17.27 * tempC) / (tempC + 237.3));
  return svp * (1 - rhPct / 100);
}

// ---- channel guessing ------------------------------------------------------

const TEMP_HINTS = /air.*temp|temp.*air|hc.*air|^temperature$/i;
const RH_HINTS = /humidit|relative|\brh\b/i;

function guessRole(name, unit) {
  const u = String(unit || "").replace("\u00b0", "");
  const n = String(name || "");
  // Some stations publish a calculated VPD channel even though the v2 schema
  // never mentions one. When it is there it beats anything we could derive.
  if (u === "kPa" && /^vpd$/i.test(n.trim())) return "VPD";
  if (u === "%" && RH_HINTS.test(n)) return "RH";
  if (u === "C" && TEMP_HINTS.test(n)) return "TEMP";
  if (u === "%") return "rh?";
  if (u === "C") return "temp?";
  return "";
}

// ---- main ------------------------------------------------------------------

(async () => {
  console.log("=== 1. Stations on this account ===\n");
  const stations = await apiGet("/user/stations");

  if (!Array.isArray(stations) || stations.length === 0) {
    console.log("No stations returned. Check that the API subscription is active.");
    return;
  }

  for (const s of stations) {
    const id = (s.name && s.name.original) || s.station_id || "(unknown)";
    console.log("  STATION ID : " + id);
    console.log("  custom name: " + ((s.name && s.name.custom) || "(none)"));
    console.log("  last comm  : " + ((s.dates && s.dates.last_communication) || "(none)"));
    console.log("");
  }

  const first = stations[0];
  const target = process.env.FC_STATION_ID ||
                 (first.name && first.name.original) ||
                 first.station_id;
  console.log("--- using station " + target + " for the rest of this report ---\n");

  console.log("=== 2. Sensors on that station ===\n");
  const sensors = await apiGet("/station/" + target + "/sensors");
  const rows = [];
  for (const s of Array.isArray(sensors) ? sensors : []) {
    rows.push({
      role: guessRole(s.name, s.unit),
      name: s.name,
      unit: s.unit,
      ch: s.ch,
      code: s.code,
    });
  }
  rows.sort((a, b) => (b.role ? 1 : 0) - (a.role ? 1 : 0));
  for (const r of rows) {
    const tag = r.role ? ("[" + r.role + "]").padEnd(8) : "        ";
    console.log("  " + tag +
                "ch=" + String(r.ch).padEnd(4) +
                "code=" + String(r.code).padEnd(6) +
                "unit=" + String(r.unit).padEnd(6) + r.name);
  }
  console.log("");

  console.log("=== 3. Last hourly data ===\n");
  const data = await apiGet("/data/" + target + "/hourly/last/2");

  console.log("  timestamps: " + JSON.stringify(data.dates || []));
  console.log("");

  let temp = null;
  let rh = null;
  let stationVpd = null;

  for (const sensor of data.data || []) {
    const label = sensor.name + " (ch " + sensor.ch + ", code " + sensor.code +
                  ", " + sensor.unit + ")";
    for (const agg of Object.keys(sensor.values || {})) {
      const vals = sensor.values[agg];
      const lastVal = Array.isArray(vals) ? vals[vals.length - 1] : vals;
      console.log("  " + label + " " + agg + " = " + lastVal);
      if (agg !== "avg") continue;
      const role = guessRole(sensor.name, sensor.unit);
      if (temp === null && role === "TEMP") {
        temp = {value: lastVal, ch: sensor.ch, code: sensor.code, name: sensor.name};
      }
      if (rh === null && role === "RH") {
        rh = {value: lastVal, ch: sensor.ch, code: sensor.code, name: sensor.name};
      }
      if (stationVpd === null && role === "VPD") {
        stationVpd = {value: lastVal, ch: sensor.ch, code: sensor.code, name: sensor.name};
      }
    }
  }

  console.log("\n=== 4. VPD ===\n");
  if (temp && rh && temp.value != null && rh.value != null) {
    const v = vpdFrom(temp.value, rh.value);
    console.log("  temp = " + temp.value + " C   from \"" + temp.name +
                "\" (ch " + temp.ch + ", code " + temp.code + ")");
    console.log("  RH   = " + rh.value + " %    from \"" + rh.name +
                "\" (ch " + rh.ch + ", code " + rh.code + ")");
    console.log("  VPD  = " + v.toFixed(3) + " kPa  (derived from the two above)");
    if (stationVpd && stationVpd.value != null) {
      console.log("  VPD  = " + stationVpd.value +
                  " kPa  (reported by the station, ch " + stationVpd.ch +
                  ", code " + stationVpd.code + ") <- this one is used");
    }
    console.log("");
    console.log("  Put these in functions/.env so the function stops guessing:");
    console.log("    FC_STATION_ID=" + target);
    if (stationVpd) {
      console.log("    FC_VPD_CODE=" + stationVpd.code);
      console.log("    FC_VPD_CH=" + stationVpd.ch);
    }
    console.log("    FC_TEMP_CODE=" + temp.code);
    console.log("    FC_TEMP_CH=" + temp.ch);
    console.log("    FC_RH_CODE=" + rh.code);
    console.log("    FC_RH_CH=" + rh.ch);
  } else {
    console.log("  Could not identify an air-temperature and a humidity channel");
    console.log("  automatically. Send me the section 2 and 3 output above and");
    console.log("  I will pin the right channels by hand.");
  }
})().catch((e) => {
  console.error("\nFAILED: " + e.message);
  if (/401|403/.test(e.message)) {
    console.error("\n401/403 means the keys or the signature were rejected:");
    console.error("  - is the API subscription active on fieldclimate.com?");
    console.error("  - are these the HMAC keys, not the OAuth client id/secret?");
    console.error("  - is this machine's clock correct? the Request-Date is signed.");
  }
  process.exit(1);
});
