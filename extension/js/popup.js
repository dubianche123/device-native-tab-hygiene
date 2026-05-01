/**
 * Neural-Janitor — Popup Controller
 *
 * Renders three panels:
 *   1. Active Tabs  — currently tracked tabs with category badges & age
 *   2. Closed Log   — historically closed tabs, filterable by category
 *   3. ML Predictions — idle-window predictions from the companion app
 * Plus a settings overlay.
 */

import { APP_NAME, CATEGORIES, DEFAULT_CATEGORY, HARDWARE_MARKER_STATES } from './constants.js';

// ── Helpers ──────────────────────────────────────────────────────────

function formatAge(ms) {
  ms = Math.max(0, ms || 0);
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

function formatRelativeTime(timestampMs) {
  if (!timestampMs) return 'Not yet';
  const delta = Math.max(0, Date.now() - timestampMs);
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatPercent(value, digits = 0) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '--';
  return `${(value * 100).toFixed(digits)}%`;
}

function formatDays(value) {
  const days = Number(value) || 0;
  return days >= 10 ? days.toFixed(0) : days.toFixed(1);
}

function formatClock(hour, minute) {
  if (typeof hour !== 'number') return '';
  return `${String(hour).padStart(2, '0')}:${String(minute || 0).padStart(2, '0')}`;
}

function getCategoryInfo(key) {
  return CATEGORIES[key] || { label: 'Other', color: DEFAULT_CATEGORY.color };
}

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function escapeHTML(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function liveDwellMs(entry) {
  const base = entry.dwellMs || 0;
  if (entry.active && entry.lastActivatedAt) {
    return base + Math.max(0, Date.now() - entry.lastActivatedAt);
  }
  return base;
}

function faviconURL(entry) {
  return entry?.favIconUrl || null;
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, resolve);
  });
}

function shortRuntimeLabel(status = {}) {
  if (status.runtime === 'disabled') return 'OFF';
  if (status.runtime === 'coreml') return 'ML';
  if (status.runtime === 'lookup') return 'CPU';
  if (status.runtime === 'heuristic') return 'CPU';
  return status.connected ? 'ML' : 'CPU';
}

function deviceClass(device = {}) {
  const state = device.state || HARDWARE_MARKER_STATES.STANDBY;
  if (Object.values(HARDWARE_MARKER_STATES).includes(state)) {
    return `ml-device--${state}`;
  }
  return 'ml-device--standby';
}

function telemetryDevices(status = {}) {
  return status.hardwareTelemetry?.devices || status.devices || [
    {
      key: 'npu',
      label: 'NPU',
      state: HARDWARE_MARKER_STATES.ERROR,
      detail: 'Apple Neural Engine telemetry unavailable',
    },
    {
      key: 'gpu',
      label: 'GPU',
      state: HARDWARE_MARKER_STATES.ERROR,
      detail: 'Metal GPU telemetry unavailable',
    },
    {
      key: 'cpu',
      label: 'CPU',
      state: HARDWARE_MARKER_STATES.ACTIVE,
      detail: 'Browser heuristic',
    },
  ];
}

function renderMLStatus(status = {}) {
  const el = document.getElementById('ml-status');
  const devices = telemetryDevices(status);

  el.innerHTML = `
    <span class="ml-status__mode">${escapeHTML(shortRuntimeLabel(status))}</span>
    ${devices.map(device => `
      <span class="ml-device ${deviceClass(device)}" data-device="${escapeHTML(device.key || '')}">
        ${escapeHTML(device.label || device.key || '')}
      </span>
    `).join('')}
  `;

  const runtime = status.runtimeLabel || (status.connected ? 'Local ML' : 'Heuristic fallback');
  const engine = status.engineCodename ? `engine=${status.engineCodename}` : '';
  const compute = status.computeUnits ? `compute=${status.computeUnits}` : '';
  const telemetry = status.telemetryStatus || status.hardwareTelemetry?.status || 'unknown';
  const deviceSummary = devices
    .map(device => `${device.label || device.key}: ${device.state || 'standby'}${device.available === false ? ' (unavailable)' : ''}`)
    .join(' | ');
  el.title = [runtime, engine, compute, `telemetry=${telemetry}`, deviceSummary, status.note]
    .filter(Boolean)
    .join(' - ');
}

function acceleratorLabel(status = {}) {
  const devices = telemetryDevices(status);
  const npu = devices.find(device => device.key === 'npu');
  if (status.runtime === 'coreml' && npu?.available) return 'NPU-eligible';
  if (status.runtime === 'coreml') return 'Core ML';
  if (status.runtime === 'lookup') return 'CPU Lookup';
  if (status.runtime === 'disabled') return 'ML Off';
  return 'CPU Heuristic';
}

function retrainRuntimeLabel(status = {}) {
  const runtime = status.lastRetrainRuntime || status.runtimeLabel || 'local model';
  const devices = telemetryDevices(status);
  const npu = devices.find(device => device.key === 'npu');
  if (runtime === 'Core ML Auto' && npu?.available) return 'Core ML Auto (NPU eligible)';
  return runtime;
}

function computePathExplanation(status = {}) {
  const runtime = status.runtime || 'heuristic';
  const devices = telemetryDevices(status);
  const npu = devices.find(device => device.key === 'npu');
  const gpu = devices.find(device => device.key === 'gpu');
  const cpu = devices.find(device => device.key === 'cpu');

  if (runtime === 'coreml') {
    const eligible = [
      npu?.available ? 'NPU eligible' : null,
      gpu?.available ? 'GPU eligible' : null,
      cpu?.available ? 'CPU fallback ready' : null,
    ].filter(Boolean).join(', ');
    return `Core ML Auto (${eligible || 'Apple runtime managed'})`;
  }
  if (runtime === 'lookup') {
    return `CPU lookup fallback (${status.trainingSamples || 0} local samples)`;
  }
  if (runtime === 'disabled') {
    return 'Companion disabled in settings';
  }
  if (status.connected === false) {
    return `Browser CPU heuristic; NPU telemetry ${status.disconnectReason || 'offline'}`;
  }
  const count = status.activityCount || status.trainingSamples || 0;
  const min = status.minimumTrainingSamples || 100;
  if (count >= min && !status.modelLoaded && status.runtime !== 'lookup') {
    return `CPU heuristic (awaiting idle/active variety for Core ML)`;
  }
  return `CPU heuristic (${count}/${min} samples before Core ML)`;
}

function renderConfidenceCurve(curve = []) {
  const container = document.getElementById('confidence-curve');
  if (!container) return;

  const points = curve.length > 0
    ? curve
    : [{ offsetMinutes: 0, confidence: 0, hour: 0, minute: 0 }];

  container.innerHTML = points.slice(0, 7).map((point) => {
    const confidence = Math.max(0, Math.min(1, point.confidence || 0));
    const label = point.offsetMinutes === 0 ? 'now' : `+${Math.round(point.offsetMinutes / 60 * 10) / 10}h`;
    return `
      <div class="confidence-curve__bar" title="${formatClock(point.hour, point.minute)} ${formatPercent(confidence)}">
        <div class="confidence-curve__fill" style="height:${Math.max(6, confidence * 28)}px"></div>
        <div class="confidence-curve__label">${escapeHTML(label)}</div>
      </div>`;
  }).join('');
}

function renderMLConsole(status = {}) {
  const link = document.getElementById('ml-link');
  const samples = document.getElementById('ml-samples');
  const progress = document.getElementById('ml-progress-fill');
  const trainingStatus = document.getElementById('ml-training-status');
  const computePath = document.getElementById('ml-compute-path');
  const accuracy = document.getElementById('ml-accuracy');
  const retrain = document.getElementById('ml-retrain');
  const decision = document.getElementById('decision-headline');
  const power = document.getElementById('power-light');

  const trainingSamples = status.trainingSamples || status.activityCount || 0;
  const targetSamples = status.targetTrainingSamples || 1000;
  const minimumSamples = status.minimumTrainingSamples || 100;
  const maturity = typeof status.modelMaturity === 'number'
    ? status.modelMaturity
    : Math.min(1, trainingSamples / targetSamples);

  link.textContent = status.connected ? 'Connected' : 'Disconnected';
  link.style.color = status.connected ? 'var(--success)' : 'var(--danger)';
  const isAwaitingVariety = !status.modelLoaded && trainingSamples >= minimumSamples;
  const displaySamples = isAwaitingVariety ? minimumSamples - 1 : trainingSamples;

  samples.textContent = status.modelLoaded
    ? `${trainingSamples.toLocaleString()} / ${targetSamples.toLocaleString()}`
    : isAwaitingVariety
      ? `${displaySamples.toLocaleString()} / ${minimumSamples.toLocaleString()} (Needs idle data)`
      : `${displaySamples.toLocaleString()} / ${minimumSamples.toLocaleString()} for Core ML`;
  
  const displayMaturity = isAwaitingVariety 
    ? (minimumSamples - 1) / minimumSamples 
    : maturity;
  progress.style.width = `${Math.round(Math.max(0, Math.min(1, displayMaturity)) * 100)}%`;
  trainingStatus.textContent = status.readinessReason || status.runtimeLabel || 'Checking local runtime';
  trainingStatus.title = trainingStatus.textContent;
  computePath.textContent = computePathExplanation(status);
  computePath.title = status.note || computePath.textContent;
  accuracy.textContent = typeof status.modelAccuracy === 'number'
    ? formatPercent(status.modelAccuracy, 1)
    : 'Collecting';

  const retrainAge = formatRelativeTime(status.lastTrainingCompletedAt);
  retrain.textContent = status.lastTrainingCompletedAt
    ? `${retrainAge} on ${retrainRuntimeLabel(status)}`
    : 'Not yet';

  const confidence = typeof status.currentIdleConfidence === 'number'
    ? status.currentIdleConfidence
    : 0;
  decision.textContent = `${acceleratorLabel(status)} Predicts Idle Confidence: ${formatPercent(confidence)}`;
  decision.title = status.readinessReason || '';
  renderConfidenceCurve(status.confidenceCurve || []);

  power.className = 'power-light';
  if (!status.connected || status.runtime === 'disabled') {
    power.classList.add('power-light--off');
    power.title = 'Low Power Mode: offline';
  } else if (status.powerSignal === 'breathing') {
    power.classList.add('power-light--breathing');
    power.title = 'Low Power Mode: recent local inference';
  } else {
    power.classList.add('power-light--standby');
    power.title = 'Low Power Mode: standing by';
  }
}

// ── Tab Navigation ───────────────────────────────────────────────────

document.querySelectorAll('.tabs__btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs__btn').forEach(b => b.classList.remove('tabs__btn--active'));
    btn.classList.add('tabs__btn--active');
    const target = btn.dataset.tab;
    document.querySelectorAll('.panel').forEach(p => p.classList.add('panel--hidden'));
    document.getElementById(`panel-${target}`).classList.remove('panel--hidden');
    // Hide settings when switching tabs
    document.getElementById('panel-settings').classList.add('panel--hidden');
  });
});

// ── Settings Toggle ──────────────────────────────────────────────────

document.getElementById('btn-settings').addEventListener('click', () => {
  const settingsPanel = document.getElementById('panel-settings');
  const isHidden = settingsPanel.classList.contains('panel--hidden');
  document.querySelectorAll('.panel').forEach(p => p.classList.add('panel--hidden'));
  if (isHidden) {
    settingsPanel.classList.remove('panel--hidden');
    loadSettings();
  }
});

// ── Force Check ──────────────────────────────────────────────────────

document.getElementById('btn-force-check').addEventListener('click', async () => {
  const btn = document.getElementById('btn-force-check');
  const statusText = document.getElementById('status-text');
  btn.disabled = true;
  btn.textContent = 'Checking';
  const response = await sendMessage({ type: 'forceCheck' });
  const closed = response?.closedCount || 0;
  btn.textContent = closed > 0 ? `Closed ${closed}` : 'Checked';
  statusText.textContent = response?.disabled
    ? 'Auto-cleanup is disabled'
    : `Checked ${response?.scannedCount ?? 0} tabs, closed ${closed}`;
  await loadActiveTabs();
  await loadClosedLog();
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = 'Check';
    updateStatus();
  }, 1800);
});

// ── Active Tabs ──────────────────────────────────────────────────────

async function loadActiveTabs() {
  const registry = await sendMessage({ type: 'getRegistry' });
  const list = document.getElementById('active-tab-list');
  const entries = Object.entries(registry || {});

  document.getElementById('active-count').textContent = entries.length;

  if (entries.length === 0) {
    list.innerHTML = '<div class="empty-state">No tracked tabs</div>';
    return;
  }

  // Sort by category priority (lowest first = most urgent)
  entries.sort((a, b) => {
    const pa = (CATEGORIES[a[1].category] || DEFAULT_CATEGORY).priority || 50;
    const pb = (CATEGORIES[b[1].category] || DEFAULT_CATEGORY).priority || 50;
    return pa - pb;
  });

  list.innerHTML = entries.map(([tabId, entry]) => {
    const cat = getCategoryInfo(entry.category);
    const age = Date.now() - (entry.lastVisited || Date.now());
    const dwell = liveDwellMs(entry);
    const maxAge = cat.maxAgeMs || DEFAULT_CATEGORY.maxAgeMs;
    const pct = Math.min(100, (age / maxAge) * 100);
    const urgencyClass = pct > 80 ? 'color: var(--danger)' : pct > 50 ? 'color: var(--warning)' : '';
    const favicon = faviconURL(entry);

    return `
      <div class="tab-item" data-url="${escapeHTML(entry.url)}">
        ${favicon
          ? `<img class="tab-item__favicon" src="${escapeHTML(favicon)}" onerror="this.outerHTML='<div class=\\'tab-item__favicon tab-item__favicon--fallback\\'>🌐</div>'">`
          : '<div class="tab-item__favicon tab-item__favicon--fallback">🌐</div>'}
        <div class="tab-item__info">
          <div class="tab-item__title">${escapeHTML(entry.title || getDomain(entry.url))}</div>
          <div class="tab-item__url">${escapeHTML(getDomain(entry.url))}</div>
        </div>
        <div class="tab-item__meta">
          <span class="tab-item__badge" style="background:${cat.color}20; color:${cat.color}">${escapeHTML(cat.label)}</span>
          <span class="tab-item__age" style="${urgencyClass}">idle ${formatAge(age)} / ${formatAge(maxAge)}</span>
          <span class="tab-item__age">seen ${formatAge(dwell)}</span>
          <button class="btn btn--sm btn-close-tab" data-tab-id="${escapeHTML(tabId)}" title="Close and add to Closed Log">Close &amp; Log</button>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.btn-close-tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Closing';
      const response = await sendMessage({
        type: 'closeTrackedTab',
        tabId: btn.dataset.tabId,
        reason: 'manual_popup_close',
      });
      btn.textContent = response?.ok ? 'Closed' : 'Failed';
      await loadActiveTabs();
      await loadClosedLog();
    });
  });
}

// ── Closed Log ───────────────────────────────────────────────────────

let currentFilter = 'all';

async function loadClosedLog() {
  const closedLog = await sendMessage({ type: 'getClosedLog' }) || {};

  // Flatten & sort by closedAt descending
  const allEntries = [];
  for (const [category, entries] of Object.entries(closedLog)) {
    for (const entry of entries) {
      allEntries.push({ ...entry, category });
    }
  }
  allEntries.sort((a, b) => b.closedAt - a.closedAt);

  // Build category filter buttons
  const filterContainer = document.getElementById('category-filters');
  const categories = ['all', ...Object.keys(closedLog)];
  filterContainer.innerHTML = categories.map(cat => {
    const label = cat === 'all' ? 'All' : getCategoryInfo(cat).label;
    const active = currentFilter === cat ? 'category-filter--active' : '';
    return `<button class="category-filter ${active}" data-cat="${cat}">${label}</button>`;
  }).join('');

  filterContainer.querySelectorAll('.category-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      currentFilter = btn.dataset.cat;
      loadClosedLog();
    });
  });

  // Filter entries
  const filtered = currentFilter === 'all'
    ? allEntries
    : allEntries.filter(e => e.category === currentFilter);

  document.getElementById('closed-count').textContent = allEntries.length;

  const list = document.getElementById('closed-tab-list');
  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-state">No closed tabs yet</div>';
    return;
  }

  list.innerHTML = filtered.slice(0, 100).map(entry => {
    const cat = getCategoryInfo(entry.category);
    const closedDate = new Date(entry.closedAt).toLocaleDateString();
    const favicon = faviconURL(entry);
    const restored = Boolean(entry.restoredAt);

    return `
      <div class="tab-item">
        ${favicon
          ? `<img class="tab-item__favicon" src="${escapeHTML(favicon)}" onerror="this.outerHTML='<div class=\\'tab-item__favicon tab-item__favicon--fallback\\'>🌐</div>'">`
          : '<div class="tab-item__favicon tab-item__favicon--fallback">🌐</div>'}
        <div class="tab-item__info">
          <div class="tab-item__title">${escapeHTML(entry.title || getDomain(entry.url))}</div>
          <div class="tab-item__url">${escapeHTML(entry.url)}</div>
        </div>
        <div class="tab-item__meta">
          <span class="tab-item__badge" style="background:${cat.color}20; color:${cat.color}">${escapeHTML(cat.label)}</span>
          <span class="tab-item__age">${restored ? 'Restored' : `Closed ${closedDate}`}</span>
          <span class="tab-item__age">seen ${formatAge(entry.dwellMs || 0)}</span>
          ${restored
            ? ''
            : `<button class="btn btn--sm btn-restore" data-cat="${escapeHTML(entry.category)}" data-id="${escapeHTML(entry.id)}" data-url="${escapeHTML(entry.url)}" data-session-id="${escapeHTML(entry.sessionId || '')}">Restore</button>`}
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.btn-restore').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Restoring';
      const response = await sendMessage({
        type: 'restoreClosedTab',
        category: btn.dataset.cat,
        id: btn.dataset.id,
        url: btn.dataset.url,
        sessionId: btn.dataset.sessionId || null,
      });
      btn.textContent = response?.ok ? 'Restored' : 'Failed';
      await loadClosedLog();
    });
  });
}

// ── Export ───────────────────────────────────────────────────────────

document.getElementById('btn-export').addEventListener('click', async () => {
  const closedLog = await sendMessage({ type: 'getClosedLog' }) || {};
  const blob = new Blob([JSON.stringify(closedLog, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `neural-janitor-closed-log-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// ── ML Predictions ───────────────────────────────────────────────────

async function loadPredictions() {
  const predictions = await sendMessage({ type: 'requestPredictions' }) || {};
  await updateMLStatus();
  const container = document.getElementById('predictions-content');
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const entries = Object.entries(predictions);
  if (entries.length === 0) {
    container.innerHTML = '<div class="empty-state">No predictions available. Start the companion app.</div>';
    return;
  }

  container.innerHTML = entries.map(([day, pred]) => {
    const startH = Math.floor(pred.startHour);
    const startM = Math.round((pred.startHour % 1) * 60);
    const endH = Math.floor(pred.endHour);
    const endM = Math.round((pred.endHour % 1) * 60);
    const conf = Math.round((pred.confidence || 0) * 100);

    return `
      <div class="prediction-card">
        <div class="prediction-card__day">${days[day] || `Day ${day}`}</div>
        <div class="prediction-card__window">
          Idle window: ${String(startH).padStart(2, '0')}:${String(startM).padStart(2, '0')} – ${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}
        </div>
        <div class="prediction-card__confidence">Confidence: ${conf}%</div>
        <div class="prediction-card__bar">
          <div class="prediction-card__bar-fill" style="width: ${conf}%"></div>
        </div>
      </div>`;
  }).join('');
}

// ── Settings ─────────────────────────────────────────────────────────

async function loadSettings() {
  const settings = await sendMessage({ type: 'getSettings' }) || {};

  document.getElementById('setting-enabled').checked = settings.enabled !== false;
  document.getElementById('setting-use-companion').checked = settings.useCompanion !== false;
  document.getElementById('setting-whitelist').value = (settings.whitelist || []).join('\n');

  // Build threshold controls
  const container = document.getElementById('threshold-controls');
  container.innerHTML = Object.entries(CATEGORIES).map(([key, cat]) => {
    const current = settings.customThresholds?.[key] || cat.maxAgeMs;
    const currentDays = Math.min(30, Math.max(0.1, current / (24 * 60 * 60 * 1000)));
    return `
      <div class="threshold-row">
        <span class="threshold-row__label" style="color:${cat.color}">${cat.label}</span>
        <input class="threshold-row__range" type="range" data-cat="${key}" value="${currentDays}" min="0.1" max="30" step="0.1" aria-label="${escapeHTML(cat.label)} threshold slider">
        <input class="threshold-row__number" type="number" data-cat="${key}" value="${formatDays(currentDays)}" step="0.1" min="0.1" max="30" aria-label="${escapeHTML(cat.label)} threshold days">
        <span class="threshold-row__unit">days</span>
      </div>`;
  }).join('');

  container.querySelectorAll('.threshold-row').forEach((row) => {
    const slider = row.querySelector('.threshold-row__range');
    const number = row.querySelector('.threshold-row__number');
    const sync = (source) => {
      const value = Math.min(30, Math.max(0.1, parseFloat(source.value) || 0.1));
      slider.value = String(value);
      number.value = formatDays(value);
    };
    slider.addEventListener('input', () => sync(slider));
    number.addEventListener('input', () => sync(number));
  });
}

document.getElementById('btn-save-settings').addEventListener('click', async () => {
  const enabled = document.getElementById('setting-enabled').checked;
  const useCompanion = document.getElementById('setting-use-companion').checked;
  const whitelist = document.getElementById('setting-whitelist').value
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);

  const customThresholds = {};
  document.querySelectorAll('#threshold-controls .threshold-row__number').forEach(input => {
    const cat = input.dataset.cat;
    const days = Math.min(30, Math.max(0.1, parseFloat(input.value) || 0.1));
    if (days > 0) {
      customThresholds[cat] = days * 24 * 60 * 60 * 1000;
    }
  });

  await sendMessage({
    type: 'updateSettings',
    settings: { enabled, useCompanion, whitelist, customThresholds },
  });

  // Flash confirmation
  const btn = document.getElementById('btn-save-settings');
  btn.textContent = '✓ Saved';
  btn.style.background = 'var(--success)';
  setTimeout(() => {
    btn.textContent = 'Save Settings';
    btn.style.background = '';
  }, 1500);
});

// ── Status Bar ───────────────────────────────────────────────────────

async function updateStatus() {
  const settings = await sendMessage({ type: 'getSettings' }) || {};
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');

  if (!settings.enabled) {
    dot.className = 'status__dot';
    text.textContent = `${APP_NAME} is disabled`;
  } else {
    dot.className = 'status__dot status__dot--active';
    text.textContent = 'Monitoring active tabs';
  }
}

async function updateMLStatus() {
  const status = await sendMessage({ type: 'requestCompanionHealth' });
  const nextStatus = status || {};
  renderMLStatus(nextStatus);
  renderMLConsole(nextStatus);
}

// ── Initialise ───────────────────────────────────────────────────────

let mlStatusTimer = null;

async function init() {
  await updateStatus();
  await updateMLStatus();
  await loadActiveTabs();
  await loadClosedLog();
  await loadPredictions();
  if (!mlStatusTimer) {
    mlStatusTimer = setInterval(updateMLStatus, 5_000);
  }
}

init();
