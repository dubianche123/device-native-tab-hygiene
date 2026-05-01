/**
 * Smart Tab Hygiene — Constants & Category Definitions
 *
 * Each category has:
 *   - keywords: URL substrings / hostname fragments used for fast matching
 *   - maxAgeMs: how long a tab in this category may stay open WITHOUT any visit
 *   - priority:  lower = cleaned sooner (used when ML idle-window is available)
 *
 * NSFW gets the shortest window — even 12 h is generous for a tab you opened
 * once and walked away from. AI tools get the longest default window because
 * long-running research/chat sessions are often intentionally kept around.
 */

export const CATEGORIES = {
  nsfw: {
    label: 'NSFW',
    keywords: [
      'porn', 'xvideos', 'xnxx', 'xhamster', 'pornhub', 'redtube',
      'brazzers', 'onlyfans', 'chaturbate', 'stripchat',
      'hentai', 'nhentai', 'gelbooru', 'danbooru',
      'rule34', 'e-hentai', 'exhentai',
    ],
    maxAgeMs: 12 * 60 * 60 * 1000,       // 12 hours
    priority: 0,
    color: '#e74c3c',
  },
  finance: {
    label: 'Finance & Banking',
    keywords: [
      'bank', 'chase', 'wellsfargo', 'citibank', 'hsbc',
      'paypal', 'stripe', 'venmo', 'cashapp', 'robinhood',
      'fidelity', 'schwab', 'vanguard', 'etrade', 'coinbase',
      'binance', 'kraken', 'crypto', 'defi', 'webull',
      'etrade', 'tdameritrade', 'ally.com', 'sofi.com',
      'mint.com', 'creditkarma', 'bankofamerica',
      'mufg.jp', 'smbc.co.jp', 'mizuhobank.co.jp', 'rakuten-sec.co.jp',
      'sbisec.co.jp', 'monex.co.jp', 'jpx.co.jp',
      'alipay.com', 'tenpay.com', 'eastmoney.com', 'xueqiu.com',
      'futunn.com', 'tigerbrokers', 'joinquant.com',
    ],
    maxAgeMs: 14 * 24 * 60 * 60 * 1000,  // 14 days
    priority: 80,
    color: '#27ae60',
  },
  ai: {
    label: 'AI Tools',
    keywords: [
      'chatgpt.com', 'chat.openai.com', 'openai.com',
      'deepseek.com', 'chat.deepseek.com',
      'claude.ai', 'anthropic.com',
      'gemini.google.com', 'bard.google.com',
      'aistudio.google.com', 'notebooklm.google.com',
      'huggingface.co', 'hf.co',
      'perplexity.ai', 'poe.com',
      'copilot.microsoft.com', 'mistral.ai',
      'chat.mistral.ai', 'qwen.ai', 'chat.qwen.ai',
      'kimi.moonshot.cn', 'doubao.com',
      'yuanbao.tencent.com', 'chatglm.cn',
      'yiyan.baidu.com', 'wenxin.baidu.com', 'tongyi.aliyun.com',
      'zhipuai.cn', 'bigmodel.cn', 'baichuan-ai.com',
      'minimax.chat', 'coze.cn', 'coze.com', 'dify.ai',
      'grok.com', 'x.ai',
      'phind.com', 'you.com', 'blackbox.ai',
      'openrouter.ai', 'lmarena.ai', 'replicate.com',
      'cursor.com', 'windsurf.com', 'v0.dev',
      'bolt.new', 'lovable.dev', 'replit.com',
    ],
    maxAgeMs: 30 * 24 * 60 * 60 * 1000,  // 30 days
    priority: 90,
    color: '#00c2ff',
  },
  email: {
    label: 'Email & Communication',
    keywords: [
      'mail.google', 'outlook.live', 'mail.yahoo', 'protonmail',
      'fastmail', 'zoho.com/mail', 'tutanota',
      'slack.com', 'teams.microsoft', 'discord.com',
      'telegram.org', 'web.whatsapp', 'signal.org',
      'mail.qq.com', 'mail.163.com', 'mail.126.com',
      'mail.sina.com.cn', 'mail.aliyun.com', 'mail.yahoo.co.jp',
      'chatwork.com', 'line.me', 'worksmobile.com',
    ],
    maxAgeMs: 14 * 24 * 60 * 60 * 1000,  // 14 days
    priority: 70,
    color: '#3498db',
  },
  work: {
    label: 'Work & Productivity',
    keywords: [
      'notion.so', 'confluence', 'jira', 'asana', 'trello',
      'monday.com', 'linear.app', 'figma.com', 'miro.com',
      'docs.google', 'sheets.google', 'slides.google',
      'office.com', 'onedrive', 'sharepoint',
      'github.com', 'gitlab.com', 'bitbucket',
      'vercel', 'netlify', 'aws.amazon', 'console.cloud',
      'heroku', 'digitalocean', 'linode',
      'qiita.com', 'zenn.dev', 'notion.site', 'cybozu.com',
      'backlog.com', 'esa.io', 'kintone.com', 'yuque.com',
      'teambition.com', 'feishu.cn', 'larksuite.com', 'coding.net',
      'gitee.com', 'tapd.cn', 'shimo.im',
    ],
    maxAgeMs: 14 * 24 * 60 * 60 * 1000,  // 14 days
    priority: 60,
    color: '#8e44ad',
  },
  social: {
    label: 'Social Media',
    keywords: [
      'facebook.com', 'twitter.com', 'x.com', 'instagram.com',
      'tiktok.com', 'reddit.com', 'linkedin.com', 'pinterest.com',
      'tumblr.com', 'mastodon', 'threads.net', 'weibo',
      'snapchat.com', 'vine.co',
      'weibo.com', 'xiaohongshu.com', 'zhihu.com',
      'douban.com', 'tieba.baidu.com', '5ch.net', '2ch.sc',
      'mixi.jp',
    ],
    maxAgeMs: 3 * 24 * 60 * 60 * 1000,   // 3 days
    priority: 20,
    color: '#e67e22',
  },
  news: {
    label: 'News & Media',
    keywords: [
      'cnn.com', 'bbc.com', 'nytimes.com', 'washingtonpost.com',
      'reuters.com', 'apnews.com', 'theguardian.com', 'bloomberg.com',
      'techcrunch.com', 'theverge.com', 'arstechnica.com',
      'wired.com', 'hacker-news', 'news.ycombinator',
      'nhk.or.jp', 'asahi.com', 'yomiuri.co.jp', 'mainichi.jp',
      'sankei.com', 'nikkei.com', 'news.yahoo.co.jp',
      'itmedia.co.jp', 'gigazine.net', 'toyokeizai.net',
      'diamond.jp', 'news.livedoor.com',
      '36kr.com', 'thepaper.cn', 'caixin.com', 'jiemian.com',
      'news.qq.com', 'news.sina.com.cn', 'toutiao.com', 'ifeng.com',
      'ithome.com', 'guancha.cn', 'people.com.cn', 'xinhuanet.com',
    ],
    maxAgeMs: 5 * 24 * 60 * 60 * 1000,   // 5 days
    priority: 30,
    color: '#f39c12',
  },
  shopping: {
    label: 'Shopping',
    keywords: [
      'amazon.com', 'ebay.com', 'aliexpress', 'etsy.com',
      'walmart.com', 'target.com', 'bestbuy.com',
      'shopify', 'newegg.com', 'costco.com',
      'taobao.com', 'tmall.com', 'jd.com', 'pinduoduo.com',
      'rakuten.co.jp', 'mercari.com', 'mercari.jp',
      'yodobashi.com', 'zozo.jp', 'yahoo.co.jp/shopping',
      'kakaku.com',
    ],
    maxAgeMs: 7 * 24 * 60 * 60 * 1000,   // 7 days
    priority: 40,
    color: '#1abc9c',
  },
  entertainment: {
    label: 'Entertainment',
    keywords: [
      'youtube.com', 'netflix.com', 'twitch.tv', 'spotify.com',
      'hbomax.com', 'disneyplus.com', 'hulu.com', 'peacocktv',
      'crunchyroll.com', 'vimeo.com', 'dailymotion',
      'imdb.com', 'rottentomatoes',
      'bilibili.com', 'nicovideo.jp', 'niconico', 'abema.tv',
      'tver.jp', 'pixiv.net', 'douyin.com', 'kuaishou.com',
      'youku.com', 'iqiyi.com', 'acfun.cn', 'music.163.com',
    ],
    maxAgeMs: 5 * 24 * 60 * 60 * 1000,   // 5 days
    priority: 25,
    color: '#9b59b6',
  },
  reference: {
    label: 'Reference & Learning',
    keywords: [
      'wikipedia.org', 'stackoverflow.com', 'stackexchange',
      'medium.com', 'dev.to', 'mdn.', 'developer.mozilla',
      'coursera.org', 'udemy.com', 'edx.org', 'khanacademy',
      'duolingo.com', 'brilliant.org',
      'baike.baidu.com', 'zh.wikipedia.org',
      'ja.wikipedia.org', 'csdn.net', 'cnblogs.com', 'juejin.cn',
      'segmentfault.com', 'oschina.net', 'teratail.com',
      'note.com', 'hatena.ne.jp', 'kotobank.jp', 'weblio.jp',
      'developer.aliyun.com', 'cloud.tencent.com', 'infoq.cn',
      'sspai.com',
    ],
    maxAgeMs: 10 * 24 * 60 * 60 * 1000,  // 10 days
    priority: 50,
    color: '#2c3e50',
  },
};

// Fallback for URLs that don't match any category
export const DEFAULT_CATEGORY = {
  key: 'other',
  label: 'Other',
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,    // 7 days
  priority: 50,
  color: '#95a5a6',
};

// How often the service worker checks for stale tabs (in minutes)
export const CHECK_INTERVAL_MINUTES = 30;

// How often to persist foreground-session dwell time while a tab is active
export const SESSION_CHECKPOINT_INTERVAL_MINUTES = 1;

// How often to sync with the native companion app (in minutes)
export const COMPANION_SYNC_INTERVAL_MINUTES = 60;

// Storage keys
export const STORAGE_KEYS = {
  TAB_REGISTRY: 'tabRegistry',         // Legacy registry object, migrated to per-tab keys
  TAB_REGISTRY_INDEX: 'tabRegistryIndex', // [tabId]
  TAB_ENTRY_PREFIX: 'tabEntry:',       // tabEntry:<tabId> -> { url, title, lastVisited, ... }
  CLOSED_LOG: 'closedLog',             // [{ url, title, category, closedAt, reason }]
  IDLE_PREDICTIONS: 'idlePredictions', // { [dayOfWeek]: { startHour, endHour, confidence } }
  USER_SETTINGS: 'userSettings',       // { enabled, customThresholds, ... }
  ACTIVE_SESSION: 'activeSession',      // { tabId, windowId, startedAt, url }
  RETURN_NOTIFICATION: 'returnNotification', // { pending: bool, closedTabs: [...] }
  COMPANION_STATUS: 'companionStatus', // { connected, lastSync, modelVersion }
};

// Native messaging host name (must match the one registered in the companion app)
export const NATIVE_HOST_NAME = 'com.smarttabhygiene.companion';
