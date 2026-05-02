/**
 * Neural-Janitor — Closure Learner
 *
 * Learns from HOW the user closes tabs to dynamically adjust category
 * and root-domain retention thresholds. Three data streams:
 *
 *   manual_browser_close  — user closed tab via Ctrl+W / close button
 *   manual_popup_close    — user closed tab via the extension popup
 *   auto_cleanup          — stale check or AI cleanup closed the tab
 *
 * Manual closes carry full learning weight. Auto-cleanup samples are kept
 * for context only (stored with weight 0.2) so the system does not reinforce
 * its own decisions.
 *
 * Each sample records: category, rootDomain, foreground dwell, background
 * age, interactions, openedAt, lastVisited, and hourOfDay.
 *
 * Per-category and per-root-domain stats recommend adjusted retention
 * thresholds once enough short-but-real manual close samples exist.
 */

import { CATEGORIES, DEFAULT_CATEGORY, STORAGE_KEYS } from './constants.js';
import { allowsRootDomainLearning } from './domain-utils.js';
import { getLearningRootDomain, SEARCH_RESULTS_CATEGORY } from './search-results.js';
import { getSettings } from './storage.js';
import { sendCompanionRequest } from './idle-detector.js';

const MAX_SAMPLES = 2000;
const MIN_DOMAIN_MANUAL_SAMPLES = 3; // Fast domain-level learning from repeated manual closes
const MIN_CATEGORY_MANUAL_SAMPLES = 6; // Category learning needs broader evidence
const MIN_CATEGORY_MANUAL_DOMAINS = 2;
const MIN_ANY_SAMPLES = 3;         // Minimum total samples to show any stats
const MIN_USEFUL_SAMPLE_MS = 15 * 1000; // Ignore immediate misclicks/background bulk closes
const AUTO_CLEANUP_WEIGHT = 0.2;   // Dampened feedback weight
const MANUAL_TYPES = new Set(['manual_browser_close', 'manual_popup_close']);
const VALID_TYPES = new Set([...MANUAL_TYPES, 'auto_cleanup']);
const SHORT_SESSION_FLOOR_MS = 2 * 60 * 1000;
const IMPORTANT_SESSION_FLOOR_MS = 10 * 60 * 1000;
const ENTERTAINMENT_SESSION_FLOOR_MS = 20 * 60 * 1000;
const UNCATEGORIZED_SESSION_FLOOR_MS = 12 * 60 * 60 * 1000;
const IMPORTANT_CATEGORIES = new Set(['ai', 'work', 'email', 'reference', 'finance']);

// ── Storage access ────────────────────────────────────────────────────

const LOCAL_PENDING_KEY = STORAGE_KEYS.CLOSURE_LEARNING;

function currentBrowserType() {
  const ua = typeof navigator !== 'undefined' ? String(navigator.userAgent || '') : '';
  if (/Edg\//i.test(ua)) return 'edge';
  if (/Chrome\//i.test(ua)) return 'chrome';
  if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) return 'safari';
  return 'other';
}

function normalizeBrowserType(browserType = '', fallback = 'unknown') {
  const value = String(browserType || '').toLowerCase();
  if (value === 'edge' || value === 'chrome' || value === 'safari') return value;
  return fallback;
}

function closureSampleSignature(sample = {}, browserType = currentBrowserType()) {
  return [
    sample.type || 'manual_browser_close',
    sample.category || 'other',
    sample.rootDomain || getLearningRootDomain(sample.url || ''),
    normalizeBrowserType(sample.browserType || browserType),
    sample.closedRecordId || '',
    Math.round(Number(sample.closedAt) || 0),
    Math.round(Number(sample.openedAt) || 0),
    Math.round(Number(sample.lastVisited) || 0),
    Math.round(Number(sample.lastBackgroundedAt) || 0),
    Math.round(Number(sample.dwellMs) || 0),
    Math.round(Number(sample.ageMs) || 0),
    Math.round(Number(sample.interactions) || 0),
    sample.url || '',
  ].join('|');
}

function normalizeClosureSample(sample = {}, browserType = currentBrowserType()) {
  const now = Date.now();
  const type = normalizeClosureType(sample.type);
  const closedAt = Number(sample.closedAt) || now;
  const rootDomain = sample.rootDomain || getLearningRootDomain(sample.url || '');
  const resolvedBrowserType = normalizeBrowserType(sample.browserType || browserType, browserType);
  const sampleId = String(sample.sampleId || closureSampleSignature(sample, resolvedBrowserType));

  return {
    sampleId,
    type,
    category: sample.category || 'other',
    rootDomain,
    browserType: resolvedBrowserType,
    url: sample.url || '',
    closedRecordId: sample.closedRecordId || null,
    dwellMs: Number(sample.dwellMs) || 0,
    ageMs: Number(sample.ageMs) || 0,
    backgroundAgeMs: sample.backgroundAgeMs ?? null,
    interactions: Number(sample.interactions) || 0,
    openedAt: Number(sample.openedAt) || now,
    lastVisited: Number(sample.lastVisited) || now,
    lastBackgroundedAt: sample.lastBackgroundedAt ?? null,
    closedAt,
    hourOfDay: new Date(closedAt).getHours(),
    weight: isManualClosure(type) ? 1 : AUTO_CLEANUP_WEIGHT,
  };
}

function normalizeClosureSamples(samples = [], browserType = 'unknown') {
  return (Array.isArray(samples) ? samples : [])
    .map(sample => normalizeClosureSample(sample, browserType))
    .filter(sample => sample.sampleId);
}

function normalizePendingRemoval(removal = {}) {
  const closedRecordId = removal.closedRecordId || null;
  const url = removal.url || '';
  const closedAt = Number(removal.closedAt) || 0;
  const type = normalizeClosureType(removal.type || 'auto_cleanup');
  const requestId = removal.requestId || [
    closedRecordId || '',
    url || '',
    Math.round(closedAt),
    type,
  ].join('|');

  return {
    requestId,
    closedRecordId,
    url,
    closedAt,
    type,
  };
}

function closureSampleMatchesRemoval(sample = {}, removal = {}) {
  if (!sample || !removal) return false;
  if (removal.closedRecordId && sample.closedRecordId && sample.closedRecordId === removal.closedRecordId) {
    return true;
  }
  if (normalizeClosureType(sample.type) !== normalizeClosureType(removal.type || 'auto_cleanup')) {
    return false;
  }

  const targetRoot = getLearningRootDomain(removal.url || '');
  const targetClosedAt = Number(removal.closedAt) || 0;
  const legacyTimeMatch = targetClosedAt > 0
    && Math.abs((Number(sample.closedAt) || 0) - targetClosedAt) <= 2 * 60 * 1000;
  const legacyUrlMatch = Boolean(removal.url) && sample.url === removal.url;
  const legacyRootMatch = Boolean(targetRoot) && sample.rootDomain === targetRoot;
  return legacyTimeMatch && (legacyUrlMatch || legacyRootMatch);
}

async function getPendingClosureData() {
  const data = await chrome.storage.local.get(LOCAL_PENDING_KEY);
  const pending = data[LOCAL_PENDING_KEY];
  if (!pending || typeof pending !== 'object') return { samples: [], removals: [] };
  const samples = normalizeClosureSamples(pending.samples || [], currentBrowserType());
  const removals = (Array.isArray(pending.removals) ? pending.removals : [])
    .map(normalizePendingRemoval);
  const sampleChanged = (pending.samples || []).length !== samples.length
    || (pending.samples || []).some((sample, index) => sample?.sampleId !== samples[index]?.sampleId);
  const removalChanged = (pending.removals || []).length !== removals.length
    || (pending.removals || []).some((removal, index) => removal?.requestId !== removals[index]?.requestId);
  if (sampleChanged || removalChanged) {
    await chrome.storage.local.set({ [LOCAL_PENDING_KEY]: { samples, removals } });
  }
  return { ...pending, samples, removals };
}

async function setPendingClosureData(data) {
  const samples = normalizeClosureSamples(data?.samples || [], currentBrowserType());
  const removals = (Array.isArray(data?.removals) ? data.removals : [])
    .map(normalizePendingRemoval);
  await chrome.storage.local.set({ [LOCAL_PENDING_KEY]: { samples, removals } });
}

async function clearPendingClosureData() {
  await chrome.storage.local.remove(LOCAL_PENDING_KEY);
}

async function getCompanionClosureSamples() {
  try {
    const response = await sendCompanionRequest({ type: 'getClosureLearning' });
    if (Array.isArray(response?.samples)) {
      return {
        samples: normalizeClosureSamples(response.samples, 'unknown'),
        totalSamples: response.totalSamples ?? response.samples.length,
        browserCounts: response.browserCounts || {},
      };
    }
  } catch {
    // Companion unavailable; fall back to local pending queue.
  }
  return null;
}

async function isCompanionEnabled() {
  const settings = await getSettings().catch(() => null);
  return settings?.useCompanion !== false;
}

export async function syncClosureLearningToCompanion() {
  if (!(await isCompanionEnabled())) return { ok: false, skipped: true };
  const pending = await getPendingClosureData();
  const samples = pending.samples || [];
  const removals = pending.removals || [];
  let remainingRemovals = [...removals];

  try {
    for (const removal of removals) {
      const response = await sendCompanionRequest({
        type: 'removeClosureSamplesForClosedRecord',
        closedRecordId: removal.closedRecordId,
        url: removal.url,
        closedAt: removal.closedAt,
        recordType: removal.type,
      });
      if (response?.ok) {
        remainingRemovals = remainingRemovals.filter(item => item.requestId !== removal.requestId);
      } else {
        break;
      }
    }

    let syncedCount = 0;
    let totalCount = samples.length;
    if (samples.length > 0) {
      const response = await sendCompanionRequest({ type: 'recordClosureSamples', samples });
      if (response?.ok) {
        syncedCount = response.importedCount ?? samples.length;
        totalCount = response.totalSamples ?? samples.length;
      } else {
        await setPendingClosureData({ samples, removals: remainingRemovals });
        return { ok: false, syncedCount: 0, removalCount: removals.length - remainingRemovals.length };
      }
    }

    if (remainingRemovals.length === 0) {
      await clearPendingClosureData();
    } else {
      await setPendingClosureData({ samples: [], removals: remainingRemovals });
    }
    return {
      ok: true,
      syncedCount,
      totalCount,
      removalCount: removals.length - remainingRemovals.length,
    };
  } catch {
    // Leave local pending data intact so we can retry later.
  }

  return { ok: false, syncedCount: 0 };
}

export async function getClosureData() {
  if (await isCompanionEnabled()) {
    await syncClosureLearningToCompanion();
    const remote = await getCompanionClosureSamples();
    const pending = await getPendingClosureData();
    const removalQueue = pending.removals || [];
    const pendingSamples = removalQueue.length > 0
      ? pending.samples.filter(sample => !removalQueue.some(removal => closureSampleMatchesRemoval(sample, removal)))
      : pending.samples;
    if (remote) {
      const remoteSamples = removalQueue.length > 0
        ? remote.samples.filter(sample => !removalQueue.some(removal => closureSampleMatchesRemoval(sample, removal)))
        : remote.samples;
      const mergedMap = new Map();
      for (const sample of [...remoteSamples, ...pendingSamples]) {
        const key = sample.sampleId || closureSampleSignature(sample);
        if (!mergedMap.has(key)) {
          mergedMap.set(key, sample);
        }
      }
      const merged = [...mergedMap.values()];
      const browserCounts = {};
      for (const sample of merged) {
        const key = normalizeBrowserType(sample.browserType || 'unknown');
        browserCounts[key] = (browserCounts[key] || 0) + 1;
      }
      return {
        samples: merged,
        totalSamples: merged.length,
        browserCounts,
      };
    }
  }

  const pending = await getPendingClosureData();
  const removalQueue = pending.removals || [];
  const pendingSamples = removalQueue.length > 0
    ? pending.samples.filter(sample => !removalQueue.some(removal => closureSampleMatchesRemoval(sample, removal)))
    : pending.samples;
  const browserCounts = {};
  for (const sample of pendingSamples) {
    const key = normalizeBrowserType(sample.browserType || 'unknown');
    browserCounts[key] = (browserCounts[key] || 0) + 1;
  }
  return {
    ...pending,
    samples: pendingSamples,
    totalSamples: pendingSamples.length,
    browserCounts,
  };
}

// ── Stat helpers ──────────────────────────────────────────────────────

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function normalizeClosureType(type) {
  return VALID_TYPES.has(type) ? type : 'manual_browser_close';
}

function isManualClosure(type) {
  return MANUAL_TYPES.has(type);
}

function learnedThresholdFloor(category) {
  if (category === SEARCH_RESULTS_CATEGORY) return SHORT_SESSION_FLOOR_MS;
  if (category === DEFAULT_CATEGORY.key) return UNCATEGORIZED_SESSION_FLOOR_MS;
  if (category === 'entertainment') return ENTERTAINMENT_SESSION_FLOOR_MS;
  return IMPORTANT_CATEGORIES.has(category) ? IMPORTANT_SESSION_FLOOR_MS : SHORT_SESSION_FLOOR_MS;
}

function requiredManualSamples(category, scope = 'domain') {
  if (category === SEARCH_RESULTS_CATEGORY) return MIN_DOMAIN_MANUAL_SAMPLES;
  if (scope === 'category') {
    if (category === DEFAULT_CATEGORY.key) return Number.POSITIVE_INFINITY;
    if (category === 'entertainment') return 8;
    return MIN_CATEGORY_MANUAL_SAMPLES;
  }
  if (category === 'entertainment') return 5;
  return MIN_DOMAIN_MANUAL_SAMPLES;
}

// ── Record a closure sample ───────────────────────────────────────────

/**
 * Record a closure event for learning.
 * @param {object} sample
 * @param {'manual_browser_close'|'manual_popup_close'|'auto_cleanup'} sample.type
 * @param {string} sample.category
 * @param {number} sample.dwellMs
 * @param {number} sample.ageMs
 * @param {number} sample.interactions
 * @param {number} sample.openedAt
 * @param {number} sample.lastVisited
 * @param {number} [sample.backgroundAgeMs] - time since tab left foreground
 * @param {number} [sample.lastBackgroundedAt] - timestamp when tab left foreground
 * @param {string} [sample.url] - used only to derive rootDomain for local learning
 * @param {string} [sample.closedRecordId] - closed-log record id for reversible auto-cleanup samples
 * @param {number} [sample.closedAt] - timestamp when the closure happened
 */
export async function recordClosureSample(sample) {
  const normalized = normalizeClosureSample(sample);

  if (await isCompanionEnabled()) {
    try {
      const response = await sendCompanionRequest({ type: 'recordClosureSample', sample: normalized });
      if (response?.ok) {
        return { ok: true, sample: normalized, source: 'companion' };
      }
    } catch {
      // Fall through to local pending storage.
    }
  }

  const data = await getPendingClosureData();
  const existing = data.samples || [];
  const removals = data.removals || [];
  const next = [...existing.filter(item => item.sampleId !== normalized.sampleId), normalized];
  const capped = next.length > MAX_SAMPLES ? next.slice(-MAX_SAMPLES) : next;
  await setPendingClosureData({ samples: capped, removals });
  return { ok: true, sample: normalized, source: 'local-pending' };
}

export async function removeClosureSamplesForClosedRecord({ closedRecordId, url, closedAt, type = 'auto_cleanup' } = {}) {
  const normalizedType = normalizeClosureType(type);
  const data = await getPendingClosureData();
  const samples = data.samples || [];
  const removals = data.removals || [];
  const targetRoot = getLearningRootDomain(url || '');
  const targetClosedAt = Number(closedAt) || 0;
  let removedCount = 0;
  let fallbackRemoved = false;
  const nextRemoval = normalizePendingRemoval({
    closedRecordId,
    url,
    closedAt: targetClosedAt,
    type: normalizedType,
  });
  const nextRemovals = [
    ...removals.filter(item => item.requestId !== nextRemoval.requestId),
    nextRemoval,
  ];

  data.samples = samples.filter(sample => {
    if (normalizeClosureType(sample.type) !== normalizedType) return true;

    if (closedRecordId && sample.closedRecordId === closedRecordId) {
      removedCount++;
      return false;
    }

    const legacyTimeMatch = targetClosedAt > 0
      && Math.abs((Number(sample.closedAt) || 0) - targetClosedAt) <= 2 * 60 * 1000;
    const legacyUrlMatch = url && sample.url === url;
    const legacyRootMatch = targetRoot && sample.rootDomain === targetRoot;
    if (!fallbackRemoved && removedCount === 0 && legacyTimeMatch && (legacyUrlMatch || legacyRootMatch)) {
      fallbackRemoved = true;
      removedCount++;
      return false;
    }

    return true;
  });
  await setPendingClosureData({ samples: data.samples, removals: nextRemovals });

  if (await isCompanionEnabled()) {
    try {
      const response = await sendCompanionRequest({
        type: 'removeClosureSamplesForClosedRecord',
        closedRecordId,
        url,
        closedAt,
        recordType: normalizedType,
      });
      if (response?.ok) {
        removedCount += response.removedCount;
        await setPendingClosureData({
          samples: data.samples,
          removals: nextRemovals.filter(item => item.requestId !== nextRemoval.requestId),
        });
      }
    } catch {
      // Keep local removal even if the companion is offline.
    }
  }

  return { ok: true, removedCount };
}

function summariseClosureBucket(key, b, defaultCategory = DEFAULT_CATEGORY.key, options = {}) {
  const scope = options.scope || 'category';
  const catInfo = CATEGORIES[defaultCategory] || DEFAULT_CATEGORY;
  const defaultThreshold = catInfo.maxAgeMs || DEFAULT_CATEGORY.maxAgeMs;
  const manualCount = b.manualDwell.length;
  const autoCount = b.autoDwell.length;
  const manualDomainCount = b.manualDomains?.size || 0;

  const manualDwellMs = median(b.manualDwell);
  const manualBackgroundAgeMs = median(b.manualBackgroundAge);
  const manualP25Dwell = percentile(b.manualDwell, 0.25);
  const manualP25BackgroundAge = percentile(b.manualBackgroundAge, 0.25);
  const autoDwellMs = median(b.autoDwell);
  const autoBackgroundAgeMs = median(b.autoBackgroundAge);
  const recommendationDwellSamples = b.manualDwell.filter(ms => ms >= MIN_USEFUL_SAMPLE_MS);
  const validBackgroundSamples = b.manualBackgroundAge.filter(ms => ms >= MIN_USEFUL_SAMPLE_MS);
  const thresholdFloor = learnedThresholdFloor(defaultCategory);
  const sampleRequirement = requiredManualSamples(defaultCategory, scope);
  const domainRequirement = scope === 'category' && defaultCategory !== SEARCH_RESULTS_CATEGORY
    ? MIN_CATEGORY_MANUAL_DOMAINS
    : 1;

  let recommendedThresholdMs = null;
  let thresholdDelta = null;
  const recommendationSampleCount = Math.max(validBackgroundSamples.length, recommendationDwellSamples.length);
  const hasEnoughSamples = Number.isFinite(sampleRequirement)
    && recommendationSampleCount >= sampleRequirement;
  const hasEnoughDomains = scope !== 'category'
    || manualDomainCount >= domainRequirement
    || (manualDomainCount === 0 && recommendationSampleCount >= sampleRequirement * 2);
  let recommendationBlockedReason = null;

  if (!Number.isFinite(sampleRequirement)) {
    recommendationBlockedReason = 'category_too_broad';
  } else if (!hasEnoughSamples) {
    recommendationBlockedReason = 'needs_more_manual_samples';
  } else if (!hasEnoughDomains) {
    recommendationBlockedReason = 'needs_more_domains';
  }

  if (!recommendationBlockedReason && validBackgroundSamples.length >= sampleRequirement) {
    const medianBackgroundAge = median(validBackgroundSamples);
    recommendedThresholdMs = Math.max(
      thresholdFloor,
      Math.min(defaultThreshold * 2, medianBackgroundAge * 1.5),
    );
    thresholdDelta = recommendedThresholdMs - defaultThreshold;
  } else if (!recommendationBlockedReason && recommendationDwellSamples.length >= sampleRequirement) {
    const recommendationDwellMs = median(recommendationDwellSamples);
    recommendedThresholdMs = Math.max(
      thresholdFloor,
      Math.min(defaultThreshold * 2, recommendationDwellMs * 1.5),
    );
    thresholdDelta = recommendedThresholdMs - defaultThreshold;
  }

  const hourCounts = {};
  for (const h of b.hourDist) hourCounts[h] = (hourCounts[h] || 0) + 1;
  const peakHour = Object.entries(hourCounts)
    .sort((a, c) => c[1] - a[1])[0]?.[0];

  return {
    key,
    category: defaultCategory,
    manualDwellMs,
    manualBackgroundAgeMs,
    manualP25Dwell,
    manualP25BackgroundAge,
    autoDwellMs,
    autoBackgroundAgeMs,
    manualCount,
    autoCount,
    manualDomainCount,
    recommendationSampleCount,
    recommendationSampleRequirement: Number.isFinite(sampleRequirement) ? sampleRequirement : null,
    recommendationDomainRequirement: domainRequirement,
    recommendationScope: scope,
    recommendationBlockedReason,
    totalSamples: manualCount + autoCount,
    peakClosureHour: peakHour != null ? Number(peakHour) : null,
    recommendedThresholdMs,
    thresholdDelta,
    defaultThresholdMs: defaultThreshold,
  };
}

// ── Per-category statistics ───────────────────────────────────────────

/**
 * Compute per-category closure statistics.
 * Returns { [category]: { manualDwellMs, manualAgeMs, manualInteractions,
 *   autoDwellMs, autoAgeMs, manualCount, autoCount, totalSamples,
 *   recommendedThresholdMs, thresholdDelta, defaultThresholdMs } }
 */
export async function getCategoryClosureStats() {
  const data = await getClosureData();
  const samples = data.samples || [];
  if (samples.length < MIN_ANY_SAMPLES) return {};

  const buckets = {};

  for (const s of samples) {
    const cat = s.category || 'other';
    if (!buckets[cat]) {
      buckets[cat] = {
        manualDwell: [],
        manualBackgroundAge: [],
        manualInteractions: [],
        autoDwell: [],
        autoBackgroundAge: [],
        hourDist: [],
        manualDomains: new Set(),
      };
    }
    const b = buckets[cat];
    const rootDomain = s.rootDomain || getLearningRootDomain(s.url || '');

    if (isManualClosure(s.type)) {
      b.manualDwell.push(s.dwellMs);
      // Prefer backgroundAgeMs (time since tab left foreground).
      // Fallback to ageMs for samples recorded before this field existed.
      const backgroundAge = s.backgroundAgeMs != null ? s.backgroundAgeMs : s.ageMs;
      b.manualBackgroundAge.push(backgroundAge);
      b.manualInteractions.push(s.interactions);
      if (rootDomain) b.manualDomains.add(rootDomain);
    } else {
      b.autoDwell.push(s.dwellMs);
      const backgroundAge = s.backgroundAgeMs != null ? s.backgroundAgeMs : s.ageMs;
      b.autoBackgroundAge.push(backgroundAge);
    }
    b.hourDist.push(s.hourOfDay);
  }

  const stats = {};
  for (const [cat, b] of Object.entries(buckets)) {
    stats[cat] = summariseClosureBucket(cat, b, cat, { scope: 'category' });
  }

  return stats;
}

function dominantCategory(categoryCounts = {}) {
  const entries = Object.entries(categoryCounts);
  if (entries.length === 0) return DEFAULT_CATEGORY.key;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0] || DEFAULT_CATEGORY.key;
}

/**
 * Compute per-root-domain closure statistics. This is the fallback learning
 * layer for pages that are hard to categorise, especially broad "other" tabs.
 */
export async function getDomainClosureStats() {
  const data = await getClosureData();
  const samples = data.samples || [];
  if (samples.length < MIN_ANY_SAMPLES) return {};

  const buckets = {};

  for (const s of samples) {
    const rootDomain = s.rootDomain || getLearningRootDomain(s.url || '');
    if (!rootDomain || !allowsRootDomainLearning(rootDomain)) continue;
    if (!buckets[rootDomain]) {
      buckets[rootDomain] = {
        manualDwell: [],
        manualBackgroundAge: [],
        manualInteractions: [],
        autoDwell: [],
        autoBackgroundAge: [],
        hourDist: [],
        categoryCounts: {},
        manualDomains: new Set(),
      };
    }
    const b = buckets[rootDomain];
    const cat = s.category || DEFAULT_CATEGORY.key;
    b.categoryCounts[cat] = (b.categoryCounts[cat] || 0) + 1;

    if (isManualClosure(s.type)) {
      b.manualDwell.push(s.dwellMs);
      const backgroundAge = s.backgroundAgeMs != null ? s.backgroundAgeMs : s.ageMs;
      b.manualBackgroundAge.push(backgroundAge);
      b.manualInteractions.push(s.interactions);
      b.manualDomains.add(rootDomain);
    } else {
      b.autoDwell.push(s.dwellMs);
      const backgroundAge = s.backgroundAgeMs != null ? s.backgroundAgeMs : s.ageMs;
      b.autoBackgroundAge.push(backgroundAge);
    }
    b.hourDist.push(s.hourOfDay);
  }

  const stats = {};
  for (const [rootDomain, b] of Object.entries(buckets)) {
    const cat = dominantCategory(b.categoryCounts);
    stats[rootDomain] = {
      ...summariseClosureBucket(rootDomain, b, cat, { scope: 'domain' }),
      rootDomain,
      categoryCounts: b.categoryCounts,
    };
  }

  return stats;
}

/**
 * Get learned thresholds for categories and root domains with enough manual data.
 * Returns { [category]: recommendedThresholdMs, __domains: { [rootDomain]: recommendedThresholdMs } }
 */
export async function getLearnedThresholds() {
  const stats = await getCategoryClosureStats();
  const domainStats = await getDomainClosureStats();
  const thresholds = {};

  for (const [cat, s] of Object.entries(stats)) {
    if (s.recommendedThresholdMs != null) {
      thresholds[cat] = s.recommendedThresholdMs;
    }
  }

  thresholds.__domains = {};
  for (const [rootDomain, s] of Object.entries(domainStats)) {
    if (s.recommendedThresholdMs != null) {
      thresholds.__domains[rootDomain] = s.recommendedThresholdMs;
    }
  }

  return thresholds;
}

/**
 * Get overall learning summary for the popup.
 */
export async function getLearningSummary() {
  const data = await getClosureData();
  const samples = data.samples || [];
  const browserCounts = data.browserCounts || {};
  const stats = await getCategoryClosureStats();
  const domainStats = await getDomainClosureStats();

  const totalSamples = samples.length;
  const manualCount = samples.filter(
    s => isManualClosure(s.type),
  ).length;
  const autoCount = samples.filter(s => s.type === 'auto_cleanup').length;
  const categoriesWithRecommendations = Object.values(stats)
    .filter(s => s.recommendedThresholdMs != null).length;
  const domainsWithRecommendations = Object.values(domainStats)
    .filter(s => s.recommendedThresholdMs != null).length;
  const learnedBuckets = categoriesWithRecommendations + domainsWithRecommendations;

  return {
    totalSamples,
    manualCount,
    autoCount,
    categoriesTracked: Object.keys(stats).length,
    categoriesWithRecommendations,
    domainsTracked: Object.keys(domainStats).length,
    domainsWithRecommendations,
    learnedBuckets,
    trackedBuckets: Object.keys(stats).length + Object.keys(domainStats).length,
    stats,
    domainStats,
    browserCounts,
  };
}

/**
 * Reset all closure learning data.
 */
export async function resetClosureLearning() {
  if (await isCompanionEnabled()) {
    try {
      await sendCompanionRequest({ type: 'resetClosureLearning' });
    } catch {
      // Fall back to local cleanup below.
    }
  }
  await clearPendingClosureData();
}
