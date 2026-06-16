# Galcon real-time worker

Holds one persistent **Socket.IO v2** connection **per controller** (A–D) to
Galcon's online server and writes each controller's live **fertigation centers**
(EC/pH) and **tank sensors** (level / pH) into Firebase RTDB. The dashboard reads
these values live, so it no longer needs the per-request Galcon login.

Each controller is a separate socket registration (`GALILEO_<commUnitID>`), so a
dedicated socket per controller keeps their event streams cleanly separated.

## Why a worker (and not a Cloud Function)
The values are pushed over a socket, not exposed via REST. A Cloud Function is
stateless and can't hold a socket, so this runs as a small always-on process
(same idea as the git auto-sync task). The socket needs **no auth** — only the
optional snapshot triggers do, via a Galcon login.

## How it works
```
for each controller with a known commUnitID:
  connect galileo_onlineserver.galcon-smart.com:3008
   → on 'server_ready'  emit('register', ['GALILEO_<commUnitID>'])
   → receive 'events'   EC=3 → fert centers (ECActual/PHActual ÷100)
                        EC=5 → sensors      (Index→Value ÷10^decimals)
   → write to RTDB  galcon/live/<letter>/{fertCenters,sensors}/{number}
```
`commUnitID` is the socket registration id. **A** (Mevo Horon) = `210202` is
known; **B/C/D** are auto-discovered from `/controllers-dashboard` at startup. If
discovery can't find the field, set `GALCON_COMMUNIT_<LETTER>` (the worker logs
each controller's dashboard keys + candidate so you can confirm the value).
Controllers without a commUnitID are skipped (no live socket) until one is set.

## Data written (RTDB)
```
galcon/live/<letter>/                            // <letter> = A | B | C | D
  updatedAt: <epoch ms>                          // heartbeat
  fertCenters/<n>: { number, name, ec, ph, reqEc, reqPh, status, ts }
  sensors/<n>:     { number, name, value, raw, unit, ts }
galcon/mevoHoron/                                // legacy mirror of A (dosing tab)
  ...same shape as galcon/live/A
```

## Setup
1. `cd worker && npm install`
2. Get a Firebase **service-account JSON** (Firebase console → Project settings →
   Service accounts → Generate new private key). Save it somewhere private.
3. Point ADC at it: set `GOOGLE_APPLICATION_CREDENTIALS` to that file's path.

## Run
```powershell
# dry run — prints values, does NOT touch RTDB (good first test)
$env:DRY_RUN="1"; node galcon-realtime.js

# live
$env:GOOGLE_APPLICATION_CREDENTIALS="C:\path\to\serviceAccount.json"
node galcon-realtime.js
```

### Env
| var | default | meaning |
|-----|---------|---------|
| `GOOGLE_APPLICATION_CREDENTIALS` | – | service-account JSON path (required unless DRY_RUN) |
| `GALCON_USER` / `GALCON_PASS` | shared account | used for metadata, snapshot triggers + commUnitID discovery |
| `GALCON_COMMUNIT_<LETTER>` | – | supply/override a controller's commUnitID (e.g. `GALCON_COMMUNIT_B=210555`) |
| `TRIGGER_INTERVAL_MS` | `600000` | force a fresh sensor snapshot every N ms; `0` = never (pure socket) |
| `DRY_RUN` | – | `1` = log instead of writing RTDB |

> **Single session:** the snapshot trigger logs in, which kicks an interactive
> Galcon login on the same account (and vice-versa). Use a **dedicated Galcon
> user** for `GALCON_USER/PASS`, or set `TRIGGER_INTERVAL_MS=0` to never log in
> (sensors then populate only as they naturally change; fert centers still stream).

## Keep it running (Windows)
Register a scheduled task that runs at logon and restarts on failure, e.g.:
```powershell
schtasks /Create /TN "Galcon-Realtime" /SC ONLOGON /RL HIGHEST ^
  /TR "node \"C:\Users\Admin\Documents\js coding\plantsTracker\worker\galcon-realtime.js\""
```
(or use NSSM / pm2 for auto-restart).

## RTDB security rules
Managers must be able to read `galcon/`. Add to your rules:
```json
"galcon": { ".read": "auth != null", ".write": false }
```
The worker writes with admin privileges (service account), which bypasses rules.
