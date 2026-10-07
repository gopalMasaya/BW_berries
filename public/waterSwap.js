// Drip/drain flowmeter assignment by date (settings page → "חיישני טפטפת ונקז").
//
// A station whose drip and drain flowmeters were plumbed the wrong way round
// reports the drip as waterOut and the drain as waterIn. The user records, per
// station, from which moment the meters are swapped (and, after a fix, from
// which moment they are straight again) at
//   berries/{stationId}/control/waterSwap/{pushId} =
//     { from: "YYYY-MM-DDTHH:MM" (Israel local), swapped: bool,
//       rawIn, rawOut }   // raw counters of the last reading before `from`
//
// waterIn/waterOut are cumulative counters, so simply exchanging the two fields
// would put a bogus jump at the switch. Instead each period continues the
// counters from where the previous period left them: inside a period
//   waterIn = counterAtStart + (sourceMeter − sourceMeterAtStart)
// which keeps every reset-aware delta in the app correct across the switch.
// A counter that drops below its anchor (device reset) falls back to the raw
// meter, which the delta code already treats as a reset.
//
// Nothing in the DB is rewritten; the swap is applied on every read.
// functions/waterSwap.js is a copy of this file for the cloud functions —
// keep the two identical.
(function (root) {
  const num = (v) => {
    const n = Number(v);
    return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n;
  };

  // "YYYY-MM-DDTHH:MM[:SS]" → "YYYYMMDDHHMMSS"
  function fromToSort(from) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(from || ""));
    if (!m) return null;
    return m[1] + m[2] + m[3] + (m[4] || "00") + (m[5] || "00") + (m[6] || "00");
  }

  // "DDMMYYYY_HHMMSS" → "YYYYMMDDHHMMSS"
  function keyToSort(key) {
    const k = String(key || "");
    if (!/^\d{8}_\d{6}/.test(k)) return null;
    return k.slice(4, 8) + k.slice(2, 4) + k.slice(0, 2) + k.slice(9, 15);
  }

  // Map raw counters through one period.
  function mapPeriod(p, rIn, rOut) {
    const srcIn = p.swapped ? rOut : rIn;
    const srcOut = p.swapped ? rIn : rOut;
    const baseIn = p.swapped ? p.aOut : p.aIn;
    const baseOut = p.swapped ? p.aIn : p.aOut;
    const one = (src, base, start) => {
      if (src === null) return null;
      if (base === null || start === null || src < base) return src;
      return start + (src - base);
    };
    return { in: one(srcIn, baseIn, p.vIn), out: one(srcOut, baseOut, p.vOut) };
  }

  // RTDB value of control/waterSwap → ordered periods with their start counters.
  function compile(entries) {
    const list = Object.values(entries || {})
      .map((e) => e && {
        sort: fromToSort(e.from),
        swapped: !!e.swapped,
        aIn: num(e.rawIn),
        aOut: num(e.rawOut),
      })
      .filter((p) => p && p.sort)
      .sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
    list.forEach((p, i) => {
      if (i === 0) { p.vIn = p.aIn; p.vOut = p.aOut; return; }
      if (p.aIn === null || p.aOut === null) { p.vIn = null; p.vOut = null; return; }
      const v = mapPeriod(list[i - 1], p.aIn, p.aOut);
      p.vIn = v.in; p.vOut = v.out;
    });
    return list;
  }

  // The period a reading falls in, or null (before the first entry = as stored).
  function periodAt(plan, tsKey) {
    if (!plan || !plan.length) return null;
    const s = keyToSort(tsKey);
    if (!s) return null;
    let hit = null;
    for (const p of plan) { if (p.sort <= s) hit = p; else break; }
    return hit;
  }

  // Returns the reading with waterIn = drip and waterOut = drain. `item` must
  // already carry the canonical waterIn/waterOut names.
  function apply(plan, item, tsKey) {
    if (!item || typeof item !== "object") return item;
    const p = periodAt(plan, tsKey || item.time);
    if (!p) return item;
    const rIn = num(item.waterIn), rOut = num(item.waterOut);
    if (rIn === null && rOut === null) return item;
    const v = mapPeriod(p, rIn, rOut);
    const out = { ...item };
    if (v.in !== null) out.waterIn = v.in; else delete out.waterIn;
    if (v.out !== null) out.waterOut = v.out; else delete out.waterOut;
    return out;
  }

  // Is the station's meter pair swapped at this reading time?
  function swappedAt(plan, tsKey) {
    const p = periodAt(plan, tsKey);
    return !!(p && p.swapped);
  }

  const api = { compile, apply, swappedAt, fromToSort, keyToSort };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WaterSwap = api;
})(typeof self !== "undefined" ? self : this);
