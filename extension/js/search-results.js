import { getRootDomain } from './domain-utils.js';

export const SEARCH_RESULTS_CATEGORY = 'search';

const SEARCH_RESULT_PATTERNS = [
  /^https?:\/\/(www\.)?google\.[a-z.]+\/search/,
  /^https?:\/\/(www\.)?bing\.com\/search/,
  /^https?:\/\/search\.yahoo\./,
  /^https?:\/\/(www\.)?duckduckgo\.com\//,
  /^https?:\/\/(www\.)?baidu\.com\/s/,
  /^https?:\/\/(www\.)?sogou\.com\/web/,
  /^https?:\/\/search\.naver\.com/,
  /^https?:\/\/(www\.)?ecosia\.org\/search/,
  /^https?:\/\/(www\.)?startpage\.com\/sp\/search/,
  /^https?:\/\/yandex\.[a-z.]+\/search/,
];

export function isSearchResultPage(url) {
  if (!url) return false;
  return SEARCH_RESULT_PATTERNS.some(re => re.test(String(url).toLowerCase()));
}

export function getLearningRootDomain(url) {
  const rootDomain = getRootDomain(url);
  if (!rootDomain) return rootDomain;
  return isSearchResultPage(url) ? `search:${rootDomain}` : rootDomain;
}
