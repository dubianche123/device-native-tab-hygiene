# Smart Tab Hygiene

A Chrome/Edge extension that **learns when you're away from your Mac** using Apple's Core ML on the Neural Engine (NPU), and automatically closes stale browser tabs after category-specific idle thresholds.

中文说明见 [README.zh-CN.md](README.zh-CN.md).

## Why?

You leave 47 tabs open. Three days later, your MacBook sounds like a jet engine. Smart Tab Hygiene watches your patterns, knows when you're sleeping or away, and quietly closes tabs you haven't touched — categorising and recording them so nothing is lost.

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│  Chrome / Edge Extension (Manifest V3)                  │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────────┐ │
│  │ Tab      │  │ Category │  │ Stale Tab Checker     │ │
│  │ Tracker  │→ │ Engine   │→ │ (alarm every 30 min)  │ │
│  └──────────┘  └──────────┘  └───────────────────────┘ │
│       ↕                                    ↓            │
│  ┌──────────────────────┐    ┌───────────────────────┐ │
│  │ Native Messaging     │    │ Closed Tab Log        │ │
│  │ Client               │    │ (by category, local)  │ │
│  └──────────┬───────────┘    └───────────────────────┘ │
└─────────────┼───────────────────────────────────────────┘
              │ Native Messaging (stdio)
              ↓
┌─────────────────────────────────────────────────────────┐
│  macOS Companion App (Swift)                            │
│                                                         │
│  ┌──────────────────────┐  ┌─────────────────────────┐ │
│  │ Activity Collector   │→ │ Core ML Idle Predictor  │ │
│  │ (idle + tab context) │  │ (runs on ANE / NPU)     │ │
│  └──────────────────────┘  └─────────────────────────┘ │
│                                    ↓                    │
│                           Idle window predictions       │
│                           sent back to extension        │
└─────────────────────────────────────────────────────────┘
```

## Category Timeout Rules

| Category | Max Idle Time | Rationale |
|----------|--------------|-----------|
| **NSFW** | **12 hours** | Opened once, walked away — close ASAP |
| Social Media | 3 days | FOMO fades fast |
| Entertainment | 5 days | Netflix tab from Tuesday? Gone. |
| News | 5 days | Stale news is no news |
| Shopping | 7 days | Cart abandonment, but for tabs |
| Other | 7 days | Default for uncategorised URLs |
| Reference | 10 days | Stack Overflow answers age gracefully |
| Work & Productivity | 14 days | PRs and Jira tickets need time |
| Email & Communication | 14 days | Slack/Gmail may need session continuity |
| **Finance & Banking** | **14 days** | Banking sessions are precious but still sensitive |
| **AI Tools** | **30 days** | Long-running ChatGPT, Claude, Gemini, DeepSeek, Hugging Face, etc. sessions |

All thresholds are customisable in the extension popup settings. The popup also lets you close a tracked tab directly; those manual closes are written to the same Closed Log as automatic cleanups.

The popup status area also shows the local ML runtime. `Link: Connected` confirms Native Messaging, the training progress shows local sample maturity and measured training accuracy when available, and the decision panel shows the current idle confidence plus a short confidence curve. `ML` means the native companion is responding; `CPU` means lookup/heuristic fallback; `NPU`, `GPU`, and `CPU` chips show whether those local devices are available to Core ML Auto or whether CPU fallback is currently active. The green Low Power light is a visualisation based on recent local inference activity, not a direct wattage reading.

## Quick Start

### Prerequisites

- macOS 13+ (Ventura or later)
- Xcode Command Line Tools (`xcode-select --install`) to build locally, or a prebuilt `SmartTabHygieneCompanion` binary
- Chrome 88+ or Edge 88+

### 1. Load the Extension

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `Mimo/extension` directory
5. Copy the extension ID shown on the card

### 2. Build & Install the Companion

```bash
cd Mimo
chmod +x scripts/install.sh
./scripts/install.sh <extension-id>
```

This will:
- Build the Swift companion app in release mode
- Install it to `~/.local/bin/SmartTabHygieneCompanion`
- Register it as a Native Messaging host for Chrome & Edge

If you already have a prebuilt companion binary, you can skip the local Swift build:

```bash
MIMO_COMPANION_BINARY=/path/to/SmartTabHygieneCompanion ./scripts/install.sh YOUR_EXTENSION_ID
```

### 3. Restart the Browser

The companion starts automatically when the extension connects.
5. Copy the **extension ID** shown on the card

### 3. Link Extension ↔ Companion

Either rerun the installer with your extension ID:

```bash
./scripts/install.sh YOUR_EXTENSION_ID
```

Or edit the Native Messaging manifest:

```bash
# Chrome
vim ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.smarttabhygiene.companion.json

# Edge
vim ~/Library/Application\ Support/Microsoft\ Edge/NativeMessagingHosts/com.smarttabhygiene.companion.json
```

Replace `REPLACE_WITH_EXTENSION_ID` with your actual extension ID. Chrome and Edge both use the `chrome-extension://<id>/` origin format for Native Messaging.

### 4. Restart the Browser

The companion app starts automatically when the extension connects. You'll see activity in the extension popup's status bar.

### 5. (Optional) Bootstrap the ML Model

If you don't want to wait for the model to learn from scratch:

```bash
python3 scripts/train_model.py
```

This generates synthetic activity events and a fallback idle lookup based on typical human sleep/work schedules. The companion app will refine it over time with your actual activity data.

## Sharing / Distribution Notes

The browser extension can be loaded directly from `Mimo/extension` or packaged for the Chrome Web Store / Edge Add-ons store. The Apple ML companion is different: Chrome and Edge do not allow an extension package to install a Native Messaging host by itself. That native host must be installed separately by the user, by a signed macOS app, or by an installer package.

Practical distribution options:

- Extension-only mode: easiest for friends; uses browser idle signals and fallback predictions, but not Apple Core ML.
- Extension + install script: current developer-friendly path.
- Extension + signed macOS companion app/pkg: best polished path for public sharing.
- Prebuilt companion binary: avoids requiring friends to install Xcode/Swift, using `MIMO_COMPANION_BINARY=/path/to/SmartTabHygieneCompanion ./scripts/install.sh EXTENSION_ID`.

## Project Structure

```
Mimo/
├── extension/                    # Chrome/Edge extension
│   ├── manifest.json            # Manifest V3
│   ├── popup.html               # Extension popup UI
│   ├── css/popup.css            # Styles
│   ├── js/
│   │   ├── background.js        # Service worker (main logic)
│   │   ├── constants.js         # Categories, thresholds, keys
│   │   ├── storage.js           # chrome.storage.local wrappers
│   │   ├── categorizer.js       # URL → category classifier
│   │   ├── idle-detector.js     # Native Messaging client
│   │   ├── content.js           # Content script (activity ping)
│   │   └── popup.js             # Popup UI controller
│   └── icons/                   # Extension icons
├── companion/
│   └── MimoCompanion/
│       ├── Package.swift        # Swift Package Manager
│       ├── Sources/main.swift   # Native Messaging host + Core ML
│       └── Info.plist
└── scripts/
    ├── install.sh               # Build + register
    ├── uninstall.sh             # Clean removal
    └── train_model.py           # Bootstrap ML model
```

## ML / NPU Details

The idle prediction model is trained locally with **Create ML** and loaded with **Core ML**, which automatically dispatches inference to:

| Hardware | Backend | Power Draw |
|----------|---------|------------|
| Apple Silicon (M1/M2/M3/M4) | **ANE (Neural Engine)** | ~mW |
| Apple Silicon (fallback) | GPU | ~100mW |
| Intel Mac | CPU | ~1W |

The model is a boosted-tree tabular classifier:
- **Input**: day-of-week, hour, minute, weekend flag, minutes since last active event, active events in the last 24h, active days in the last 7d, tab count, and average dwell minutes
- **Output**: probability that the user is idle
- **Training**: Create ML boosted-tree classifier on browser activity + Chrome idle/locked events
- **Retraining**: automatic, daily, from accumulated activity data

If there is not enough training data yet, Smart Tab Hygiene uses a local lookup/fallback schedule until 100+ activity samples are available. On Apple Silicon, Core ML can use the ANE for low-power inference when the trained model is loaded.

## Data Storage

All data stays on your Mac:

| Data | Location |
|------|----------|
| Browser activity events | `~/Library/Application Support/Smart Tab Hygiene/activity_events.json` |
| ML model + lookup fallback | `~/Library/Application Support/Smart Tab Hygiene/TabIdlePredictor.mlmodel`, `~/Library/Application Support/Smart Tab Hygiene/idle_lookup.json` |
| Companion logs | `~/Library/Application Support/Smart Tab Hygiene/companion.log` |
| Closed tab records | Chrome extension storage (`chrome.storage.local`) |
| Tracked tab registry + dwell time | Chrome extension storage (`chrome.storage.local`) |

## Dwell-Time Tracking

Smart Tab Hygiene records foreground tab sessions whenever a tab becomes active, the window gains/loses focus, the browser becomes idle/locked, or the user interacts with the page. Each tracked tab keeps:

- `openedAt`
- `lastVisited`
- `dwellMs` (cumulative foreground time)
- `interactions`
- category confidence/source

The popup shows both stale age and cumulative time seen. Closed-tab records preserve dwell time, interactions, and a Chrome session id where available so the tab can be restored from the log.

**No data leaves your device.** No analytics, no telemetry, no cloud.

## How NSFW Detection Works

NSFW URLs get special treatment:

1. **Keyword matching**: URL hostname/path is checked against a curated keyword list
2. **Ultra-short threshold**: 12 hours (vs 7 days default)
3. **No idle-window gating**: NSFW tabs are closed immediately when stale, even during active hours — unlike other categories which prefer closing during predicted idle windows
4. **Separate log bucket**: Closed NSFW tabs are stored in their own category in the closed-tab log

The NSFW keyword list is conservative (major sites only) to avoid false positives. It can be extended in `constants.js`.

## Whitelist

Some tabs should never be auto-closed. Add domains to the whitelist in the extension popup settings:

```
docs.google.com
github.com/your-org
```

## Uninstalling

```bash
chmod +x scripts/uninstall.sh
./scripts/uninstall.sh
```

Then remove the extension from Chrome/Edge and delete the `Mimo/` directory.

## License

MIT
