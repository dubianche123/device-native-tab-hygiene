/**
 * Neural-Janitor — URL Categoriser (v2)
 *
 * Three-tier classification:
 *   1. DOMAIN_MAP lookup  — exact hostname suffix → category (highest confidence)
 *   2. Keyword matching   — per-category keywords against *hostname parts* only
 *   3. Content analysis   — page title / description / body text signals
 *
 * Tier 1 prevents false positives from generic keyword collisions
 * (e.g. "open" in a Reuters URL accidentally matching AI keywords).
 */

import { CATEGORIES, DEFAULT_CATEGORY, DOMAIN_MAP } from './constants.js';

// ── Content signals for page-level classification ────────────────────

const CONTENT_SIGNALS = {
  nsfw: [
    'adult content', 'explicit', 'nsfw', 'xxx', 'erotic', 'nude',
    'cam girl', 'fetish', 'hentai', 'pornography',
  ],
  finance: [
    'banking', 'brokerage', 'portfolio', 'credit card', 'mortgage',
    'invoice', 'payment', 'transaction', 'crypto', 'investment',
    'stock price', 'stock market', 'dividend', 'etf', 'mutual fund',
    'interest rate', 'savings account', 'checking account',
    'bank transfer', 'wire transfer', 'forex', 'futures',
    'p/e ratio', 'market cap', 'earnings report', 'balance sheet',
    '銀行', '証券', '投資', '株価', '資産', '口座', '決済',
    '保険', '為替', 'クレジット', '暗号資産',
    '银行', '证券', '投资', '股票', '基金', '理财', '支付', '账单',
    '保险', '汇率', '信用卡', '贷款', '收益率',
  ],
  ai: [
    'large language model', 'llm inference', 'model card', 'transformers',
    'text generation', 'ai studio', 'model playground', 'prompt engineering',
    'fine-tuning', 'neural network training', 'embedding', 'vector database',
    'retrieval augmented generation', 'rag', 'chatbot api',
    '生成ai', '人工知能', '大規模言語モデル', 'プロンプトエンジニアリング',
    '生成式ai', '人工智能', '大语言模型', '提示词工程', '微调', '智能体',
  ],
  email: [
    'inbox', 'email client', 'message thread', 'direct message',
    'workspace chat', 'video meeting', 'voice call',
    '受信トレイ', 'メール', 'メッセージ', '会議', 'ビデオ通話',
    '收件箱', '邮箱', '邮件', '消息', '视频会议',
  ],
  work: [
    'pull request', 'issue tracker', 'sprint board', 'project management',
    'document editor', 'spreadsheet', 'dashboard', 'deployment pipeline',
    'code repository', 'ci/cd', 'infrastructure', 'cloud console',
    'コンテナ', 'デプロイ', 'プロジェクト', 'タスク管理', 'リポジトリ',
    '容器', '部署', '项目管理', '任务看板', '代码仓库', '持续集成',
  ],
  social: [
    'followers', 'following', 'timeline', 'newsfeed',
    'direct message', 'story', 'reels', 'live stream',
    'フォロー', 'プロフィール', '投稿', 'タイムライン',
    '关注', '粉丝', '主页', '朋友圈', '动态',
  ],
  news: [
    'breaking news', 'latest headlines', 'editorial', 'opinion piece',
    'investigative report', 'world news', 'market analysis',
    'ニュース速報', '報道', '記事', '社説', '特集',
    '突发新闻', '头条', '社论', '深度报道', '独家',
  ],
  shopping: [
    'add to cart', 'checkout', 'order tracking', 'shipping',
    'product review', 'sale price', 'coupon code', 'wishlist',
    'カートに入れる', '購入', '注文', '配送', 'レビュー',
    '加入购物车', '购买', '订单', '物流', '评价', '优惠券',
  ],
  entertainment: [
    'watch now', 'streaming', 'episode', 'season', 'playlist',
    'gameplay', 'trailer', 'subscribe', 'new release',
    '視聴する', '配信', 'アニメ', 'ドラマ', 'プレイリスト',
    '立即观看', '直播', '动漫', '综艺', '播放列表',
  ],
  reference: [
    'documentation', 'api reference', 'tutorial', 'getting started',
    'user guide', 'manual', 'textbook', 'course syllabus',
    'dictionary entry', 'vocabulary', 'translation', 'encyclopedia',
    '学習', '教程', '文档', '百科', '辞典', '课程',
  ],
};

// ── Helpers ──────────────────────────────────────────────────────────

function defaultResult(extra = {}) {
  return { key: DEFAULT_CATEGORY.key, ...DEFAULT_CATEGORY, confidence: 0.2, source: 'fallback', ...extra };
}

function hostEndsWith(hostname, suffix) {
  return hostname === suffix || hostname.endsWith('.' + suffix);
}

// ── Tier 1: DOMAIN_MAP lookup ────────────────────────────────────────

function lookupDomainMap(hostname) {
  // Try longest suffix first for specificity (e.g. finance.yahoo.com before yahoo.com)
  const parts = hostname.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const suffix = parts.slice(i).join('.');
    if (DOMAIN_MAP[suffix]) {
      return DOMAIN_MAP[suffix];
    }
  }
  return null;
}

// ── Tier 2: Hostname-scoped keyword matching ─────────────────────────

function matchKeywords(hostname, fullUrl) {
  let bestKey = null;
  let bestLen = 0;

  for (const [key, cat] of Object.entries(CATEGORIES)) {
    for (const keyword of cat.keywords) {
      const kw = keyword.toLowerCase();
      // Only match against hostname (not URL path) to avoid false positives
      // like "open" in reuters.com/article/berkshire-open
      if (hostname.includes(kw) && kw.length > bestLen) {
        bestKey = key;
        bestLen = kw.length;
      }
    }
  }

  // Also check a small set of very specific full-URL keywords
  // (path-based patterns that are unambiguous)
  const pathPatterns = {
    shopping: ['/checkout', '/cart', '/basket'],
  };
  for (const [key, patterns] of Object.entries(pathPatterns)) {
    for (const pat of patterns) {
      if (fullUrl.includes(pat)) return key;
    }
  }

  return bestKey;
}

// ── Tier 3: Content signal analysis ──────────────────────────────────

function matchContentSignals(title, description, text) {
  const haystack = `${title} ${description} ${text}`.toLowerCase();
  if (haystack.length < 10) return null;

  let best = { key: null, score: 0 };

  for (const [key, words] of Object.entries(CONTENT_SIGNALS)) {
    let score = 0;
    for (const word of words) {
      if (haystack.includes(word)) {
        // Multi-word phrases are stronger signals
        score += word.includes(' ') ? 3 : 1;
      }
    }
    if (score > best.score) best = { key, score };
  }

  return best.score >= 2 ? best.key : null;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Categorise a URL string into one of the defined categories.
 * Returns { key, label, maxAgeMs, priority, color, confidence, source }.
 */
export function categorizeURL(url) {
  if (!url) return defaultResult();

  let hostname = '';
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return defaultResult();
  }

  const fullUrl = url.toLowerCase();

  // Tier 1: DOMAIN_MAP (highest confidence)
  const domainKey = lookupDomainMap(hostname);
  if (domainKey && CATEGORIES[domainKey]) {
    return {
      key: domainKey,
      ...CATEGORIES[domainKey],
      confidence: 0.98,
      source: 'domain',
    };
  }

  // Tier 2: Hostname-scoped keyword matching
  const keywordKey = matchKeywords(hostname, fullUrl);
  if (keywordKey && CATEGORIES[keywordKey]) {
    return {
      key: keywordKey,
      ...CATEGORIES[keywordKey],
      confidence: 0.85,
      source: 'url',
    };
  }

  // Heuristic: TLD or path patterns
  if (hostname.endsWith('.gov') || hostname.endsWith('.edu')) {
    return { key: 'reference', ...CATEGORIES.reference, confidence: 0.75, source: 'tld' };
  }

  return defaultResult();
}

/**
 * Categorise with page metadata from the content script.
 * DOMAIN_MAP always wins.  Content signals can upgrade an "other" result.
 */
export function categorizePage({ url, title = '', description = '', text = '' } = {}) {
  const byUrl = categorizeURL(url);

  // If we got a confident URL match (domain or keyword), trust it
  if (byUrl.key !== DEFAULT_CATEGORY.key && byUrl.confidence >= 0.8) {
    return byUrl;
  }

  // Try content signals as a tiebreaker for ambiguous URLs
  const contentKey = matchContentSignals(title, description, text);
  if (contentKey && CATEGORIES[contentKey]) {
    const cat = CATEGORIES[contentKey];
    // Content signals get moderate confidence — enough to classify,
    // but a future URL match could override if the user navigates elsewhere.
    return {
      key: contentKey,
      ...cat,
      confidence: 0.70,
      source: 'page',
    };
  }

  return byUrl;
}

/**
 * Get the effective max-age for a category.
 * Precedence: user custom thresholds > learned thresholds > default category.
 */
export function getMaxAgeMs(categoryKey, customThresholds = {}, learnedThresholds = {}) {
  if (customThresholds[categoryKey]) {
    return customThresholds[categoryKey];
  }
  if (learnedThresholds[categoryKey]) {
    return learnedThresholds[categoryKey];
  }
  const cat = CATEGORIES[categoryKey];
  return cat ? cat.maxAgeMs : DEFAULT_CATEGORY.maxAgeMs;
}

/**
 * Check whether a tab is "stale" — i.e. it has exceeded its category's
 * max idle time and should be closed.
 * @param {object} [learnedThresholds] — { [category]: maxAgeMs } from closure learner
 */
export function isTabStale(staleSince, categoryKey, customThresholds = {}, learnedThresholds = {}) {
  const now = Date.now();
  const ageMs = now - staleSince;
  const maxAgeMs = getMaxAgeMs(categoryKey, customThresholds, learnedThresholds);

  return {
    stale: ageMs > maxAgeMs,
    ageMs,
    maxAgeMs,
    reason: ageMs > maxAgeMs ? 'exceeded_idle_threshold' : 'within_threshold',
  };
}
