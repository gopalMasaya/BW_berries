import { db, ref, get } from "./auth.mjs";

// Known stations, available synchronously. loadStations() adds every station
// the ingest function has registered under /stations, so a newly connected
// station shows up without editing this list.
export const STATIONS = ["station1", "station2"];

// "station10" sorts after "station9", not after "station1".
export const compareStations = (a, b) => a.localeCompare(b, undefined, { numeric: true });

export async function loadStations() {
  try {
    const reg = (await get(ref(db, "stations"))).val() || {};
    for (const id of Object.keys(reg)) if (!STATIONS.includes(id)) STATIONS.push(id);
    STATIONS.sort(compareStations);
  } catch (e) {
    console.warn("station registry", e);
  }
  return STATIONS;
}
