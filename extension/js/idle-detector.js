/**
 * Neural-Janitor — Idle Prediction Client
 *
 * Communicates with the macOS companion app via Native Messaging to:
 *   1. Record user activity timestamps (for ML training data)
 *   2. Retrieve idle-window predictions from the Core ML model
 *   3. Check companion health / model version
 *
 * If the companion is unavailable the module falls back to the user's
 * reference idle schedule.
 */

import {
  APP_NAME,
  ENGINE_CODENAME,
  HARDWARE_MARKER_STATES,
  IPC_PROTOCOL_VERSION,
  NATIVE_HOST_NAME,
} from './constants.js';
import { getIdlePredictions, setIdlePredictions, getCompanionStatus, setCompanionStatus, getSettings } from './storage.js';
import { getRestDayLevel } from './holidays.js';
import { hourInWindow, referenceWindowForRestLevel, scheduleToIPC, timeToHour } from './idle-schedule.js';

let nativePort = null;
let companionQueue = Promise.resolve();

function dateAfterDays(baseDate, dayOffset) {
  const target = new Date(baseDate);
  target.setDate(baseDate.getDate() + dayOffset);
  return target;
}

function buildHolidayLevels(calendar, baseDate = new Date()) {
  const levels = {};
  for (let offset = 0; offset < 7; offset++) {
    const target = dateAfterDays(baseDate, offset);
    levels[String(target.getDay())] = getRestDayLevel(target, calendar);
  }
  return levels;
}

// ── Native Messaging helpers ──────────────────────────────────────────

export function connectToCompanion() {
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort.onMessage.addListener(handleCompanionMessage);
    nativePort.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message || 'Native Messaging port disconnected';
      console.warn('[Neural-Janitor] Companion disconnected:', error);
      nativePort = null;
      disconnectedStatus(error).then(s => setCompanionStatus(s));
    });
    setCompanionStatus({
      connected: true,
      lastSync: Date.now(),
      protocolVersion: IPC_PROTOCOL_VERSION,
      appName: APP_NAME,
      engineCodename: ENGINE_CODENAME,
      telemetryStatus: 'connecting',
    });
    console.log('[Neural-Janitor] Connected to companion app');
  } catch (err) {
    console.warn('[Neural-Janitor] Could not connect to companion:', err.message);
    nativePort = null;
    disconnectedStatus(err.message).then(s => setCompanionStatus(s));
  }
}

function withIPCMetadata(message) {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    appName: APP_NAME,
    engineCodename: ENGINE_CODENAME,
    ...message,
  };
}

function sendToCompanion(message) {
  const run = () => new Promise((resolve, reject) => {
    if (!nativePort) {
      reject(new Error('Companion not connected'));
      return;
    }
    let timeout = null;
    const handler = (response) => {
      clearTimeout(timeout);
      nativePort.onMessage.removeListener(handler);
      resolve(response);
    };
    timeout = setTimeout(() => {
      nativePort?.onMessage.removeListener(handler);
      reject(new Error('Companion response timeout'));
    }, 10_000);
    nativePort.onMessage.addListener(handler);
    try {
      nativePort.postMessage(withIPCMetadata(message));
    } catch (err) {
      clearTimeout(timeout);
      nativePort.onMessage.removeListener(handler);
      reject(err);
    }
  });

  const queued = companionQueue.then(run, run);
  companionQueue = queued.catch(() => {});
  return queued;
}

function handleCompanionMessage(msg) {
  if (msg.type === 'idlePredictions') {
    setIdlePredictions(msg.predictions);
    if (msg.health) {
      setCompanionStatus(normalizeHealthStatus({ connected: true, lastSync: Date.now(), ...msg.health }));
      if (msg.health.resetRequested) {
        chrome.runtime.sendMessage({ type: 'companionResetRequested' }).catch(() => {});
      }
    }
    console.log('[Neural-Janitor] Updated idle predictions from ML model:', msg.predictions);
  } else if (msg.type === 'health') {
    setCompanionStatus(normalizeHealthStatus({ connected: true, lastSync: Date.now(), ...msg }));
  }
}

function normalizeHealthStatus(status = {}) {
  const connected = status.connected !== false;
  const devices = status.hardwareTelemetry?.devices || status.devices || [
    {
      key: 'npu',
      label: 'NPU',
      detail: connected ? 'Apple Neural Engine' : 'Apple Neural Engine telemetry unavailable',
      available: null,
      state: connected ? HARDWARE_MARKER_STATES.STANDBY : HARDWARE_MARKER_STATES.ERROR,
    },
    {
      key: 'gpu',
      label: 'GPU',
      detail: connected ? 'Metal GPU' : 'Metal GPU telemetry unavailable',
      available: null,
      state: connected ? HARDWARE_MARKER_STATES.STANDBY : HARDWARE_MARKER_STATES.ERROR,
    },
    {
      key: 'cpu',
      label: 'CPU',
      detail: connected ? 'Fallback ready' : 'Browser fallback estimate',
      available: true,
      state: status.runtime === 'coreml' ? HARDWARE_MARKER_STATES.STANDBY : HARDWARE_MARKER_STATES.ACTIVE,
    },
  ];
  const markerStates = Object.fromEntries(
    devices.map(device => [device.key, device.state || HARDWARE_MARKER_STATES.STANDBY])
  );

  return {
    protocolVersion: status.protocolVersion || 1,
    appName: status.appName || APP_NAME,
    engineCodename: status.engineCodename || ENGINE_CODENAME,
    telemetryStatus: status.telemetryStatus || status.hardwareTelemetry?.status || (connected ? 'online' : 'offline'),
    ...status,
    devices,
    hardwareTelemetry: {
      source: connected ? 'companion' : 'browser-fallback',
      status: connected ? 'online' : 'offline',
      ...status.hardwareTelemetry,
      markerStates: status.hardwareTelemetry?.markerStates || markerStates,
      devices,
    },
  };
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Send an activity timestamp to the companion for ML training.
 */
export async function recordActivity(activity) {
  if (!nativePort) connectToCompanion();
  try {
    const payload = typeof activity === 'object'
      ? { type: 'activity', ...activity }
      : { type: 'activity', timestamp: activity };
    await sendToCompanion(payload);
  } catch {
    // Companion unavailable — silent fallback
  }
}

/**
 * Request fresh idle-window predictions from the companion's Core ML model.
 * Returns predictions keyed by day-of-week (0=Sun … 6=Sat).
 *
 * Shape per day:
 *   { startHour: number, endHour: number, confidence: number }
 *
 * The model uses the ANE (Apple Neural Engine) automatically via Core ML.
 */
export async function requestPredictions() {
  if (!nativePort) connectToCompanion();
  try {
    const settings = await getSettings();
    const calendar = settings.holidayCalendar || 'none';
    const now = new Date();
    const holidayLevel = getRestDayLevel(now, calendar);
    const holidayLevels = buildHolidayLevels(calendar, now);
    const idleSchedule = scheduleToIPC(settings.idleSchedule);
    const response = await sendToCompanion({
      type: 'predict',
      holidayLevel,
      holidayLevels,
      idleSchedule,
    });
    if (response?.predictions) {
      await setIdlePredictions(response.predictions);
      if (response.modelMode) {
        await setCompanionStatus(normalizeHealthStatus({
          connected: true,
          lastSync: Date.now(),
          modelVersion: response.modelMode,
          activityCount: response.activityCount || 0,
          ...(response.health || {}),
        }));
        if (response.health?.resetRequested) {
          chrome.runtime.sendMessage({ type: 'companionResetRequested' }).catch(() => {});
        }
      }
      return response.predictions;
    }
  } catch (err) {
    const status = await disconnectedStatus(err.message);
    await setCompanionStatus(status);
  }
  return getFallbackPredictions();
}

/**
 * Ask the companion for the current ML runtime / local hardware status.
 */
export async function requestCompanionHealth() {
  if (!nativePort) connectToCompanion();
  try {
    const settings = await getSettings();
    const calendar = settings.holidayCalendar || 'none';
    const holidayLevel = getRestDayLevel(new Date(), calendar);
    const response = await sendToCompanion({
      type: 'health',
      holidayLevel,
      idleSchedule: scheduleToIPC(settings.idleSchedule),
    });
    if (response?.type === 'health') {
      const status = {
        connected: true,
        lastSync: Date.now(),
        modelVersion: response.modelMode || response.runtime || 'unknown',
        ...response,
      };
      const normalized = normalizeHealthStatus(status);
      await setCompanionStatus(normalized);
      return normalized;
    }
  } catch (err) {
    const status = await disconnectedStatus(err.message);
    await setCompanionStatus(status);
    return status;
  }

  const status = await getCompanionStatus();
  return status.connected ? status : await disconnectedStatus();
}

/**
 * Request the companion to wipe its local learning artifacts.
 */
export async function resetCompanionLearning() {
  if (!nativePort) connectToCompanion();
  try {
    const response = await sendToCompanion({ type: 'resetLearningState' });
    if (response?.ok) {
      const status = await requestCompanionHealth().catch(() => null);
      return { ok: true, response, status };
    }
  } catch (err) {
    const status = await disconnectedStatus(err.message);
    await setCompanionStatus(status);
    return { ok: false, error: err.message, status };
  }
  return { ok: false, error: 'Companion did not confirm reset' };
}

/**
 * Ask the companion whether the user is *currently* in a predicted idle window.
 */
export async function isInIdleWindow() {
  const predictions = await getIdlePredictions();
  const now = new Date();
  const day = now.getDay();
  const hour = now.getHours() + now.getMinutes() / 60;

  const pred = predictions[day];
  if (pred && pred.startHour !== undefined && pred.endHour !== undefined) {
    // Handle overnight windows (e.g. 22:00 → 07:00)
    if (pred.startHour > pred.endHour) {
      return hour >= pred.startHour || hour < pred.endHour;
    }
    return hour >= pred.startHour && hour < pred.endHour;
  }

  // Fallback heuristic — calendar-aware
  const settings = await getSettings();
  const calendar = settings.holidayCalendar || 'none';
  const restLevel = getRestDayLevel(now, calendar);
  const window = referenceWindowForRestLevel(settings.idleSchedule, restLevel);
  return hourInWindow(hour, window);
}

/**
 * Request the companion to classify an ambiguous URL via on-device NLP.
 */
export async function classifyURL(input) {
  if (!nativePort) connectToCompanion();
  try {
    const payload = typeof input === 'object' ? input : { url: input };
    const response = await sendToCompanion({ type: 'classifyURL', ...payload });
    return response?.category ? response : null;
  } catch {
    return null;
  }
}

// ── Fallback heuristic ────────────────────────────────────────────────

function fallbackHeuristicProbability(hourValue, restLevel, window) {
  const insideReferenceWindow = hourInWindow(hourValue, window);
  if (restLevel === 2) {
    // Holidays widen the early-morning idle window, but should not add a
    // blanket daytime confidence bump just because a calendar is enabled.
    return insideReferenceWindow ? 0.60 : 0.18;
  }
  if (restLevel === 1) {
    return insideReferenceWindow ? 0.57 : 0.18;
  }
  return insideReferenceWindow ? 0.56 : 0.18;
}

async function getFallbackPredictions() {
  const settings = await getSettings();
  const calendar = settings.holidayCalendar || 'none';
  const predictions = {};

  for (let d = 0; d < 7; d++) {
    const now = new Date();
    const dayOffset = (d - now.getDay() + 7) % 7;
    const target = dateAfterDays(now, dayOffset);
    const restLevel = getRestDayLevel(target, calendar);
    const window = referenceWindowForRestLevel(settings.idleSchedule, restLevel);
    const startHour = timeToHour(window.sleep, 1);
    const endHour = timeToHour(window.wake, 7);

    if (restLevel === 2) {
      predictions[d] = { startHour, endHour, confidence: 0.55 };
    } else if (restLevel === 1) {
      predictions[d] = { startHour, endHour, confidence: 0.40 };
    } else {
      predictions[d] = { startHour, endHour, confidence: 0.3 };
    }
  }
  return predictions;
}

function diagnoseNativeDisconnect(error = null) {
  const text = String(error || '').toLowerCase();
  if (text.includes('not found') || text.includes('specified native messaging host')) {
    return 'host_missing';
  }
  if (text.includes('forbidden') || text.includes('permission') || text.includes('access')) {
    return 'host_forbidden';
  }
  if (text.includes('timeout')) {
    return 'ipc_timeout';
  }
  if (text.includes('exited') || text.includes('closed') || text.includes('disconnected')) {
    return 'host_exited';
  }
  return error ? 'native_link_error' : 'native_link_offline';
}

async function disconnectedStatus(error = null) {
  const disconnectReason = diagnoseNativeDisconnect(error);
  const devices = [
    {
      key: 'npu',
      label: 'NPU',
      detail: 'Apple Neural Engine telemetry unavailable',
      available: null,
      state: HARDWARE_MARKER_STATES.ERROR,
    },
    {
      key: 'gpu',
      label: 'GPU',
      detail: 'Metal GPU telemetry unavailable',
      available: null,
      state: HARDWARE_MARKER_STATES.ERROR,
    },
    {
      key: 'cpu',
      label: 'CPU',
      detail: 'Browser fallback estimate',
      available: true,
      state: HARDWARE_MARKER_STATES.ACTIVE,
    },
  ];
  return {
    connected: false,
    ok: false,
    protocolVersion: IPC_PROTOCOL_VERSION,
    appName: APP_NAME,
    engineCodename: ENGINE_CODENAME,
    lastSync: Date.now(),
    modelMode: 'fallback',
    modelLoaded: false,
    runtime: 'heuristic',
    runtimeLabel: 'Fallback',
    computeUnits: 'cpu',
    trainingSamples: 0,
    targetTrainingSamples: 1000,
    minimumTrainingSamples: 100,
    modelMaturity: 0,
    modelAccuracy: null,
    readinessReason: 'Native link offline; showing a browser fallback estimate while NPU telemetry is unavailable',
    currentActivityState: 'unknown',
    currentIdleConfidence: await fallbackConfidenceNow(),
    confidenceCurve: await fallbackConfidenceCurve(),
    decisionThreshold: 0.55,
    powerMode: 'low',
    powerSignal: 'standby',
    telemetryStatus: 'offline',
    npuDisconnected: true,
    disconnectReason,
    error,
    devices,
    hardwareTelemetry: {
      source: 'browser-fallback',
      status: 'offline',
      reason: disconnectReason,
      markerStates: {
        npu: HARDWARE_MARKER_STATES.ERROR,
        gpu: HARDWARE_MARKER_STATES.ERROR,
        cpu: HARDWARE_MARKER_STATES.ACTIVE,
      },
      devices,
    },
  };
}

async function fallbackConfidenceNow() {
  const now = new Date();
  const hour = now.getHours() + now.getMinutes() / 60;
  const settings = await getSettings();
  const calendar = settings.holidayCalendar || 'none';
  const restLevel = getRestDayLevel(now, calendar);
  const window = referenceWindowForRestLevel(settings.idleSchedule, restLevel);
  return fallbackHeuristicProbability(hour, restLevel, window);
}

async function fallbackConfidenceCurve() {
  const now = new Date();
  const settings = await getSettings();
  const calendar = settings.holidayCalendar || 'none';

  return Promise.all(Array.from({ length: 7 }, async (_, index) => {
    const offsetMinutes = index * 30;
    const date = new Date(now.getTime() + offsetMinutes * 60_000);
    const hourValue = date.getHours() + date.getMinutes() / 60;
    const restLevel = getRestDayLevel(date, calendar);
    const window = referenceWindowForRestLevel(settings.idleSchedule, restLevel);
    const confidence = fallbackHeuristicProbability(hourValue, restLevel, window);

    return {
      offsetMinutes,
      hour: date.getHours(),
      minute: date.getMinutes(),
      confidence,
    };
  }));
}
