const STATIC_PROXY_HOSTS = new Set([
  'api.github.com',
  'codeload.github.com',
  'raw.githubusercontent.com',
  'striffs-config.tor1.cdn.digitaloceanspaces.com'
]);

const CACHE_PREFIXES = ["striffs:", "striffscache:", "striffscachemeta:"];
const CACHE_KEYS = [
  "striffsActiveTab",
  "striffsRemoteConfig",
  "striffsRemoteConfigFetchedAt",
  "striffsRemoteConfigUrl",
  "striffsSupportedLangs",
  "striffsSupportedLangsFetchedAt",
  "striffsSupportedLangsBase",
  "striffsConfigUrl",
  "striffsApiBase"
];
const CLEAR_FLAG_KEY = "striffsCacheClearAt";
const DEBUG_FLAG_KEY = "striffsDebug";
const TEMP_RESPONSE_PREFIX = "striffsTempResponse:";
const TEMP_KEY_PREFIX_RE = new RegExp(`^${TEMP_RESPONSE_PREFIX.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}(\\d+):`);

function normalizeApiBase(base) {
  return String(base || '').trim().replace(/\/+$/, '');
}

function isLoopbackHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1';
}

function shouldAllowProxyUrl(rawUrl, apiBase = '') {
  try {
    const url = new URL(String(rawUrl || ''));
    if (!/^https?:$/i.test(url.protocol)) return false;
    if (STATIC_PROXY_HOSTS.has(url.hostname) || isLoopbackHostname(url.hostname)) return true;
    const normalizedApiBase = normalizeApiBase(apiBase);
    if (!normalizedApiBase) return false;
    return url.origin === new URL(normalizedApiBase).origin;
  } catch (_) {
    return false;
  }
}

function selectChromeStorageCacheKeys(items) {
  return Object.keys(items || {}).filter((key) => {
    if (!key) return false;
    if (key === "ghToken") return false;
    if (key === CLEAR_FLAG_KEY) return false;
    if (key === DEBUG_FLAG_KEY) return false;
    const lower = key.toLowerCase();
    return CACHE_KEYS.includes(key) || CACHE_PREFIXES.some((prefix) => lower.startsWith(prefix));
  });
}

function parseTempResponseTimestamp(key) {
  if (!key?.startsWith(TEMP_RESPONSE_PREFIX)) return null;
  const match = key.match(TEMP_KEY_PREFIX_RE);
  if (!match) return null;
  const timestamp = Number(match[1]);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function collectExpiredTempResponseKeys(items, now, maxAgeMs) {
  const result = [];
  for (const key of Object.keys(items || {})) {
    const timestamp = parseTempResponseTimestamp(key);
    if (timestamp == null) continue;
    if ((now - timestamp) > maxAgeMs) {
      result.push(key);
    }
  }
  return result;
}

function isGithubPullRequestUrl(url) {
  return /^https?:\/\/(?:[^/]+\.)?github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:\/.*)?$/i.test(String(url || ""));
}

function pickReturnHeaders(headers) {
  const wanted = new Set([
    'content-type',
    'x-oauth-scopes',
    'x-accepted-oauth-scopes',
    'x-ratelimit-remaining',
    'x-ratelimit-reset'
  ]);
  const result = {};
  for (const [key, value] of headers?.entries?.() || []) {
    if (wanted.has(String(key).toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}

async function readApiErrorResponse(res) {
  const contentType = String(res?.headers?.get?.('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) {
    const json = await res.json().catch(() => null);
    if (json && typeof json === 'object') {
      return {
        detail: json,
        error: json.errorMessage || json.message || `API request failed: ${res.status}`,
        errorCode: json.errorCode || json.errorType || null
      };
    }
  }
  const text = await res.text().catch(() => '');
  return {
    detail: text,
    error: text || `API request failed: ${res.status}`,
    errorCode: null
  };
}

const api = {
  CACHE_KEYS,
  CACHE_PREFIXES,
  CLEAR_FLAG_KEY,
  DEBUG_FLAG_KEY,
  STATIC_PROXY_HOSTS,
  TEMP_RESPONSE_PREFIX,
  collectExpiredTempResponseKeys,
  isGithubPullRequestUrl,
  isLoopbackHostname,
  normalizeApiBase,
  parseTempResponseTimestamp,
  pickReturnHeaders,
  readApiErrorResponse,
  selectChromeStorageCacheKeys,
  shouldAllowProxyUrl,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}

if (typeof globalThis !== 'undefined') {
  globalThis.StriffsBackgroundUtils = api;
}
