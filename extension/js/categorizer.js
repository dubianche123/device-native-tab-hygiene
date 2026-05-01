/**
 * Smart Tab Hygiene — URL Categoriser
 *
 * Fast, deterministic categorisation based on URL hostname/path matching.
 * Falls back to a simple heuristic if no keyword matches.
 *
 * For production, an optional LLM-based classifier can be called via the
 * companion app for ambiguous URLs, but the keyword approach covers ~95 %
 * of real-world browsing.
 */

import { CATEGORIES, DEFAULT_CATEGORY } from './constants.js';

const CONTENT_SIGNALS = {
  nsfw: [
    'adult', 'explicit', 'nsfw', 'xxx', 'erotic', 'cam', 'fetish',
  ],
  finance: [
    'banking', 'brokerage', 'portfolio', 'credit card', 'mortgage',
    'invoice', 'payment', 'transaction', 'crypto', 'investment',
  ],
  ai: [
    'chatgpt', 'openai', 'claude', 'anthropic', 'gemini', 'deepseek',
    'hugging face', 'huggingface', 'perplexity', 'copilot', 'large language model',
    'mistral', 'qwen', 'kimi', 'doubao', 'chatglm', 'openrouter',
    'llm', 'prompt', 'assistant', 'model card', 'transformers', 'inference',
    'text generation', 'ai studio', 'model playground',
  ],
  email: [
    'inbox', 'email', 'message', 'chat', 'workspace', 'meeting',
    'direct message', 'conversation',
  ],
  work: [
    'pull request', 'issue tracker', 'sprint', 'project', 'workspace',
    'document', 'spreadsheet', 'dashboard', 'deployment', 'repository',
  ],
  social: [
    'profile', 'followers', 'following', 'feed', 'timeline', 'post',
    'comments', 'community',
  ],
  news: [
    'breaking news', 'latest news', 'analysis', 'opinion', 'reporting',
    'world news', 'market news',
  ],
  shopping: [
    'cart', 'checkout', 'order', 'shipping', 'product', 'sale',
    'coupon', 'wishlist',
  ],
  entertainment: [
    'watch', 'stream', 'episode', 'movie', 'music', 'playlist',
    'gameplay', 'trailer',
  ],
  reference: [
    'documentation', 'tutorial', 'reference', 'manual', 'guide',
    'course', 'lesson', 'api', 'wiki',
  ],
};

function defaultResult(extra = {}) {
  return { key: DEFAULT_CATEGORY.key, ...DEFAULT_CATEGORY, confidence: 0.2, source: 'fallback', ...extra };
}

/**
 * Categorise a URL string into one of the defined categories.
 * Returns { key, label, maxAgeMs, priority, color }.
 */
export function categorizeURL(url) {
  if (!url) return defaultResult();

  let hostname = '';
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    // Malformed URL — treat as "other"
    return defaultResult();
  }

  const fullUrl = url.toLowerCase();

  for (const [key, cat] of Object.entries(CATEGORIES)) {
    for (const keyword of cat.keywords) {
      if (hostname.includes(keyword) || fullUrl.includes(keyword)) {
        return { key, ...cat, confidence: hostname.includes(keyword) ? 0.95 : 0.85, source: 'url' };
      }
    }
  }

  // Heuristic: guess based on TLD or path patterns
  if (hostname.endsWith('.gov') || hostname.endsWith('.edu')) {
    return { key: 'reference', ...CATEGORIES.reference, confidence: 0.75, source: 'tld' };
  }
  if (fullUrl.includes('/checkout') || fullUrl.includes('/cart')) {
    return { key: 'shopping', ...CATEGORIES.shopping, confidence: 0.80, source: 'path' };
  }

  return defaultResult();
}

/**
 * Categorise with page metadata from the content script. URL matches still win,
 * but ambiguous pages can be classified from title, meta description and
 * visible headings/text.
 */
export function categorizePage({ url, title = '', description = '', text = '' } = {}) {
  const byUrl = categorizeURL(url);
  if (byUrl.key !== DEFAULT_CATEGORY.key && byUrl.confidence >= 0.8) {
    return byUrl;
  }

  const haystack = `${title} ${description} ${text}`.toLowerCase();
  let best = { key: DEFAULT_CATEGORY.key, score: 0 };

  for (const [key, words] of Object.entries(CONTENT_SIGNALS)) {
    let score = 0;
    for (const word of words) {
      if (haystack.includes(word)) score += word.includes(' ') ? 2 : 1;
    }
    if (score > best.score) best = { key, score };
  }

  if (best.score > 0) {
    const cat = CATEGORIES[best.key];
    return {
      key: best.key,
      ...cat,
      confidence: Math.min(0.75, 0.35 + best.score * 0.1),
      source: 'page',
    };
  }

  return byUrl;
}

/**
 * Get the effective max-age for a category, taking user overrides into account.
 */
export function getMaxAgeMs(categoryKey, customThresholds = {}) {
  if (customThresholds[categoryKey]) {
    return customThresholds[categoryKey];
  }
  const cat = CATEGORIES[categoryKey];
  return cat ? cat.maxAgeMs : DEFAULT_CATEGORY.maxAgeMs;
}

/**
 * Check whether a tab is "stale" — i.e. it has exceeded its category's
 * max idle time and should be closed.
 *
 * @param {number} lastVisited  Epoch ms of the tab's last user visit
 * @param {string} categoryKey  Category key from categorizeURL()
 * @param {object} customThresholds  Optional per-category overrides
 * @returns {{ stale: boolean, ageMs: number, maxAgeMs: number, reason: string }}
 */
export function isTabStale(lastVisited, categoryKey, customThresholds = {}) {
  const now = Date.now();
  const ageMs = now - lastVisited;
  const maxAgeMs = getMaxAgeMs(categoryKey, customThresholds);

  return {
    stale: ageMs > maxAgeMs,
    ageMs,
    maxAgeMs,
    reason: ageMs > maxAgeMs ? 'exceeded_idle_threshold' : 'within_threshold',
  };
}
