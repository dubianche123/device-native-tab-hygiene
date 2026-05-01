/**
 * Neural-Janitor — Closure Learner
 *
 * Learns from HOW the user closes tabs to dynamically adjust category
 * retention thresholds. Three data streams:
 *
 *   manual_browser_close  — user closed tab via Ctrl+W / close button
 *   manual_popup_close    — user closed tab via the extension popup
 *   auto_cleanup          — stale check or AI cleanup closed the tab
 *
 * Manual closes carry full learning weight. Auto-cleanup samples are kept
 * for context only (stored with weight 0.2) so the system does not reinforce
 * its own decisions.
 *
 * Each sample records: category, dwellMs, ageMs, interactions, openedAt,
 * lastVisited, hourOfDay.
 *
 * Per-category stats (median/p25/p75 of dwell & age for manual closes)
 * are used to recommend adjusted retention thresholds once enough useful
 * foreground dwell samples exist.
 */

import { CATEGORIES, DEFAULT_CATEGORY, STORAGE_KEYS } from './constants.js';

const MAX_SAMPLES = 2000;
const MIN_MANUAL_SAMPLES = 5;      // Need at least this many manual closes to recommend
const MIN_ANY_SAMPLES = 3;         // Minimum total samples to show any stats
const MIN_RECOMMEND_DWELL_MS = 60 * 1000; // Ignore background/mass-close samples for thresholds
const AUTO_CLEANUP_WEIGHT = 0.2;   // Dampened feedback weight
const MANUAL_TYPES = new Set(['manual_browser_close', 'manual_popup_close']);
const VALID_TYPES = new Set([...MANUAL_TYPES, 'auto_cleanup']);

// ── Storage access ────────────────────────────────────────────────────

export async function getClosureData() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.CLOSURE_LEARNING);
  return data[STORAGE_KEYS.CLOSURE_LEARNING] || { samples: [] };
}

async function setClosureData(data) {
  await chrome.storage.local.set({ [STORAGE_KEYS.CLOSURE_LEARNING]: data });
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
 */
export async function recordClosureSample(sample) {
  const data = await getClosureData();
  const now = Date.now();
  const type = normalizeClosureType(sample.type);

  data.samples.push({
    type,
    category: sample.category || 'other',
    dwellMs: sample.dwellMs || 0,
    ageMs: sample.ageMs || 0,
    interactions: sample.interactions || 0,
    openedAt: sample.openedAt || now,
    lastVisited: sample.lastVisited || now,
    closedAt: now,
    hourOfDay: new Date().getHours(),
    weight: isManualClosure(type) ? 1 : AUTO_CLEANUP_WEIGHT,
  });

  // Rolling window cap
  if (data.samples.length > MAX_SAMPLES) {
    data.samples = data.samples.slice(-MAX_SAMPLES);
  }

  await setClosureData(data);
  return sample;
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
        manualAge: [],
        manualInteractions: [],
        autoDwell: [],
        autoAge: [],
        hourDist: [],
      };
    }
    const b = buckets[cat];

    if (isManualClosure(s.type)) {
      b.manualDwell.push(s.dwellMs);
      b.manualAge.push(s.ageMs);
      b.manualInteractions.push(s.interactions);
    } else {
      b.autoDwell.push(s.dwellMs);
      b.autoAge.push(s.ageMs);
    }
    b.hourDist.push(s.hourOfDay);
  }

  const stats = {};
  for (const [cat, b] of Object.entries(buckets)) {
    const catInfo = CATEGORIES[cat] || DEFAULT_CATEGORY;
    const defaultThreshold = catInfo.maxAgeMs || DEFAULT_CATEGORY.maxAgeMs;
    const manualCount = b.manualDwell.length;
    const autoCount = b.autoDwell.length;

    const manualDwellMs = median(b.manualDwell);
    const manualAgeMs = median(b.manualAge);
    const manualP25Dwell = percentile(b.manualDwell, 0.25);
    const manualP25Age = percentile(b.manualAge, 0.25);
    const autoDwellMs = median(b.autoDwell);
    const autoAgeMs = median(b.autoAge);
    const recommendationDwellSamples = b.manualDwell.filter(ms => ms >= MIN_RECOMMEND_DWELL_MS);

    // Recommended threshold: based on manual close patterns
    // Use meaningful median foreground dwell × 1.5. Manual closes with
    // zero/near-zero dwell are usually background tab cleanup, so they are
    // tracked but do not shrink retention thresholds.
    let recommendedThresholdMs = null;
    let thresholdDelta = null;

    if (recommendationDwellSamples.length >= MIN_MANUAL_SAMPLES) {
      const recommendationDwellMs = median(recommendationDwellSamples);
      recommendedThresholdMs = Math.max(
        5 * 60 * 1000,  // Floor: 5 minutes
        Math.min(
          defaultThreshold * 2,  // Cap: 2x default
          recommendationDwellMs * 1.5,
        ),
      );
      thresholdDelta = recommendedThresholdMs - defaultThreshold;
    }

    // Peak hour for closures (most common)
    const hourCounts = {};
    for (const h of b.hourDist) hourCounts[h] = (hourCounts[h] || 0) + 1;
    const peakHour = Object.entries(hourCounts)
      .sort((a, c) => c[1] - a[1])[0]?.[0];

    stats[cat] = {
      manualDwellMs,
      manualAgeMs,
      manualP25Dwell,
      manualP25Age,
      autoDwellMs,
      autoAgeMs,
      manualCount,
      autoCount,
      recommendationSampleCount: recommendationDwellSamples.length,
      totalSamples: manualCount + autoCount,
      peakClosureHour: peakHour != null ? Number(peakHour) : null,
      recommendedThresholdMs,
      thresholdDelta,
      defaultThresholdMs: defaultThreshold,
    };
  }

  return stats;
}

/**
 * Get learned thresholds for all categories with enough manual data.
 * Returns { [category]: recommendedThresholdMs }
 */
export async function getLearnedThresholds() {
  const stats = await getCategoryClosureStats();
  const thresholds = {};

  for (const [cat, s] of Object.entries(stats)) {
    if (s.recommendedThresholdMs != null) {
      thresholds[cat] = s.recommendedThresholdMs;
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
  const stats = await getCategoryClosureStats();

  const totalSamples = samples.length;
  const manualCount = samples.filter(
    s => isManualClosure(s.type),
  ).length;
  const autoCount = samples.filter(s => s.type === 'auto_cleanup').length;
  const categoriesWithRecommendations = Object.values(stats)
    .filter(s => s.recommendedThresholdMs != null).length;

  return {
    totalSamples,
    manualCount,
    autoCount,
    categoriesTracked: Object.keys(stats).length,
    categoriesWithRecommendations,
    stats,
  };
}

/**
 * Reset all closure learning data.
 */
export async function resetClosureLearning() {
  await chrome.storage.local.remove(STORAGE_KEYS.CLOSURE_LEARNING);
}
