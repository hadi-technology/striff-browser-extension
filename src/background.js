// Ensure chrome-style callbacks exist when only browser.* is available (Firefox/Safari).
try { importScripts('./webext-shim.js'); } catch (_) {}
try { importScripts('./background-utils.js'); } catch (_) {}

// background.js (MV3 service worker) — robust onMessage router + timeouts

// ------------------------------------------------------------
// Lifecycle
// ------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  console.log('[bg-striffs] Installed.');
});

// ------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------
const log  = (...a) => { try { console.log('[bg-striffs]', ...a); } catch {} };
const warn = (...a) => { try { console.warn('[bg-striffs]', ...a); } catch {} };
const err  = (...a) => { try { console.error('[bg-striffs]', ...a); } catch {} };
const BgUtils = globalThis.StriffsBackgroundUtils || {};
const SESSION_TOKEN_KEY = 'ghTokenSession';
let debugEnabled = false;

async function loadDebugFlag() {
  try {
    const stored = await chrome.storage.local.get(['striffsDebug']);
    debugEnabled = stored?.striffsDebug === true;
  } catch {
    debugEnabled = false;
  }
}

const debugLog = (...a) => {
  if (!debugEnabled) return;
  log(...a);
};

loadDebugFlag();
migrateLegacyTokenFromLocal().then(() => broadcastTokenState()).catch(() => {});

const normalizeApiBase = BgUtils.normalizeApiBase || ((base) => String(base || '').trim().replace(/\/+$/, ''));

function abortableTimeout(ms) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(to) };
}

// API base override via chrome.storage.local key "striffsApiBase"
async function getApiBase(defaultBase = 'http://localhost:8080') {
  try {
    const stored = await chrome.storage.local.get(['striffsApiBase']);
    const val = stored?.striffsApiBase;
    if (typeof val === 'string' && val.trim()) {
      const normalized = normalizeApiBase(val);
      if (normalized && normalized !== val.replace(/\/+$/, '')) {
        try {
          await chrome.storage.local.set({ striffsApiBase: normalized });
        } catch {}
      }
      return normalized;
    }
  } catch (e) {
    warn('getApiBase failed', e);
  }
  return normalizeApiBase(defaultBase);
}

async function fetchArrayBuffer(url, { timeoutMs = 45000, init = {} } = {}) {
  const t = abortableTimeout(timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: t.signal, cache: 'no-cache' });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const ab = await res.arrayBuffer();
    return { ok: true, status: res.status, arrayBuffer: ab };
  } catch (e) {
    // AbortError.name === 'AbortError' means timeout, not user abort
    if (e?.name === 'AbortError') {
      return { ok: false, error: `Timeout (${timeoutMs / 1000}s)` };
    }
    return { ok: false, error: String(e?.message || e) };
  } finally {
    t.cancel();
  }
}

const STATIC_PROXY_HOSTS = BgUtils.STATIC_PROXY_HOSTS || new Set([
  'api.github.com',
  'codeload.github.com',
  'raw.githubusercontent.com',
  'striffs-config.tor1.cdn.digitaloceanspaces.com'
]);
const isLoopbackHostname = BgUtils.isLoopbackHostname || ((hostname) => {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1';
});

async function isAllowedProxyUrl(rawUrl) {
  const apiBase = await getApiBase();
  if (typeof BgUtils.shouldAllowProxyUrl === 'function') {
    return BgUtils.shouldAllowProxyUrl(rawUrl, apiBase);
  }
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

async function downloadRepoZipAsArrayBuffer(owner, repo, ref) {
  const url = `https://codeload.github.com/${owner}/${repo}/zip/${encodeURIComponent(ref)}`;
  const r = await fetchArrayBuffer(url, { timeoutMs: 60000 });
  if (!r.ok) return { ok: false, error: r.error || `Failed to download zip: ${r.status}` };
  return { ok: true, arrayBuffer: r.arrayBuffer };
}

const readApiErrorResponse = BgUtils.readApiErrorResponse || (async (res) => {
  const text = await res.text().catch(() => '');
  return {
    detail: text,
    error: text || `API request failed: ${res.status}`,
    errorCode: null
  };
});

async function postIncrementalToLocal(apiUrl, beforeAB, changedFiles = [], { timeoutMs = 120000 } = {}) {
  const fd = new FormData();
  fd.append('before', new Blob([beforeAB], { type: 'application/zip' }), 'before.zip');
  fd.append('changed_files', new Blob([JSON.stringify(Array.isArray(changedFiles) ? changedFiles : [])], { type: 'application/json' }));

  const t = abortableTimeout(timeoutMs);
  try {
    const res = await fetch(apiUrl, { method: 'POST', body: fd, signal: t.signal });
    if (!res.ok) {
      const parsed = await readApiErrorResponse(res);
      return {
        ok: false,
        status: res.status,
        error: parsed.error,
        errorCode: parsed.errorCode,
        detail: parsed.detail
      };
    }
    const json = await res.json();
    return { ok: true, json };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    t.cancel();
  }
}

const CACHE_PREFIXES = BgUtils.CACHE_PREFIXES || ["striffs:", "striffscache:", "striffscachemeta:"];
const CLEAR_FLAG_KEY = BgUtils.CLEAR_FLAG_KEY || "striffsCacheClearAt";
const DEBUG_FLAG_KEY = BgUtils.DEBUG_FLAG_KEY || "striffsDebug";
const TEMP_RESPONSE_PREFIX = BgUtils.TEMP_RESPONSE_PREFIX || "striffsTempResponse:";
const CACHE_KEYS = BgUtils.CACHE_KEYS || [
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

async function storeTempResponsePayload(json) {
  const key = `${TEMP_RESPONSE_PREFIX}${Date.now()}:${Math.random().toString(36).slice(2)}`;
  await chrome.storage.local.set({ [key]: json });
  return key;
}

async function clearChromeStorageCaches() {
  try {
    const items = await chrome.storage.local.get(null);
    const keys = (BgUtils.selectChromeStorageCacheKeys || (() => []))(items);
    if (keys.length) {
      await chrome.storage.local.remove(keys);
    }
  } catch (e) {
    warn('clearChromeStorageCaches failed', e);
  }
}

// Cleanup orphaned temp storage keys (older than 5 minutes)
const TEMP_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const TEMP_KEY_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
let lastTempCleanup = 0;

async function cleanupOrphanedTempKeys() {
  const now = Date.now();
  // Only run cleanup periodically (at most once per interval)
  if (now - lastTempCleanup < TEMP_CLEANUP_INTERVAL_MS) return;

  try {
    const items = await chrome.storage.local.get(null);
    const toRemove = (BgUtils.collectExpiredTempResponseKeys || (() => []))(items, now, TEMP_KEY_MAX_AGE_MS);
    if (toRemove.length > 0) {
      await chrome.storage.local.remove(toRemove);
      log(`Cleaned up ${toRemove.length} orphaned temp storage keys`);
    }
    lastTempCleanup = now;
  } catch (e) {
    warn('cleanupOrphanedTempKeys failed', e);
  }
}

const isGithubPullRequestUrl = BgUtils.isGithubPullRequestUrl || ((url) =>
  /^https?:\/\/(?:[^/]+\.)?github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:\/.*)?$/i.test(String(url || ""))
);

async function clearGithubLocalStorages({ senderTabId = null, senderUrl = "" } = {}) {
  try {
    const tabIds = new Set();
    if (Number.isInteger(senderTabId) && senderTabId >= 0 && isGithubPullRequestUrl(senderUrl)) {
      tabIds.add(senderTabId);
    }
    if (chrome.tabs?.query) {
      const tabs = await chrome.tabs.query({ url: ["*://github.com/*/pull/*", "*://*.github.com/*/pull/*"] });
      for (const tab of (tabs || [])) {
        if (Number.isInteger(tab?.id)) tabIds.add(tab.id);
      }
    }
    if (!tabIds.size) return;
    const promises = Array.from(tabIds).map(async (tabId) => {
      if (!chrome.tabs?.sendMessage) return false;
      try {
        const resp = await chrome.tabs.sendMessage(tabId, { type: "clearStriffsCaches" });
        return !!resp?.ok;
      } catch (_) {
        return false;
      }
    });
    await Promise.allSettled(promises);
  } catch (e) {
    warn('clearGithubLocalStorages failed', e);
  }
}

async function clearTokenFromStorage() {
  try { await chrome.storage.session?.remove?.(SESSION_TOKEN_KEY); } catch {}
  try { await chrome.storage.local.remove('ghToken'); } catch {}
}

async function getStoredTokenFromSession() {
  try {
    const stored = await chrome.storage.session?.get?.([SESSION_TOKEN_KEY]);
    const token = stored?.[SESSION_TOKEN_KEY];
    if (typeof token === 'string' && token.trim()) return token.trim();
  } catch {}
  return '';
}

async function storeTokenInSession(token) {
  const normalized = String(token || '').trim();
  if (!normalized) throw new Error('missing token');
  if (!chrome.storage.session?.set) throw new Error('session storage unavailable');
  await chrome.storage.session.set({ [SESSION_TOKEN_KEY]: normalized });
  try { await chrome.storage.local.remove('ghToken'); } catch {}
}

async function migrateLegacyTokenFromLocal() {
  const current = await getStoredTokenFromSession();
  if (current) return current;
  try {
    const stored = await chrome.storage.local.get(['ghToken']);
    const legacy = typeof stored?.ghToken === 'string' ? stored.ghToken.trim() : '';
    if (!legacy) return '';
    await storeTokenInSession(legacy);
    return legacy;
  } catch {
    return '';
  }
}

async function broadcastTokenState() {
  const hasToken = Boolean(await getStoredTokenFromSession());
  try { await chrome.runtime.sendMessage({ type: 'tokenStateChanged', hasToken }); } catch {}
  try {
    const tabs = await chrome.tabs?.query?.({ url: ["*://github.com/*", "*://*.github.com/*"] }) || [];
    await Promise.allSettled((tabs || []).map((tab) => (
      Number.isInteger(tab?.id)
        ? chrome.tabs.sendMessage(tab.id, { type: 'tokenStateChanged', hasToken }).catch(() => {})
        : Promise.resolve()
    )));
  } catch {}
  return hasToken;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.prototype.hasOwnProperty.call(changes, 'striffsDebug')) {
    debugEnabled = changes?.striffsDebug?.newValue === true;
  }
});

// ------------------------------------------------------------
// Message Router (always safeReply + return true for async)
// ------------------------------------------------------------
const handlers = {
  clearStriffsCaches: async (msg, { safeReply }) => {
    try {
      const clearAt = Date.now();
      try { await chrome.storage.local.set({ [CLEAR_FLAG_KEY]: clearAt }); } catch {}
      await clearChromeStorageCaches();
      await clearGithubLocalStorages({
        senderTabId: Number.isInteger(msg?.senderTabId) ? msg.senderTabId : null,
        senderUrl: msg?.senderUrl || ""
      });
      // Run a second pass to remove any keys re-written by active tabs during clear.
      await clearChromeStorageCaches();
      try { await chrome.storage.local.set({ [CLEAR_FLAG_KEY]: clearAt }); } catch {}
      safeReply({ ok: true });
    } catch (e) {
      safeReply({ ok: false, error: String(e?.message || e) });
    }
  },
  ping: (msg, { safeReply }) => {
    safeReply({ ok: true, pong: true, ts: Date.now() });
  },
  forgetToken: async (msg, { safeReply }) => {
    try {
      await clearTokenFromStorage();
      const hasToken = await broadcastTokenState();
      safeReply({ ok: true, hasToken });
    } catch (e) {
      safeReply({ ok: false, error: String(e?.message || e) });
    }
  },
  storeToken: async (msg, { safeReply }) => {
    try {
      await storeTokenInSession(msg?.token);
      const hasToken = await broadcastTokenState();
      safeReply({ ok: true, hasToken });
    } catch (e) {
      safeReply({ ok: false, error: String(e?.message || e) });
    }
  },
  getTokenStatus: async (msg, { safeReply }) => {
    try {
      const token = await migrateLegacyTokenFromLocal();
      safeReply({ ok: true, hasToken: Boolean(token) });
    } catch (e) {
      safeReply({ ok: false, error: String(e?.message || e) });
    }
  },
  getToken: async (msg, { safeReply }) => {
    try {
      const token = await migrateLegacyTokenFromLocal();
      safeReply({ ok: true, token: token || '' });
    } catch (e) {
      safeReply({ ok: false, error: String(e?.message || e) });
    }
  },
  fetchStriffsWithToken: async (msg, { safeReply }) => {
    const { owner, repo, pull_number, updated_at, token } = msg;
    if (!owner || !repo || !pull_number) {
      safeReply({ ok: false, error: 'missing args (owner/repo/pull_number)' });
      return;
    }
    const apiBase = await getApiBase();
    debugLog('fetchStriffsWithToken using base', apiBase);
    const url = `${apiBase}/api/v1/github/striffs/owners/${owner}/repos/${repo}/pulls/${pull_number}?updated_at=${encodeURIComponent(updated_at || '')}`;

    const t = abortableTimeout(180000);
    const started = Date.now();
    let lastStatus = null;
    try {
      const headers = {};
      if (token) {
        headers['Authorization'] = `token ${token}`;
      }
      const res = await fetch(url, { headers, signal: t.signal, cache: 'no-cache' });
      lastStatus = res.status;
      if (!res.ok) {
        const parsed = await readApiErrorResponse(res);
        debugLog('fetchStriffsWithToken timings', {
          owner, repo, pull_number,
          durationMs: Date.now() - started,
          status: res.status,
          ok: false
        });
        safeReply({
          ok: false,
          status: res.status,
          error: parsed.error,
          errorCode: parsed.errorCode,
          detail: parsed.detail
        });
        return;
      }
      const json = await res.json();
      const responseStorageKey = await storeTempResponsePayload(json);
      debugLog('fetchStriffsWithToken timings', {
        owner, repo, pull_number,
        durationMs: Date.now() - started,
        status: res.status,
        ok: true
      });
      safeReply({
        ok: true,
        responseStorageKey,
        timings: { type: 'token', durationMs: Date.now() - started, status: res.status }
      });
    } catch (e) {
      debugLog('fetchStriffsWithToken error', { durationMs: Date.now() - started, status: lastStatus, error: String(e?.message || e) });
      safeReply({ ok: false, error: String(e?.message || e) });
    } finally {
      t.cancel();
    }
  },
  fetchSupportedLanguages: async (msg, { safeReply }) => {
    try {
      const base = await getApiBase();
      const url = `${base.replace(/\/+$/, '')}/api/v1/languages`;
      const t = abortableTimeout(10000);
      try {
        const res = await fetch(url, { signal: t.signal, cache: 'no-cache' });
        if (!res.ok) {
          safeReply({ ok: false, error: `HTTP ${res.status}` });
          return;
        }
        const text = await res.text();
        safeReply({ ok: true, text });
      } finally {
        t.cancel();
      }
    } catch (e) {
      safeReply({ ok: false, error: String(e?.message || e) });
    }
  },
  generateStriffs: async (msg, { safeReply }) => {
    const {
      baseOwner, baseRepo, baseBranch,
      changedFiles = [],
      changedFilesStorageKey = ''
    } = msg;

    if (!baseOwner || !baseRepo || !baseBranch) {
      safeReply({ ok: false, error: 'missing repo/ref args' });
      return;
    }

    let effectiveChangedFiles = Array.isArray(changedFiles) ? changedFiles : [];
    if ((!effectiveChangedFiles || !effectiveChangedFiles.length) && changedFilesStorageKey) {
      try {
        const stored = await chrome.storage.local.get([changedFilesStorageKey]);
        effectiveChangedFiles = Array.isArray(stored?.[changedFilesStorageKey]) ? stored[changedFilesStorageKey] : [];
      } finally {
        try { await chrome.storage.local.remove(changedFilesStorageKey); } catch {}
      }
    }

    debugLog('generateStriffs start', {
      baseOwner, baseRepo, baseBranch,
      changedFilesCount: Array.isArray(effectiveChangedFiles) ? effectiveChangedFiles.length : 0,
      changedFilesPreview: Array.isArray(effectiveChangedFiles) ? effectiveChangedFiles.slice(0, 10).map((f) => ({
        path: f?.path || '',
        status: f?.status || '',
        contentLength: typeof f?.content === 'string' ? f.content.length : 0
      })) : []
    });

    const overallStart = Date.now();
    const downloadStart = Date.now();
    const beforeStarted = Date.now();
    const before = await downloadRepoZipAsArrayBuffer(baseOwner, baseRepo, baseBranch);
    before.durationMs = Date.now() - beforeStarted;
    const downloadDurationMs = Date.now() - downloadStart;

    if (!before.ok) {
      debugLog('generateStriffs download error', {
        baseOk: before.ok,
        baseDurationMs: before.durationMs,
        totalDownloadMs: downloadDurationMs,
        baseError: before.error
      });
      safeReply({ ok: false, error: `Failed downloading base zip: ${before.error}` });
      return;
    }

    debugLog('generateStriffs download timings', {
      baseDownloadMs: before.durationMs,
      totalDownloadMs: downloadDurationMs,
      changedFilesCount: Array.isArray(effectiveChangedFiles) ? effectiveChangedFiles.length : 0
    });

    const postStart = Date.now();
    const apiBase = await getApiBase();
    debugLog('generateStriffs using base', apiBase);
    const posted = await postIncrementalToLocal(
      `${apiBase}/api/v1/github/striffs`,
      before.arrayBuffer,
      effectiveChangedFiles,
      { timeoutMs: 180000 }
    );
    const postDurationMs = Date.now() - postStart;
    const totalDurationMs = Date.now() - overallStart;

    debugLog('generateStriffs timings', {
      baseDownloadMs: before.durationMs,
      totalDownloadMs: downloadDurationMs,
      postDurationMs,
      totalMs: totalDurationMs,
      changedFilesCount: Array.isArray(effectiveChangedFiles) ? effectiveChangedFiles.length : 0,
      ok: posted.ok === true
    });

    if (!posted.ok) {
      safeReply({
        ok: false,
        status: posted.status ?? null,
        error: posted.error,
        errorCode: posted.errorCode ?? null,
        detail: posted.detail ?? null,
        timings: {
          baseDownloadMs: before.durationMs,
          totalDownloadMs: downloadDurationMs,
          postDurationMs,
          totalMs: totalDurationMs,
          changedFilesCount: Array.isArray(effectiveChangedFiles) ? effectiveChangedFiles.length : 0
        }
      });
      return;
    }
    safeReply({
      ok: true,
      responseStorageKey: await storeTempResponsePayload(posted.json),
      timings: {
        type: 'generate',
        baseDownloadMs: before.durationMs,
        totalDownloadMs: downloadDurationMs,
        postDurationMs,
        totalMs: totalDurationMs,
        changedFilesCount: Array.isArray(effectiveChangedFiles) ? effectiveChangedFiles.length : 0
      }
    });
  },
  proxyFetch: async (msg, { safeReply }) => {
    const { url, method = 'GET', headers = {}, bodyType = 'text', body, timeoutMs = 20000, returnHeaders = false } = msg;
    if (!url) { safeReply({ ok: false, error: 'missing url' }); return; }
    if (!(await isAllowedProxyUrl(url))) {
      safeReply({ ok: false, error: 'proxyFetch blocked for disallowed URL' });
      return;
    }

    const t = abortableTimeout(timeoutMs);
    try {
      const init = { method, headers, signal: t.signal, cache: 'no-cache' };
      if (method !== 'GET' && body != null) init.body = body;
      const res = await fetch(url, init);
      const status = res.status;

      let hdrs = undefined;
      if (returnHeaders) {
        hdrs = (BgUtils.pickReturnHeaders || (() => ({})))(res.headers);
      }

      if (bodyType === 'json') {
        const json = await res.json().catch(() => null);
        safeReply({ ok: res.ok, status, json, headers: hdrs });
      } else {
        const text = await res.text().catch(() => '');
        safeReply({ ok: res.ok, status, text, headers: hdrs });
      }
    } catch (e) {
      safeReply({ ok: false, error: String(e?.message || e) });
    } finally {
      t.cancel();
    }
  },
  recordEngagementEvent: async (msg, { safeReply }) => {
    const {
      operationId,
      engagementToken,
      payload,
      timeoutMs = 12000
    } = msg || {};
    const op = String(operationId || "").trim();
    const token = String(engagementToken || "").trim();
    if (!op) { safeReply({ ok: false, error: "missing operationId" }); return; }
    if (!token) { safeReply({ ok: false, error: "missing engagementToken" }); return; }
    if (!payload || typeof payload !== "object") {
      safeReply({ ok: false, error: "missing payload" });
      return;
    }
    const apiBase = await getApiBase();
    const url = `${apiBase}/api/v1/striffs/${encodeURIComponent(op)}/engagement`;
    const t = abortableTimeout(timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Striff-Engagement-Token": token
        },
        body: JSON.stringify(payload),
        signal: t.signal,
        cache: "no-cache"
      });
      const status = res.status;
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        debugLog("recordEngagementEvent failed", {
          operationId: op,
          status,
          eventType: payload?.eventType || payload?.event?.type || null
        });
        safeReply({ ok: false, status, error: `HTTP ${status}`, body: text });
        return;
      }
      const json = await res.json().catch(() => null);
      safeReply({ ok: true, status, json });
    } catch (e) {
      safeReply({ ok: false, error: String(e?.message || e) });
    } finally {
      t.cancel();
    }
  },
  fetchAiReviewStatus: async (msg, { safeReply }) => {
    const {
      operationId,
      engagementToken,
      timeoutMs = 15000
    } = msg || {};
    const op = String(operationId || "").trim();
    const token = String(engagementToken || "").trim();
    if (!op) { safeReply({ ok: false, error: "missing operationId" }); return; }
    if (!token) { safeReply({ ok: false, error: "missing engagementToken" }); return; }
    const apiBase = await getApiBase();
    const url = `${apiBase}/api/v1/striffs/${encodeURIComponent(op)}/ai-review`;
    const t = abortableTimeout(timeoutMs);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "X-Striff-Engagement-Token": token
        },
        signal: t.signal,
        cache: "no-cache"
      });
      const status = res.status;
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        safeReply({
          ok: false,
          status,
          error: `HTTP ${status}`,
          json,
          body: json?.errorMessage || null
        });
        return;
      }
      safeReply({ ok: true, status, json });
    } catch (e) {
      safeReply({ ok: false, error: String(e?.message || e) });
    } finally {
      t.cancel();
    }
  },
  fetchRemoteConfig: async (msg, { safeReply }) => {
    const { url, timeoutMs = 7000 } = msg || {};
    if (!url) { safeReply({ ok: false, error: 'missing url' }); return; }
    const t = abortableTimeout(timeoutMs);
    try {
      const res = await fetch(url, { cache: 'no-cache', signal: t.signal });
      const status = res.status;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        safeReply({ ok: false, status, error: `HTTP ${status}`, body: text });
        return;
      }
      const json = await res.json().catch(() => null);
      safeReply({ ok: true, status, json });
    } catch (e) {
      safeReply({ ok: false, error: String(e?.message || e) });
    } finally {
      t.cancel();
    }
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const safeReply = (payload) => {
    try { sendResponse(payload); }
    catch (e) { err('sendResponse failed:', e); }
  };

  // Passive cleanup of orphaned temp storage (fire-and-forget, throttled internally)
  cleanupOrphanedTempKeys().catch(() => {});

  try {
    const type = msg?.type;
    if (!type || !handlers[type]) {
      safeReply({ ok: false, error: type ? `unknown message type ${type}` : 'missing message type' });
      return true;
    }
    const handler = handlers[type];
    const msgWithSender = {
      ...(msg || {}),
      senderTabId: Number.isInteger(sender?.tab?.id) ? sender.tab.id : undefined,
      senderUrl: sender?.tab?.url || sender?.url || undefined
    };
    Promise.resolve(handler(msgWithSender, { sender, safeReply })).catch(e => safeReply({ ok: false, error: String(e?.message || e) }));
    return true;
  } catch (e) {
    safeReply({ ok: false, error: String(e?.message || e) });
    return true;
  }
});
