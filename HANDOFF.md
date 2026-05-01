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
- `predict`: returns `idlePredictions` plus nested `health`.
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

## Current Operational Notes

- Browser extension install is still Load Unpacked from `extension/`.
- Full local ML requires rerunning `./scripts/install.sh <extension-id>` after the native host id rename.
- Chrome/Edge cannot silently install a Native Messaging host from an extension package; a script, signed app, or pkg installer is still required for companion setup.
- Core ML public APIs expose requested compute units and hardware availability, but not the exact per-inference processor. Do not claim exact ANE usage for a single inference.
- Finalized (2026-05-01): IPC logic is perfectly synced for protocol version 2, hardware telemetry markers map cleanly to the popup UI components, and the NPU-disconnect scenario is robustly handled using fallback browser heuristics.
