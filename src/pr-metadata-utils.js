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

const COMMITS_COUNTER_SELECTOR = '#commits_tab_counter';

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
  const counter = document.querySelector(COMMITS_COUNTER_SELECTOR);
  if (!counter) return null;
  const raw = counter.getAttribute?.('title') || counter.textContent || '';
  const digits = String(raw).replace(/[^\d]/g, '');
  const parsed = Number(digits);
  return Number.isFinite(parsed) ? parsed : null;
};

module.exports = {
  resolveLatestCommitShaFromDocument,
  normalizeCommit,
  getCommitFromMeta,
  getCommitFromEmbeddedData,
  resolveCommitCountFromDocument,
};
