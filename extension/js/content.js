/**
 * Smart Tab Hygiene — Content Script
 *
 * Injected into every page. Its only job is to detect meaningful user
 * interaction (clicks, keypresses, scrolls) and notify the background
 * service worker so it can update the "last visited" timestamp and
 * trigger return-notification logic.
 */

(function () {
  'use strict';

  let lastPing = 0;
  const PING_THROTTLE_MS = 30_000; // Don't ping more than once per 30 s

  function ping() {
    const now = Date.now();
    if (now - lastPing < PING_THROTTLE_MS) return;
    lastPing = now;
    try {
      chrome.runtime.sendMessage({ type: 'recordActivity', timestamp: now });
    } catch {
      // Extension context invalidated — ignore
    }
  }

  function metaContent(selector) {
    return document.querySelector(selector)?.getAttribute('content') || '';
  }

  function collectPageText() {
    const headings = Array.from(document.querySelectorAll('h1, h2'))
      .slice(0, 8)
      .map(el => el.textContent || '')
      .join(' ');
    const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 1500);
    return `${headings} ${bodyText}`.trim();
  }

  function sendPageMetadata() {
    try {
      chrome.runtime.sendMessage({
        type: 'pageMetadata',
        url: location.href,
        title: document.title || '',
        description: metaContent('meta[name="description"]') || metaContent('meta[property="og:description"]'),
        text: collectPageText(),
        timestamp: Date.now(),
      });
    } catch {
      // Extension context invalidated — ignore
    }
  }

  document.addEventListener('click', ping, { passive: true });
  document.addEventListener('keydown', ping, { passive: true });
  document.addEventListener('scroll', ping, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) ping();
  }, { passive: true });

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(sendPageMetadata, 250);
  } else {
    document.addEventListener('DOMContentLoaded', sendPageMetadata, { once: true });
  }
})();
