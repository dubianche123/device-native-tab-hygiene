/**
 * Small domain helpers shared by categorisation and close-time learning.
 *
 * This is intentionally lightweight: a full public-suffix list would be more
 * precise, but the extension only needs a stable local bucket for learning.
 */

const MULTI_PART_SUFFIXES = new Set([
  'ac.jp', 'co.jp', 'ed.jp', 'go.jp', 'gr.jp', 'lg.jp', 'ne.jp', 'or.jp',
  'com.cn', 'edu.cn', 'gov.cn', 'net.cn', 'org.cn',
  'com.hk', 'edu.hk', 'gov.hk', 'net.hk', 'org.hk',
  'co.uk', 'ac.uk', 'gov.uk', 'org.uk',
  'com.au', 'edu.au', 'gov.au', 'net.au', 'org.au',
  'co.kr', 'or.kr', 'go.kr',
  'co.nz', 'com.sg', 'com.tw',
]);

const BROAD_SERVICE_ROOTS = new Set([
  'google.com',
  'bing.com',
  'microsoft.com',
  'yahoo.com',
  'yahoo.co.jp',
  'amazon.com',
  'apple.com',
  'baidu.com',
  'tencent.com',
  'alibaba.com',
  'rakuten.co.jp',
  'dmm.com',
  'github.io',
  'cloudfront.net',
]);

export function normalizeHostname(input = '') {
  if (!input) return '';
  try {
    return new URL(input).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return String(input)
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .split('/')[0]
      .replace(/^www\./, '');
  }
}

export function getRootDomain(input = '') {
  const hostname = normalizeHostname(input);
  if (!hostname || hostname === 'localhost') return hostname;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return hostname;

  const parts = hostname.split('.').filter(Boolean);
  if (parts.length <= 2) return hostname;

  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }

  return lastTwo;
}

export function allowsRootDomainLearning(input = '') {
  const rootDomain = getRootDomain(input);
  return Boolean(rootDomain) && !BROAD_SERVICE_ROOTS.has(rootDomain);
}
