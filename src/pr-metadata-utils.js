const SHA_PATTERN = /^[a-f0-9]{7,40}$/i;
const EMBEDDED_DATA_SELECTOR = 'script[data-target="react-app.embeddedData"]';
const META_SELECTORS = [
  'meta[name="octolytics-dimension-head_sha"]',
  'meta[name="octolytics-dimension-head_commit_sha"]',
  'meta[name="octolytics-dimension-git_head_sha"]'
];

const normalizeCommit = (value) => {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (trimmed.length > 40) {
    const candidate = trimmed.slice(0, 40);
    return SHA_PATTERN.test(candidate) ? candidate : null;
  }
  return SHA_PATTERN.test(trimmed) ? trimmed : null;
};

const getCommitFromMeta = (document) => {
  for (const selector of META_SELECTORS) {
    const node = document?.querySelector(selector);
    const content = node?.getAttribute?.('content');
    const normalized = normalizeCommit(content);
    if (normalized) return normalized;
  }
  return null;
};

const getCommitFromEmbeddedData = (document) => {
  const scripts = document?.querySelectorAll(EMBEDDED_DATA_SELECTOR) || [];
  for (const script of scripts) {
    const text = script?.textContent || script?.innerText || '';
    if (!text) continue;
    try {
      const payload = JSON.parse(text);
      const commit = payload?.payload?.pullRequest?.headRefOid
        || payload?.payload?.pullRequest?.headRef?.oid
        || payload?.payload?.pullRequest?.headRefOid
        || payload?.data?.pullRequest?.headRefOid
        || payload?.pullRequest?.headRefOid;
      const normalized = normalizeCommit(commit);
      if (normalized) return normalized;
    } catch (e) {
      // ignore malformed JSON
    }
  }
  return null;
};

const COMMIT_COUNT_COUNTER_SELECTORS = [
  '#commits_tab_counter',
  'a#commits_tab .Counter',
  '#commits_tab .Counter',
  '[data-tab-item="commits-tab"] .Counter',
  'a[href$="/commits"] .Counter'
];

const COMMIT_COUNT_TAB_SELECTORS = [
  'a#commits_tab',
  '#commits_tab',
  '[data-tab-item="commits-tab"]',
  'a[href$="/commits"]'
];

const parseCommitCountFromText = (value) => {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const compact = raw.replace(/,/g, '');
  const match = compact.match(/\d+/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseCommitCountFromNode = (node) => {
  if (!node) return null;
  const candidates = [
    node?.getAttribute?.('title'),
    node?.getAttribute?.('aria-label'),
    node?.textContent
  ];
  for (const candidate of candidates) {
    const parsed = parseCommitCountFromText(candidate);
    if (parsed != null) return parsed;
  }
  return null;
};

const resolveLatestCommitShaFromDocument = (document) => {
  if (!document) return null;
  const clipboard = document.querySelector("clipboard-copy[value][aria-label*='SHA'], clipboard-copy[value][aria-label*='commit']");
  const clipboardValue = clipboard?.getAttribute?.('value');
  const clipboardSha = normalizeCommit(clipboardValue);
  if (clipboardSha) return clipboardSha;

  const commitLink = document.querySelector('a[data-hovercard-type="commit"], a[href*="/commit/"]');
  const href = commitLink?.getAttribute?.('href') || '';
  const slug = href.split('/').filter(Boolean).pop() || commitLink?.textContent?.trim() || '';
  const commitFromLink = normalizeCommit(slug);
  if (commitFromLink) return commitFromLink;

  const metaSha = getCommitFromMeta(document);
  if (metaSha) return metaSha;

  return getCommitFromEmbeddedData(document);
};

const resolveCommitCountFromDocument = (document) => {
  if (!document) return null;
  for (const selector of COMMIT_COUNT_COUNTER_SELECTORS) {
    const node = document.querySelector(selector);
    const parsed = parseCommitCountFromNode(node);
    if (parsed != null) return parsed;
  }

  for (const selector of COMMIT_COUNT_TAB_SELECTORS) {
    const node = document.querySelector(selector);
    const parsed = parseCommitCountFromNode(node);
    if (parsed != null) return parsed;
  }

  return null;
};

const api = {
  resolveLatestCommitShaFromDocument,
  normalizeCommit,
  getCommitFromMeta,
  getCommitFromEmbeddedData,
  resolveCommitCountFromDocument,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}

if (typeof globalThis !== 'undefined') {
  globalThis.StriffsPrMetadataUtils = api;
}
