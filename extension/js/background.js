/**
 * Smart Tab Hygiene — Background Service Worker (Manifest V3)
 *
 * Core lifecycle:
 *   1. On install / startup → snapshot all open tabs into the registry
 *   2. On alarm (every 30 min) → scan for stale tabs & close them
 *   3. On tab activation / update → record last-visited timestamp
 *   4. On idle state change → sync with companion & trigger checks
 *   5. On first user interaction after idle → show return notification
 */

import {
  CATEGORIES,
  CHECK_INTERVAL_MINUTES,
  COMPANION_SYNC_INTERVAL_MINUTES,
  SESSION_CHECKPOINT_INTERVAL_MINUTES,
} from './constants.js';
import {
  getTabCount, getTabEntry, getTabRegistry, setTabRegistry, upsertTabEntry, updateTabEntry, removeTabEntry,
  appendClosedRecord, getClosedLog, getSettings, updateSettings,
  markClosedRecordRestored,
  getReturnNotification, setReturnNotification, clearReturnNotification,
  getActiveSession, setActiveSession, clearActiveSession,
} from './storage.js';
import { categorizePage, isTabStale } from './categorizer.js';
import {
  classifyURL,
  connectToCompanion,
  recordActivity,
  requestCompanionHealth,
  requestPredictions,
  isInIdleWindow,
} from './idle-detector.js';

function isTrackableUrl(url) {
  return Boolean(url)
    && !url.startsWith('chrome://')
    && !url.startsWith('edge://')
    && !url.startsWith('chrome-extension://')
    && !url.startsWith('about:')
    && !url.startsWith('file://');
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

  recordActivity({
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
  const cat = categorizePage({ url: tab.url, title: tab.title || '' });
  const prev = await getTabEntry(tab.id) || {};
  await upsertTabEntry(tab.id, {
    url: tab.url,
    title: tab.title || '',
    favIconUrl: tab.favIconUrl || prev.favIconUrl || '',
    category: cat.key,
    categorySource: cat.source,
    categoryConfidence: cat.confidence,
    lastVisited: now,
    lastActivatedAt: now,
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
  const cat = categorizePage({ url: tab.url, title: tab.title || '' });
  await updateTabEntry(tab.id, (entry) => ({
    ...(entry || {}),
    url: tab.url,
    title: tab.title || '',
    favIconUrl: tab.favIconUrl || entry?.favIconUrl || '',
    category: cat.key,
    categorySource: cat.source,
    categoryConfidence: cat.confidence,
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

async function restoreClosedTab({ category, id, url, sessionId }) {
  let restored = null;
  if (sessionId) {
    restored = await chrome.sessions.restore(sessionId).catch(() => null);
  }

  if (!restored && url) {
    restored = await chrome.tabs.create({ url }).catch(() => null);
  }

  if (restored && category && id) {
    await markClosedRecordRestored(category, id);
  }

  return { ok: Boolean(restored), restored };
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
    const cat = categorizePage({ url: tab.url, title: tab.title || '' });
    entry = {
      ...(entry || {}),
      url: tab.url,
      title: tab.title || '',
      favIconUrl: tab.favIconUrl || entry?.favIconUrl || '',
      category: entry?.category || cat.key,
      categorySource: entry?.categorySource || cat.source,
      categoryConfidence: entry?.categoryConfidence || cat.confidence,
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
  try {
    await chrome.tabs.remove(numericTabId);
  } catch (err) {
    console.warn('[Smart Tab Hygiene] Manual close failed:', err);
    return { ok: false, error: err?.message || 'Could not close tab' };
  }

  const sessionId = await findRecentlyClosedSession(entry.url);
  const categoryKey = entry.category || 'other';
  await appendClosedRecord({
    url: entry.url,
    title: entry.title,
    favIconUrl: entry.favIconUrl || '',
    category: categoryKey,
    sessionId,
    closedAt: now,
    reason,
    lastVisited: entry.lastVisited || now,
    ageMs: now - (entry.lastVisited || now),
    dwellMs: entry.dwellMs || 0,
    interactions: entry.interactions || 0,
  });
  await removeTabEntry(numericTabId);

  return { ok: true };
}

// ══════════════════════════════════════════════════════════════════════
// INSTALLATION & STARTUP
// ══════════════════════════════════════════════════════════════════════

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Smart Tab Hygiene] Extension installed; initialising tab registry');
  await snapshotAllTabs();
  setupAlarms();
  connectToCompanion();
  requestPredictions();
  await resumeActiveFocusedTab();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[Smart Tab Hygiene] Browser started; resuming');
  await snapshotAllTabs();
  setupAlarms();
  connectToCompanion();
  requestPredictions();
  await resumeActiveFocusedTab();
});

// ══════════════════════════════════════════════════════════════════════
// ALARMS — periodic stale-tab check & companion sync
// ══════════════════════════════════════════════════════════════════════

function setupAlarms() {
  chrome.alarms.create('sth-stale-check', { periodInMinutes: CHECK_INTERVAL_MINUTES });
  chrome.alarms.create('sth-companion-sync', { periodInMinutes: COMPANION_SYNC_INTERVAL_MINUTES });
  chrome.alarms.create('sth-session-checkpoint', { periodInMinutes: SESSION_CHECKPOINT_INTERVAL_MINUTES });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'sth-stale-check') {
    console.log('[Smart Tab Hygiene] Periodic stale-tab check triggered');
    await performStaleCheck();
  } else if (alarm.name === 'sth-companion-sync') {
    const settings = await getSettings();
    if (settings.useCompanion !== false) await requestPredictions();
  } else if (alarm.name === 'sth-session-checkpoint') {
    await checkpointActiveSession();
  }
});

// ══════════════════════════════════════════════════════════════════════
// TAB EVENT LISTENERS
// ══════════════════════════════════════════════════════════════════════

// Tab created → add to registry
chrome.tabs.onCreated.addListener(async (tab) => {
  if (!isTrackableUrl(tab.url)) return;
  const cat = categorizePage({ url: tab.url, title: tab.title || '' });
  await upsertTabEntry(tab.id, {
    url: tab.url,
    title: tab.title || '',
    favIconUrl: tab.favIconUrl || '',
    category: cat.key,
    categorySource: cat.source,
    categoryConfidence: cat.confidence,
    lastVisited: Date.now(),
    openedAt: Date.now(),
    dwellMs: 0,
    interactions: 0,
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
  const cat = categorizePage({ url: tab.url, title: tab.title || '' });
  await upsertTabEntry(tabId, {
    url: tab.url,
    title: tab.title || '',
    favIconUrl: tab.favIconUrl || prev.favIconUrl || '',
    category: cat.key,
    categorySource: cat.source,
    categoryConfidence: cat.confidence,
    lastVisited: Date.now(),
    openedAt: navigated ? Date.now() : (prev.openedAt || Date.now()),
    dwellMs: navigated ? 0 : (prev.dwellMs || 0),
    interactions: navigated ? 0 : (prev.interactions || 0),
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

// Tab removed → clean up registry
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const active = await getActiveSession();
  if (active?.tabId === tabId) await closeActiveSession('tab_removed');
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
    console.log(`[Smart Tab Hygiene] System state -> ${newState}, running stale check`);
    await performStaleCheck();
  }
});

// ══════════════════════════════════════════════════════════════════════
// CORE: STALE TAB CHECK
// ══════════════════════════════════════════════════════════════════════

async function performStaleCheck() {
  const settings = await getSettings();
  if (!settings.enabled) return { ok: true, disabled: true, scannedCount: 0, closedCount: 0 };

  const registry = await getTabRegistry();
  const now = Date.now();
  const closedTabs = [];
  let staleCount = 0;
  let deferredCount = 0;
  const active = await getActiveSession();
  const predictedIdle = settings.useCompanion !== false ? await isInIdleWindow() : false;
  const currentlyIdle = await browserIsIdle();
  const closeWindowIsQuiet = predictedIdle || currentlyIdle;

  for (const [tabIdStr, entry] of Object.entries(registry)) {
    const tabId = parseInt(tabIdStr, 10);
    if (active?.tabId === tabId) continue;

    // Skip whitelisted URLs
    if (settings.whitelist.some(w => entry.url?.includes(w))) continue;

    const categoryKey = entry.category || 'other';
    const result = isTabStale(entry.lastVisited, categoryKey, settings.customThresholds);

    if (!result.stale) continue;
    staleCount++;

    // NSFW closes as soon as stale. Other categories prefer quiet windows
    // learned by Core ML or reported by chrome.idle.
    let shouldClose = true;

    if (categoryKey !== 'nsfw') {
      // For non-NSFW categories, prefer closing during idle windows
      // but close anyway if age exceeds 2x the threshold (safety net)
      if (!closeWindowIsQuiet && result.ageMs < result.maxAgeMs * 2) {
        shouldClose = false;
      }
    }

    if (!shouldClose) {
      deferredCount++;
      continue;
    }

    // Attempt to close the tab
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // Tab already closed — just log it
    }
    const sessionId = await findRecentlyClosedSession(entry.url);

    // Record the closure
    await appendClosedRecord({
      url: entry.url,
      title: entry.title,
      favIconUrl: entry.favIconUrl || '',
      category: categoryKey,
      sessionId,
      closedAt: now,
      reason: `idle_${Math.round(result.ageMs / (1000 * 60 * 60))}h`,
      lastVisited: entry.lastVisited,
      ageMs: result.ageMs,
      dwellMs: entry.dwellMs || 0,
      interactions: entry.interactions || 0,
    });

    closedTabs.push({
      url: entry.url,
      title: entry.title,
      favIconUrl: entry.favIconUrl || '',
      category: categoryKey,
      ageMs: result.ageMs,
      dwellMs: entry.dwellMs || 0,
    });

    // Remove from registry
    await removeTabEntry(tabId);
  }

  // If we closed anything, queue a return notification
  if (closedTabs.length > 0) {
    await setReturnNotification({ pending: true, closedTabs });
    console.log(`[Smart Tab Hygiene] Closed ${closedTabs.length} stale tab(s). Return notification queued.`);
  }

  return {
    ok: true,
    disabled: false,
    scannedCount: Object.keys(registry).length,
    staleCount,
    deferredCount,
    closedCount: closedTabs.length,
    closeWindowIsQuiet,
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

  const title = `Smart Tab Hygiene cleaned ${closedTabs.length} tab${closedTabs.length > 1 ? 's' : ''}`;
  const message = `While you were away, Smart Tab Hygiene closed stale tabs:\n${summaryLines}\n\nOpen the popup to review.`;

  try {
    chrome.notifications.create('sth-return', {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message,
      priority: 2,
      requireInteraction: true,
    });
  } catch (err) {
    console.warn('[Smart Tab Hygiene] Notification error:', err);
  }
}

chrome.notifications.onClicked.addListener((notifId) => {
  if (notifId === 'sth-return') {
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
    const cat = categorizePage({ url: tab.url, title: tab.title || '' });
    const entry = {
      url: tab.url,
      title: tab.title || '',
      favIconUrl: tab.favIconUrl || (sameUrl ? (prev.favIconUrl || '') : ''),
      category: cat.key,
      categorySource: cat.source,
      categoryConfidence: cat.confidence,
      lastVisited: sameUrl ? (prev.lastVisited || now) : now,
      openedAt: sameUrl ? (prev.openedAt || now) : now,
      dwellMs: sameUrl ? (prev.dwellMs || 0) : 0,
      interactions: sameUrl ? (prev.interactions || 0) : 0,
    };
    if (sameUrl && prev.lastInteractionAt) entry.lastInteractionAt = prev.lastInteractionAt;
    registry[tab.id] = entry;
  }

  await setTabRegistry(registry);
  console.log(`[Smart Tab Hygiene] Snapshotted ${Object.keys(registry).length} tabs`);
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
        sendResponse(await performStaleCheck());
        break;
      case 'getSettings':
        sendResponse(await getSettings());
        break;
      case 'updateSettings':
        sendResponse(await updateSettings(msg.settings));
        break;
      case 'requestPredictions':
        sendResponse(await requestPredictions());
        break;
      case 'requestCompanionHealth': {
        const settings = await getSettings();
        if (settings.useCompanion === false) {
          sendResponse({
            connected: false,
            ok: false,
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
            currentIdleConfidence: 0,
            confidenceCurve: [],
            decisionThreshold: 0.55,
            powerMode: 'low',
            powerSignal: 'standby',
            devices: [
              { key: 'npu', label: 'NPU', detail: 'Apple Neural Engine', available: false, state: 'standby' },
              { key: 'gpu', label: 'GPU', detail: 'Metal GPU', available: false, state: 'standby' },
              { key: 'cpu', label: 'CPU', detail: 'Disabled', available: true, state: 'standby' },
            ],
          });
        } else {
          sendResponse(await requestCompanionHealth());
        }
        break;
      }
      case 'restoreClosedTab':
        sendResponse(await restoreClosedTab(msg));
        break;
      case 'closeTrackedTab':
        sendResponse(await closeTrackedTab(msg.tabId, msg.reason));
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
        let cat = categorizePage({
          url: msg.url || sender.tab.url,
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
        await upsertTabEntry(sender.tab.id, {
          url: msg.url || sender.tab.url,
          title: msg.title || sender.tab.title || '',
          favIconUrl: sender.tab.favIconUrl || '',
          category: cat.key,
          categorySource: cat.source,
          categoryConfidence: cat.confidence,
          pageSeenAt: msg.timestamp || Date.now(),
        });
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ error: 'Unknown message type' });
    }
  })();
  return true; // Keep message channel open for async response
});
