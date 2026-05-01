/**
 * Neural-Janitor - Local Storage Manager
 *
 * Tab entries are stored under per-tab keys instead of one large registry
 * object. That keeps normal activity updates to a single small read/write.
 */

import { STORAGE_KEYS } from './constants.js';
import { allowsRootDomainLearning, getRootDomain } from './domain-utils.js';
import { DEFAULT_IDLE_SCHEDULE, normalizeIdleSchedule } from './idle-schedule.js';

const DOMAIN_CATEGORY_MEMORY_MAX = 500;
const DOMAIN_CATEGORY_MEMORY_MIN_CONFIDENCE = 0.55;

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
    rootDomain: record.rootDomain || getRootDomain(record.url || ''),
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

// ── Domain Category Memory ───────────────────────────────────────────

export async function getDomainCategoryMemory() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.DOMAIN_CATEGORY_MEMORY);
  return data[STORAGE_KEYS.DOMAIN_CATEGORY_MEMORY] || {};
}

async function setDomainCategoryMemory(memory) {
  await chrome.storage.local.set({ [STORAGE_KEYS.DOMAIN_CATEGORY_MEMORY]: memory });
}

function bestCategoryFromCounts(counts = {}) {
  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1]);
  const [category, count] = entries[0];
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  return { category, count, total, dominance: total > 0 ? count / total : 0 };
}

export async function rememberDomainCategory({ url, category, confidence = 0, source = '' } = {}) {
  if (!url || !category || category === 'other' || source === 'domain-memory') return null;
  if ((confidence || 0) < DOMAIN_CATEGORY_MEMORY_MIN_CONFIDENCE) return null;

  const rootDomain = getRootDomain(url);
  if (!rootDomain || !allowsRootDomainLearning(rootDomain)) return null;

  const memory = await getDomainCategoryMemory();
  const current = memory[rootDomain] || {
    counts: {},
    confidenceSum: {},
    samples: 0,
    createdAt: Date.now(),
  };

  current.counts[category] = (current.counts[category] || 0) + 1;
  current.confidenceSum[category] = (current.confidenceSum[category] || 0) + confidence;
  current.samples = (current.samples || 0) + 1;
  current.lastCategory = category;
  current.lastSource = source || 'local';
  current.updatedAt = Date.now();
  memory[rootDomain] = current;

  const domains = Object.keys(memory);
  if (domains.length > DOMAIN_CATEGORY_MEMORY_MAX) {
    domains
      .sort((a, b) => (memory[a].updatedAt || 0) - (memory[b].updatedAt || 0))
      .slice(0, domains.length - DOMAIN_CATEGORY_MEMORY_MAX)
      .forEach(domain => delete memory[domain]);
  }

  await setDomainCategoryMemory(memory);
  return { rootDomain, ...current };
}

export async function inferDomainCategory(url) {
  const rootDomain = getRootDomain(url);
  if (!rootDomain || !allowsRootDomainLearning(rootDomain)) return null;

  const memory = await getDomainCategoryMemory();
  const record = memory[rootDomain];
  if (!record) return null;

  const best = bestCategoryFromCounts(record.counts);
  if (!best) return null;

  const avgConfidence = (record.confidenceSum?.[best.category] || 0) / best.count;
  const enoughEvidence = best.count >= 2 || (best.count === 1 && avgConfidence >= 0.8);
  if (!enoughEvidence || best.dominance < 0.6) return null;

  return {
    rootDomain,
    category: best.category,
    samples: best.total,
    dominance: best.dominance,
    confidence: Math.min(0.86, 0.58 + best.dominance * 0.18 + Math.log2(best.count + 1) * 0.04),
    source: 'domain-memory',
  };
}

// ── User Settings ─────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  enabled: true,
  checkIntervalMinutes: 30,
  customThresholds: {},
  useCompanion: true,
  whitelist: [],
  blacklist: [],      // [{ pattern: string, hours: number, minutes: number }]
  holidayCalendar: 'none',
  idleSchedule: DEFAULT_IDLE_SCHEDULE,
  testMode: false,
  aiSuggestionsMutedUntil: 0,
  aiCleanupTargetMemory: 70,
  aiCleanupTargetTabs: 30,
  aiForceCleanupThreshold: 85,
};

function mergeIdleSchedule(current, next) {
  return normalizeIdleSchedule({
    weekday: {
      ...(current?.weekday || {}),
      ...(next?.weekday || {}),
    },
    rest: {
      ...(current?.rest || {}),
      ...(next?.rest || {}),
    },
  });
}

function normalizeBlacklist(entries = []) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map(entry => ({
      pattern: String(entry?.pattern || '').trim(),
      hours: Math.min(99, Math.max(0, parseInt(entry?.hours, 10) || 0)),
      minutes: Math.min(59, Math.max(0, parseInt(entry?.minutes, 10) || 0)),
    }))
    .filter(entry => entry.pattern);
}

function normalizeSettings(settings = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    idleSchedule: normalizeIdleSchedule(settings.idleSchedule || DEFAULT_IDLE_SCHEDULE),
    blacklist: normalizeBlacklist(settings.blacklist),
  };
}

export async function getSettings() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.USER_SETTINGS);
  return normalizeSettings(data[STORAGE_KEYS.USER_SETTINGS] || {});
}

export async function updateSettings(partial) {
  const current = await getSettings();
  const merged = { ...current, ...partial };
  if (partial?.idleSchedule) {
    merged.idleSchedule = mergeIdleSchedule(current.idleSchedule, partial.idleSchedule);
  }
  const normalized = normalizeSettings(merged);
  await chrome.storage.local.set({ [STORAGE_KEYS.USER_SETTINGS]: normalized });
  return normalized;
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

// ── Tagged Tabs (test-mode markers) ──────────────────────────────────

export async function getTaggedTabs() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.TAGGED_TABS);
  return data[STORAGE_KEYS.TAGGED_TABS] || {};
}

export async function setTaggedTabs(tagged) {
  await chrome.storage.local.set({ [STORAGE_KEYS.TAGGED_TABS]: tagged });
}

export async function tagTab(tabId, info) {
  const tagged = await getTaggedTabs();
  tagged[tabId] = { ...info, taggedAt: Date.now() };
  await chrome.storage.local.set({ [STORAGE_KEYS.TAGGED_TABS]: tagged });
}

export async function untagTab(tabId) {
  const tagged = await getTaggedTabs();
  delete tagged[tabId];
  await chrome.storage.local.set({ [STORAGE_KEYS.TAGGED_TABS]: tagged });
}

export async function clearAllTags() {
  await chrome.storage.local.remove(STORAGE_KEYS.TAGGED_TABS);
}
