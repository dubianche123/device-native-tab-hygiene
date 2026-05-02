/**
 * Neural-Janitor — Background Service Worker (Manifest V3)
 *
 * Core lifecycle:
 *   1. On install / startup → snapshot all open tabs into the registry
 *   2. On alarm (every 30 min) → scan for stale tabs & close them
 *   3. On tab activation / update → record last-visited timestamp
 *   4. On idle state change → sync with companion & trigger checks
 *   5. On first user interaction after idle → show return notification
 */

import {
  APP_NAME,
  CATEGORIES,
  CHECK_INTERVAL_MINUTES,
  COMPANION_SYNC_INTERVAL_MINUTES,
  ENGINE_CODENAME,
  DEFAULT_CATEGORY,
  HARDWARE_MARKER_STATES,
  IPC_PROTOCOL_VERSION,
  SESSION_CHECKPOINT_INTERVAL_MINUTES,
} from './constants.js';
import {
  getTabCount, getTabEntry, getTabRegistry, setTabRegistry, upsertTabEntry, updateTabEntry, removeTabEntry,
  appendClosedRecord, getClosedLog, getSettings, updateSettings,
  getCompanionStatus,
  markClosedRecordRestored,
  removeClosedRecords, clearRestoredClosedRecords,
  resetLearningState as clearLearningState,
  getReturnNotification, setReturnNotification, clearReturnNotification,
  getActiveSession, setActiveSession, clearActiveSession,
  getTaggedTabs, tagTab, untagTab, clearAllTags,
  inferDomainCategory, rememberDomainCategory,
} from './storage.js';
import { categorizePage } from './categorizer.js';
import {
  DEPLOYMENT_MODES,
  decideDeploymentModeRequest,
  deploymentModePatch,
  modeToTestMode,
  normalizeDeploymentMode,
  reconcileDeploymentMode,
  summarizeDeployReadiness,
} from './deployment-readiness.js';
import {
  computeCleanupScore,
  SAFE_CLEANUP_POLICY,
  PROACTIVE_CLEANUP_POLICY,
  shouldProactivelyCleanTab,
} from './cleanup-ranking.js';
import { allowsRootDomainLearning } from './domain-utils.js';
import {
  recordClosureSample,
  removeClosureSamplesForClosedRecord,
  getLearnedThresholds,
  getCategoryClosureStats,
  getLearningSummary,
  syncClosureLearningToCompanion,
} from './closure-learner.js';
import { getLearningRootDomain, isSearchResultPage, SEARCH_RESULTS_CATEGORY } from './search-results.js';
import {
  classifyURL,
  recordActivity,
  requestCompanionHealth,
  requestPredictions,
  resetCompanionLearning,
  isInIdleWindow,
} from './idle-detector.js';

const programmaticCloseReasons = new Map();
const IMPORTANCE_MULTIPLIER_MIN = 0.75;
const IMPORTANCE_MULTIPLIER_MAX = 1.75;
const MIN_EFFECTIVE_THRESHOLD_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HIGH_IDLE_CONFIDENCE = 0.92;

function isTrackableUrl(url) {
  return Boolean(url)
    && !url.startsWith('chrome://')
    && !url.startsWith('edge://')
    && !url.startsWith('chrome-extension://')
    && !url.startsWith('about:')
    && !url.startsWith('file://');
}

/**
 * Returns the matching blacklist entry for a URL, or null.
 * Pattern matching: substring of hostname or full URL.
 */
function matchBlacklist(url, blacklist) {
  if (!Array.isArray(blacklist) || !url) return null;
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    for (const entry of blacklist) {
      const pattern = (entry.pattern || '').toLowerCase().trim();
      if (!pattern) continue;
      if (hostname.includes(pattern) || url.toLowerCase().includes(pattern)) {
        return entry;
      }
    }
  } catch { /* invalid URL */ }
  return null;
}

/**
 * Convert a blacklist entry's { hours, minutes } into milliseconds.
 * Defaults to 1 hour if both are zero/missing.
 */
function blacklistThresholdMs(entry) {
  const h = Math.min(99, Math.max(0, parseInt(entry.hours, 10) || 0));
  const m = Math.min(59, Math.max(0, parseInt(entry.minutes, 10) || 0));
  const ms = (h * 3_600_000) + (m * 60_000);
  return ms > 0 ? ms : 3_600_000; // fallback 1 hour
}

function markProgrammaticClose(tabId, reason) {
  programmaticCloseReasons.set(Number(tabId), reason);
}

function clearProgrammaticClose(tabId) {
  programmaticCloseReasons.delete(Number(tabId));
}

function consumeProgrammaticClose(tabId) {
  const numericTabId = Number(tabId);
  const reason = programmaticCloseReasons.get(numericTabId) || null;
  programmaticCloseReasons.delete(numericTabId);
  return reason;
}

function closureAgeMs(entry, now = Date.now()) {
  // Prefer lastBackgroundedAt (time since tab left foreground).
  // Fallback to lastVisited for entries created before this field existed.
  return Math.max(0, now - backgroundReferenceTime(entry, now));
}

function backgroundReferenceTime(entry, now = Date.now()) {
  return entry?.lastBackgroundedAt || entry?.lastVisited || entry?.openedAt || now;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function categoryFromDomainMemory(memoryHit) {
  if (!memoryHit?.category) return null;
  const categoryInfo = CATEGORIES[memoryHit.category];
  if (!categoryInfo) return null;
  return {
    key: memoryHit.category,
    ...categoryInfo,
    confidence: memoryHit.confidence || 0.6,
    source: 'domain-memory',
    rootDomain: memoryHit.rootDomain,
  };
}

function effectiveCategoryKey(entry = {}) {
  return isSearchResultPage(entry.url) ? SEARCH_RESULTS_CATEGORY : (entry.category || DEFAULT_CATEGORY.key);
}

function effectiveLearningRootDomain(entry = {}) {
  return isSearchResultPage(entry.url)
    ? getLearningRootDomain(entry.url)
    : (entry.rootDomain || getLearningRootDomain(entry.url || ''));
}

function learnedDomainThresholdFor(entry, learnedThresholds = {}) {
  const rootDomain = effectiveLearningRootDomain(entry);
  if (!allowsRootDomainLearning(rootDomain)) return null;
  const domainThreshold = learnedThresholds?.__domains?.[rootDomain];
  return typeof domainThreshold === 'number' && domainThreshold > 0
    ? domainThreshold
    : null;
}

async function upgradeWithDomainMemory(url, cat) {
  if (!url || (cat.key !== 'other' && (cat.confidence || 0) >= 0.7)) return cat;
  const memoryCat = categoryFromDomainMemory(await inferDomainCategory(url));
  return memoryCat || cat;
}

async function categorizeWithDomainMemory(input = {}, { remember = true } = {}) {
  const cat = await upgradeWithDomainMemory(input.url, categorizePage(input));
  if (remember) {
    await rememberDomainCategory({
      url: input.url,
      category: cat.key,
      confidence: cat.confidence,
      source: cat.source,
    });
  }
  return cat;
}

function normalizedTabImportance(entry, backgroundAgeMs) {
  const foregroundDwellMs = Math.max(0, entry?.dwellMs || 0);
  const safeBackgroundAgeMs = Math.max(0, backgroundAgeMs || 0);
  const totalObservedMs = foregroundDwellMs + safeBackgroundAgeMs;
  const focusRatio = totalObservedMs > 0 ? foregroundDwellMs / totalObservedMs : 0;
  const normalizedImportance = clamp(focusRatio, 0, 1);
  const importanceMultiplier = IMPORTANCE_MULTIPLIER_MIN
    + normalizedImportance * (IMPORTANCE_MULTIPLIER_MAX - IMPORTANCE_MULTIPLIER_MIN);

  return {
    foregroundDwellMs,
    backgroundAgeMs: safeBackgroundAgeMs,
    focusRatio,
    normalizedImportance,
    importanceMultiplier,
  };
}

function idleContextMultiplier({ predictedIdle = false, currentlyIdle = false } = {}) {
  if (currentlyIdle) return 0.75;
  if (predictedIdle) return 0.9;
  return 1.15;
}

async function buildCleanupContext(settings = {}) {
  const currentlyIdle = await browserIsIdle();
  const predictedIdleWindow = settings.useCompanion !== false ? await isInIdleWindow() : false;
  const predictedIdle = currentlyIdle && predictedIdleWindow;
  const companionStatus = settings.useCompanion !== false ? await getCompanionStatus() : null;
  const rawConfidence = companionStatus?.currentIdleConfidence;
  const idleConfidence = typeof rawConfidence === 'number' && !Number.isNaN(rawConfidence)
    ? clamp(rawConfidence, 0, 1)
    : 0;
  return {
    predictedIdle,
    predictedIdleWindow,
    currentlyIdle,
    idleConfidence: currentlyIdle ? idleConfidence : 0,
    rawIdleConfidence: idleConfidence,
  };
}

function tabRetentionProfile(entry, settings, learnedThresholds, now = Date.now(), context = {}) {
  const categoryKey = effectiveCategoryKey(entry);
  const rootDomain = effectiveLearningRootDomain(entry);
  const backgroundAgeMs = closureAgeMs(entry, now);
  const importance = normalizedTabImportance(entry, backgroundAgeMs);
  const contextMultiplier = idleContextMultiplier(context);
  const closureLimit = settings.customThresholds?.[categoryKey];
  const hasClosureLimit = typeof closureLimit === 'number' && closureLimit > 0;
  const domainLearnedThreshold = learnedDomainThresholdFor(entry, learnedThresholds);
  const hasDomainThreshold = typeof domainLearnedThreshold === 'number' && domainLearnedThreshold > 0;
  const learnedThreshold = hasDomainThreshold ? domainLearnedThreshold : learnedThresholds?.[categoryKey];
  const hasLearnedThreshold = typeof learnedThreshold === 'number' && learnedThreshold > 0;
  const defaultThreshold = CATEGORIES[categoryKey]?.maxAgeMs || CATEGORIES.other?.maxAgeMs || 7 * 24 * 60 * 60 * 1000;
  const limitMs = hasClosureLimit ? closureLimit : defaultThreshold;

  let modelMaxAgeMs = defaultThreshold;
  let thresholdSource = 'default';

  if (hasLearnedThreshold) {
    modelMaxAgeMs = clamp(
      learnedThreshold * importance.importanceMultiplier * contextMultiplier,
      MIN_EFFECTIVE_THRESHOLD_MS,
      Math.max(MIN_EFFECTIVE_THRESHOLD_MS, defaultThreshold * 2),
    );
    thresholdSource = hasDomainThreshold ? 'domain_learned_x_importance_x_context' : 'learned_x_importance_x_context';
  }

  const maxAgeMs = Math.min(modelMaxAgeMs, limitMs);
  if (maxAgeMs < modelMaxAgeMs) {
    thresholdSource = hasLearnedThreshold
      ? (hasDomainThreshold ? 'domain_learned_x_importance_x_context_capped' : 'learned_x_importance_x_context_capped')
      : 'default_capped';
  }

  const remainingMs = Math.max(0, maxAgeMs - backgroundAgeMs);
  const highIdleConfidence = (context.currentlyIdle === true)
    && (context.idleConfidence ?? 0) >= HIGH_IDLE_CONFIDENCE
    && maxAgeMs >= DAY_MS
    && remainingMs <= DAY_MS;
  const stale = backgroundAgeMs > maxAgeMs || highIdleConfidence;
  const reason = highIdleConfidence
    ? 'high_idle_confidence_early_close'
    : (backgroundAgeMs > maxAgeMs ? 'exceeded_background_threshold' : 'within_threshold');

  return {
    ...importance,
    categoryKey,
    rootDomain,
    baseThresholdMs: hasLearnedThreshold ? learnedThreshold : defaultThreshold,
    contextMultiplier,
    modelMaxAgeMs,
    limitMs,
    maxAgeMs,
    earlyCloseEligible: highIdleConfidence,
    thresholdSource,
    stale,
    reason,
  };
}

function closureReasonForRecord(result, backgroundAgeMs) {
  const hours = Math.round(backgroundAgeMs / (1000 * 60 * 60));
  if (result.reason === 'blacklist') {
    return `blacklist_${hours}h`;
  }
  if (result.reason === 'high_idle_confidence_early_close') {
    return `confidence_idle_${hours}h`;
  }
  return `idle_${hours}h`;
}

async function deploymentStatus(settings = null, learningSummary = null) {
  const currentSettings = settings || await getSettings();
  const summary = learningSummary || await getLearningSummary();
  const readiness = summarizeDeployReadiness(summary);
  const currentMode = normalizeDeploymentMode(currentSettings);
  const reconciled = reconcileDeploymentMode(currentMode, readiness);
  const shouldPersist = reconciled.changed
    || currentSettings.deploymentMode !== reconciled.mode
    || currentSettings.testMode !== modeToTestMode(reconciled.mode);

  let nextSettings = currentSettings;
  if (shouldPersist) {
    const patch = deploymentModePatch(reconciled.mode, {
      deployArmedAt: reconciled.mode === DEPLOYMENT_MODES.ARMED
        ? (currentSettings.deployArmedAt || Date.now())
        : null,
      autoDeployActivatedAt: reconciled.reason === 'armed_ready'
        ? Date.now()
        : (reconciled.mode === DEPLOYMENT_MODES.DEPLOY ? currentSettings.autoDeployActivatedAt || null : null),
    });
    nextSettings = await updateSettings(patch);
  }

  const mode = normalizeDeploymentMode(nextSettings);
  return {
    settings: nextSettings,
    mode,
    effectiveTestMode: modeToTestMode(mode),
    readiness,
    changed: shouldPersist,
    reason: reconciled.reason,
    canArm: readiness.armable,
    canDeploy: readiness.ready,
    blocked: !readiness.armable,
  };
}

async function setDeploymentMode(requestedMode) {
  const settings = await getSettings();
  const summary = await getLearningSummary();
  const readiness = summarizeDeployReadiness(summary);
  const decision = decideDeploymentModeRequest(requestedMode, readiness);

  if (!decision.ok) {
    const safeSettings = await updateSettings(deploymentModePatch(DEPLOYMENT_MODES.TEST, {
      deployArmedAt: null,
      autoDeployActivatedAt: null,
    }));
    return {
      ...decision,
      settings: safeSettings,
      readiness,
      effectiveTestMode: true,
      canArm: readiness.armable,
      canDeploy: readiness.ready,
      blocked: true,
    };
  }

  const now = Date.now();
  const nextSettings = await updateSettings(deploymentModePatch(decision.mode, {
    deployArmedAt: decision.mode === DEPLOYMENT_MODES.ARMED ? (settings.deployArmedAt || now) : null,
    autoDeployActivatedAt: null,
  }));

  return {
    ...decision,
    settings: nextSettings,
    readiness,
    effectiveTestMode: modeToTestMode(decision.mode),
    canArm: readiness.armable,
    canDeploy: readiness.ready,
    blocked: false,
  };
}

// ── Protected Tabs ───────────────────────────────────────────────────

/**
 * Build a set of tab IDs that must never be auto-closed.
 * Includes: active tabs in every window, pinned tabs, audible tabs,
 * and the current active session tab.
 */
async function getProtectedTabIds() {
  const protected_ = new Set();

  // Active tab in the current active session (fast path)
  const session = await getActiveSession();
  if (session?.tabId) protected_.add(session.tabId);

  // All tabs that are currently active in any window, pinned, or audible
  try {
    const liveTabs = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    for (const t of liveTabs) protected_.add(t.id);

    // Also protect active tabs in other windows
    const allWindows = await chrome.windows.getAll({ populate: true });
    for (const win of allWindows) {
      if (win.tabs) {
        for (const t of win.tabs) {
          if (t.active) protected_.add(t.id);
          if (t.pinned) protected_.add(t.id);
          if (t.audible) protected_.add(t.id);
        }
      }
    }
  } catch (err) {
    console.warn('[Neural-Janitor] getProtectedTabIds query failed:', err);
  }

  return protected_;
}

async function recordTabClosureForLearning(entry, type, now = Date.now(), closedRecordId = null) {
  if (!entry?.url) return;
  // Skip blacklisted URLs — they follow fixed rules, not learned heuristics.
  const settings = await getSettings();
  if (matchBlacklist(entry.url, settings.blacklist)) return;
  const searchResult = isSearchResultPage(entry.url);
  await recordClosureSample({
    type,
    category: searchResult ? SEARCH_RESULTS_CATEGORY : (entry.category || 'other'),
    url: entry.url,
    rootDomain: searchResult ? getLearningRootDomain(entry.url) : (entry.rootDomain || getLearningRootDomain(entry.url)),
    closedRecordId,
    closedAt: now,
    dwellMs: entry.dwellMs || 0,
    ageMs: closureAgeMs(entry, now),
    backgroundAgeMs: entry.lastBackgroundedAt ? Math.max(0, now - entry.lastBackgroundedAt) : null,
    interactions: entry.interactions || 0,
    openedAt: entry.openedAt || now,
    lastVisited: entry.lastVisited || now,
    lastBackgroundedAt: entry.lastBackgroundedAt || null,
  });
}

function isAutoClosedRecord(record = {}) {
  return record.reason !== 'manual_popup_close'
    && (
      String(record.reason || '').startsWith('ai_cleanup')
      || String(record.reason || '').startsWith('idle_')
      || String(record.reason || '').startsWith('confidence_idle_')
    );
}

async function getClosedRecord(category, id) {
  if (!category || !id) return null;
  const log = await getClosedLog();
  return (log[category] || []).find(entry => entry.id === id) || null;
}

function queryIdleState() {
  return new Promise((resolve) => {
    chrome.idle.queryState(60 * 5, resolve);
  });
}

async function browserIsIdle() {
  const state = await queryIdleState();
  return state === 'idle' || state === 'locked';
}

async function recordBrowserActivity(state = 'active', tab = null, extra = {}) {
  const timestamp = extra.timestamp || Date.now();
  const activeSession = await getActiveSession();
  const entry = tab?.id ? await getTabEntry(tab.id) : (activeSession?.tabId ? await getTabEntry(activeSession.tabId) : null);
  const tabCount = await getTabCount();

  await recordActivity({
    timestamp,
    state,
    tabId: tab?.id || activeSession?.tabId || null,
    category: entry?.category || extra.category || 'other',
    dwellMs: entry?.dwellMs || 0,
    interactions: entry?.interactions || 0,
    tabCount,
  });
}

async function closeActiveSession(reason = 'ended') {
  const session = await getActiveSession();
  if (!session?.tabId || !session.startedAt) return;

  const endedAt = Date.now();
  const duration = Math.max(0, endedAt - session.startedAt);
  await updateTabEntry(session.tabId, (entry) => {
    if (!entry?.url) return null;
    return {
      ...entry,
      dwellMs: (entry.dwellMs || 0) + duration,
      lastVisited: Math.max(entry.lastVisited || 0, endedAt),
      lastSessionEndedAt: endedAt,
      lastBackgroundedAt: endedAt,
      active: false,
      activeReason: reason,
    };
  });

  await clearActiveSession();
}

async function checkpointActiveSession(reason = 'checkpoint') {
  const session = await getActiveSession();
  if (!session?.tabId || !session.startedAt) return;

  const now = Date.now();
  const idle = await browserIsIdle();
  const duration = Math.max(0, now - session.startedAt);
  const cappedDuration = idle ? 0 : Math.min(duration, 5 * 60 * 1000);

  if (cappedDuration > 0) {
    await updateTabEntry(session.tabId, (entry) => {
      if (!entry?.url) return null;
      return {
        ...entry,
        dwellMs: (entry.dwellMs || 0) + cappedDuration,
        lastVisited: Math.max(entry.lastVisited || 0, now),
        lastActivatedAt: now,
        lastForegroundAt: entry.lastForegroundAt || now,
        lastCheckpointAt: now,
        active: true,
        activeReason: reason,
      };
    });
  }

  await setActiveSession({ ...session, startedAt: now, lastCheckpointAt: now });
}

async function startActiveSession(tab, reason = 'activated') {
  if (!tab?.id || !isTrackableUrl(tab.url)) return;

  const current = await getActiveSession();
  if (current?.tabId === tab.id && current.startedAt) {
    await checkpointActiveSession('resume_same_tab');
    return;
  }

  await closeActiveSession(reason);

  const now = Date.now();
  const cat = await categorizeWithDomainMemory({ url: tab.url, title: tab.title || '' });
  const rootDomain = getLearningRootDomain(tab.url);
  const prev = await getTabEntry(tab.id) || {};
  await upsertTabEntry(tab.id, {
    url: tab.url,
    title: tab.title || '',
    favIconUrl: tab.favIconUrl || prev.favIconUrl || '',
    category: cat.key,
    categorySource: cat.source,
    categoryConfidence: cat.confidence,
    rootDomain,
    lastVisited: now,
    lastActivatedAt: now,
    lastForegroundAt: now,
    openedAt: prev.openedAt || now,
    dwellMs: prev.dwellMs || 0,
    interactions: prev.interactions || 0,
    active: true,
  });
  await setActiveSession({ tabId: tab.id, windowId: tab.windowId, startedAt: now, url: tab.url });
  await recordBrowserActivity('active', tab, { timestamp: now, category: cat.key });
}

async function resumeActiveFocusedTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (tabs[0]) await startActiveSession(tabs[0], 'resume');
}

async function noteTabActivity(tab, timestamp = Date.now()) {
  if (!tab?.id || !isTrackableUrl(tab.url)) return;
  const cat = await categorizeWithDomainMemory({ url: tab.url, title: tab.title || '' }, { remember: false });
  const rootDomain = getLearningRootDomain(tab.url);
  await updateTabEntry(tab.id, (entry) => ({
    ...(entry || {}),
    url: tab.url,
    title: tab.title || '',
    favIconUrl: tab.favIconUrl || entry?.favIconUrl || '',
    category: cat.key,
    categorySource: cat.source,
    categoryConfidence: cat.confidence,
    rootDomain,
    lastVisited: timestamp,
    lastInteractionAt: timestamp,
    interactions: ((entry && entry.interactions) || 0) + 1,
  }));
  await recordBrowserActivity('active', tab, { timestamp, category: cat.key });
}

async function findRecentlyClosedSession(url) {
  await new Promise(resolve => setTimeout(resolve, 150));
  const sessions = await chrome.sessions.getRecentlyClosed({ maxResults: 10 }).catch(() => []);
  const match = sessions.find(session => session.tab?.url === url);
  return match?.tab?.sessionId || null;
}

async function getRecentlyClosedSessions(maxResults = 50) {
  return chrome.sessions.getRecentlyClosed({ maxResults }).catch(() => []);
}

async function reconcileRestoredSessionTabs() {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const sessions = await getRecentlyClosedSessions(100);
  const now = Date.now();
  const restoreWindowMs = 15 * 60 * 1000;
  const usedSessionIds = new Set();
  const closedRecords = Object.entries(await getClosedLog()).flatMap(([category, entries]) =>
    (Array.isArray(entries) ? entries : []).map(entry => ({ category, ...entry }))
  );

  let restoredCount = 0;
  let removedSampleCount = 0;

  for (const tab of tabs) {
    if (!isTrackableUrl(tab.url)) continue;

    const candidates = sessions
      .filter(session =>
        session?.tab?.url === tab.url
        && session?.sessionId
        && !usedSessionIds.has(session.sessionId)
        && typeof session.lastModified === 'number'
        && now - session.lastModified <= restoreWindowMs
      )
      .sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));

    if (candidates.length === 0) continue;

    const session = candidates[0];
    usedSessionIds.add(session.sessionId);
    restoredCount++;

    const closedRecord = closedRecords.find(entry => entry.sessionId && entry.sessionId === session.sessionId)
      || closedRecords.find(entry =>
        entry.url === tab.url
        && typeof entry.closedAt === 'number'
        && Math.abs(entry.closedAt - session.lastModified) <= 2 * 60 * 1000
      );

    if (closedRecord) {
      await markClosedRecordRestored(closedRecord.category, closedRecord.id).catch(() => false);
      const sampleType = isAutoClosedRecord(closedRecord) ? 'auto_cleanup' : 'manual_popup_close';
      const removal = await removeClosureSamplesForClosedRecord({
        closedRecordId: closedRecord.id,
        url: closedRecord.url,
        closedAt: closedRecord.closedAt,
        type: sampleType,
      }).catch(() => ({ removedCount: 0 }));
      removedSampleCount += removal.removedCount || 0;
      continue;
    }

    const removal = await removeClosureSamplesForClosedRecord({
      url: tab.url,
      closedAt: session.lastModified,
      type: 'manual_browser_close',
    }).catch(() => ({ removedCount: 0 }));
    removedSampleCount += removal.removedCount || 0;
  }

  if (restoredCount > 0 || removedSampleCount > 0) {
    console.log(`[Neural-Janitor] Reconciled ${restoredCount} restored startup tab(s); removed ${removedSampleCount} learning sample(s).`);
  }
}

async function restoreClosedTab({ category, id, url, sessionId }) {
  const record = await getClosedRecord(category, id);
  let restored = null;
  let learningRemovedCount = 0;
  if (sessionId) {
    restored = await chrome.sessions.restore(sessionId).catch(() => null);
  }

  if (!restored && url) {
    restored = await chrome.tabs.create({ url }).catch(() => null);
  }

  if (restored && category && id) {
    await markClosedRecordRestored(category, id);
    if (isAutoClosedRecord(record)) {
      const removal = await removeClosureSamplesForClosedRecord({
        closedRecordId: id,
        url: record?.url || url,
        closedAt: record?.closedAt,
        type: 'auto_cleanup',
      });
      learningRemovedCount = removal.removedCount || 0;
    }
  }

  return { ok: Boolean(restored), restored, learningRemovedCount };
}

async function restoreClosedTabs(items = []) {
  const results = [];
  for (const item of items) {
    const result = await restoreClosedTab(item);
    results.push({
      category: item.category || null,
      id: item.id || null,
      ok: Boolean(result.ok),
      learningRemovedCount: result.learningRemovedCount || 0,
    });
  }

  return {
    ok: results.some(result => result.ok),
    restoredCount: results.filter(result => result.ok).length,
    failedCount: results.filter(result => !result.ok).length,
    learningRemovedCount: results.reduce((sum, result) => sum + (result.learningRemovedCount || 0), 0),
    results,
  };
}

async function closeTrackedTab(tabId, reason = 'manual_popup_close') {
  const numericTabId = Number.parseInt(tabId, 10);
  if (!Number.isInteger(numericTabId)) {
    return { ok: false, error: 'Invalid tab id' };
  }

  const active = await getActiveSession();
  if (active?.tabId === numericTabId) {
    await closeActiveSession('manual_close');
  }

  const tab = await chrome.tabs.get(numericTabId).catch(() => null);
  let entry = await getTabEntry(numericTabId);

  if (tab && isTrackableUrl(tab.url)) {
    const cat = await categorizeWithDomainMemory({ url: tab.url, title: tab.title || '' });
    const rootDomain = getLearningRootDomain(tab.url);
    const searchResult = isSearchResultPage(tab.url);
    entry = {
      ...(entry || {}),
      url: tab.url,
      title: tab.title || '',
      favIconUrl: tab.favIconUrl || entry?.favIconUrl || '',
      category: searchResult ? SEARCH_RESULTS_CATEGORY : (entry?.category || cat.key),
      categorySource: entry?.categorySource || cat.source,
      categoryConfidence: entry?.categoryConfidence || cat.confidence,
      rootDomain: searchResult ? rootDomain : (entry?.rootDomain || rootDomain),
      lastVisited: entry?.lastVisited || Date.now(),
      openedAt: entry?.openedAt || Date.now(),
      dwellMs: entry?.dwellMs || 0,
      interactions: entry?.interactions || 0,
    };
  }

  if (!tab) {
    await removeTabEntry(numericTabId);
    return { ok: false, error: 'Tab is already closed' };
  }

  if (!entry?.url) {
    return { ok: false, error: 'Tab is no longer tracked' };
  }

  const now = Date.now();
  markProgrammaticClose(numericTabId, 'manual_popup_close');
  try {
    await chrome.tabs.remove(numericTabId);
  } catch (err) {
    clearProgrammaticClose(numericTabId);
    console.warn('[Neural-Janitor] Manual close failed:', err);
    return { ok: false, error: err?.message || 'Could not close tab' };
  }

  const sessionId = await findRecentlyClosedSession(entry.url);
  const categoryKey = effectiveCategoryKey(entry);
  await appendClosedRecord({
    url: entry.url,
    title: entry.title,
    favIconUrl: entry.favIconUrl || '',
    category: categoryKey,
    sessionId,
    closedAt: now,
    reason,
    lastVisited: entry.lastVisited || now,
    ageMs: closureAgeMs(entry, now),
    dwellMs: entry.dwellMs || 0,
    interactions: entry.interactions || 0,
  });
  await recordTabClosureForLearning(entry, 'manual_popup_close', now);

  await removeTabEntry(numericTabId);

  return { ok: true };
}

// ══════════════════════════════════════════════════════════════════════
// INSTALLATION & STARTUP
// ══════════════════════════════════════════════════════════════════════

async function bootstrapBrowserState(source = 'startup') {
  console.log(`[Neural-Janitor] Browser ${source}; initialising tab registry`);
  await snapshotAllTabs();
  await reconcileRestoredSessionTabs().catch(() => {});
  setupAlarms();
  await syncClosureLearningToCompanion().catch(() => {});
  requestPredictions();
  await resumeActiveFocusedTab();
}

chrome.runtime.onInstalled.addListener(async () => {
  await bootstrapBrowserState('installed');
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[Neural-Janitor] Browser started; resuming');
  await bootstrapBrowserState('startup');
});

// ══════════════════════════════════════════════════════════════════════
// ALARMS — periodic stale-tab check & companion sync
// ══════════════════════════════════════════════════════════════════════

function setupAlarms() {
  chrome.alarms.create('nj-stale-check', { periodInMinutes: CHECK_INTERVAL_MINUTES });
  chrome.alarms.create('nj-companion-sync', { periodInMinutes: COMPANION_SYNC_INTERVAL_MINUTES });
  chrome.alarms.create('nj-session-checkpoint', { periodInMinutes: SESSION_CHECKPOINT_INTERVAL_MINUTES });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'nj-stale-check') {
    console.log('[Neural-Janitor] Periodic stale-tab check triggered');
    await performStaleCheck({ source: 'alarm' });

    // Force-trigger AI cleanup if memory exceeds threshold
    const settings = await getSettings();
    if (settings.enabled) {
      const deployStatus = await deploymentStatus(settings);
      const mem = await getMemoryPressure();
      const forceThreshold = settings.aiForceCleanupThreshold || 85;
      if (deployStatus.mode === DEPLOYMENT_MODES.DEPLOY && mem.percent >= forceThreshold) {
        console.log(`[Neural-Janitor] Memory at ${mem.percent}% >= force threshold ${forceThreshold}% — auto-triggering AI cleanup`);
        await aiCleanup({ source: 'auto' });
      }
    }
  } else if (alarm.name === 'nj-companion-sync') {
    const settings = await getSettings();
    if (settings.useCompanion !== false) {
      await syncClosureLearningToCompanion().catch(() => {});
      await requestPredictions();
    }
  } else if (alarm.name === 'nj-session-checkpoint') {
    await checkpointActiveSession();
  }
});

// ══════════════════════════════════════════════════════════════════════
// TAB EVENT LISTENERS
// ══════════════════════════════════════════════════════════════════════

// Tab created → add to registry
chrome.tabs.onCreated.addListener(async (tab) => {
  if (!isTrackableUrl(tab.url)) return;
  const now = Date.now();
  const cat = await categorizeWithDomainMemory({ url: tab.url, title: tab.title || '' });
  const rootDomain = getLearningRootDomain(tab.url);
  await upsertTabEntry(tab.id, {
    url: tab.url,
    title: tab.title || '',
    favIconUrl: tab.favIconUrl || '',
    category: cat.key,
    categorySource: cat.source,
    categoryConfidence: cat.confidence,
    rootDomain,
    lastVisited: now,
    lastForegroundAt: tab.active ? now : null,
    lastBackgroundedAt: tab.active ? null : now,
    openedAt: now,
    dwellMs: 0,
    interactions: 0,
    active: tab.active === true,
  });
});

// Tab updated (navigated, loaded) → update last-visited
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!isTrackableUrl(tab.url)) return;
  const prev = await getTabEntry(tabId) || {};
  const navigated = prev.url && prev.url !== tab.url;
  const active = await getActiveSession();
  if (navigated && active?.tabId === tabId) {
    await closeActiveSession('navigation');
  }
  const cat = await categorizeWithDomainMemory({ url: tab.url, title: tab.title || '' });
  const rootDomain = getLearningRootDomain(tab.url);
  const now = Date.now();
  const lastBackgroundedAt = tab.active
    ? null
    : (navigated ? now : (prev.lastBackgroundedAt || prev.lastVisited || now));
  await upsertTabEntry(tabId, {
    url: tab.url,
    title: tab.title || '',
    favIconUrl: tab.favIconUrl || prev.favIconUrl || '',
    category: cat.key,
    categorySource: cat.source,
    categoryConfidence: cat.confidence,
    rootDomain,
    lastVisited: now,
    lastForegroundAt: tab.active ? (prev.lastForegroundAt || now) : (prev.lastForegroundAt || null),
    lastBackgroundedAt,
    openedAt: navigated ? now : (prev.openedAt || now),
    dwellMs: navigated ? 0 : (prev.dwellMs || 0),
    interactions: navigated ? 0 : (prev.interactions || 0),
    active: tab.active === true,
  });
  if (tab.active) await startActiveSession(tab, 'navigation');
  await recordBrowserActivity('active', tab);
});

// Tab activated (user switched to it) → update last-visited
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tab = await chrome.tabs.get(activeInfo.tabId).catch(() => null);
  if (!tab || !isTrackableUrl(tab.url)) return;
  await startActiveSession(tab, 'tab_switch');

  // Check if we have a pending return notification
  const notif = await getReturnNotification();
  if (notif.pending) {
    await showReturnNotification(notif.closedTabs);
    await clearReturnNotification();
  }
});

// Tab removed → clean up registry & record real browser/manual closes.
// Programmatic closes from the popup, stale check, or AI Cleanup also fire
// this event, so those tab ids are marked before chrome.tabs.remove().
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const programmaticReason = consumeProgrammaticClose(tabId);
  const active = await getActiveSession();
  if (active?.tabId === tabId) await closeActiveSession('tab_removed');

  const entry = await getTabEntry(tabId);
  if (!programmaticReason) {
    await recordTabClosureForLearning(entry, 'manual_browser_close');
  }

  await removeTabEntry(tabId);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await closeActiveSession('window_blur');
    return;
  }
  const tabs = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
  if (tabs[0]) await startActiveSession(tabs[0], 'window_focus');
});

// ══════════════════════════════════════════════════════════════════════
// IDLE DETECTION (chrome.idle API)
// ══════════════════════════════════════════════════════════════════════

chrome.idle.setDetectionInterval(60 * 5); // 5 minutes

chrome.idle.onStateChanged.addListener(async (newState) => {
  if (newState === 'active') {
    await resumeActiveFocusedTab();
    await recordBrowserActivity('active');
    // Check if we closed tabs while user was away
    const notif = await getReturnNotification();
    if (notif.pending) {
      // Wait for the user's first meaningful interaction (tab switch)
      // The notification will fire on next onActivated
    }
  } else if (newState === 'idle' || newState === 'locked') {
    await closeActiveSession(`system_${newState}`);
    await recordBrowserActivity(newState);
    // User went idle — good time to run a check
    console.log(`[Neural-Janitor] System state -> ${newState}, running stale check`);
    await performStaleCheck({ source: `system_${newState}` });
  }
});

// ══════════════════════════════════════════════════════════════════════
// CORE: STALE TAB CHECK
// ══════════════════════════════════════════════════════════════════════

async function performStaleCheck({ dryRun = false, source = 'auto' } = {}) {
  let settings = await getSettings();
  const deployStatus = await deploymentStatus(settings);
  settings = deployStatus.settings;
  if (!settings.enabled && !dryRun) return { ok: true, disabled: true, scannedCount: 0, closedCount: 0 };

  const registry = await getTabRegistry();
  const now = Date.now();
  const closedTabs = [];
  const taggedTabs = [];
  let staleCount = 0;
  const retentionContext = await buildCleanupContext(settings);
  const testMode = deployStatus.effectiveTestMode;
  const activeGuard = !dryRun && !testMode && retentionContext.currentlyIdle !== true;
  const learnedThresholds = await getLearnedThresholds();
  const protectedTabs = await getProtectedTabIds();

  // Manual checks, Test mode, and active Deploy scans are previews.
  // Real automatic stale closure waits for chrome.idle to report idle/locked.
  if (testMode || dryRun || activeGuard) await clearAllTags();

  for (const [tabIdStr, entry] of Object.entries(registry)) {
    const tabId = parseInt(tabIdStr, 10);

    // Never close protected tabs (active, pinned, audible in any window)
    if (protectedTabs.has(tabId)) continue;

    // Skip whitelisted URLs (never close)
    if (settings.whitelist.some(w => entry.url?.includes(w))) continue;

    // Blacklist: use fixed threshold, bypass category/learned thresholds
    const blacklistMatch = matchBlacklist(entry.url, settings.blacklist);
    const blacklistMaxAgeMs = blacklistMatch ? blacklistThresholdMs(blacklistMatch) : null;

    const categoryKey = effectiveCategoryKey(entry);
    let result;
    if (blacklistMatch) {
      const backgroundAgeMs = closureAgeMs(entry, now);
      result = {
        backgroundAgeMs,
        maxAgeMs: blacklistMaxAgeMs,
        stale: backgroundAgeMs > blacklistMaxAgeMs,
        reason: 'blacklist',
        categoryKey,
      };
    } else {
      result = tabRetentionProfile(entry, settings, learnedThresholds, now, retentionContext);
    }

    if (!result.stale) continue;
    staleCount++;

    if (testMode || dryRun || activeGuard) {
      // Preview paths tag the tab instead of closing it.
      await tagTab(tabId, {
        reason: closureReasonForRecord(result, result.backgroundAgeMs),
        category: categoryKey,
        title: entry.title || '',
        url: entry.url || '',
      });
      taggedTabs.push({
        tabId,
        url: entry.url,
        title: entry.title,
        category: categoryKey,
        ageMs: result.backgroundAgeMs,
      });
      continue;
    }

    // Deploy mode automatic scan: actually close the tab after idle approval.
    markProgrammaticClose(tabId, 'auto_cleanup');
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      clearProgrammaticClose(tabId);
      // Tab already closed — just log it
    }
    const sessionId = await findRecentlyClosedSession(entry.url);

    // Record the closure
    const closedRecordId = await appendClosedRecord({
      url: entry.url,
      title: entry.title,
      favIconUrl: entry.favIconUrl || '',
      category: categoryKey,
      sessionId,
      closedAt: now,
      reason: closureReasonForRecord(result, result.backgroundAgeMs),
      lastVisited: entry.lastVisited,
      ageMs: result.backgroundAgeMs,
      dwellMs: entry.dwellMs || 0,
      interactions: entry.interactions || 0,
    });

    await recordTabClosureForLearning(entry, 'auto_cleanup', now, closedRecordId);

    closedTabs.push({
      url: entry.url,
      title: entry.title,
      favIconUrl: entry.favIconUrl || '',
      category: categoryKey,
      ageMs: result.backgroundAgeMs,
      dwellMs: entry.dwellMs || 0,
    });

    // Remove from registry
    await removeTabEntry(tabId);
  }

  // If we closed anything, queue a return notification
  if (closedTabs.length > 0) {
    await setReturnNotification({ pending: true, closedTabs });
    console.log(`[Neural-Janitor] Closed ${closedTabs.length} stale tab(s). Return notification queued.`);
  }

  if (testMode && taggedTabs.length > 0) {
    console.log(`[Neural-Janitor] Test mode: tagged ${taggedTabs.length} stale tab(s).`);
  }

  return {
    ok: true,
    disabled: false,
    dryRun,
    source,
    testMode,
    deploymentMode: deployStatus.mode,
    activeGuard,
    action: (dryRun || testMode || activeGuard) ? (activeGuard ? 'tagged_active_guard' : 'tagged') : 'closed',
    scannedCount: Object.keys(registry).length,
    staleCount,
    wouldCloseCount: staleCount,
    closedCount: (dryRun || testMode || activeGuard) ? 0 : closedTabs.length,
    taggedCount: (dryRun || testMode || activeGuard) ? taggedTabs.length : 0,
    currentlyIdle: retentionContext.currentlyIdle,
    idleContextMultiplier: idleContextMultiplier(retentionContext),
    idleConfidence: retentionContext.idleConfidence,
  };
}

// ══════════════════════════════════════════════════════════════════════
// MEMORY PRESSURE & AI CLEANUP
// ══════════════════════════════════════════════════════════════════════

/**
 * Read system memory usage via chrome.system.memory API.
 * Returns { usedCapacity, capacity, percent } in bytes / 0-100.
 */
async function getMemoryPressure() {
  try {
    const info = await chrome.system.memory.getInfo();
    if (!info || !info.capacity) throw new Error('Invalid memory info');
    const used = info.capacity - info.availableCapacity;
    const percent = Math.round((used / info.capacity) * 100);
    return {
      usedCapacity: used,
      capacity: info.capacity,
      availableCapacity: info.availableCapacity,
      percent: Math.min(100, Math.max(0, percent)),
    };
  } catch (err) {
    console.warn('[Neural-Janitor] Memory API error:', err);
    // Return a dummy value if the API fails, so the UI isn't stuck at 0
    return { usedCapacity: 4096, capacity: 8192, availableCapacity: 4096, percent: 50, error: true };
  }
}

async function buildCleanupCandidates(settings = {}, { now = Date.now() } = {}) {
  const registry = await getTabRegistry();
  const protectedTabs = await getProtectedTabIds();
  const learnedThresholds = await getLearnedThresholds();
  const retentionContext = await buildCleanupContext(settings);
  const whitelist = Array.isArray(settings.whitelist) ? settings.whitelist : [];
  const blacklist = Array.isArray(settings.blacklist) ? settings.blacklist : [];
  const candidates = [];

  for (const [tabIdStr, entry] of Object.entries(registry)) {
    const tabId = parseInt(tabIdStr, 10);
    if (protectedTabs.has(tabId)) continue;
    if (whitelist.some(w => entry.url?.includes(w))) continue;

    const blacklistMatch = matchBlacklist(entry.url, blacklist);
    const categoryKey = effectiveCategoryKey(entry);
    const catInfo = CATEGORIES[categoryKey] || {};
    const priority = catInfo.priority ?? 50;
    const defaultThresholdMs = catInfo.maxAgeMs || DEFAULT_CATEGORY.maxAgeMs;

    let retention = tabRetentionProfile(entry, settings, learnedThresholds, now, retentionContext);
    const backgroundAgeMs = retention.backgroundAgeMs;

    if (blacklistMatch) {
      const blMaxAgeMs = blacklistThresholdMs(blacklistMatch);
      if (backgroundAgeMs < blMaxAgeMs) continue;
      retention = {
        ...retention,
        maxAgeMs: blMaxAgeMs,
        thresholdSource: 'blacklist',
        stale: true,
        reason: 'blacklist',
      };
    }

    const learnedThresholdMs = String(retention.thresholdSource || '').includes('learned')
      ? retention.baseThresholdMs
      : null;
    const cleanupScore = computeCleanupScore({
      categoryPriority: priority,
      interactions: entry.interactions || 0,
      normalizedImportance: retention.normalizedImportance,
      backgroundAgeMs,
      effectiveClosureTimeMs: retention.maxAgeMs,
      defaultThresholdMs,
      learnedThresholdMs,
      blacklist: Boolean(blacklistMatch),
      earlyCloseEligible: retention.earlyCloseEligible,
      nsfw: entry.category === 'nsfw',
    });
    const safeCleanup = shouldProactivelyCleanTab({
      score: cleanupScore.score,
      normalizedImportance: retention.normalizedImportance,
      backgroundAgeMs,
      stale: retention.stale,
    }, SAFE_CLEANUP_POLICY);
    const broadCleanup = shouldProactivelyCleanTab({
      score: cleanupScore.score,
      normalizedImportance: retention.normalizedImportance,
      backgroundAgeMs,
      stale: retention.stale,
    }, PROACTIVE_CLEANUP_POLICY);

    candidates.push({
      tabId,
      entry,
      score: cleanupScore.score,
      backgroundAgeMs,
      retention,
      cleanupScore,
      safeEligible: safeCleanup.eligible,
      safeReason: safeCleanup.reason,
      broadEligible: broadCleanup.eligible,
      broadReason: broadCleanup.reason,
      proactiveEligible: broadCleanup.eligible,
      proactiveReason: broadCleanup.reason,
    });
  }

  candidates.sort((a, b) => a.score - b.score);
  return {
    registry,
    candidates,
    retentionContext,
  };
}

let lastCPUInfo = null;

/**
 * Read system CPU usage via chrome.system.cpu API.
 * Compares two snapshots to find the delta of active vs idle time.
 */
async function getCPUUsage() {
  try {
    const info = await chrome.system.cpu.getInfo();
    if (!info || !info.processors) throw new Error('Invalid CPU info');

    if (!lastCPUInfo) {
      lastCPUInfo = info;
      return { percent: 0, model: info.modelName, threads: info.numOfProcessors };
    }

    let totalActive = 0;
    let totalIdle = 0;

    for (let i = 0; i < info.processors.length; i++) {
      const now = info.processors[i].usage;
      const prev = lastCPUInfo.processors[i].usage;

      totalActive += (now.user - prev.user) + (now.kernel - prev.kernel);
      totalIdle += (now.idle - prev.idle);
    }

    lastCPUInfo = info;
    const total = totalActive + totalIdle;
    if (total === 0) return { percent: 0, model: info.modelName, threads: info.numOfProcessors };

    return {
      percent: Math.round((totalActive / total) * 100),
      model: info.modelName,
      threads: info.numOfProcessors,
    };
  } catch (err) {
    console.warn('[Neural-Janitor] CPU API error:', err);
    return { percent: 0, error: true };
  }
}

/**
 * AI Cleanup: close tabs by importance.
 *
 * Manual cleanup can proactively trim a few clearly low-value tabs even when
 * the machine is otherwise under target, but only after Deploy is actually
 * active. Automatic cleanup stays conservative and only acts when pressure
 * really needs relief.
 */
async function aiCleanup({ source = 'manual', profile = 'broad' } = {}) {
  let settings = await getSettings();
  const deployStatus = await deploymentStatus(settings);
  settings = deployStatus.settings;
  const deploymentMode = deployStatus.mode;
  const targetMemory = settings.aiCleanupTargetMemory || 70;
  const targetTabs = settings.aiCleanupTargetTabs || 30;
  const mem = await getMemoryPressure();
  const now = Date.now();
  const { registry, candidates } = await buildCleanupCandidates(settings, { now });
  const tabCount = Object.keys(registry).length;
  const manualSource = source === 'manual';
  if (deploymentMode !== DEPLOYMENT_MODES.DEPLOY) {
    return {
      ok: false,
      blocked: true,
      action: 'locked',
      cleanupMode: 'locked',
      deploymentMode,
      memoryBefore: mem.percent,
      tabCountBefore: tabCount,
      closedCount: 0,
      taggedCount: 0,
      message: 'AI Clean is locked until Deploy is ready',
    };
  }

  const profileKey = profile === 'safe' ? 'safe' : (profile === 'pressure' ? 'pressure' : 'broad');
  const profilePolicy = profileKey === 'safe' ? SAFE_CLEANUP_POLICY : PROACTIVE_CLEANUP_POLICY;
  const tabPressureActive = tabCount > targetTabs;
  const memoryPressureActive = mem.percent > targetMemory;
  const trimProfile = manualSource && profileKey !== 'pressure';
  const trimCandidates = trimProfile
    ? (profileKey === 'safe'
      ? safeTrimCandidatesFromRanked(candidates)
      : rankedLowImportanceCandidates(candidates).slice(0, profilePolicy.maxCount))
    : [];
  const canTrim = trimProfile && trimCandidates.length > 0;

  if (trimProfile && !canTrim) {
    return {
      ok: true,
      action: 'none',
      cleanupMode: `${profileKey}_trim`,
      cleanupProfile: profileKey,
      deploymentMode,
      memoryBefore: mem.percent,
      tabCountBefore: tabCount,
      closedCount: 0,
      message: 'No low-importance tabs matched this cleanup profile',
    };
  }

  if (!canTrim && !tabPressureActive && !memoryPressureActive) {
    return {
      ok: true,
      action: 'none',
      cleanupMode: 'idle',
      cleanupProfile: profileKey,
      deploymentMode,
      memoryBefore: mem.percent,
      tabCountBefore: tabCount,
      closedCount: 0,
      message: 'Already within targets',
    };
  }

  const closedTabs = [];
  let currentMem = mem.percent;
  let currentCount = tabCount;
  const memoryOnlyCloseLimit = tabPressureActive ? Number.POSITIVE_INFINITY : 5;
  const selectedCandidates = canTrim ? trimCandidates : candidates;
  const cleanupMode = canTrim ? `${profileKey}_trim` : 'targeted';

  for (const { tabId, entry, backgroundAgeMs } of selectedCandidates) {
    // Tab count is the primary control target. Memory pressure often does not
    // drop immediately after tab closure, so memory-only cleanup is bounded.
    if (!canTrim) {
      if (tabPressureActive) {
        if (currentCount <= targetTabs) break;
      } else if (currentMem <= targetMemory || closedTabs.length >= memoryOnlyCloseLimit) {
        break;
      }
    }

    markProgrammaticClose(tabId, 'auto_cleanup');
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      clearProgrammaticClose(tabId);
      /* already closed */
    }

    const categoryKey = effectiveCategoryKey(entry);
    const sessionId = await findRecentlyClosedSession(entry.url);
    const closedRecordId = await appendClosedRecord({
      url: entry.url,
      title: entry.title,
      favIconUrl: entry.favIconUrl || '',
      category: categoryKey,
      sessionId,
      closedAt: now,
      reason: cleanupMode === 'safe_trim' ? 'ai_cleanup_safe' : (cleanupMode === 'broad_trim' ? 'ai_cleanup_broad' : 'ai_cleanup'),
      lastVisited: entry.lastVisited,
      ageMs: backgroundAgeMs,
      dwellMs: entry.dwellMs || 0,
      interactions: entry.interactions || 0,
    });

    await recordTabClosureForLearning(entry, 'auto_cleanup', now, closedRecordId);

    await removeTabEntry(tabId);

    currentCount--;
    closedTabs.push({ url: entry.url, title: entry.title });

    // Re-check memory after every 5 closures
    if (!canTrim && closedTabs.length % 5 === 0) {
      const freshMem = await getMemoryPressure();
      currentMem = freshMem.percent;
    }
  }

  if (closedTabs.length > 0 && !manualSource) {
    await setReturnNotification({
      pending: true,
      closedTabs,
    });
  }

  return {
    ok: true,
    action: cleanupMode === 'targeted' ? 'closed' : 'trimmed',
    cleanupMode,
    cleanupProfile: profileKey,
    deploymentMode,
    memoryBefore: mem.percent,
    tabCountBefore: tabCount,
    closedCount: closedTabs.length,
    tabCountAfter: currentCount,
    message: cleanupMode === 'safe_trim'
      ? `Safely trimmed ${closedTabs.length} low-importance tab(s)`
      : cleanupMode === 'broad_trim'
        ? `Trimmed ${closedTabs.length} low-importance tab(s)`
        : `Closed ${closedTabs.length} tab(s)`,
  };
}

/**
 * Analyse current state and return actionable suggestions.
 * Returns { suggestions: [{ level, icon, text, action? }], mem, tabCount }.
 */
function strongestSuggestionLevel(levels = []) {
  const rank = { ok: 0, info: 1, warning: 2, critical: 3 };
  return levels.reduce((best, level) => (
    (rank[level] || 0) > (rank[best] || 0) ? level : best
  ), 'info');
}

function uniqueSuggestionActions(actions = []) {
  const seen = new Set();
  return actions.filter(action => {
    if (!action?.action || seen.has(action.action)) return false;
    seen.add(action.action);
    return true;
  });
}

function rankedLowImportanceCandidates(candidates = []) {
  return candidates.filter(candidate => candidate.broadEligible && !candidate.retention?.stale);
}

function safeTrimCandidatesFromRanked(candidates = []) {
  const strictSafe = candidates.filter(candidate => candidate.safeEligible && !candidate.retention?.stale);
  const ranked = rankedLowImportanceCandidates(candidates);
  return (strictSafe.length > 0 ? strictSafe : ranked).slice(0, SAFE_CLEANUP_POLICY.maxCount);
}

async function getAISuggestion() {
  let settings = await getSettings();
  const mem = await getMemoryPressure();
  const tabCount = await getTabCount();
  const now = Date.now();
  const closureLearning = await getLearningSummary();
  const deployStatus = await deploymentStatus(settings, closureLearning);
  settings = deployStatus.settings;
  const readiness = deployStatus.readiness;
  const targetMem = settings.aiCleanupTargetMemory || 70;
  const targetTabs = settings.aiCleanupTargetTabs || 30;
  const forceThreshold = settings.aiForceCleanupThreshold || 85;

  const suggestions = [];
  const cleanupActionsEnabled = deployStatus.mode === DEPLOYMENT_MODES.DEPLOY;
  const { candidates } = await buildCleanupCandidates(settings, { now });
  const staleCount = candidates.filter(candidate => candidate.retention.stale).length;
  const safeTrimCount = candidates.filter(candidate => candidate.safeEligible && !candidate.retention.stale).length;
  const broadTrimCount = candidates.filter(candidate => candidate.broadEligible && !candidate.retention.stale).length;

  if (deployStatus.mode === DEPLOYMENT_MODES.TEST) {
    if (!readiness.armable) {
      suggestions.push({
        level: 'warning',
        icon: '🧪',
        text: `Deploy is locked until there are ${readiness.required.ARM_MANUAL_CLOSES} manual closes and ${readiness.required.ARM_LEARNED_BUCKETS} learned close-time bucket. Keep Test mode on while the learner warms up.`,
      });
    } else if (!readiness.ready) {
      suggestions.push({
        level: 'info',
        icon: '🧪',
        text: `Close-time learning is warming up: ${readiness.manualCount}/${readiness.required.READY_MANUAL_CLOSES} manual closes and ${readiness.learnedBucketCount}/${readiness.required.READY_LEARNED_BUCKETS} learned buckets. You can arm Deploy now; it will activate automatically when ready.`,
        action: 'armDeploy',
      });
    } else {
      suggestions.push({
        level: 'ok',
        icon: '🚀',
        text: `Deploy looks ready. You have ${readiness.manualCount} manual closes and ${readiness.learnedBucketCount} learned close-time buckets. ${readiness.required.SAFE_MANUAL_CLOSES}/${readiness.required.SAFE_LEARNED_BUCKETS} is the safer bar.`,
        action: 'setModeDeploy',
      });
    }
  } else if (deployStatus.mode === DEPLOYMENT_MODES.ARMED) {
    suggestions.push({
      level: 'info',
      icon: '⏳',
      text: `Deploy is armed. It will switch on automatically at ${readiness.required.READY_MANUAL_CLOSES} manual closes and ${readiness.required.READY_LEARNED_BUCKETS} learned buckets; currently ${readiness.manualCount}/${readiness.required.READY_MANUAL_CLOSES} and ${readiness.learnedBucketCount}/${readiness.required.READY_LEARNED_BUCKETS}.`,
      action: 'setModeTest',
    });
  } else if (!readiness.ready) {
    suggestions.push({
      level: 'warning',
      icon: '🧯',
      text: 'Deploy was disabled because close-time learning is no longer ready.',
      action: 'setModeTest',
    });
  }

  const pressureSignals = [];
  const pressureLevels = [];
  let pressureCleanupNeeded = false;

  if (tabCount > targetTabs * 2) {
    pressureSignals.push(`${tabCount} tabs / target ${targetTabs}`);
    pressureLevels.push('warning');
    pressureCleanupNeeded = true;
  } else if (tabCount > targetTabs) {
    pressureSignals.push(`${tabCount} tabs / target ${targetTabs}`);
    pressureLevels.push('info');
    pressureCleanupNeeded = true;
  }

  if (mem.percent >= forceThreshold) {
    pressureSignals.push(`MEM ${mem.percent}% / force ${forceThreshold}%`);
    pressureLevels.push('critical');
    pressureCleanupNeeded = true;
  } else if (mem.percent >= targetMem + 10) {
    pressureSignals.push(`MEM ${mem.percent}% / target ${targetMem}%`);
    pressureLevels.push('warning');
    pressureCleanupNeeded = true;
  } else if (mem.percent >= targetMem) {
    pressureSignals.push(`MEM ${mem.percent}% / target ${targetMem}%`);
    pressureLevels.push('info');
  }

  if (pressureSignals.length > 0) {
    const level = strongestSuggestionLevel(pressureLevels);
    const actions = [];
    const textParts = [pressureSignals.join(' · ')];
    if (!cleanupActionsEnabled) {
      textParts.push(`Cleanup is locked in ${deployStatus.mode}; Test/Armed only learns and previews.`);
    } else if (broadTrimCount > 0) {
      textParts.push(`Use the cleanup card below to choose a small safe trim or a broader trim.`);
    } else {
      textParts.push('No low-importance candidates are ready yet.');
      if (pressureCleanupNeeded) {
        actions.push({ action: 'aiCleanupPressure', label: tabCount > targetTabs ? '📑 Reduce tabs' : '🧹 Reduce pressure' });
      }
    }

    suggestions.push({
      level,
      icon: !cleanupActionsEnabled ? '🔒' : (level === 'critical' ? '🔴' : '📊'),
      text: textParts.join(' '),
      actions: cleanupActionsEnabled ? uniqueSuggestionActions(actions) : [],
    });
  }

  if (staleCount > 0) {
    suggestions.push({
      level: 'info',
      icon: '🔍',
      text: `${staleCount} stale tab(s) exceeded learned close time. Preview tags them now; auto-close still waits for Mac idle.`,
      actions: [{ action: 'forceCheck', label: `🔍 Preview ${staleCount}` }],
    });
  }

  if (broadTrimCount > 0) {
    const safeActionCount = Math.max(1, Math.min(safeTrimCount || broadTrimCount, SAFE_CLEANUP_POLICY.maxCount));
    const broadActionCount = Math.max(1, Math.min(broadTrimCount, PROACTIVE_CLEANUP_POLICY.maxCount));
    const safeButtonLabel = `🧊 Clean safest ${safeActionCount}`;
    const broadButtonLabel = `🧹 Clean more ${broadActionCount}`;
    const textParts = [
      `${broadTrimCount} low-importance tab(s) ranked.`,
      `Clean safest closes up to ${safeActionCount}; Clean more closes up to ${broadActionCount}.`,
    ];
    if (!cleanupActionsEnabled) {
      textParts.push(`Deploy is required before tabs can close.`);
    }

    suggestions.push({
      level: pressureCleanupNeeded ? 'warning' : 'info',
      icon: cleanupActionsEnabled ? '🧹' : '🔒',
      text: textParts.join(' '),
      actions: cleanupActionsEnabled ? [
        { action: 'aiCleanupSafe', label: safeButtonLabel },
        { action: 'aiCleanupBroad', label: broadButtonLabel },
      ] : [],
    });
  }

  // All clear
  if (suggestions.length === 0) {
    suggestions.push({
      level: 'ok',
      icon: '✅',
      text: 'Everything looks healthy. No action needed.',
    });
  }

  return {
    suggestions,
    memPercent: mem.percent,
    tabCount,
    targetMem,
    targetTabs,
    forceThreshold,
    deployReadiness: readiness,
    deploymentMode: deployStatus.mode,
  };
}

// ══════════════════════════════════════════════════════════════════════
// RETURN NOTIFICATION
// ══════════════════════════════════════════════════════════════════════

async function showReturnNotification(closedTabs) {
  if (!closedTabs || closedTabs.length === 0) return;

  // Group by category for the notification body
  const grouped = {};
  for (const tab of closedTabs) {
    const cat = CATEGORIES[tab.category] || { label: 'Other' };
    const label = cat.label;
    if (!grouped[label]) grouped[label] = 0;
    grouped[label]++;
  }

  const summaryLines = Object.entries(grouped)
    .map(([cat, count]) => `• ${cat}: ${count}`)
    .join('\n');

  const title = `Neural-Janitor cleaned ${closedTabs.length} tab${closedTabs.length > 1 ? 's' : ''}`;
  const message = `While you were away, Neural-Janitor closed stale tabs:\n${summaryLines}\n\nOpen the popup to review.`;

  try {
    chrome.notifications.create('nj-return', {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message,
      priority: 2,
      requireInteraction: true,
    });
  } catch (err) {
    console.warn('[Neural-Janitor] Notification error:', err);
  }
}

chrome.notifications.onClicked.addListener((notifId) => {
  if (notifId === 'nj-return') {
    // Open the popup programmatically isn't directly possible,
    // but we can focus the browser window
    chrome.notifications.clear(notifId);
  }
});

// ══════════════════════════════════════════════════════════════════════
// INITIAL SNAPSHOT — capture all existing tabs on startup
// ══════════════════════════════════════════════════════════════════════

async function snapshotAllTabs() {
  const tabs = await chrome.tabs.query({});
  const existing = await getTabRegistry();
  const registry = {};
  const now = Date.now();

  for (const tab of tabs) {
    if (!isTrackableUrl(tab.url)) continue;
    const prev = existing[tab.id] || {};
    const sameUrl = prev.url === tab.url;
    const cat = await categorizeWithDomainMemory({ url: tab.url, title: tab.title || '' });
    const rootDomain = getLearningRootDomain(tab.url);
    const entry = {
      url: tab.url,
      title: tab.title || '',
      favIconUrl: tab.favIconUrl || (sameUrl ? (prev.favIconUrl || '') : ''),
      category: cat.key,
      categorySource: cat.source,
      categoryConfidence: cat.confidence,
      rootDomain,
      lastVisited: sameUrl ? (prev.lastVisited || now) : now,
      lastForegroundAt: sameUrl ? (prev.lastForegroundAt || null) : (tab.active ? now : null),
      lastBackgroundedAt: sameUrl
        ? (prev.lastBackgroundedAt || (tab.active ? null : (prev.lastVisited || now)))
        : (tab.active ? null : now),
      openedAt: sameUrl ? (prev.openedAt || now) : now,
      dwellMs: sameUrl ? (prev.dwellMs || 0) : 0,
      interactions: sameUrl ? (prev.interactions || 0) : 0,
      active: tab.active === true,
    };
    if (sameUrl && prev.lastInteractionAt) entry.lastInteractionAt = prev.lastInteractionAt;
    registry[tab.id] = entry;
  }

  await setTabRegistry(registry);
  console.log(`[Neural-Janitor] Snapshotted ${Object.keys(registry).length} tabs`);
}

// ══════════════════════════════════════════════════════════════════════
// MESSAGE HANDLER (from popup / content scripts)
// ══════════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'getRegistry':
        sendResponse(await getTabRegistry());
        break;
      case 'getClosedLog':
        sendResponse(await getClosedLog());
        break;
      case 'forceCheck':
        sendResponse(await performStaleCheck({ dryRun: true, source: 'manual_check' }));
        break;
      case 'getSettings': {
        const status = await deploymentStatus();
        sendResponse({ ...status.settings, deploymentStatus: status });
        break;
      }
      case 'updateSettings': {
        const patch = { ...(msg.settings || {}) };
        const requestedMode = patch.deploymentMode
          || (typeof patch.testMode === 'boolean' ? (patch.testMode ? DEPLOYMENT_MODES.TEST : DEPLOYMENT_MODES.DEPLOY) : null);
        delete patch.deploymentMode;
        delete patch.testMode;

        const saved = Object.keys(patch).length > 0 ? await updateSettings(patch) : await getSettings();
        if (requestedMode) {
          const result = await setDeploymentMode(requestedMode);
          sendResponse({ ...result.settings, deploymentStatus: result });
        } else {
          const status = await deploymentStatus(saved);
          sendResponse({ ...status.settings, deploymentStatus: status });
        }
        break;
      }
      case 'setDeploymentMode':
        sendResponse(await setDeploymentMode(msg.mode));
        break;
      case 'getDeploymentStatus':
        sendResponse(await deploymentStatus());
        break;
      case 'requestPredictions':
        sendResponse(await requestPredictions());
        break;
      case 'requestCompanionHealth': {
        const settings = await getSettings();
        if (settings.useCompanion === false) {
          const closureLearning = await getLearningSummary();
          const devices = [
            { key: 'npu', label: 'NPU', detail: 'Apple Neural Engine', available: null, state: HARDWARE_MARKER_STATES.STANDBY },
            { key: 'gpu', label: 'GPU', detail: 'Metal GPU', available: null, state: HARDWARE_MARKER_STATES.STANDBY },
            { key: 'cpu', label: 'CPU', detail: 'Disabled', available: true, state: HARDWARE_MARKER_STATES.STANDBY },
          ];
          sendResponse({
            connected: false,
            ok: false,
            protocolVersion: IPC_PROTOCOL_VERSION,
            appName: APP_NAME,
            engineCodename: ENGINE_CODENAME,
            modelMode: 'disabled',
            modelLoaded: false,
            runtime: 'disabled',
            runtimeLabel: 'ML Off',
            computeUnits: 'none',
            trainingSamples: 0,
            targetTrainingSamples: 1000,
            minimumTrainingSamples: 100,
            modelMaturity: 0,
            modelAccuracy: null,
            readinessReason: 'Companion disabled in settings',
            currentActivityState: 'unknown',
            currentIdleConfidence: 0,
            confidenceCurve: [],
            decisionThreshold: 0.55,
            powerMode: 'low',
            powerSignal: 'standby',
            telemetryStatus: 'disabled',
            devices,
            closureLearning,
            hardwareTelemetry: {
              source: 'settings',
              status: 'disabled',
              markerStates: {
                npu: HARDWARE_MARKER_STATES.STANDBY,
                gpu: HARDWARE_MARKER_STATES.STANDBY,
                cpu: HARDWARE_MARKER_STATES.STANDBY,
              },
              devices,
            },
          });
        } else {
          await resumeActiveFocusedTab();
          await recordBrowserActivity('active');
          const health = await requestCompanionHealth();
          if (health?.resetRequested) {
            await clearLearningState();
          }
          const closureLearning = await getLearningSummary();
          sendResponse({
            ...health,
            closureLearning,
            resetApplied: Boolean(health?.resetRequested),
          });
        }
        break;
      }
      case 'restoreClosedTab':
        sendResponse(await restoreClosedTab(msg));
        break;
      case 'restoreClosedTabs':
        sendResponse(await restoreClosedTabs(msg.items || []));
        break;
      case 'removeClosedRecords':
        sendResponse(await removeClosedRecords(msg.items || []));
        break;
      case 'clearRestoredClosedRecords':
        sendResponse(await clearRestoredClosedRecords());
        break;
      case 'closeTrackedTab':
        sendResponse(await closeTrackedTab(msg.tabId, msg.reason));
        break;
      case 'getMemoryPressure':
        sendResponse(await getMemoryPressure());
        break;
      case 'getCPUUsage':
        sendResponse(await getCPUUsage());
        break;
      case 'aiCleanup':
        sendResponse(await aiCleanup({ source: msg.source || 'manual', profile: msg.profile || 'broad' }));
        break;
      case 'getTaggedTabs':
        sendResponse(await getTaggedTabs());
        break;
      case 'getAISuggestion':
        sendResponse(await getAISuggestion());
        break;
      case 'recordActivity':
        if (sender.tab) {
          if (sender.tab.active) await startActiveSession(sender.tab, 'content_activity');
          await noteTabActivity(sender.tab, msg.timestamp || Date.now());
        } else {
          recordActivity(msg.timestamp || Date.now());
        }
        sendResponse({ ok: true });
        break;
      case 'pageMetadata': {
        if (!sender.tab?.id || !isTrackableUrl(msg.url || sender.tab.url)) {
          sendResponse({ ok: false });
          break;
        }
        const pageUrl = msg.url || sender.tab.url;
        let cat = await categorizeWithDomainMemory({
          url: pageUrl,
          title: msg.title || sender.tab.title || '',
          description: msg.description || '',
          text: msg.text || '',
        });
        const settings = await getSettings();
        if (settings.useCompanion !== false && (cat.key === 'other' || (cat.confidence || 0) < 0.7)) {
          const companionCat = await classifyURL({
            url: msg.url || sender.tab.url,
            title: msg.title || sender.tab.title || '',
            description: msg.description || '',
            text: msg.text || '',
          });
          if (companionCat?.category && companionCat.category !== 'other') {
            const categoryInfo = CATEGORIES[companionCat.category];
            if (categoryInfo) {
              cat = {
                key: companionCat.category,
                ...categoryInfo,
                confidence: companionCat.confidence || 0.5,
                source: companionCat.source || 'companion',
              };
            }
          }
        }
        if (String(cat.source || '').startsWith('companion')) {
          await rememberDomainCategory({
            url: pageUrl,
            category: cat.key,
            confidence: cat.confidence,
            source: cat.source,
          });
        }
        await upsertTabEntry(sender.tab.id, {
          url: pageUrl,
          title: msg.title || sender.tab.title || '',
          favIconUrl: sender.tab.favIconUrl || '',
          category: cat.key,
          categorySource: cat.source,
          categoryConfidence: cat.confidence,
          rootDomain: getLearningRootDomain(pageUrl),
          pageSeenAt: msg.timestamp || Date.now(),
        });
        sendResponse({ ok: true });
        break;
      }
      case 'getClosureLearning':
        sendResponse(await getLearningSummary());
        break;
      case 'getCategoryClosureStats':
        sendResponse(await getCategoryClosureStats());
        break;
      case 'getLearnedThresholds':
        sendResponse(await getLearnedThresholds());
        break;
      case 'resetLearningState': {
        const settings = await getSettings();
        if (settings.useCompanion !== false) {
          await resetCompanionLearning().catch(() => null);
        }
        await clearLearningState();
        sendResponse({ ok: true, resetApplied: true });
        break;
      }
      case 'resetClosureLearning': {
        await clearLearningState();
        sendResponse({ ok: true, resetApplied: true });
        break;
      }
      case 'companionResetRequested': {
        await clearLearningState();
        sendResponse({ ok: true, resetApplied: true });
        break;
      }
      default:
        sendResponse({ error: 'Unknown message type' });
    }
  })();
  return true; // Keep message channel open for async response
});
