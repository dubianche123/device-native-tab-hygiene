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
- `predict`: returns `idlePredictions` plus nested `health`. JS sends `holidayLevel` for "now", `holidayLevels` keyed by day-of-week for the next 7 calendar dates, and `idleSchedule` reference windows.
- `health`: returns current model/runtime/hardware telemetry. JS also sends `idleSchedule` so the confidence curve uses the same reference prior as predictions.
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
- `active`: known active fallback path, usually browser/native fallback.
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
- Model export script: `scripts/export_model_bundle.sh`
- Model import script: `scripts/import_model_bundle.sh`
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
bash -n scripts/export_model_bundle.sh
bash -n scripts/import_model_bundle.sh
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
| Holiday | User `idleSchedule.rest` reference window | 0.60 estimate |
| Weekend | User `idleSchedule.rest` reference window | 0.57 estimate |
| Weekday | User `idleSchedule.weekday` reference window | 0.56 estimate |

Outside those windows, browser/Swift CPU heuristic confidence stays at `0.18` even when a holiday calendar is selected. The calendar widens likely idle windows; it should not create a blanket daytime +10% confidence jump.

Setting: `holidayCalendar` — `'none'` (default), `'japan'`, or `'china'`.
Setting: `idleSchedule` — `{ weekday: { sleep, wake }, rest: { sleep, wake } }`, stored as `HH:mm`. Defaults: weekday `01:00` to `07:00`, weekend/holiday `00:00` to `08:30`. It is a reference prior, not a close-time rule.

Important IPC detail: `extension/js/idle-detector.js` builds `holidayLevels` for the next seven actual dates before sending `predict`. Swift's `IdlePredictor.predict(holidayLevel:holidayLevels:idleSchedule:)` applies the matching value per day, so a Monday Japanese/Chinese holiday can change that Monday's prediction even when today is not a holiday. When no Core ML model or lookup exists, Swift returns the appropriate reference schedule window directly instead of the old hardcoded sleep window.

## Test / Deploy Mode

Toggle in popup header (`🚀 Deploy` / `🧪 Test`).

- **Deploy mode** (default): `performStaleCheck()` and `aiCleanup()` call `chrome.tabs.remove()`.
- **Test mode**: Same logic, but calls `tagTab(tabId)` instead — tabs get red `🏷 TEST` badge in popup. Tagged tab IDs stored in `chrome.storage.local` under `nj:taggedTabs`.
- Tags cleared at start of each scan (`clearAllTags()`), so each run shows fresh results.

Setting: `testMode` (boolean, default `false`).

## Protected Tabs & Foreground/Background Lifecycle

**Protected tabs** (`getProtectedTabIds()` in background.js): Before any auto-close scan, the system queries Chrome for tabs that must never be closed:
- Active tab in every window (`active: true` per window)
- Pinned tabs (`pinned: true`)
- Audible tabs (`audible: true`)
- Current active session tab

Both `performStaleCheck()` and `aiCleanup()` skip all protected tab IDs. This prevents closing the tab the user is currently looking at, even if the service worker's session state is stale.

**Foreground/Background lifecycle**:
- `startActiveSession()`: sets `lastForegroundAt = now` on the tab entry.
- `closeActiveSession()`: sets `lastBackgroundedAt = now` on the tab entry.
- `checkpointActiveSession()`: preserves `lastForegroundAt`.

**Tracker role**: The interaction tracker is a signal collector. It never decides to close a page by itself. Cleanup decisions compare the background clock (`now - lastBackgroundedAt`) against an effective close-after time. For learned categories, that time is:

```
modelClosureTime = learnedManualThreshold × importanceMultiplier
effectiveClosureTime = min(modelClosureTime, userClosureTimeLimit)
importanceMultiplier = 0.75 + normalizedFocusRatio × 1.0
normalizedFocusRatio = clamp(foregroundDwellMs / (foregroundDwellMs + backgroundAgeMs), 0, 1)
```

The multiplier is clamped to `0.75x..1.75x`. The model-calculated closure time is capped to `[1 min, 2× category default]`, then the user's Settings slider caps it as the final closure time limit. The slider is not a model replacement; it is the upper bound users can reason about.

**Stale detection**: `tabRetentionProfile()` calculates `backgroundAgeMs` from `lastBackgroundedAt` (time since tab left foreground), then falls back to `lastVisited`, `openedAt`, and finally `now` for legacy entries. It returns the model close time, user cap, final effective close time, and close reason for stale checks / AI Cleanup.

**AI Cleanup scoring**: Uses `backgroundAgeMs / effectiveClosureTime` as threshold pressure. Foreground/background importance is already baked into the model closure time, so do not add a separate focus-ratio protection term.

**Migration**: Old entries without `lastBackgroundedAt` gracefully fall back to `lastVisited`. New entries get both fields populated.

## Memory Pressure & AI Cleanup

**Memory/CPU bars** (popup header): Polls `chrome.system.memory.getInfo()` and `chrome.system.cpu.getInfo()` every 5s. Memory shows `used/total GB` in the tooltip and percentage bar. CPU shows percentage plus a very compact model/thread label such as `M3 8T`; keep it short or the popup header will overflow. Color: green (<60%), orange (60–80%), red (≥80%). The status row also shows a compact `Pkg ~xW` estimate derived from CPU telemetry; exact macOS package watts require privileged `powermetrics`, so do not label this as an exact sensor readout.

**AI Cleanup button** (🤖, popup header): Sends `aiCleanup` message to background. Scoring:
```
score = categoryPriority + log₂(interactions + 1) × 8 - min(72, backgroundAgeMs / effectiveClosureTime × 24)
```
- NSFW categories get score -1000 (always closed first).
- Lower score = more likely to be closed.
- `effectiveClosureTime` already includes the normalized foreground/background importance multiplier when a learned manual threshold exists, then applies the user's closure time limit.
- **Protected tabs** (active in any window, pinned, audible) are skipped entirely — see below.
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

Popup refresh behavior: `Check`, `AI Clean`, mode changes, holiday-calendar changes, and settings saves all refresh AI Suggestions. A low-frequency 30s timer also refreshes suggestions while the popup stays open.

Training samples: the popup displays real `trainingSamples` from the companion. It no longer fakes `99/100` while the model is awaiting enough valid/varied samples; raw browser events are shown separately as `0 valid (N events)` when applicable.

## Closure Learning

Learns from HOW the user closes tabs to dynamically adjust per-category learned close-after times. Three data streams:

| Type | Source | Learning weight |
|---|---|---|
| `manual_browser_close` | Real browser close from `chrome.tabs.onRemoved` (Ctrl+W, close button) | 1.0 (full) |
| `manual_popup_close` | Extension popup "Close & Log" button | 1.0 (full) |
| `auto_cleanup` | `performStaleCheck()` or `aiCleanup()` | Context only; stored with weight 0.2 |

**Storage**: `closureLearning` key in `chrome.storage.local`. Rolling window of up to 2000 samples.

**Per-sample fields**: `type`, `category`, `dwellMs` (foreground dwell), `backgroundAgeMs` (time since tab left foreground), `interactions`, `openedAt`, `lastVisited`, `lastBackgroundedAt`, `closedAt`, `hourOfDay`.

**Learned close-time recommendation algorithm**:
1. Collect manual close `backgroundAgeMs` values per category (time since tab left foreground).
2. Ignore zero / near-zero values below 15 seconds — those indicate immediate close or misclick, not meaningful retention data.
3. Compute median meaningful `backgroundAgeMs` of manual closes per category.
4. Recommended learned close time = `median_background_age × 1.5`, clamped to category floor and `2× default`.
5. Requires ≥ 3 meaningful manual close samples before recommending.
6. Fallback: if there are not enough meaningful `backgroundAgeMs` samples yet, use meaningful `dwellMs` (foreground dwell) as proxy for active-close patterns.
7. Runtime close time: `min(learned close time × foreground/background importance multiplier, user maximum close-after slider)`. If no learned time exists yet, the category default is capped by the user slider.

**Learned close-time floor**: Short-session categories can learn down to 2 minutes. Important categories (`ai`, `work`, `email`, `reference`, `finance`) floor at 10 minutes so a few quick closes do not make long-lived work/AI tabs dangerously aggressive.

**Anti-feedback-loop**: Programmatic `chrome.tabs.remove()` calls must call `markProgrammaticClose()` before removal so `tabs.onRemoved` does not misrecord them as `manual_browser_close`. Auto-cleanup samples are recorded for context but do not create threshold recommendations; only meaningful manual closes drive threshold adaptation.

**Popup UI**: Settings sliders are user-facing maximum close-after times, not abstract model thresholds. Each category row shows the current ML × importance close time and the final used time (`min(ML time, slider cap)`). The ML console separates `Model Samples` (idle-model activity events) from `Closure Samples` (manual / auto close learning). "Closure Learning" in ML Insights shows per-category stats (manual/auto counts, median foreground dwell, median background age, learned recommendation vs default, delta). Reset button in Settings.

**Module**: `extension/js/closure-learner.js` — exports `recordClosureSample`, `getLearnedThresholds`, `getCategoryClosureStats`, `getLearningSummary`, `resetClosureLearning`.

## Important Paths (new/changed)

- Holiday module: `extension/js/holidays.js` (new)
- Categorizer: `extension/js/categorizer.js` (rewritten)
- Domain map: `extension/js/constants.js` → `DOMAIN_MAP` constant (new, 200+ entries)
- Idle detector: `extension/js/idle-detector.js` (async `disconnectedStatus`, calendar-aware fallback)
- Storage: `extension/js/storage.js` (new settings keys, tagged-tabs functions)
- Background: `extension/js/background.js` (test mode, memory, AI cleanup, AI suggestions, force-trigger)
- Closure learner: `extension/js/closure-learner.js` (new — closure sampling, learned close-time recommendations)
- Popup: `extension/js/popup.js` + `extension/popup.html` + `extension/css/popup.css` (mode toggle, memory bar, AI panel, holiday settings, closure learning UI)
- Model transfer helpers: `scripts/export_model_bundle.sh`, `scripts/import_model_bundle.sh`

## Validation Commands (additions)

```bash
node --check extension/js/holidays.js
node --check extension/js/closure-learner.js
```

All 8 JS files pass `node --check`. CSS braces balanced. Manifest JSON valid.

## Current Operational Notes

- Browser extension install is still Load Unpacked from `extension/`.
- Full local ML requires rerunning `./scripts/install.sh <extension-id>` after the native host id rename.
- Chrome/Edge cannot silently install a Native Messaging host from an extension package; a script, signed app, or pkg installer is still required for companion setup.
- Cross-Mac model transfer is snapshot-based. Use `./scripts/export_model_bundle.sh --output ~/Desktop` on the source Mac and `./scripts/import_model_bundle.sh <bundle.tar.gz>` on the target Mac after installing the extension/companion. Do not live-sync `~/Library/Application Support/Neural-Janitor/` through iCloud while the companion is running; `activity_events.json` is hot-written and can conflict.
- Transfer bundle defaults to model artifacts only: `TabIdlePredictor.mlmodel`, `idle_lookup.json`, and `model_metrics.json`. Raw `activity_events.json` requires `--with-events` on export and import.
- Core ML public APIs expose requested compute units and hardware availability, but not the exact per-inference processor. Do not claim exact ANE usage for a single inference.
- `chrome.system.memory` permission added to manifest for memory pressure monitoring.
- DOMAIN_MAP hostname suffixes are matched right-to-left (longest suffix wins). Add new sites there first; only add to CATEGORIES keywords as a fallback.
- URL paths are never matched against category keywords — this is intentional to prevent false positives.
- Finalized (2026-05-01): IPC logic is synced for protocol version 2, including per-day `holidayLevels` for prediction requests. Hardware telemetry markers map cleanly to the popup UI components, and the NPU-disconnect scenario is handled with clearly labeled browser heuristic estimates. Categorizer v2 with DOMAIN_MAP-first architecture, holiday calendars, test/deploy mode, memory pressure + AI cleanup, and AI suggestions panel are implemented and syntax-verified.
- Added (2026-05-01): Closure learning system — `closure-learner.js` records manual_browser_close, manual_popup_close, and auto_cleanup events. Uses median background age × 1.5 to recommend per-category learned close-after times. Programmatic closes are suppressed from `tabs.onRemoved` manual learning, and auto_cleanup is context-only to avoid self-reinforcement. Runtime cleanup multiplies the learned time by foreground/background importance, then caps it with the user-facing maximum close-after slider.
- Added (2026-05-01): Protected tabs + foreground/background lifecycle. `getProtectedTabIds()` queries Chrome for active/pinned/audible tabs before any auto-close scan — both `performStaleCheck()` and `aiCleanup()` skip them. `lastForegroundAt` / `lastBackgroundedAt` replace `lastVisited` for stale detection (fallback for old entries). AI Cleanup scoring uses `backgroundAgeMs` + `focusRatio` for importance weighting.
- Adjusted (2026-05-01): `snapshotAllTabs()`, tab creation, tab navigation, popup active-tab display, and AI Suggestions now preserve/use `lastBackgroundedAt` consistently. Suggestions should not count protected tabs as stale.
