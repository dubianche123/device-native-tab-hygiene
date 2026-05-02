# Neural-Janitor Agent Handoff

Last updated: 2026-05-03

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
- JS uses short-lived native ports in `idle-detector.js`; do not reintroduce a global long-lived `connectNative()` port because it can keep Chrome/Edge waiting during shutdown.

## Important Paths

- Extension manifest: `extension/manifest.json`
- Popup UI: `extension/popup.html`, `extension/js/popup.js`, `extension/css/popup.css`
- Background service worker: `extension/js/background.js`
- Native IPC client: `extension/js/idle-detector.js`
- Shared constants: `extension/js/constants.js`
- Domain helper: `extension/js/domain-utils.js`
- Swift companion: `companion/NeuralJanitorCompanion/Sources/main.swift`
- Install script: `scripts/install.sh`
- Uninstall script: `scripts/uninstall.sh`
- Installed companion path: `~/Library/Application Support/Neural-Janitor/NeuralJanitorCompanion`
- Model export script: `scripts/export_model_bundle.sh`
- Model import script: `scripts/import_model_bundle.sh`
- Bootstrap trainer: `scripts/train_model.py`

## Validation Commands

Run from repo root unless noted:

```bash
node --check extension/js/background.js
node --check extension/js/content.js
node --check extension/js/constants.js
node --check extension/js/domain-utils.js
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

Key rule: URL path substrings are **not** matched against generic category keywords. This prevents false positives like Reuters `/openai/` path matching "open" → AI category. Only narrowly-scoped path exceptions are allowed, such as Microsoft/Bing Rewards and API docs paths.

**Root-domain category memory**: `extension/js/storage.js` stores `domainCategoryMemory` keyed by `getRootDomain(url)` from `extension/js/domain-utils.js`. When a domain has repeated high-confidence non-`other` classifications, low-confidence future pages under that same root can be upgraded with source `domain-memory`. This is local-only, capped at 500 domains, and skips broad multi-service roots such as `google.com`, `bing.com`, `microsoft.com`, `yahoo.co.jp`, and `amazon.com`. SERP close-time learning is separate and uses `search:<engine>` learning roots, not domain category memory.

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

## Test / Armed / Deploy Mode

Toggle in popup header (`🚀 Deploy` / `⏳ Armed` / `🧪 Test`).

- **Deploy mode**: idle-triggered `performStaleCheck()` and `aiCleanup()` can call `chrome.tabs.remove()`. Scheduled stale scans in Deploy mode require `chrome.idle` to report `idle` or `locked`; while the Mac is active, they only refresh stale tags.
- **Armed mode**: behaves like Test mode (`testMode: true`) until close-time readiness reaches the Deploy target, then `deploymentStatus()` promotes it to Deploy automatically. Switching back to Test clears the armed state.
- **Test mode** (fresh-install default): Same logic, but calls `tagTab(tabId)` instead — tabs get red `🏷 TEST` badge in popup. Tagged tab IDs stored in `chrome.storage.local` under `nj:taggedTabs`.
- **Manual Preview**: popup `Preview` sends `forceCheck`, which calls `performStaleCheck({ dryRun: true, source: "manual_check" })`. It refreshes stale-tab tags and reports counts, but never closes tabs, even while Deploy is active. Use `AI Clean` or scheduled auto-cleanup for real closure.
- Tags cleared at start of each scan (`clearAllTags()`), so each run shows fresh results.
- Idle-context acceleration and automatic stale closure are only applied while `chrome.idle` reports `idle` or `locked`. A model can still show a high time-window prior while the user is active, but active state suppresses the cleanup multiplier, high-confidence early-close path, and scheduled stale closure.
- `Reset Model State` is available both in the popup and via `scripts/reset_model_state.sh`. It clears closure learning, root-domain memory, idle predictions, and companion-side artifacts. The shell script writes a reset request so the live native host clears its in-memory store on the next message.

Setting: `deploymentMode` (`test` / `armed` / `deploy`, default `test`). `testMode` is still stored for compatibility and is derived from `deploymentMode`; old bare `testMode: false` data migrates to safe Test unless an explicit `deploymentMode: deploy` exists.

**Deploy readiness gate** (`extension/js/deployment-readiness.js`): Deploy is locked below 3 manual closes or 1 learned close-time bucket. At 3 manual closes + 1 learned bucket, the user can arm Deploy; it stays in Test behavior. At 5 manual closes + 2 learned buckets, Armed auto-promotes to Deploy or the user can switch directly. 10 manual closes + 3 learned buckets is the safer bar.

## Closed Log Restore

Closed records are stored by category under `closedLog` in `chrome.storage.local`. The popup supports both single restore and checkbox-based batch restore:
- Single restore sends `restoreClosedTab`.
- Batch restore sends `restoreClosedTabs` with selected restorable `{ category, id, url, sessionId }` entries.
- Closed-log cleanup sends `removeClosedRecords` for any selected records, including records already marked `restoredAt`, or `clearRestoredClosedRecords` to remove all restored entries.
- Background restores sequentially via `chrome.sessions.restore(sessionId)` when possible, then falls back to `chrome.tabs.create({ url })`, and marks each successful record with `restoredAt`.
- Restoring an automatically closed record is corrective feedback: `restoreClosedTab()` removes the linked `auto_cleanup` closure-learning sample from the shared companion store via `closedRecordId`, with a legacy root/time fallback for older samples.

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

**Tracker role**: The interaction tracker is a signal collector. It never decides to close a page by itself. Cleanup decisions compare the background clock (`now - lastBackgroundedAt`) against an effective close-after time. For learned domain/category buckets, that time is:

```
modelClosureTime = learnedManualThreshold × importanceMultiplier × idleContextMultiplier
effectiveClosureTime = min(modelClosureTime, userClosureTimeLimit)
importanceMultiplier = 0.75 + normalizedFocusRatio × 1.0
normalizedFocusRatio = clamp(foregroundDwellMs / (foregroundDwellMs + backgroundAgeMs), 0, 1)
idleContextMultiplier = 0.75 if chrome.idle is idle/locked, otherwise 1.15
```

The foreground/background multiplier is clamped to `0.75x..1.75x`. Idle is an auxiliary context weight for timing, but also the approval gate for scheduled stale closure in Deploy mode. The model-calculated closure time is capped to `[1 min, 2× category default]`, then the user's Settings slider caps it as the final closure time limit. The slider is not a model replacement; it is the upper bound users can reason about.

**Stale detection**: `tabRetentionProfile()` calculates `backgroundAgeMs` from `lastBackgroundedAt` (time since tab left foreground), then falls back to `lastVisited`, `openedAt`, and finally `now` for legacy entries. It returns the model close time, user cap, final effective close time, idle-context multiplier, and close reason for stale checks / AI Cleanup. When the Mac is actually idle and the tab is within one day of its learned close time, the tab can be marked for an early close rather than waiting for the exact threshold.

**AI Cleanup scoring**: Uses learned close-time pressure, engagement, and interaction count to rank candidates. `backgroundAgeMs / effectiveClosureTime` is the main pressure term, while category priority is only a weak tie-breaker. Foreground/background importance is already baked into the model closure time, so do not add a separate focus-ratio protection term. Manual AI Clean may also proactively trim a very small set of low-scoring tabs, but only in Deploy. Automatic cleanup remains pressure-gated and also requires Deploy.

**Migration**: Old entries without `lastBackgroundedAt` gracefully fall back to `lastVisited`. New entries get both fields populated.

## Memory Pressure & AI Cleanup

**Memory/CPU bars** (popup header): Polls `chrome.system.memory.getInfo()` and `chrome.system.cpu.getInfo()` every 5s. Memory shows `used/total GB` in the tooltip and percentage bar. CPU shows percentage plus a very compact model/thread label such as `M3 8T`; keep it short or the popup header will overflow. Color: green (<60%), orange (60–80%), red (≥80%). The status row also shows a compact `Pkg ~xW` estimate derived from CPU telemetry; exact macOS package watts require privileged `powermetrics`, so do not label this as an exact sensor readout.

**AI Cleanup button** (popup header): Locked in Test / Armed; only Deploy can actually clean. Header button sends `profile: "pressure"` and reduces tab/memory pressure toward configured targets. Suggestion-card buttons send bounded trim profiles: `safe` closes at most `SAFE_CLEANUP_POLICY.maxCount` and `broad` closes at most `PROACTIVE_CLEANUP_POLICY.maxCount`. If no tab meets the strict safe threshold but broad low-importance candidates exist, `safe` takes the top-ranked one or two broad candidates so the UI still offers a small first step. Scoring:
```
score = categoryBias + log₂(interactions + 1) × 8 + normalizedImportance × 14 - min(90, backgroundAgeMs / effectiveClosureTime × 80) - learnedShortness × 24
```
- NSFW categories get score -1000 (always closed first).
- Lower score = more likely to be closed.
- `effectiveClosureTime` already includes the normalized foreground/background importance multiplier when a learned manual threshold exists, then applies the user's closure time limit.
- **Protected tabs** (active in any window, pinned, audible) are skipped entirely — see below.
- High-priority categories such as AI/work are only a weak bias now; long idle time lowers the score, low engagement lowers the score, and interactions raise it.
- Tab count is the primary stop condition for pressure-driven cleanup. If tab count starts above `aiCleanupTargetTabs`, pressure cleanup stops once that target is reached even if memory pressure has not immediately fallen. If only memory pressure is high, pressure cleanup is bounded to 5 tabs because Chromium/macOS may reclaim memory lazily. Safe/broad suggestion trims are always capped by their policy max counts, even when tab or memory pressure is active.

**Settings**:
- `aiCleanupTargetMemory` — target memory % after cleanup (default 70%).
- `aiCleanupTargetTabs` — target tab count after cleanup (default 30).
- `aiForceCleanupThreshold` — auto-trigger AI cleanup when memory ≥ this % (default 85%). Checked every 30-min alarm cycle.

## AI Suggestions Panel

Below memory bar in popup. `getAISuggestion()` in background.js analyzes current state and returns suggestions with levels:
- 🔴 `critical` — memory ≥ `aiForceCleanupThreshold`.
- 🟡 `warning` — tab count > `2× aiCleanupTargetTabs`, or memory ≥ target + 10%.
- 🔵 `info` — tab count > target, stale tabs exist, low-importance tabs are ready to trim, or memory is slightly above target.
- 🟢 `ok` — everything nominal.

Each suggestion has `action` or `actions` plus `text`. Popup renders clickable cards that trigger the corresponding action. Stale-tab preview is its own card and is available in any mode because it only tags tabs. Low-importance cleanup is a separate card with paired safe/broad AI Clean buttons; those buttons stay hidden unless Deploy is active. There is no Ignore button anymore.

Popup refresh behavior: `Preview`, `AI Clean`, mode changes, holiday-calendar changes, and settings saves all refresh AI Suggestions. A low-frequency 30s timer also refreshes suggestions while the popup stays open.

Updated (2026-05-03): Cleanup-related suggestions are separated by job: pressure state, stale preview, and low-importance cleanup. Avoid merging stale preview counts with proactive trim counts; they are different actions. The low-importance cleanup card should expose exactly two scopes in Deploy: `Clean safest` and `Clean more`.

Training samples: the popup displays real `trainingSamples` from the companion. It no longer fakes `99/100` while the model is awaiting enough valid/varied samples; raw browser events are shown separately as `0 valid (N events)` when applicable.

## Closure Learning

Learns from HOW the user closes tabs to dynamically adjust per-category and per-root-domain learned close-after times. The source of truth now lives in the companion so Chrome and Edge share the same closure database; browser storage only keeps a temporary pending queue when the companion is unavailable. Three data streams:

| Type | Source | Learning weight |
|---|---|---|
| `manual_browser_close` | Real browser close from `chrome.tabs.onRemoved` (Ctrl+W, close button) | 1.0 (full) |
| `manual_popup_close` | Extension popup "Close & Log" button | 1.0 (full) |
| `auto_cleanup` | `performStaleCheck()` or `aiCleanup()` | Context only; stored with weight 0.2 |

**Storage**: `closure_samples.json` in the companion app support directory. Browser `closureLearning` storage is only a temporary pending queue for unsynced samples and retryable removals. Rolling window of up to 2000 samples.

**Per-sample fields**: `sampleId`, `browserType`, `type`, `category`, `rootDomain`, `dwellMs` (foreground dwell), `backgroundAgeMs` (time since tab left foreground), `interactions`, `openedAt`, `lastVisited`, `lastBackgroundedAt`, `closedAt`, `hourOfDay`.

**Learned close-time recommendation algorithm**:
1. Collect manual close `backgroundAgeMs` values per category and per root domain (time since tab left foreground).
2. Ignore zero / near-zero values below 15 seconds — those indicate immediate close or misclick, not meaningful retention data.
3. Compute median meaningful `backgroundAgeMs` of manual closes per bucket.
4. Recommended learned close time = `median_background_age × 1.5`, clamped to category floor and `2× default`.
5. Root-domain buckets require ≥ 3 meaningful manual close samples before recommending; entertainment domains require ≥ 5.
6. Category buckets require broader evidence: ≥ 6 meaningful manual samples across ≥ 2 root domains; entertainment categories require ≥ 8. The broad `Other` category does not produce a category-level recommendation — use root-domain learning instead.
7. Fallback: if there are not enough meaningful `backgroundAgeMs` samples yet, use meaningful `dwellMs` (foreground dwell) as proxy for active-close patterns.
8. Runtime close time: on learning-eligible roots, prefer root-domain learned close time whenever present, then category learned close time, then category default. Final formula is `min(learned close time × foreground/background importance multiplier × idle-context multiplier, user maximum close-after slider)`. If no learned time exists yet, the category default is capped by the user slider.

**Learned close-time floor**: Short-session categories can learn down to 2 minutes. Important categories (`ai`, `work`, `email`, `reference`, `finance`) floor at 10 minutes so a few quick closes do not make long-lived work/AI tabs dangerously aggressive. Uncategorized `other` floors at 12 hours because unknown pages should be conservative until classification improves.

**Anti-feedback-loop**: Programmatic `chrome.tabs.remove()` calls must call `markProgrammaticClose()` before removal so `tabs.onRemoved` does not misrecord them as `manual_browser_close`. Auto-cleanup samples are recorded for context but do not create threshold recommendations; only meaningful manual closes drive threshold adaptation. If the user restores an auto-closed tab, the linked auto-cleanup sample is removed from closure learning. Browser startup also reconciles restored session tabs so Chrome/Edge "continue where you left off" tabs do not leak back into the learning set.

**Timed blacklist**: Settings store `blacklist` as `[{ pattern, hours, minutes }]`. Matching is substring-based against hostname or full URL. Blacklist entries use fixed close time (`0–99` hours, `0–59` minutes, fallback 1 hour), bypass category/learned thresholds, and are excluded from closure learning like whitelist traffic. `performStaleCheck()` records blacklist closes with `blacklist_*` reason; AI Cleanup can close blacklisted tabs only after their fixed time has elapsed.

**Popup UI**: Settings sliders are user-facing maximum close-after times, not abstract model thresholds. Each category row shows the learned close-time estimate and the final used time (`min(learned estimate, slider cap)`). The console treats close-time learning as primary: `Close-Time Samples` and `Close-Time Readiness` describe manual close learning, while `Context Samples` are auxiliary idle/activity signals. The decision panel splits current system activity (`Active now` / `Idle now`) from the model's idle likelihood, so active use does not get mislabeled as sleep. "Close-Time Learning" in ML Insights shows per-category stats plus top root-domain fallback stats (manual/auto counts, median foreground dwell, median background age, learned recommendation vs default, delta). Reset button in Settings.

**Entertainment guardrail**: `entertainment` now needs more manual samples and has a higher minimum learned floor, so a few short closes cannot collapse it to a 2-3 minute retention window.

**Module**: `extension/js/closure-learner.js` — exports `recordClosureSample`, `syncClosureLearningToCompanion`, `getLearnedThresholds`, `getCategoryClosureStats`, `getDomainClosureStats`, `getLearningSummary`, `resetClosureLearning`.

## Important Paths (new/changed)

- Holiday module: `extension/js/holidays.js` (new)
- Categorizer: `extension/js/categorizer.js` (rewritten)
- Domain map: `extension/js/constants.js` → `DOMAIN_MAP` constant (new, 200+ entries)
- Idle detector: `extension/js/idle-detector.js` (async `disconnectedStatus`, calendar-aware fallback)
- Storage: `extension/js/storage.js` (new settings keys, tagged-tabs functions)
- Background: `extension/js/background.js` (deployment gating, memory, AI cleanup, AI suggestions, force-trigger)
- Deploy readiness: `extension/js/deployment-readiness.js` (pure state machine for Test / Armed / Deploy)
- Cleanup ranking: `extension/js/cleanup-ranking.js` (pure AI Cleanup score helper)
- Closure learner: `extension/js/closure-learner.js` (new — closure sampling, learned close-time recommendations)
- Search result helpers: `extension/js/search-results.js` (SERP detection plus isolated `search:<engine>` learning roots)
- Popup: `extension/js/popup.js` + `extension/popup.html` + `extension/css/popup.css` (mode toggle, memory bar, AI panel, holiday settings, closure learning UI)
- Model transfer helpers: `scripts/export_model_bundle.sh`, `scripts/import_model_bundle.sh`

## Validation Commands (additions)

```bash
node --check extension/js/holidays.js
node --check extension/js/closure-learner.js
node --check extension/js/search-results.js
```

Core JS files pass `node --check`. CSS braces balanced. Manifest JSON valid.

## Current Operational Notes

- Browser extension install is still Load Unpacked from `extension/`.
- Full local ML requires rerunning `./scripts/install.sh <chrome-extension-id> [edge-extension-id]` after the native host id rename. The script now refuses placeholder ids, installs the binary under `~/Library/Application Support/Neural-Janitor/`, and can write multiple allowed origins when Chrome/Edge ids differ.
- Chrome/Edge cannot silently install a Native Messaging host from an extension package; a script, signed app, or pkg installer is still required for companion setup.
- Cross-Mac model transfer is snapshot-based. Use `./scripts/export_model_bundle.sh --output ~/Desktop` on the source Mac and `./scripts/import_model_bundle.sh <bundle.tar.gz>` on the target Mac after installing the extension/companion. Do not live-sync `~/Library/Application Support/Neural-Janitor/` through iCloud while the companion is running; `activity_events.json` is hot-written and can conflict.
- Transfer bundle defaults to model artifacts only: `TabIdlePredictor.mlmodel`, `idle_lookup.json`, and `model_metrics.json`. Raw `activity_events.json` requires `--with-events` on export and import.
- Core ML public APIs expose requested compute units and hardware availability, but not the exact per-inference processor. Do not claim exact ANE usage for a single inference.
- `chrome.system.memory` permission added to manifest for memory pressure monitoring.
- DOMAIN_MAP hostname suffixes are matched right-to-left (longest suffix wins). Add new sites there first; only add to CATEGORIES keywords as a fallback.
- URL paths are never matched against generic category keywords — this is intentional to prevent false positives. Keep path exceptions narrow and explicit.
- Finalized (2026-05-01): IPC logic is synced for protocol version 2, including per-day `holidayLevels` for prediction requests. Hardware telemetry markers map cleanly to the popup UI components, and the NPU-disconnect scenario is handled with clearly labeled browser heuristic estimates. Categorizer v2 with DOMAIN_MAP-first architecture, holiday calendars, test/deploy mode, memory pressure + AI cleanup, and AI suggestions panel are implemented and syntax-verified.
- Added (2026-05-01): Closure learning system — `closure-learner.js` records manual_browser_close, manual_popup_close, and auto_cleanup events, then syncs them into the companion's shared `closure_samples.json`. Uses median background age × 1.5 to recommend per-category learned close-after times. Programmatic closes are suppressed from `tabs.onRemoved` manual learning, and auto_cleanup is context-only to avoid self-reinforcement. Runtime cleanup multiplies the learned time by foreground/background importance and idle context, then caps it with the user-facing maximum close-after slider.
- Added (2026-05-01): Protected tabs + foreground/background lifecycle. `getProtectedTabIds()` queries Chrome for active/pinned/audible tabs before any auto-close scan — both `performStaleCheck()` and `aiCleanup()` skip them. `lastForegroundAt` / `lastBackgroundedAt` replace `lastVisited` for stale detection (fallback for old entries). AI Cleanup scoring uses `backgroundAgeMs` + `focusRatio` for importance weighting.
- Adjusted (2026-05-01): `snapshotAllTabs()`, tab creation, tab navigation, popup active-tab display, and AI Suggestions now preserve/use `lastBackgroundedAt` consistently. Suggestions should not count protected tabs as stale.
- Revised (2026-05-03): SERP tabs are no longer excluded from closure learning. Search engine result pages now classify as `search` / `Search Results` and use isolated `search:<engine>` root-domain learning buckets from `extension/js/search-results.js`, so repeated manual closes can teach aggressive SERP cleanup without polluting broad categories or unrelated Google/Bing/Yahoo pages.
- Fixed (2026-05-01): Close-Time Learning UI in popup redesigned from chaotic `flex-wrap` rows to clean stacked cards (`cl-card`). Each category gets a header line (name + manual/auto counts + recommendation) and a detail line for foreground, background, and default close time. Removed the unused legend section.
- Note (2026-05-01): macOS Focus sync is user-local only. Do not commit a Focus helper script, Native Messaging IPC, installer hook, or Shortcut names to the cloud repo unless the user explicitly changes that policy. If needed, document it as a private local wrapper outside the repository.
- Updated (2026-05-01): DOMAIN_MAP expanded — `finviz.com` → finance, `oracle.com`/`microsoft.com` → work, `open.mimo.xiaomi.com` → work, `deepl.com`/`lingq.com`/`tutorialsdojo.com`/`eikaiwa.dmm.com`/`learn.microsoft.com`/`skillbuilder.aws` → reference. Reference category keywords updated to include certification/exam/translation terms.
- Added (2026-05-01): CPU usage monitoring — `chrome.system.cpu` permission, `getCPUUsage()` in background.js with snapshot-delta calculation, CPU bar in popup header alongside MEM bar.
- Fixed (2026-05-01): Holiday prediction badges now show the actual holiday name (e.g. `🎌 みどりの日`) instead of generic "Holiday" text. `getHolidayName()` is called per prediction day and the name is rendered in the badge and tooltip.
- Added (2026-05-02): Root-domain close-time learning now has priority over broad category thresholds for every learning-eligible root domain, not just `Other` / low-confidence pages. Category-level recommendations require broader manual evidence, and the broad `Other` category no longer emits a shared close-time recommendation.
- Added (2026-05-02): Domain category memory — high-confidence non-`other` classifications are remembered by root domain and reused for later low-confidence pages. Added stronger multilingual signals for finance articles (`金融危机`, `日元贬值`, `円安`), language learning (`godic.net`, `eudic.net`, `duolingo`), coding interview (`nowcoder.com`), Microsoft Rewards, IBKR, and anime/manga sites.
- Fixed (2026-05-02): Idle prior no longer trusts tiny Core ML artifacts. The companion ignores undertrained idle artifacts below 100 labeled samples, retrains stale/undertrained models, caps absurd all-day idle windows, and treats long active-event gaps as unknown instead of auto-labeling them idle. Popup health requests now record a fresh active signal before asking the companion, and health payloads expose both activity-adjusted idle confidence and raw prior for transparent UI.
