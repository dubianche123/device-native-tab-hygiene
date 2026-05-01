# Neural-Janitor Agent Handoff

Last updated: 2026-05-01

## Identity

- Product / extension name: `Neural-Janitor`
- Chinese display name: `神经门卫`
- Kernel codename: `The Chronos Engine`
- GitHub repository target: `dubianche123/Neural-Janitor`
- Native Messaging host id: `com.neuraljanitor.companion`
- Swift package / binary: `companion/NeuralJanitorCompanion`, `NeuralJanitorCompanion`

Legacy compatibility intentionally remains for:

- old Native Messaging host ids: `com.smarttabhygiene.companion`, `com.mimo.companion`
- old binaries: `SmartTabHygieneCompanion`, `MimoCompanion`
- old app data dirs: `~/Library/Application Support/Smart Tab Hygiene`, `~/Library/Application Support/Mimo`
- old env vars: `SMART_TAB_HYGIENE_*`, `MIMO_*`

## IPC Contract

Browser JS talks to Swift through Chrome/Edge Native Messaging using length-prefixed JSON over stdio. The current IPC protocol version is `2`.

Common metadata sent by JS and returned by Swift:

- `protocolVersion: 2`
- `appName: "Neural-Janitor"`
- `engineCodename: "The Chronos Engine"`

JS request types:

- `activity`: records local activity for training.
- `predict`: returns `idlePredictions` plus nested `health`. JS sends both `holidayLevel` for "now" and `holidayLevels` keyed by day-of-week for the next 7 calendar dates.
- `health`: returns current model/runtime/hardware telemetry.
- `retrain`: forces local Create ML retraining.
- `classifyURL`: returns local NLP category classification.

Swift response types:

- `activityAck`
- `idlePredictions`
- `health`
- `retrainResult`
- `classification`
- `error`

IPC is serialized in `extension/js/idle-detector.js` with `companionQueue`, so request/response correlation still relies on one outstanding native request at a time. If future work adds parallel native calls, add explicit request ids on both sides.

## Hardware Telemetry Markers

All UI surfaces should use the same marker states from `extension/js/constants.js`:

- `auto`: Core ML Auto can use this device.
- `active`: known active fallback path, usually browser/native CPU fallback.
- `standby`: known but not the current explicit execution path.
- `unavailable`: hardware/API unavailable.
- `error`: telemetry link is offline or inconsistent.

Swift emits:

- top-level `devices`
- top-level `telemetryStatus`
- `hardwareTelemetry: { source, status, computeUnits, markerStates, devices }`

JS normalizes older or incomplete health payloads in `normalizeHealthStatus()` before saving to `chrome.storage.local`.

NPU disconnect behavior:

- If Native Messaging disconnects, JS sets `telemetryStatus: "offline"`.
- NPU/GPU markers become `error`.
- CPU becomes `active` as the browser heuristic fallback.
- Popup Compute Path should explain the disconnect reason from `disconnectReason`.

## Important Paths

- Extension manifest: `extension/manifest.json`
- Popup UI: `extension/popup.html`, `extension/js/popup.js`, `extension/css/popup.css`
- Background service worker: `extension/js/background.js`
- Native IPC client: `extension/js/idle-detector.js`
- Shared constants: `extension/js/constants.js`
- Swift companion: `companion/NeuralJanitorCompanion/Sources/main.swift`
- Install script: `scripts/install.sh`
- Uninstall script: `scripts/uninstall.sh`
- Bootstrap trainer: `scripts/train_model.py`

## Validation Commands

Run from repo root unless noted:

```bash
node --check extension/js/background.js
node --check extension/js/content.js
node --check extension/js/constants.js
node --check extension/js/categorizer.js
node --check extension/js/idle-detector.js
node --check extension/js/popup.js
node --check extension/js/storage.js
python3 -B -m py_compile scripts/train_model.py
bash -n scripts/install.sh
bash -n scripts/uninstall.sh
swift build -c release --package-path companion/NeuralJanitorCompanion
```

Native IPC smoke test pattern:

```bash
node - <<'NODE'
const { spawn } = require('child_process');
const bin = './companion/NeuralJanitorCompanion/.build/release/NeuralJanitorCompanion';
const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const payload = Buffer.from(JSON.stringify({ type: 'health', protocolVersion: 2 }));
const len = Buffer.alloc(4);
len.writeUInt32LE(payload.length, 0);
child.stdin.end(Buffer.concat([len, payload]));
let out = Buffer.alloc(0);
child.stdout.on('data', chunk => { out = Buffer.concat([out, chunk]); });
child.on('close', () => {
  const size = out.readUInt32LE(0);
  console.log(out.subarray(4, 4 + size).toString());
});
NODE
```

## Categorizer v2 Architecture

Three-tier classification in `extension/js/categorizer.js`:

1. **DOMAIN_MAP lookup** — `extension/js/constants.js` contains 200+ hostname→category suffix mappings (e.g. `rakuten.co.jp`→finance, `zhihu.com`→reference, `oracle.com`→work). Confidence 0.98. Runs first.
2. **Hostname keyword match** — Only the hostname (not full URL) is checked against CATEGORIES keywords. Longest match wins. Confidence 0.85. Prevents URL-path false positives.
3. **Content signal heuristics** — DOM title/meta/headers matched against signal phrases. Score ≥ 2 required (multi-word phrases worth more). Confidence 0.70.

Key rule: URL path substrings are **never** matched against category keywords. This prevents false positives like Reuters `/openai/` path matching "open" → AI category.

## Holiday Calendar Module

`extension/js/holidays.js` provides calendar-aware idle prediction for Japan and China.

**Data**: 2025–2027 holiday lists — Japan (国民の祝日 + GW/Obon/年末年始/Silver Week extended ranges), China (法定假日 + Spring Festival/National Day extended periods).

**API**:
- `getRestDayLevel(date, calendar)` → `0` normal weekday, `1` weekend, `2` public holiday or extended holiday period
- `getHolidayName(date, calendar)` → public holiday name or `null`
- `getUpcomingHolidays(calendar, daysAhead)` → holidays in the next N days with `{date, name, dayOfWeek}`
- `isHoliday(date, calendar)` → boolean
- `CALENDAR_OPTIONS` → registry for UI dropdown labels/icons

**Fallback heuristic tiers** (in `idle-detector.js` and Swift companion):
| Tier | Window | Confidence |
|------|--------|------------|
| Holiday | 00:00–09:00 | 0.62 estimate |
| Weekend | 00:00–08:00 | 0.57 estimate |
| Weekday | 01:00–07:00 | 0.56 estimate |

Setting: `holidayCalendar` — `'none'` (default), `'japan'`, or `'china'`.

Important IPC detail: `extension/js/idle-detector.js` builds `holidayLevels` for the next seven actual dates before sending `predict`. Swift's `IdlePredictor.predict(holidayLevel:holidayLevels:)` applies the matching value per day, so a Monday Japanese/Chinese holiday can change that Monday's prediction even when today is not a holiday.

## Test / Deploy Mode

Toggle in popup header (`🚀 Deploy` / `🧪 Test`).

- **Deploy mode** (default): `performStaleCheck()` and `aiCleanup()` call `chrome.tabs.remove()`.
- **Test mode**: Same logic, but calls `tagTab(tabId)` instead — tabs get red `🏷 TEST` badge in popup. Tagged tab IDs stored in `chrome.storage.local` under `nj:taggedTabs`.
- Tags cleared at start of each scan (`clearAllTags()`), so each run shows fresh results.

Setting: `testMode` (boolean, default `false`).

## Memory Pressure & AI Cleanup

**Memory/CPU bars** (popup header): Polls `chrome.system.memory.getInfo()` and `chrome.system.cpu.getInfo()` every 5s. Memory shows `used/total GB` in the tooltip and percentage bar. CPU shows percentage plus a compact model/thread label such as `Apple M3 8T`. Color: green (<60%), orange (60–80%), red (≥80%).

**AI Cleanup button** (🤖, popup header): Sends `aiCleanup` message to background. Scoring:
```
score = categoryPriority + log₂(interactions + 1) × 8 - min(72, idleHours) × 1.2
```
- NSFW categories get score -1000 (always closed first).
- Lower score = more likely to be closed.
- High-priority categories such as AI/work are protected; long idle time lowers the score; interactions raise it.
- Re-checks memory every 5 closures; stops if pressure < target.

**Settings**:
- `aiCleanupTargetMemory` — target memory % after cleanup (default 70%).
- `aiCleanupTargetTabs` — target tab count after cleanup (default 30).
- `aiForceCleanupThreshold` — auto-trigger AI cleanup when memory ≥ this % (default 85%). Checked every 30-min alarm cycle.

## AI Suggestions Panel

Below memory bar in popup. `getAISuggestion()` in background.js analyzes current state and returns suggestions with levels:
- 🔴 `critical` — memory ≥ 90% or tabs ≥ 80.
- 🟡 `warning` — memory ≥ 75% or tabs ≥ 50.
- 🔵 `info` — stale tabs > 10 or memory ≥ 60%.
- 🟢 `ok` — everything nominal.

Each suggestion has `action` (button label) and `msg` (explanation). Popup renders as clickable cards that trigger the corresponding action.

## Important Paths (new/changed)

- Holiday module: `extension/js/holidays.js` (new)
- Categorizer: `extension/js/categorizer.js` (rewritten)
- Domain map: `extension/js/constants.js` → `DOMAIN_MAP` constant (new, 200+ entries)
- Idle detector: `extension/js/idle-detector.js` (async `disconnectedStatus`, calendar-aware fallback)
- Storage: `extension/js/storage.js` (new settings keys, tagged-tabs functions)
- Background: `extension/js/background.js` (test mode, memory, AI cleanup, AI suggestions, force-trigger)
- Popup: `extension/js/popup.js` + `extension/popup.html` + `extension/css/popup.css` (mode toggle, memory bar, AI panel, holiday settings)

## Validation Commands (additions)

```bash
node --check extension/js/holidays.js
```

All 7 JS files pass `node --check`. CSS braces balanced (139/139). Manifest JSON valid.

## Current Operational Notes

- Browser extension install is still Load Unpacked from `extension/`.
- Full local ML requires rerunning `./scripts/install.sh <extension-id>` after the native host id rename.
- Chrome/Edge cannot silently install a Native Messaging host from an extension package; a script, signed app, or pkg installer is still required for companion setup.
- Core ML public APIs expose requested compute units and hardware availability, but not the exact per-inference processor. Do not claim exact ANE usage for a single inference.
- `chrome.system.memory` permission added to manifest for memory pressure monitoring.
- DOMAIN_MAP hostname suffixes are matched right-to-left (longest suffix wins). Add new sites there first; only add to CATEGORIES keywords as a fallback.
- URL paths are never matched against category keywords — this is intentional to prevent false positives.
- Finalized (2026-05-01): IPC logic is synced for protocol version 2, including per-day `holidayLevels` for prediction requests. Hardware telemetry markers map cleanly to the popup UI components, and the NPU-disconnect scenario is handled with clearly labeled browser heuristic estimates. Categorizer v2 with DOMAIN_MAP-first architecture, holiday calendars, test/deploy mode, memory pressure + AI cleanup, and AI suggestions panel are implemented and syntax-verified.
