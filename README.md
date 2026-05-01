<div align="right">
  <sub>
    <strong>English</strong> |
    <a href="README_CN.md">中文</a>
  </sub>
</div>

# Neural-Janitor: Edge-Accelerated Tab Hygiene

## A local Core ML browser automation engine

Neural-Janitor is a Chrome / Edge tab management extension powered by Apple's local machine learning stack. It tracks lightweight browsing signals, learns how long different kinds of tabs should stay open, and uses a local Swift companion to add idle-window prediction and on-device page classification.

The core rule is simple:
**tab management should learn from the user, and that learning should stay entirely on-device.**

## Runtime Dataflow (C4 Container View)

```mermaid
flowchart TB
  subgraph actors["External actors and platform APIs"]
    direction LR
    user(["Person<br/>Browser user"])
    chrome[["🧩 Chrome / Edge APIs<br/>tabs · idle · sessions · system"]]
  end

  subgraph browser["Container: Chrome / Edge Extension (Manifest V3)"]
    direction LR
    popup["🖥️ Popup UI<br/>Modes · Settings · ML console"]
    tracker["📍 Tab Tracker<br/>Focus · dwell · interactions"]
    category["🏷️ Category Engine<br/>Domain map · local signals · domain memory"]
    hygiene["🧹 Hygiene Orchestrator<br/>Check · AI Clean · test tags"]
    settings[("⚙️ Local Settings<br/>close-time caps · calendar · whitelist")]
    closedLog[("↩️ Closed Tab Log<br/>restore records")]
  end

  subgraph dataflow["IPC and local learning loop"]
    direction LR
    sampleBus["Activity samples<br/>tab state · page metadata"]
    nativeBus["Native Messaging<br/>Protocol v2 JSON over stdio"]
    resultBus["Predictions · health · classification<br/>idle windows · telemetry"]
  end

  subgraph native["Container: macOS Swift Companion"]
    direction LR
    collector["📥 Activity Collector<br/>idle state · tab context"]
    classifier["🔤 Local Page Classifier<br/>NaturalLanguage scoring"]
    predictor["🧠 The Chronos Engine<br/>9-feature Core ML predictor"]
    artifacts[("🗄️ Application Support<br/>events · lookup · model metrics")]
  end

  coreml[["⚡ Apple Core ML Runtime<br/>ANE · GPU · CPU scheduler"]]

  user --> popup
  chrome --> tracker
  popup --> hygiene
  tracker --> category --> hygiene
  settings --> hygiene
  hygiene -->|"close · tag · restore"| chrome
  hygiene --> closedLog
  tracker --> sampleBus
  category --> sampleBus
  sampleBus --> nativeBus --> collector
  category --> nativeBus --> classifier
  collector --> artifacts
  artifacts --> predictor
  classifier --> predictor
  predictor <--> coreml
  predictor --> resultBus --> popup
  classifier --> resultBus

  style actors fill:#f8fafc,stroke:#cbd5e1,stroke-width:1px
  style dataflow fill:none,stroke:#94a3b8,stroke-width:1px

  classDef person fill:#f9f2d7,stroke:#b59b3b,color:#2f2611,stroke-width:1px
  classDef browser fill:#e9f7ff,stroke:#2684b8,color:#102a3a,stroke-width:1.5px
  classDef native fill:#ecfdf3,stroke:#2f9d66,color:#123522,stroke-width:1.5px
  classDef ml fill:#eef2ff,stroke:#6366f1,color:#111827,stroke-width:2px
  classDef data fill:#fff7ed,stroke:#d97706,color:#3a2206,stroke-width:1px
  classDef bus fill:none,stroke:#94a3b8,color:#334155,stroke-width:1px
  classDef external fill:#f3f4f6,stroke:#6b7280,color:#1f2937,stroke-width:1px

  class user person
  class popup,tracker,category,hygiene browser
  class collector,classifier native
  class predictor ml
  class closedLog,settings,artifacts data
  class sampleBus,nativeBus,resultBus bus
  class coreml,chrome external
```

The two execution contexts are intentionally split:
- **Browser context**: tracks focus, dwell, interactions, classification, and cleanup actions.
- **Native context**: handles local training, idle prediction, hardware telemetry, and NLP fallback classification.

## Why This Exists

Hardcoded timers are predictable, but they are also blunt. A tab that sat untouched for two days might still matter if it was a long research session; another might be disposable after ten minutes. Neural-Janitor treats close time as something to learn from your own behavior instead of something to hardcode once.

| Problem | Traditional Tab Closers | Neural-Janitor |
|:--|:--|:--|
| **When to close?** | Static timer such as 3 or 7 days. | Learned close time × tab importance × idle context multiplier. |
| **Categorization** | Simple domain matching. | Domain map + page signals + local NLP fallback. |
| **Resource Cost** | Constant background polling. | Event-driven worker + local Core ML inference. |
| **Privacy** | Often cloud-backed. | 100% local. No telemetry leaves the device. |

## Current Feature Set

- **Test / Deploy modes**: Test mode tags tabs that would be closed; Deploy mode actually closes them and writes to the closed-tab log.
- **Category-aware retention**: AI, work, finance, email, reference, social, entertainment, shopping, news, NSFW, and `Other` each have their own close-time cap.
- **Manual closure learning**: Real browser closes and popup closes become local training samples.
- **Root-domain fallback learning**: Hard-to-classify sites can still get their own learned behavior instead of being mixed into one huge `Other` bucket.
- **Holiday-aware idle predictions**: Japan and China calendars can widen or shift likely idle windows in the ML insights view.
- **AI Cleanup**: Prioritizes reducing tab count first, then bounded memory-pressure cleanup, while protecting active, pinned, audible, and high-priority tabs.
- **Transparent telemetry UI**: Memory, CPU, model readiness, closure learning, and idle-confidence state are shown directly in the popup.
- **Closed-tab recovery**: Tabs closed by the extension can be restored one-by-one or in batches.

## Category Closure Time Rules

Tabs are assigned a close time from four inputs: category defaults, learned manual-close behavior, root-domain fallback history, and per-tab importance. The Settings sliders are caps, not replacements; the model can close sooner, but it cannot keep a tab longer than the configured maximum.

| Category | Max Idle Time | Rationale |
|----------|--------------|-----------|
| **NSFW** | **12 hours** | Opened once, walked away. Close quickly. |
| Social Media | 3 days | Fast-decaying value. |
| Entertainment | 5 days | Often revisit-able but not work-critical. |
| News | 5 days | Freshness matters. |
| Shopping | 7 days | Useful, but not indefinitely. |
| Other | 7 days | Conservative default for uncategorized pages. |
| Reference | 10 days | Documentation and articles often stay relevant. |
| Work & Productivity | 14 days | PRs, tickets, and drafts need time. |
| Email & Communication | 14 days | Session continuity can matter. |
| **Finance & Banking** | **30 days** | High-value sessions, but not permanent. |
| **AI Tools** | **30 days** | Long-running research and chat sessions are often intentional. |

## Architecture

### 1. Tab Interaction Tracker

The tracker records when a tab enters foreground, leaves foreground, how long it stayed there, and how often you interacted with it. Cleanup compares `now - lastBackgroundedAt` against an effective close time instead of relying on simple "opened at" age.

### 2. Manual Closure Learner

Manual closes are the primary signal. The learner stores category, root domain, foreground dwell, background age, and interactions, then recommends close times from meaningful manual samples. Automatic cleanup samples are kept as context only so the system does not train on its own decisions.

### 3. Local Page Classifier

The browser classifies pages with a domain map and content signals first. When confidence is low, the Swift companion uses Apple `NaturalLanguage` to score the page title, description, and text. The browser also keeps a small root-domain category memory so repeat sites do not keep falling back to `Other`.

### 4. Auxiliary Idle Predictor

The companion trains a 9-feature `TrainingSample` model from local activity history. That model is deliberately auxiliary: it influences idle-context multipliers and the ML console, while close-time learning remains the main decision source.

### 5. Holiday-Aware Idle Windows

The browser sends per-day holiday levels for the next seven calendar dates to the companion. This lets a Monday holiday change Monday's prediction even if today is a normal workday. Workday and weekend/holiday sleep-wake windows act as priors, not hard cleanup rules.

### 6. Memory Pressure Cleanup

AI Cleanup scores tabs by category priority, interaction count, and idle age. Lower-value, low-interaction, long-idle tabs are cleaned first. In Test mode, the same logic tags tabs instead of closing them.

## Security And Privacy

- **No cloud analytics**: Activity logs, models, and tab registries stay on the Mac and in extension local storage.
- **No remote tracking scripts**: The extension does not inject remote code or analytics pixels.
- **Local model only**: Core ML training and inference stay on-device.
- **Native Messaging boundary**: Browser JS and Swift communicate with length-prefixed local JSON over stdio.

## Setup Instructions

Native Messaging requires a native host manifest on macOS. Chrome / Edge cannot install that host silently, so a one-time install step is still required unless the companion is packaged as a signed installer.

### 1. Clone or open the repository

```bash
cd Neural-Janitor
```

### 2. Load the extension

Open `chrome://extensions` or `edge://extensions`, enable Developer Mode, choose **Load unpacked**, and select:

```text
extension/
```

Copy the extension ID shown by the browser.

### 3. Build and link the companion

```bash
chmod +x scripts/install.sh
./scripts/install.sh YOUR_EXTENSION_ID
```

Reload the extension afterward. The companion starts when the extension opens a Native Messaging connection.

### 4. After companion changes

If the Swift companion or native host metadata changes, rerun:

```bash
./scripts/install.sh YOUR_EXTENSION_ID
```

## Moving The Local Model Between Macs

Neural-Janitor stores learned artifacts in:

```text
~/Library/Application Support/Neural-Janitor/
```

Do not live-sync that folder through iCloud while the companion is running. Use the export/import scripts instead.

### Export on the source Mac

```bash
./scripts/export_model_bundle.sh --output ~/Desktop
```

To include raw activity history as well:

```bash
./scripts/export_model_bundle.sh --with-events --output ~/Desktop
```

### Import on the target Mac

Install Neural-Janitor first, then run:

```bash
./scripts/import_model_bundle.sh ~/Desktop/neural-janitor-model-bundle-YYYYMMDD-HHMMSS.tar.gz
```

To intentionally restore `activity_events.json` too:

```bash
./scripts/import_model_bundle.sh --with-events ~/Desktop/neural-janitor-model-bundle-YYYYMMDD-HHMMSS.tar.gz
```

The import script verifies checksums and backs up any existing local artifacts under:

```text
~/Library/Application Support/Neural-Janitor/backups/
```

Reload the browser extension after importing so the companion reloads the model.

## Using The Popup

- **Check**: Runs a stale-tab check immediately.
- **AI Clean**: Uses tab count, memory pressure, importance, and whitelist rules to decide what to clean.
- **MEM / CPU**: Shows current memory pressure, CPU usage, and compact CPU model / thread count.
- **ML Insights**: Shows idle windows for the next seven days with workday, weekend, or holiday labels.
- **Settings**: Controls companion usage, calendar selection, close-time caps, whitelist, timed blacklist, and AI Cleanup targets.

## Development Checks

```bash
node --check extension/js/background.js
node --check extension/js/content.js
node --check extension/js/constants.js
node --check extension/js/categorizer.js
node --check extension/js/holidays.js
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

<p align="center"><sub>Neural-Janitor: Edge-Accelerated Tab Hygiene — The Chronos Engine</sub></p>
