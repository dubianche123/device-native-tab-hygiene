/**
 * Smart Tab Hygiene - Local Storage Manager
 *
 * Tab entries are stored under per-tab keys instead of one large registry
 * object. That keeps normal activity updates to a single small read/write.
 */

import { STORAGE_KEYS } from './constants.js';

function tabKey(tabId) {
  return `${STORAGE_KEYS.TAB_ENTRY_PREFIX}${tabId}`;
}

async function getRegistryIndex() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.TAB_REGISTRY_INDEX);
  return data[STORAGE_KEYS.TAB_REGISTRY_INDEX] || [];
}

async function setRegistryIndex(index) {
  await chrome.storage.local.set({ [STORAGE_KEYS.TAB_REGISTRY_INDEX]: [...new Set(index.map(String))] });
}

async function ensureRegistryMigrated() {
  const index = await getRegistryIndex();
  if (index.length > 0) return index;

  const data = await chrome.storage.local.get(STORAGE_KEYS.TAB_REGISTRY);
  const legacy = data[STORAGE_KEYS.TAB_REGISTRY] || {};
  const ids = Object.keys(legacy);
  if (ids.length === 0) return [];

  const updates = {};
  for (const id of ids) updates[tabKey(id)] = legacy[id];
  updates[STORAGE_KEYS.TAB_REGISTRY_INDEX] = ids;
  await chrome.storage.local.set(updates);
  await chrome.storage.local.remove(STORAGE_KEYS.TAB_REGISTRY);
  return ids;
}

// ── Tab Registry (live tabs we are tracking) ──────────────────────────

export async function getTabEntry(tabId) {
  const data = await chrome.storage.local.get(tabKey(tabId));
  return data[tabKey(tabId)] || null;
}

export async function getTabCount() {
  return (await ensureRegistryMigrated()).length;
}

export async function getTabRegistry() {
  const ids = await ensureRegistryMigrated();
  if (ids.length === 0) return {};

  const keys = ids.map(tabKey);
  const data = await chrome.storage.local.get(keys);
  const registry = {};
  for (const id of ids) {
    const entry = data[tabKey(id)];
    if (entry) registry[id] = entry;
  }
  return registry;
}

export async function setTabRegistry(registry) {
  const existing = await ensureRegistryMigrated();
  const nextIds = Object.keys(registry).map(String);
  const updates = { [STORAGE_KEYS.TAB_REGISTRY_INDEX]: nextIds };
  for (const id of nextIds) updates[tabKey(id)] = registry[id];

  const removeKeys = existing
    .filter(id => !nextIds.includes(String(id)))
    .map(tabKey);

  await chrome.storage.local.set(updates);
  if (removeKeys.length > 0) await chrome.storage.local.remove(removeKeys);
}

export async function upsertTabEntry(tabId, entry) {
  const key = tabKey(tabId);
  const index = await ensureRegistryMigrated();
  const data = await chrome.storage.local.get(key);

  const id = String(tabId);
  const exists = index.includes(id);
  const updates = {
    [key]: { ...(data[key] || {}), ...entry },
  };

  if (!exists) updates[STORAGE_KEYS.TAB_REGISTRY_INDEX] = [...index, id];
  await chrome.storage.local.set(updates);
}

export async function updateTabEntry(tabId, updater) {
  const key = tabKey(tabId);
  const data = await chrome.storage.local.get(key);
  const current = data[key] || {};
  const next = updater(current);
  if (!next) return current;

  const index = await ensureRegistryMigrated();
  const id = String(tabId);
  const updates = { [key]: next };
  if (!index.includes(id)) updates[STORAGE_KEYS.TAB_REGISTRY_INDEX] = [...index, id];
  await chrome.storage.local.set(updates);
  return next;
}

export async function removeTabEntry(tabId) {
  const id = String(tabId);
  const index = await ensureRegistryMigrated();
  await chrome.storage.local.remove(tabKey(id));
  if (index.includes(id)) {
    await setRegistryIndex(index.filter(existing => existing !== id));
  }
}

// ── Active Foreground Session ────────────────────────────────────────

export async function getActiveSession() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.ACTIVE_SESSION);
  return data[STORAGE_KEYS.ACTIVE_SESSION] || null;
}

export async function setActiveSession(session) {
  await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_SESSION]: session });
}

export async function clearActiveSession() {
  await chrome.storage.local.remove(STORAGE_KEYS.ACTIVE_SESSION);
}

// ── Closed-Tab Log ────────────────────────────────────────────────────

export async function getClosedLog() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.CLOSED_LOG);
  return data[STORAGE_KEYS.CLOSED_LOG] || {};
}

export async function appendClosedRecord(record) {
  const log = await getClosedLog();
  const bucket = record.category || 'other';
  if (!log[bucket]) log[bucket] = [];

  const id = record.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  log[bucket].push({
    id,
    url: record.url,
    title: record.title,
    favIconUrl: record.favIconUrl || '',
    sessionId: record.sessionId || null,
    closedAt: record.closedAt || Date.now(),
    reason: record.reason || 'stale',
    lastVisited: record.lastVisited,
    ageMs: record.ageMs,
    dwellMs: record.dwellMs || 0,
    interactions: record.interactions || 0,
    restoredAt: null,
  });

  await chrome.storage.local.set({ [STORAGE_KEYS.CLOSED_LOG]: log });
  return id;
}

export async function markClosedRecordRestored(category, id, restoredAt = Date.now()) {
  const log = await getClosedLog();
  const bucket = log[category] || [];
  const record = bucket.find(entry => entry.id === id);
  if (!record) return false;
  record.restoredAt = restoredAt;
  await chrome.storage.local.set({ [STORAGE_KEYS.CLOSED_LOG]: log });
  return true;
}

// ── Idle Predictions (from ML companion) ──────────────────────────────

export async function getIdlePredictions() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.IDLE_PREDICTIONS);
  return data[STORAGE_KEYS.IDLE_PREDICTIONS] || {};
}

export async function setIdlePredictions(predictions) {
  await chrome.storage.local.set({ [STORAGE_KEYS.IDLE_PREDICTIONS]: predictions });
}

// ── User Settings ─────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  enabled: true,
  checkIntervalMinutes: 30,
  customThresholds: {},
  useCompanion: true,
  whitelist: [],
};

export async function getSettings() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.USER_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.USER_SETTINGS] || {}) };
}

export async function updateSettings(partial) {
  const current = await getSettings();
  const merged = { ...current, ...partial };
  await chrome.storage.local.set({ [STORAGE_KEYS.USER_SETTINGS]: merged });
  return merged;
}

// ── Return Notification State ─────────────────────────────────────────

export async function getReturnNotification() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.RETURN_NOTIFICATION);
  return data[STORAGE_KEYS.RETURN_NOTIFICATION] || { pending: false, closedTabs: [] };
}

export async function setReturnNotification(state) {
  await chrome.storage.local.set({ [STORAGE_KEYS.RETURN_NOTIFICATION]: state });
}

export async function clearReturnNotification() {
  await setReturnNotification({ pending: false, closedTabs: [] });
}

// ── Companion Status ──────────────────────────────────────────────────

export async function getCompanionStatus() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.COMPANION_STATUS);
  return data[STORAGE_KEYS.COMPANION_STATUS] || { connected: false, lastSync: 0, modelVersion: null };
}

export async function setCompanionStatus(status) {
  await chrome.storage.local.set({ [STORAGE_KEYS.COMPANION_STATUS]: status });
}

// ── Utility: Export closed log as JSON string ─────────────────────────

export async function exportClosedLogAsJSON() {
  const log = await getClosedLog();
  return JSON.stringify(log, null, 2);
}
