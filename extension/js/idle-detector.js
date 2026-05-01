/**
 * Smart Tab Hygiene — Idle Prediction Client
 *
 * Communicates with the macOS companion app via Native Messaging to:
 *   1. Record user activity timestamps (for ML training data)
 *   2. Retrieve idle-window predictions from the Core ML model
 *   3. Check companion health / model version
 *
 * If the companion is unavailable the module falls back to a simple
 * heuristic: assume the user is idle between 01:00–07:00 every day.
 */

import { NATIVE_HOST_NAME, STORAGE_KEYS } from './constants.js';
import { getIdlePredictions, setIdlePredictions, getCompanionStatus, setCompanionStatus } from './storage.js';

let nativePort = null;
let companionQueue = Promise.resolve();

// ── Native Messaging helpers ──────────────────────────────────────────

export function connectToCompanion() {
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort.onMessage.addListener(handleCompanionMessage);
    nativePort.onDisconnect.addListener(() => {
      console.warn('[Smart Tab Hygiene] Companion disconnected:', chrome.runtime.lastError?.message);
      nativePort = null;
      setCompanionStatus(disconnectedStatus(chrome.runtime.lastError?.message));
    });
    setCompanionStatus({ connected: true, lastSync: Date.now() });
    console.log('[Smart Tab Hygiene] Connected to companion app');
  } catch (err) {
    console.warn('[Smart Tab Hygiene] Could not connect to companion:', err.message);
    nativePort = null;
    setCompanionStatus({ connected: false, lastSync: Date.now(), error: err.message });
  }
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
      nativePort.postMessage(message);
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
      setCompanionStatus({ connected: true, lastSync: Date.now(), ...msg.health });
    }
    console.log('[Smart Tab Hygiene] Updated idle predictions from ML model:', msg.predictions);
  } else if (msg.type === 'health') {
    setCompanionStatus({ connected: true, lastSync: Date.now(), ...msg });
  }
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
    const response = await sendToCompanion({ type: 'predict' });
    if (response?.predictions) {
      await setIdlePredictions(response.predictions);
      if (response.modelMode) {
        await setCompanionStatus({
          connected: true,
          lastSync: Date.now(),
          modelVersion: response.modelMode,
          activityCount: response.activityCount || 0,
          ...(response.health || {}),
        });
      }
      return response.predictions;
    }
  } catch {
    // Fall through to heuristic
  }
  return getFallbackPredictions();
}

/**
 * Ask the companion for the current ML runtime / local hardware status.
 */
export async function requestCompanionHealth() {
  if (!nativePort) connectToCompanion();
  try {
    const response = await sendToCompanion({ type: 'health' });
    if (response?.type === 'health') {
      const status = {
        connected: true,
        lastSync: Date.now(),
        modelVersion: response.modelMode || response.runtime || 'unknown',
        ...response,
      };
      await setCompanionStatus(status);
      return status;
    }
  } catch (err) {
    const status = disconnectedStatus(err.message);
    await setCompanionStatus(status);
    return status;
  }

  const status = await getCompanionStatus();
  return status.connected ? status : disconnectedStatus();
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

  // Fallback heuristic
  return hour >= 1 && hour < 7;
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

function getFallbackPredictions() {
  // Conservative: assume idle 01:00–07:00 every day
  const predictions = {};
  for (let d = 0; d < 7; d++) {
    predictions[d] = { startHour: 1, endHour: 7, confidence: 0.3 };
  }
  return predictions;
}

function disconnectedStatus(error = null) {
  return {
    connected: false,
    ok: false,
    lastSync: Date.now(),
    modelMode: 'fallback',
    modelLoaded: false,
    runtime: 'heuristic',
    runtimeLabel: 'Heuristic',
    computeUnits: 'cpu',
    trainingSamples: 0,
    targetTrainingSamples: 1000,
    minimumTrainingSamples: 100,
    modelMaturity: 0,
    modelAccuracy: null,
    readinessReason: 'Companion disconnected; using browser CPU heuristic',
    currentIdleConfidence: fallbackConfidenceNow(),
    confidenceCurve: fallbackConfidenceCurve(),
    decisionThreshold: 0.55,
    powerMode: 'low',
    powerSignal: 'standby',
    error,
    devices: [
      { key: 'npu', label: 'NPU', detail: 'Apple Neural Engine', available: false, state: 'unavailable' },
      { key: 'gpu', label: 'GPU', detail: 'Metal GPU', available: false, state: 'unavailable' },
      { key: 'cpu', label: 'CPU', detail: 'Browser heuristic', available: true, state: 'active' },
    ],
  };
}

function fallbackConfidenceNow() {
  const now = new Date();
  const hour = now.getHours() + now.getMinutes() / 60;
  return hour >= 1 && hour < 7 ? 0.75 : 0.20;
}

function fallbackConfidenceCurve() {
  const now = new Date();
  return Array.from({ length: 7 }, (_, index) => {
    const offsetMinutes = index * 30;
    const date = new Date(now.getTime() + offsetMinutes * 60_000);
    const hourValue = date.getHours() + date.getMinutes() / 60;
    return {
      offsetMinutes,
      hour: date.getHours(),
      minute: date.getMinutes(),
      confidence: hourValue >= 1 && hourValue < 7 ? 0.75 : 0.20,
    };
  });
}
