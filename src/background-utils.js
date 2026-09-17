// Wrapped so it declares nothing in the scope that imports it.
//
// The service worker shares one global scope across importScripts, and background.js declares
// STATIC_PROXY_HOSTS, CACHE_KEYS, normalizeApiBase and eleven more names of its own. Every one of
// them collided with a name here, so importScripts('./background-utils.js') threw "Identifier ...
// has already been declared" straight into the try/catch wrapped around it and this module never
// loaded at all: BgUtils was {} in production, every `BgUtils.x || (inline fallback)` ran the
// fallback, and the tests here exercised the copy that did not execute.
//
// An IIFE fixes that without asking the importer to rename anything, and keeps working under the
// unit tests, which stub importScripts with require() and so give this file its own scope anyway.
const StriffsBackgroundUtilsFactory = (() => {
  const STATIC_PROXY_HOSTS = new Set([
    'api.github.com',
    'codeload.github.com',
    'raw.githubusercontent.com',
    'striffs-config.tor1.cdn.digitaloceanspaces.com'
  ]);

  const CACHE_PREFIXES = ["striffs:", "striffscache:", "striffscachemeta:"];
  const LEGACY_CACHE_PREFIXES = ["StriffsCache:", "striffsCache:", "striffsCacheMeta:", "StriffsCacheMeta:"];
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
  const CACHE_CLEAR_SEEN_KEY = "striffsCacheClearSeenAt";
  const DEBUG_FLAG_KEY = "striffsDebug";
  const TEMP_RESPONSE_PREFIX = "striffsTempResponse:";
  const TEMP_CHANGED_FILES_PREFIX = "striffsTempChangedFiles:";
  const INDEXEDDB_NAME = "striffs-cache-db";
  const TEMP_KEY_PREFIX_RE = new RegExp(`^${TEMP_RESPONSE_PREFIX.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}(\\d+):`);
  const TEMP_CHANGED_FILES_KEY_PREFIX_RE = new RegExp(`^${TEMP_CHANGED_FILES_PREFIX.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}(\\d+):`);

  function escapeRegex(text) {
    return String(text || '').replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  }

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

  // The only hosts the GitHub token is for. The proxy allow-list above is wider -- codeload, the
  // config CDN, loopback, the Striff API -- and the proxy used to forward any Authorization header to
  // all of them. Nothing sends one there today; this keeps it that way.
  const TOKEN_HOSTS = new Set(['api.github.com', 'raw.githubusercontent.com']);

  // The pull request an upload is of, as the form fields the API reads to answer it with the GitHub App's
  // analysis when the repository has the App. All three or none: the API ignores a partial name, so
  // sending one would only put values in the request that do nothing.
  function pullRequestFormFields({ owner, repo, pullNumber } = {}) {
    const name = /^[A-Za-z0-9_.-]+$/;
    const number = String(pullNumber ?? '').trim();
    if (!name.test(String(owner || '')) || !name.test(String(repo || '')) || !/^[1-9][0-9]*$/.test(number)) {
      return [];
    }
    return [['owner', owner], ['repo', repo], ['pull_number', number]];
  }

  function withoutUnexpectedAuthorization(rawUrl, headers = {}) {
    let host = '';
    try { host = new URL(String(rawUrl || '')).hostname; } catch (_) {}
    if (TOKEN_HOSTS.has(host)) return { ...headers };
    const result = {};
    for (const [key, value] of Object.entries(headers || {})) {
      if (String(key).toLowerCase() !== 'authorization') result[key] = value;
    }
    return result;
  }

  function selectChromeStorageCacheKeys(items) {
    return Object.keys(items || {}).filter((key) => {
      if (!key) return false;
      if (key === "ghToken") return false;
      if (key === CLEAR_FLAG_KEY) return false;
      if (key === CACHE_CLEAR_SEEN_KEY) return false;
      if (key === DEBUG_FLAG_KEY) return false;
      const lower = key.toLowerCase();
      return (
        CACHE_KEYS.includes(key) ||
        CACHE_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
        LEGACY_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
        lower.startsWith(TEMP_RESPONSE_PREFIX.toLowerCase()) ||
        lower.startsWith(TEMP_CHANGED_FILES_PREFIX.toLowerCase())
      );
    });
  }

  function parseTempResponseTimestamp(key) {
    if (!key?.startsWith(TEMP_RESPONSE_PREFIX)) return null;
    const match = key.match(TEMP_KEY_PREFIX_RE);
    if (!match) return null;
    const timestamp = Number(match[1]);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function parseTempChangedFilesTimestamp(key) {
    if (!key?.startsWith(TEMP_CHANGED_FILES_PREFIX)) return null;
    const match = key.match(TEMP_CHANGED_FILES_KEY_PREFIX_RE);
    if (!match) return null;
    const timestamp = Number(match[1]);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function collectExpiredTempStorageKeys(items, now, maxAgeMs) {
    const result = [];
    for (const key of Object.keys(items || {})) {
      const timestamp = parseTempResponseTimestamp(key) ?? parseTempChangedFilesTimestamp(key);
      if (timestamp == null) continue;
      if ((now - timestamp) > maxAgeMs) {
        result.push(key);
      }
    }
    return result;
  }

  function buildCacheKeyPatterns(cacheKey = '') {
    const normalized = String(cacheKey || '').trim();
    const escaped = escapeRegex(normalized);
    return {
      cacheKey: normalized,
      localStorageKeyPattern: normalized ? new RegExp(`^(?:${escaped}|striffsCacheMeta:${escaped}|striffsCache:${escaped}:view)$`) : null,
      chromeStorageKeyPattern: normalized ? new RegExp(`^(?:striffs:${escaped}|striffsCacheMeta:${escaped})$`, 'i') : null
    };
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
    // A proxy in front of the API -- nginx while a deploy restarts the pod -- answers with its own
    // HTML page. That page is not a message: used as one, a 503 printed the whole document, markup
    // and padding comments, into a toast.
    const isHtml = contentType.includes('text/html') || /^\s*</.test(text);
    return {
      detail: text,
      error: isHtml ? `The Striffs service returned HTTP ${res.status}.` : (text || `API request failed: ${res.status}`),
      errorCode: null
    };
  }

  const api = {
    CACHE_KEYS,
    CACHE_CLEAR_SEEN_KEY,
    CACHE_PREFIXES,
    CLEAR_FLAG_KEY,
    DEBUG_FLAG_KEY,
    INDEXEDDB_NAME,
    LEGACY_CACHE_PREFIXES,
    STATIC_PROXY_HOSTS,
    TEMP_CHANGED_FILES_PREFIX,
    TEMP_RESPONSE_PREFIX,
    buildCacheKeyPatterns,
    collectExpiredTempStorageKeys,
    isGithubPullRequestUrl,
    isLoopbackHostname,
    normalizeApiBase,
    parseTempChangedFilesTimestamp,
    parseTempResponseTimestamp,
    pickReturnHeaders,
    pullRequestFormFields,
    readApiErrorResponse,
    selectChromeStorageCacheKeys,
    shouldAllowProxyUrl,
    withoutUnexpectedAuthorization,
  };
  return api;
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = StriffsBackgroundUtilsFactory;
}

if (typeof globalThis !== 'undefined') {
  globalThis.StriffsBackgroundUtils = StriffsBackgroundUtilsFactory;
}
