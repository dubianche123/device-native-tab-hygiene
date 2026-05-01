<div align="right">
  <sub>
    <strong>English</strong> |
    <a href="README_CN.md">中文</a>
  </sub>
</div>

# Neural-Janitor: Edge-Accelerated Tab Hygiene

## A local, NPU-powered browser automation engine

**Version**: 1.0 MVP  
**Author**: Leo  
**Date**: May 2026  

Neural-Janitor is an intelligent browser tab management extension wrapped around Apple's local Machine Learning stack. The visible product is a smart tab closer, but the core subject is a method: how to capture browser behavioral telemetry, compress it locally, and predict user idle states using the Neural Engine (NPU) without ever touching the cloud.

The project is built around a simple engineering principle:

**Tab management should learn from the user, but the learning must happen entirely on-device and at near-zero power cost.**

Underneath the browser extension, the system records lightweight behavioral signals, and the macOS Swift companion app compresses them into training samples. Core ML then evaluates these samples locally on the Apple Neural Engine.

## Runtime Dataflow

```text
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
│  │ Activity Collector   │→ │ Core ML Predictor       │ │
│  │ (timestamps, state)  │  │ (runs on ANE / NPU)     │ │
│  └──────────────────────┘  └─────────────────────────┘ │
│                                    ↓                    │
│                           Idle window predictions       │
│                           sent back to extension        │
└─────────────────────────────────────────────────────────┘
```

This diagram separates the two execution contexts:
- **Browser Context**: Manifest V3 extension tracking tab focus, interaction, and content category.
- **Native Context**: Swift companion app handling model training, prediction, and local NLP classification.

## Why This Exists

Many modern browser tab managers rely on simple hardcoded timers (e.g., "close tabs after 3 days"). This is predictable but fundamentally flawed: a user might be actively using their computer but just not that specific tab, or they might be on a two-week vacation.

Neural-Janitor uses a narrower but smarter model role. It builds a `MLBoostedTreeClassifier` to predict when the user is actually away from the Mac. It only cleans tabs during predicted prolonged idle windows, ensuring you never return to a suddenly missing workspace.

| Problem | Traditional Tab Closers | The Neural-Janitor Pattern |
|:--|:--|:--|
| **When to close?** | Hardcoded static timer (e.g., 7 days). | Dynamic timer gated by Core ML idle prediction. |
| **Categorization** | Simple URL domain matching. | On-device NLP via Apple `NaturalLanguage` framework. |
| **Resource Cost** | Constant JavaScript polling in background. | Event-driven background worker + NPU-accelerated inference. |
| **Privacy** | Often requires syncing data to the cloud. | 100% local. Zero telemetry leaves the device. |

## Category Timeout Rules

Tabs are assigned an idle threshold based on their category. The companion app handles the categorization using local keyword heuristics and Natural Language tokenization.

| Category | Max Idle Time | Rationale |
|----------|--------------|-----------|
| **NSFW** | **12 hours** | Opened once, walked away — close ASAP. Does not wait for idle window. |
| Social Media | 3 days | FOMO fades fast. |
| Entertainment | 5 days | Netflix tab from Tuesday? Gone. |
| News | 5 days | Stale news is no news. |
| Shopping | 7 days | Cart abandonment, but for tabs. |
| Other | 7 days | Default for uncategorized URLs. |
| Reference | 10 days | Stack Overflow answers age gracefully. |
| Work & Productivity | 14 days | PRs and Jira tickets need time. |
| Email & Communication | 14 days | Slack/Gmail may need session continuity. |
| **Finance & Banking** | **30 days** | Banking sessions are precious but not immortal. |

## Architecture

The system is split into two deployable artifacts:

1. **Manifest V3 Extension**: Handles browser tabs, injects content scripts for interaction tracking, manages the closed tab local registry, and communicates with the companion app via Native Messaging.
2. **Swift Companion App**: An invisible macOS daemon that aggregates the behavioral data, trains the local ML model, and serves predictions and page classifications.

### 1. Tab Interaction Tracker
Tracks `openedAt`, `lastVisited`, `dwellMs` (cumulative foreground time), and `interactions`. When a tab is closed, these metrics are preserved in a `chrome.sessions` bound log so it can be restored exactly as it was.

### 2. Local Page Classifier
When the extension cannot confidently categorize a URL, it asks the companion app. The companion uses the Apple `NaturalLanguage` framework to tokenize the page title, description, and content, scoring them against a weighted taxonomy.

### 3. Core ML Predictor
The companion builds a 9-feature `TrainingSample` from historical activity (day of week, time, dwell averages, tab count, weekend flags, etc.). It continuously trains a `MLBoostedTreeClassifier`. By compiling to Core ML, macOS automatically schedules the inference workload onto the Apple Neural Engine (ANE) on Apple Silicon, drawing negligible power (milliwatts).

## Security And Privacy

- **No Cloud Analytics**: All activity logs, ML models, and tab registries stay entirely on `~/Library/Application Support/Mimo/` and the extension's local storage.
- **Zero Tracker Injections**: Does not inject remote scripts or tracking pixels.
- **Local Model Only**: The Core ML model is trained exclusively on your machine, using your data.

## Transferable Pattern

The useful pattern is not just tab closing. It is:
**browser telemetry + local Swift companion + NPU-accelerated ML inference**

This can transfer to:
- **Local Ad Blockers**: Train a model on your browsing habits to pre-emptively block dynamic tracking patterns.
- **Focus Agents**: Block distracting sites automatically during predicted deep-work periods.
- **Content Summarizers**: Offload heavy DOM parsing and summarization to native Swift rather than keeping V8 busy.

## Setup Instructions

### 1. Build the Companion
```bash
cd Mimo
chmod +x scripts/install.sh
./scripts/install.sh
```

### 2. Load the Extension
Load the `Mimo/extension` folder as an unpacked extension in Chrome/Edge. Copy the Extension ID.

### 3. Link Extension
```bash
./scripts/install.sh YOUR_EXTENSION_ID
```
Restart your browser. The companion will automatically start.

## Conclusion

Neural-Janitor tests an architectural stance: we don't need cloud LLMs for every intelligent feature. By combining Manifest V3's event-driven architecture with macOS's native ML capabilities, we can achieve context-aware automation that is private, performant, and deeply integrated into the operating system.

<p align="center"><sub>Neural-Janitor: Edge-Accelerated Tab Hygiene</sub></p>
