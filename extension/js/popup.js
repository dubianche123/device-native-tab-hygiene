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
import { getUpcomingHolidays, getRestDayLevel, getHolidayName, getExtendedPeriodLabel } from './holidays.js';

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

function formatSignedAge(ms) {
  if (!ms) return '0m';
  return `${ms > 0 ? '+' : '-'}${formatAge(Math.abs(ms))}`;
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

function formatPredictionDate(date) {
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function shortCPUModel(model) {
  const clean = String(model || 'CPU')
    .replace(/\(R\)|\(TM\)/g, '')
    .replace(/\s+CPU.*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const apple = clean.match(/Apple M\d+(?:\s(?:Pro|Max|Ultra))?/i);
  if (apple) return apple[0].replace(/^Apple\s+/i, '');
  const intel = clean.match(/(?:Intel\s+)?(?:Core\s+)?i[3579](?:-\d+)?/i);
  if (intel) return intel[0].replace(/^Intel\s+/i, '');
  return clean.split(' ').slice(0, 2).join(' ') || 'CPU';
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

function decisionText(status = {}, confidence = 0) {
  const formatted = formatPercent(confidence);
  if (status.runtime === 'coreml') {
    return `${acceleratorLabel(status)} Predicts Idle Confidence: ${formatted}`;
  }
  if (status.runtime === 'lookup') {
    return `CPU Lookup Estimates Idle Likelihood: ${formatted}`;
  }
  if (status.runtime === 'disabled') {
    return 'ML Off: no idle estimate';
  }
  return `CPU Heuristic Idle Estimate: ${formatted}`;
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
    return 'CPU Heuristic';
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

  const trainingSamples = status.trainingSamples || 0;
  const activityCount = status.activityCount || 0;
  const targetSamples = status.targetTrainingSamples || 1000;
  const minimumSamples = status.minimumTrainingSamples || 100;
  const maturity = typeof status.modelMaturity === 'number'
    ? status.modelMaturity
    : Math.min(1, trainingSamples / targetSamples);

  link.textContent = status.connected ? 'Connected' : 'Disconnected';
  link.style.color = status.connected ? 'var(--success)' : 'var(--danger)';
  if (status.modelLoaded) {
    samples.textContent = `${trainingSamples.toLocaleString()} / ${targetSamples.toLocaleString()}`;
  } else if (trainingSamples > 0) {
    samples.textContent = `${trainingSamples.toLocaleString()} / ${minimumSamples.toLocaleString()} valid`;
  } else if (activityCount > 0) {
    samples.textContent = `0 valid (${activityCount.toLocaleString()} events)`;
  } else {
    samples.textContent = `0 / ${minimumSamples.toLocaleString()} valid`;
  }

  progress.style.width = `${Math.round(Math.max(0, Math.min(1, maturity)) * 100)}%`;
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
  decision.textContent = decisionText(status, confidence);
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
    // Refresh closure learning when predictions tab is opened
    if (target === 'predictions') loadClosureLearning();
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
  const tagged = response?.taggedCount || 0;
  btn.textContent = closed > 0 ? `Closed ${closed}` : 'Checked';
  statusText.textContent = response?.disabled
    ? 'Auto-cleanup is disabled'
    : tagged > 0
      ? `Checked ${response?.scannedCount ?? 0}, tagged ${tagged}`
      : `Checked ${response?.scannedCount ?? 0}, closed ${closed}`;
  await loadActiveTabs();
  await loadClosedLog();
  await loadClosureLearning();
  await updateMemoryPressure();
  await updateCPUUsage();
  await updateAISuggestions();
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = 'Check';
    updateStatus();
  }, 1800);
});

// ── Active Tabs ──────────────────────────────────────────────────────

async function loadActiveTabs() {
  const registry = await sendMessage({ type: 'getRegistry' });
  const tagged = await sendMessage({ type: 'getTaggedTabs' }) || {};
  const settings = await sendMessage({ type: 'getSettings' }) || {};
  const learnedThresholds = await sendMessage({ type: 'getLearnedThresholds' }) || {};
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
    const backgroundAge = entry.lastBackgroundedAt
      ? Date.now() - entry.lastBackgroundedAt
      : Date.now() - (entry.lastVisited || Date.now());
    const isCurrentlyActive = entry.active === true;
    const dwell = liveDwellMs(entry);
    const maxAge = settings.customThresholds?.[entry.category]
      || learnedThresholds[entry.category]
      || cat.maxAgeMs
      || DEFAULT_CATEGORY.maxAgeMs;
    const pct = isCurrentlyActive ? 0 : Math.min(100, (backgroundAge / maxAge) * 100);
    const urgencyClass = pct > 80 ? 'color: var(--danger)' : pct > 50 ? 'color: var(--warning)' : '';
    const favicon = faviconURL(entry);
    const tagInfo = tagged[tabId];
    const taggedClass = tagInfo ? ' tab-item--tagged' : '';
    const tagBadge = tagInfo
      ? `<span class="tab-item__tag-badge" title="${escapeHTML(tagInfo.reason || 'tagged')}">🏷 ${escapeHTML(tagInfo.reason || 'tagged')}</span>`
      : '';

    return `
      <div class="tab-item${taggedClass}" data-url="${escapeHTML(entry.url)}">
        ${favicon
          ? `<img class="tab-item__favicon" src="${escapeHTML(favicon)}" onerror="this.outerHTML='<div class=\\'tab-item__favicon tab-item__favicon--fallback\\'>🌐</div>'">`
          : '<div class="tab-item__favicon tab-item__favicon--fallback">🌐</div>'}
        <div class="tab-item__info">
          <div class="tab-item__title">${escapeHTML(entry.title || getDomain(entry.url))}</div>
          <div class="tab-item__url">${escapeHTML(getDomain(entry.url))}</div>
        </div>
        <div class="tab-item__meta">
          <span class="tab-item__badge" style="background:${cat.color}20; color:${cat.color}">${escapeHTML(cat.label)}</span>
          ${tagBadge}
          <span class="tab-item__age" style="${urgencyClass}">${isCurrentlyActive ? '👁 active' : `bg ${formatAge(backgroundAge)} / ${formatAge(maxAge)}`}</span>
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
      await loadClosureLearning();
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
  const settings = await sendMessage({ type: 'getSettings' }) || {};
  const calendar = settings.holidayCalendar || 'none';

  if (Object.keys(predictions).length === 0) {
    container.innerHTML = '<div class="empty-state">No predictions available. Start the companion app.</div>';
    return;
  }

  const now = new Date();

  const cards = Array.from({ length: 7 }, (_, dayOffset) => {
    const target = new Date(now);
    target.setDate(now.getDate() + dayOffset);
    const day = String(target.getDay());
    const pred = predictions[day] || {};
    const startHour = typeof pred.startHour === 'number' ? pred.startHour : 1;
    const endHour = typeof pred.endHour === 'number' ? pred.endHour : 7;
    const startH = Math.floor(startHour);
    const startM = Math.round((startHour % 1) * 60);
    const endH = Math.floor(endHour);
    const endM = Math.round((endHour % 1) * 60);
    const conf = Math.round((pred.confidence || 0) * 100);
    const restLevel = getRestDayLevel(target, calendar);

    const hName = getHolidayName(target, calendar) || getExtendedPeriodLabel(target, calendar);
    const badge = restLevel === 2
      ? `<span class="prediction-card__badge prediction-card__badge--holiday" title="${escapeHTML(hName || 'Holiday')}">${escapeHTML(hName || 'Holiday')}</span>`
      : restLevel === 1
        ? '<span class="prediction-card__badge prediction-card__badge--weekend">Weekend</span>'
        : '<span class="prediction-card__badge prediction-card__badge--weekday">Workday</span>';
    const dateLabel = formatPredictionDate(target);
    const dayLabel = dayOffset === 0 ? 'Today' : days[day] || `Day ${day}`;

    return `
      <div class="prediction-card">
        <div class="prediction-card__day">
          <span>${escapeHTML(dayLabel)} <span class="prediction-card__date">${escapeHTML(dateLabel)}</span></span>
          ${badge}
        </div>
        <div class="prediction-card__window">
          Idle window: ${String(startH).padStart(2, '0')}:${String(startM).padStart(2, '0')} – ${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}
        </div>
        <div class="prediction-card__confidence">Confidence: ${conf}%</div>
        <div class="prediction-card__bar">
          <div class="prediction-card__bar-fill" style="width: ${conf}%"></div>
        </div>
      </div>`;
  }).join('');

  // Show upcoming holidays if a calendar is active
  let holidaySection = '';
  if (calendar !== 'none') {
    const upcoming = getUpcomingHolidays(calendar, 14);
    if (upcoming.length > 0) {
      const items = upcoming.map(h =>
        `<span class="holiday-chip">${h.date.slice(5)} ${escapeHTML(h.name)}</span>`
      ).join(' ');
      holidaySection = `<div class="upcoming-holidays"><h4>Upcoming holidays (14 days)</h4><div class="holiday-chips">${items}</div></div>`;
    }
  }

  container.innerHTML = cards + holidaySection;
}

// ── Closure Learning ─────────────────────────────────────────────────

async function loadClosureLearning() {
  const summary = await sendMessage({ type: 'getClosureLearning' });
  const container = document.getElementById('closure-learning-content');
  if (!container || !summary) return;

  if (summary.totalSamples === 0) {
    container.innerHTML = '<div class="empty-state">No closure data yet. Use the browser normally to build learning data.</div>';
    return;
  }

  const catStats = summary.stats || {};
  const rows = Object.entries(catStats)
    .sort((a, b) => b[1].totalSamples - a[1].totalSamples)
    .map(([cat, s]) => {
      const catInfo = CATEGORIES[cat] || DEFAULT_CATEGORY;
      const color = catInfo.color || '#95a5a6';
      const label = catInfo.label || cat;
      const hasRecommendation = s.recommendedThresholdMs != null;
      const delta = s.thresholdDelta;
      const deltaStr = delta != null
        ? `<span class="cl-delta ${delta > 0 ? 'cl-delta--up' : 'cl-delta--down'}">${formatSignedAge(delta)}</span>`
        : '';
      const recStr = hasRecommendation
        ? `→ ${formatAge(s.recommendedThresholdMs)}`
        : `<span class="cl-need-more">need ${Math.max(0, 5 - (s.recommendationSampleCount || 0))} useful closes</span>`;

      return `
        <div class="cl-row">
          <span class="cl-row__cat" style="color:${color}">${escapeHTML(label)}</span>
          <span class="cl-row__stat" title="Manual closes (browser + popup)">${s.manualCount} manual</span>
          <span class="cl-row__stat" title="Auto-cleanup closes">${s.autoCount} auto</span>
          <span class="cl-row__stat" title="Median foreground dwell of manual closes">dwell ${formatAge(s.manualDwellMs)}</span>
          <span class="cl-row__stat" title="Median background age of manual closes (time since left foreground)">bg age ${formatAge(s.manualBackgroundAgeMs)}</span>
          <span class="cl-row__rec" title="Current default: ${formatAge(s.defaultThresholdMs)}">${recStr} ${deltaStr}</span>
        </div>`;
    }).join('');

  container.innerHTML = `
    <div class="cl-summary">
      <span>${summary.totalSamples} samples</span>
      <span>${summary.manualCount} manual</span>
      <span>${summary.autoCount} auto</span>
      <span>${summary.categoriesWithRecommendations}/${summary.categoriesTracked} categories adapted</span>
    </div>
    <div class="cl-legend">
      <span class="cl-legend__item"><span class="cl-legend__swatch" style="background:var(--text-dim,#888)"></span> Manual close (full weight)</span>
      <span class="cl-legend__item"><span class="cl-legend__swatch" style="background:var(--text-muted,#555)"></span> Auto cleanup (context only)</span>
    </div>
    <div class="cl-table">${rows}</div>`;
}

// ── Settings ─────────────────────────────────────────────────────────

async function loadSettings() {
  const settings = await sendMessage({ type: 'getSettings' }) || {};

  document.getElementById('setting-enabled').checked = settings.enabled !== false;
  document.getElementById('setting-use-companion').checked = settings.useCompanion !== false;
  document.getElementById('setting-holiday-calendar').value = settings.holidayCalendar || 'none';
  document.getElementById('setting-whitelist').value = (settings.whitelist || []).join('\n');

  // AI cleanup targets
  const targetMem = settings.aiCleanupTargetMemory || 70;
  const targetTabs = settings.aiCleanupTargetTabs || 30;
  const forceThreshold = settings.aiForceCleanupThreshold || 85;
  document.getElementById('setting-target-memory').value = targetMem;
  document.getElementById('setting-target-memory-val').textContent = `${targetMem}%`;
  document.getElementById('setting-target-tabs').value = targetTabs;
  document.getElementById('setting-target-tabs-val').textContent = targetTabs;
  document.getElementById('setting-force-threshold').value = forceThreshold;
  document.getElementById('setting-force-threshold-val').textContent = `${forceThreshold}%`;

  // Sync target sliders with labels
  const memSlider = document.getElementById('setting-target-memory');
  const memVal = document.getElementById('setting-target-memory-val');
  const tabSlider = document.getElementById('setting-target-tabs');
  const tabVal = document.getElementById('setting-target-tabs-val');
  const forceSlider = document.getElementById('setting-force-threshold');
  const forceVal = document.getElementById('setting-force-threshold-val');
  const calendarSelect = document.getElementById('setting-holiday-calendar');
  memSlider.oninput = () => { memVal.textContent = `${memSlider.value}%`; };
  tabSlider.oninput = () => { tabVal.textContent = tabSlider.value; };
  forceSlider.oninput = () => { forceVal.textContent = `${forceSlider.value}%`; };
  calendarSelect.onchange = async () => {
    await sendMessage({ type: 'updateSettings', settings: { holidayCalendar: calendarSelect.value } });
    await loadPredictions();
    await updateAISuggestions();
  };

  // Update mode toggle UI
  updateModeToggle(settings.testMode === true);

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
  const holidayCalendar = document.getElementById('setting-holiday-calendar').value;
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

  const aiCleanupTargetMemory = parseInt(document.getElementById('setting-target-memory').value, 10) || 70;
  const aiCleanupTargetTabs = parseInt(document.getElementById('setting-target-tabs').value, 10) || 30;
  const aiForceCleanupThreshold = parseInt(document.getElementById('setting-force-threshold').value, 10) || 85;

  await sendMessage({
    type: 'updateSettings',
    settings: { enabled, useCompanion, holidayCalendar, whitelist, customThresholds, aiCleanupTargetMemory, aiCleanupTargetTabs, aiForceCleanupThreshold },
  });

  // Flash confirmation
  const btn = document.getElementById('btn-save-settings');
  btn.textContent = '✓ Saved';
  btn.style.background = 'var(--success)';
  await updateStatus();
  await loadPredictions();
  await updateAISuggestions();
  setTimeout(() => {
    btn.textContent = 'Save Settings';
    btn.style.background = '';
  }, 1500);
});

document.getElementById('btn-reset-learning').addEventListener('click', async () => {
  const btn = document.getElementById('btn-reset-learning');
  if (!confirm('Reset all closure learning data? This cannot be undone.')) return;
  btn.disabled = true;
  btn.textContent = 'Resetting…';
  await sendMessage({ type: 'resetClosureLearning' });
  btn.textContent = '✓ Reset';
  await loadClosureLearning();
  setTimeout(() => {
    btn.textContent = 'Reset Learning Data';
    btn.disabled = false;
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
  } else if (settings.testMode) {
    dot.className = 'status__dot status__dot--test';
    text.textContent = 'Test: learning only';
  } else {
    dot.className = 'status__dot status__dot--active';
    text.textContent = 'Deploy: active';
  }
}

async function updateMLStatus() {
  const status = await sendMessage({ type: 'requestCompanionHealth' });
  const nextStatus = status || {};
  renderMLStatus(nextStatus);
  renderMLConsole(nextStatus);
}

// ── Mode Toggle ──────────────────────────────────────────────────────

function updateModeToggle(testMode) {
  const deployBtn = document.getElementById('btn-mode-deploy');
  const testBtn = document.getElementById('btn-mode-test');
  if (!deployBtn || !testBtn) return;

  if (testMode) {
    deployBtn.classList.remove('mode-toggle__btn--active');
    testBtn.classList.add('mode-toggle__btn--active');
  } else {
    deployBtn.classList.add('mode-toggle__btn--active');
    testBtn.classList.remove('mode-toggle__btn--active');
  }
}

async function setMode(testMode) {
  await sendMessage({
    type: 'updateSettings',
    settings: { testMode },
  });
  updateModeToggle(testMode);
  await updateStatus();
  await updateAISuggestions();
}

document.getElementById('btn-mode-deploy')?.addEventListener('click', () => setMode(false));
document.getElementById('btn-mode-test')?.addEventListener('click', () => setMode(true));

// ── Memory Pressure ──────────────────────────────────────────────────

let memoryTimer = null;

async function updateMemoryPressure() {
  const mem = await sendMessage({ type: 'getMemoryPressure' });
  const fill = document.getElementById('memory-fill');
  const value = document.getElementById('memory-value');
  if (!fill || !value) return;

  if (!mem || mem.error) {
    fill.style.width = '0%';
    value.textContent = 'Err%';
    value.title = mem?.error || 'Memory API unavailable. Try reloading the extension.';
    return;
  }

  const pct = mem.percent || 0;
  fill.style.width = `${pct}%`;
  value.textContent = `${pct}%`;
  value.title = `Used: ${Math.round(mem.usedCapacity / 1024 / 1024 / 1024 * 10) / 10}GB / Total: ${Math.round(mem.capacity / 1024 / 1024 / 1024 * 10) / 10}GB`;

  // Color coding: green < 60, yellow < 80, red >= 80
  if (pct >= 80) {
    fill.style.background = 'var(--danger)';
    value.style.color = 'var(--danger)';
  } else if (pct >= 60) {
    fill.style.background = 'var(--warning)';
    value.style.color = 'var(--warning)';
  } else {
    fill.style.background = 'var(--accent)';
    value.style.color = 'var(--text-muted)';
  }
}

// ── CPU Usage ────────────────────────────────────────────────────────

async function updateCPUUsage() {
  const cpu = await sendMessage({ type: 'getCPUUsage' });
  const fill = document.getElementById('cpu-fill');
  const value = document.getElementById('cpu-value');
  const detail = document.getElementById('cpu-detail');
  if (!fill || !value) return;

  if (!cpu || cpu.error) {
    fill.style.width = '0%';
    value.textContent = 'Err%';
    if (detail) {
      detail.textContent = 'API';
      detail.title = 'CPU API unavailable';
    }
    return;
  }

  const pct = cpu.percent || 0;
  const model = shortCPUModel(cpu.model);
  const threads = cpu.threads ? `${cpu.threads}T` : '--T';
  fill.style.width = `${pct}%`;
  value.textContent = `${pct}%`;
  value.title = `${cpu.model || 'CPU'} (${cpu.threads || 0} threads)`;
  if (detail) {
    detail.textContent = `${model} ${threads}`;
    detail.title = value.title;
  }

  if (pct >= 80) {
    fill.style.background = 'var(--danger)';
    value.style.color = 'var(--danger)';
  } else if (pct >= 50) {
    fill.style.background = 'var(--warning)';
    value.style.color = 'var(--warning)';
  } else {
    fill.style.background = 'var(--success)';
    value.style.color = 'var(--text-muted)';
  }
}

// ── AI Cleanup Button ────────────────────────────────────────────────

document.getElementById('btn-ai-cleanup')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-ai-cleanup');
  if (!btn) return;

  btn.disabled = true;
  btn.textContent = '⏳ Cleaning…';

  try {
    const result = await sendMessage({ type: 'aiCleanup' });
    if (result?.ok) {
      if (result.action === 'none') {
        btn.textContent = '✅ At target';
      } else if (result.action === 'tagged') {
        btn.textContent = `🏷 Tagged ${result.taggedCount}`;
      } else {
        btn.textContent = `🧹 Closed ${result.closedCount}`;
      }
    } else {
      btn.textContent = '❌ Error';
    }
  } catch {
    btn.textContent = '❌ Error';
  }

  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = '🧹 AI Clean';
  }, 3000);

  await loadActiveTabs();
  await loadClosedLog();
  await loadClosureLearning();
  await updateMemoryPressure();
  await updateCPUUsage();
  await updateAISuggestions();
});

// ── AI Suggestions ───────────────────────────────────────────────────

async function updateAISuggestions() {
  const data = await sendMessage({ type: 'getAISuggestion' });
  if (!data?.suggestions) return;

  const container = document.getElementById('ai-suggestions-list');
  if (!container) return;

  const levelClass = {
    critical: 'ai-suggestion--critical',
    warning: 'ai-suggestion--warning',
    info: 'ai-suggestion--info',
    ok: 'ai-suggestion--ok',
  };

  container.innerHTML = data.suggestions.map(s => {
    const cls = levelClass[s.level] || 'ai-suggestion--info';
    const btn = s.action
      ? `<button class="btn btn--xs ai-suggestion__action" data-action="${escapeHTML(s.action)}">${s.action === 'aiCleanup' ? '🧹 Clean' : '🔍 Check'}</button>`
      : '';
    return `<div class="ai-suggestion ${cls}"><span>${s.icon}</span> ${escapeHTML(s.text)}${btn}</div>`;
  }).join('');

  container.querySelectorAll('.ai-suggestion__action').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      btn.disabled = true;
      btn.textContent = '⏳';
      if (action === 'aiCleanup') {
        document.getElementById('btn-ai-cleanup')?.click();
      } else if (action === 'forceCheck') {
        document.getElementById('btn-force-check')?.click();
      }
      setTimeout(() => updateAISuggestions(), 2000);
    });
  });
}

// ── Initialise ───────────────────────────────────────────────────────

let mlStatusTimer = null;
let suggestionsTimer = null;

async function init() {
  await updateStatus();
  await updateMLStatus();
  await loadActiveTabs();
  await loadClosedLog();
  await loadPredictions();
  await loadClosureLearning();
  await updateMemoryPressure();
  await updateCPUUsage();
  await updateAISuggestions();

  if (!mlStatusTimer) {
    mlStatusTimer = setInterval(updateMLStatus, 5_000);
  }
  if (!memoryTimer) {
    memoryTimer = setInterval(() => {
      updateMemoryPressure();
      updateCPUUsage();
    }, 5_000);
  }
  if (!suggestionsTimer) {
    suggestionsTimer = setInterval(updateAISuggestions, 30_000);
  }
}

init();
