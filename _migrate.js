// One-off migration: rekey bogus berries/station2/022106 records into the
// correct month node, deriving the key/time from each record's serverTimestamp
// (Israel local), since the device "time" field overflowed to year 2106.
const fs = require("fs");

const src = JSON.parse(fs.readFileSync("_migrate_src.json", "utf8"));

function israelParts(iso) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso)).reduce((a, x) => (a[x.type] = x.value, a), {});
  return p;
}

const byMonth = {};      // monthKey -> { tsKey: record }
const usedKeys = {};     // monthKey -> Set of tsKeys (collision guard)
let count = 0, skipped = 0;

for (const [origKey, rec] of Object.entries(src)) {
  if (!rec || typeof rec !== "object") continue;
  if (!rec.serverTimestamp) { console.warn("NO serverTimestamp, skipping:", origKey); skipped++; continue; }
  const p = israelParts(rec.serverTimestamp);
  const monthKey = `${p.month}${p.year}`;
  let tsKey = `${p.day}${p.month}${p.year}_${p.hour}${p.minute}${p.second}`;

  usedKeys[monthKey] = usedKeys[monthKey] || new Set();
  // de-collide if two records land on the same Israel-local second
  let suffix = 0, candidate = tsKey;
  while (usedKeys[monthKey].has(candidate)) { suffix++; candidate = `${tsKey}_${suffix}`; }
  tsKey = candidate;
  usedKeys[monthKey].add(tsKey);

  const out = { ...rec, time: `${p.day}${p.month}${p.year}_${p.hour}${p.minute}${p.second}` };
  byMonth[monthKey] = byMonth[monthKey] || {};
  byMonth[monthKey][tsKey] = out;
  count++;
}

fs.writeFileSync("_migrate_dst.json", JSON.stringify(byMonth, null, 0));
console.log("migrated records:", count, "skipped:", skipped);
console.log("target month nodes:", Object.keys(byMonth).map(m => `${m} (${Object.keys(byMonth[m]).length})`).join(", "));
