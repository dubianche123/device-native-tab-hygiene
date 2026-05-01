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
    '銀行', '証券', '投資', '株価', '資産', '口座', '決済',
    '银行', '证券', '投资', '股票', '基金', '理财', '支付', '账单',
  ],
  ai: [
    'chatgpt', 'openai', 'claude', 'anthropic', 'gemini', 'deepseek',
    'hugging face', 'huggingface', 'perplexity', 'copilot', 'large language model',
    'mistral', 'qwen', 'kimi', 'doubao', 'chatglm', 'openrouter',
    'llm', 'prompt', 'assistant', 'model card', 'transformers', 'inference',
    'text generation', 'ai studio', 'model playground',
    '生成ai', '人工知能', 'チャット', 'プロンプト', '大規模言語モデル',
    '生成式ai', '人工智能', '提示词', '大语言模型', '智能体',
  ],
  email: [
    'inbox', 'email', 'message', 'chat', 'workspace', 'meeting',
    'direct message', 'conversation',
    '受信トレイ', 'メール', 'メッセージ', '会議', '通知',
    '收件箱', '邮箱', '邮件', '消息', '会议', '通知',
  ],
  work: [
    'pull request', 'issue tracker', 'sprint', 'project', 'workspace',
    'document', 'spreadsheet', 'dashboard', 'deployment', 'repository',
    'プロジェクト', 'タスク', '議事録', '資料', 'ドキュメント', '開発',
    '项目', '任务', '文档', '表格', '看板', '部署', '代码仓库',
  ],
  social: [
    'profile', 'followers', 'following', 'feed', 'timeline', 'post',
    'comments', 'community',
    'フォロー', 'プロフィール', '投稿', 'コメント', 'コミュニティ',
    '关注', '粉丝', '主页', '帖子', '评论', '社区', '动态',
  ],
  news: [
    'breaking news', 'latest news', 'analysis', 'opinion', 'reporting',
    'world news', 'market news',
    'ニュース', '速報', '報道', '記事', '社会', '政治', '経済',
    '新闻', '快讯', '报道', '时政', '财经', '热点', '专栏',
  ],
  shopping: [
    'cart', 'checkout', 'order', 'shipping', 'product', 'sale',
    'coupon', 'wishlist',
    'カート', '購入', '注文', '配送', '商品', 'セール', '価格',
    '购物车', '购买', '订单', '配送', '商品', '优惠券', '价格',
  ],
  entertainment: [
    'watch', 'stream', 'episode', 'movie', 'music', 'playlist',
    'gameplay', 'trailer',
    '動画', '映画', '音楽', '配信', 'アニメ', '漫画', 'ゲーム',
    '视频', '电影', '音乐', '直播', '动漫', '漫画', '游戏', '播放',
  ],
  reference: [
    'documentation', 'tutorial', 'reference', 'manual', 'guide',
    'course', 'lesson', 'api', 'wiki',
    '百科', '辞書', '解説', '使い方', '講座', '学習', '資料',
    '词条', '教程', '指南', '文档', '学习', '课程', '知识库',
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
