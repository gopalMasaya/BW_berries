// Where each station stands in the field: which qrCode measurement plot /
// Galcon valve ("B07" = controller B, valve 7), from which day, and which
// station probe measures which line there.
//
// Set in Settings → "📍 מיקום התחנה", stored per station at
//   berries/{stationId}/control/location/{pushId} =
//     { from: "YYYY-MM-DD", code: "B07",
//       map: { ec: "drainEc", ph1: "drainPh", ... } }   // field → line
// The lines are dripEc / drainEc / dripPh / drainPh. A station that moves gets
// a new row from the day it moved, so history keeps its own plot.
//
// DEFAULTS are the locations that were hard-coded before the setting existed;
// they still apply to the days before a station's first Settings row.
// Mirrors PLOTS_BY_STATION in functions/calibration.js (daily calibration).
(function (root) {
  // Pots per plot + main variety, from qrCode's stations-catalog.mjs
  // (PLANTS_BY_CODE / STATIONS). Pots turn a Galcon valve volume (m³) into ml/pot.
  const INFO = {
    A01: { pots: 7750, variety: "1908" },
    A02: { pots: 9200, variety: "Colibri" },
    A03: { pots: 6240, variety: "Titan" },
    A04: { pots: 6240, variety: "Och" },
    A05: { pots: 8320, variety: "Titan" },
    A06: { pots: 6240, variety: "Haven S" },
    A07: { pots: 8640, variety: "Haven C" },
    A08: { pots: 8640, variety: "Biloxi" },
    A09: { pots: 6380, variety: "Titan" },
    A10: { pots: 9000, variety: "Haven S" },
    A11: { pots: 6750, variety: "1907" },
    A12: { pots: 9000, variety: "1901" },
    A13: { pots: 6750, variety: "Biloxi" },
    B01: { pots: 3080, variety: "Zawadi" },
    B02: { pots: 2900, variety: "119" },
    B03: { pots: 4800, variety: "Sarfina" },
    B04: { pots: 4800, variety: "Sarfina" },
    B05: { pots: 4800, variety: "Sarfina" },
    B06: { pots: 4800, variety: "Sarfina" },
    B07: { pots: 1000, variety: "Amanda" },
    B08: { pots: 1000, variety: "Amanda" },
    B09: { pots: 1000, variety: "Amanda" },
    B10: { pots: 1000, variety: "dana" },
    B11: { pots: 1550, variety: "MariCarmen" },
    B12: { pots: 1460, variety: "MariCarmen" },
    B13: { pots: 3600, variety: "Zawadi" },
    B14: { pots: 3600, variety: "Zawadi" },
    B15: { pots: 3600, variety: "Kwanza" },
    B16: { pots: 3600, variety: "Kwanza" },
    B17: { pots: 3600, variety: "Adilita" },
    B18: { pots: 3600, variety: "Zawadi" },
    B19: { pots: 7800, variety: "Shani" },
    B20: { pots: 7800, variety: "Shani" },
    B21: { pots: 7800, variety: "119" },
    B22: { pots: 7800, variety: "Sarfina" },
    B23: { pots: 7800, variety: "Adilita" },
    B24: { pots: 7800, variety: "Mothers" },
    C01: { pots: 2460, variety: "Amanda" },
    C02: { pots: 2460, variety: "dana" },
    C03: { pots: 3735, variety: "esyroc" },
    C04: { pots: 3735, variety: "Clarita" },
    C05: { pots: 3735, variety: "Clarita" },
    C06: { pots: 3735, variety: "119" },
    C40: { pots: 3600, variety: "Adilita" },
    C41: { pots: 1350, variety: "Zawadi" },
    C42: { pots: null, variety: "Zawadi" },
    D01: { pots: 4125, variety: "1908" },
    D02: { pots: 3300, variety: "1908" },
    D03: { pots: 4125, variety: "1908" },
    D04: { pots: 3300, variety: "1908" },
    D05: { pots: 4300, variety: "1908" },
    D06: { pots: 6020, variety: "1908" },
    D07: { pots: 4300, variety: "1908" },
    D08: { pots: 2720, variety: "1908" },
    D09: { pots: null, variety: "1907" },
    D10: { pots: null, variety: "1907" },
    D11: { pots: null, variety: "1908" },
    D12: { pots: null, variety: "1908" },
    D20: { pots: 7800, variety: "1908" },
    D21: { pots: 7800, variety: "1908" },
    D22: { pots: 7800, variety: "1908" },
    D23: { pots: 7032, variety: "1908" },
  };

  const LINES = ["dripEc", "drainEc", "dripPh", "drainPh"];
  // Station fields a probe can sit on.
  const FIELDS = ["ec", "ec2", "ph1", "ph2"];

  const DEFAULTS = {
    station1: [
      { from: "2026-09-25", code: "B01", map: { ec: "drainEc", ph1: "drainPh" } },
      { from: "", code: "B09", map: { ec: "dripEc", ph1: "dripPh" } },
    ],
    station2: [{ from: "", code: "B07", map: { ec2: "dripEc", ec: "drainEc", ph1: "dripPh", ph2: "drainPh" } }],
    // station3 shares B07 with station2; its one EC + one pH probe are on the dripper.
    station3: [{ from: "", code: "B07", map: { ec: "dripEc", ph1: "dripPh" } }],
  };

  const validCode = (c) => /^[A-D]\d{2}$/.test(String(c || ""));
  const validFrom = (f) => f === "" || /^\d{4}-\d{2}-\d{2}$/.test(String(f || ""));
  function cleanMap(m) {
    const out = {};
    for (const f of FIELDS) if (m && LINES.includes(m[f])) out[f] = m[f];
    return out;
  }

  // Station's locations, newest first: the Settings rows, then the defaults
  // that are older than the first Settings row. [] = location unknown.
  function merge(stationId, entries) {
    const cfg = Object.values(entries || {})
      .filter((e) => e && validCode(e.code) && validFrom(e.from || ""))
      .map((e) => ({ from: e.from || "", code: e.code, map: cleanMap(e.map) }))
      .sort((a, b) => (a.from < b.from ? 1 : a.from > b.from ? -1 : 0));
    const first = cfg.length ? cfg[cfg.length - 1].from : null;
    const defs = (DEFAULTS[stationId] || [])
      .filter((p) => first === null || (first !== "" && p.from < first))
      .map((p) => ({ ...p, map: { ...p.map } }));
    return cfg.concat(defs);
  }

  // The location in force on a day ("YYYY-MM-DD"; default today).
  function at(list, day) {
    if (!list || !list.length) return null;
    const d = day || new Date().toLocaleDateString("en-CA");
    return list.find((p) => d >= p.from) || list[list.length - 1];
  }

  const api = { INFO, LINES, FIELDS, DEFAULTS, merge, at, validCode };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Plots = api;
})(typeof self !== "undefined" ? self : this);
