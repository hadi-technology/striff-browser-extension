// Ensure chrome-style callbacks exist when only browser.* is available (Firefox/Safari).
try { importScripts('./webext-shim.js'); } catch (_) {}

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
      return val.replace(/\/+$/, '');
    }
  } catch (e) {
    warn('getApiBase failed', e);
  }
  return defaultBase;
}

async function fetchArrayBuffer(url, { timeoutMs = 45000, init = {} } = {}) {
  const t = abortableTimeout(timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: t.signal, cache: 'no-cache' });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const ab = await res.arrayBuffer();
    return { ok: true, status: res.status, arrayBuffer: ab };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    t.cancel();
  }
}

async function downloadRepoZipAsArrayBuffer(owner, repo, ref) {
  const url = `https://codeload.github.com/${owner}/${repo}/zip/${encodeURIComponent(ref)}`;
  const r = await fetchArrayBuffer(url, { timeoutMs: 60000 });
  if (!r.ok) return { ok: false, error: r.error || `Failed to download zip: ${r.status}` };
  return { ok: true, arrayBuffer: r.arrayBuffer };
}

async function postZipsToLocal(apiUrl, beforeAB, afterAB, filterFiles = [], { timeoutMs = 120000 } = {}) {
  const fd = new FormData();
  fd.append('before', new Blob([beforeAB], { type: 'application/zip' }), 'before.zip');
  fd.append('after',  new Blob([afterAB],  { type: 'application/zip' }), 'after.zip');
  for (const f of (filterFiles || [])) fd.append('filter_files', f);

  const t = abortableTimeout(timeoutMs);
  try {
    const res = await fetch(apiUrl, { method: 'POST', body: fd, signal: t.signal });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { ok: false, error: `API request failed: ${res.status}`, detail: txt };
    }
    const json = await res.json();
    return { ok: true, json };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    t.cancel();
  }
}

const CACHE_PREFIXES = ["striffs:", "striffscache:", "striffscachemeta:", "striffscachemeta:"];
const CLEAR_FLAG_KEY = "striffsCacheClearAt";
const DEBUG_FLAG_KEY = "striffsDebug";
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

async function clearChromeStorageCaches() {
  try {
    const items = await chrome.storage.local.get(null);
    const keys = Object.keys(items || {}).filter((k) => {
      if (!k) return false;
      if (k === "ghToken") return false;
      if (k === CLEAR_FLAG_KEY) return false;
      if (k === DEBUG_FLAG_KEY) return false;
      const lower = k.toLowerCase();
      return CACHE_KEYS.includes(k) || CACHE_PREFIXES.some((p) => lower.startsWith(p)) || lower.startsWith("striffs");
    });
    if (keys.length) {
      await chrome.storage.local.remove(keys);
    }
  } catch (e) {
    warn('clearChromeStorageCaches failed', e);
  }
}

async function clearGithubLocalStorages() {
  if (!chrome.scripting?.executeScript) return;
  try {
    const tabs = await chrome.tabs.query({ url: ["*://github.com/*/pull/*", "*://*.github.com/*/pull/*"] });
    if (!tabs || !tabs.length) return;
    const promises = tabs.map(async (tab) => {
      const tryMessage = async () => {
        try {
          const resp = await chrome.tabs.sendMessage(tab.id, { type: "clearStriffsCaches" });
          return !!resp?.ok;
        } catch (_) {
          return false;
        }
      };

      const tryScript = async () => {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "MAIN",
            func: () => {
              const prefixes = ["striffs:", "striffscache:", "striffscachemeta:"];
              const removeKeys = (store) => {
                if (!store) return;
                const toRemove = [];
                for (let i = 0; i < store.length; i += 1) {
                  const key = store.key(i);
                  if (!key) continue;
                  const lower = key.toLowerCase();
                  if (lower === "striffsdebug") continue;
                  if (prefixes.some((p) => lower.startsWith(p)) || lower.startsWith("striffs")) {
                    toRemove.push(key);
                  }
                }
                toRemove.forEach((k) => store.removeItem(k));
              };
              try {
                removeKeys(window.localStorage);
              } catch (e) {
                console.error('clearGithubLocalStorages localStorage failed', e);
              }
              try {
                removeKeys(window.sessionStorage);
              } catch (e) {
                console.error('clearGithubLocalStorages sessionStorage failed', e);
              }
              try {
                window.Striffs?.clearLocalDiagramCaches?.();
              } catch (e) {
                console.error('clearGithubLocalStorages Striffs clear failed', e);
              }
              return true;
            },
          });
          return true;
        } catch (_) {
          return false;
        }
      };

      const ok = (await tryMessage()) || (await tryScript());
      return ok;
    });
    await Promise.allSettled(promises);
  } catch (e) {
    warn('clearGithubLocalStorages failed', e);
  }
}

// ------------------------------------------------------------
// Token cache + helpers (ADDED)
// ------------------------------------------------------------
let tokenCache = null;

async function readTokenFromStorage() {
  try {
    const l = await chrome.storage.local.get(['ghToken']);
    if (l && l.ghToken) return l.ghToken;
  } catch {}
  try {
    const s = await chrome.storage.sync.get(['ghToken']);
    if (s && s.ghToken) return s.ghToken;
  } catch {}
  return null;
}

async function clearTokenFromStorage() {
  await Promise.allSettled([
    chrome.storage.local.remove('ghToken'),
    chrome.storage.sync.remove('ghToken'),
  ]);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.prototype.hasOwnProperty.call(changes, 'striffsDebug')) {
    debugEnabled = changes?.striffsDebug?.newValue === true;
  }
  if ((area === 'local' || area === 'sync') && changes.ghToken) {
    tokenCache = null; // invalidate cache on any change to ghToken
    debugLog('Token cache invalidated due to storage change.');
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
      await clearGithubLocalStorages();
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
  keepAlive: (msg, { safeReply }) => {
    setTimeout(() => safeReply({ ok: true, msg: 'kept alive' }), 2500);
  },
  getToken: async (msg, { safeReply }) => {
    try {
      if (tokenCache !== null) {
        safeReply({ ok: true, token: tokenCache });
        return;
      }
      const t = await readTokenFromStorage();
      tokenCache = t;
      safeReply({ ok: true, token: t });
    } catch (e) {
      safeReply({ ok: false, error: String(e?.message || e) });
    }
  },
  forgetToken: async (msg, { safeReply }) => {
    try {
      tokenCache = null;
      await clearTokenFromStorage();
      safeReply({ ok: true });
    } catch (e) {
      safeReply({ ok: false, error: String(e?.message || e) });
    }
  },
  fetchStriffsWithToken: async (msg, { safeReply }) => {
    const { owner, repo, pull_number, updated_at, token } = msg;
    if (!owner || !repo || !pull_number || !token) {
      safeReply({ ok: false, error: 'missing args (owner/repo/pull_number/token)' });
      return;
    }
    const apiBase = await getApiBase();
    debugLog('fetchStriffsWithToken using base', apiBase);
    const url = `${apiBase}/api/v1/github/striffs/owners/${owner}/repos/${repo}/pulls/${pull_number}?updated_at=${encodeURIComponent(updated_at || '')}`;

    const t = abortableTimeout(180000);
    const started = Date.now();
    let lastStatus = null;
    try {
      const res = await fetch(url, { headers: { Authorization: `token ${token}` }, signal: t.signal, cache: 'no-cache' });
      lastStatus = res.status;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        debugLog('fetchStriffsWithToken timings', {
          owner, repo, pull_number,
          durationMs: Date.now() - started,
          status: res.status,
          ok: false
        });
        safeReply({ ok: false, error: `API request failed: ${res.status}`, detail: text });
        return;
      }
      const json = await res.json();
      debugLog('fetchStriffsWithToken timings', {
        owner, repo, pull_number,
        durationMs: Date.now() - started,
        status: res.status,
        ok: true
      });
      safeReply({ ok: true, json, timings: { type: 'token', durationMs: Date.now() - started, status: res.status } });
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
  getSupportedLanguagesCache: async (msg, { safeReply }) => {
    try {
      const cached = await chrome.storage.local.get(['striffsSupportedLangs', 'striffsSupportedLangsFetchedAt']);
      safeReply({ ok: true, cached });
    } catch (e) {
      safeReply({ ok: false, error: String(e?.message || e) });
    }
  },
  generateStriffs: async (msg, { safeReply }) => {
    const {
      baseOwner, baseRepo, baseBranch,
      headOwner, headRepo, headBranch,
      filterFiles = []
    } = msg;

    if (!baseOwner || !baseRepo || !baseBranch || !headOwner || !headRepo || !headBranch) {
      safeReply({ ok: false, error: 'missing repo/ref args' });
      return;
    }

    debugLog('generateStriffs start', {
      baseOwner, baseRepo, baseBranch, headOwner, headRepo, headBranch,
      filterFilesCount: filterFiles.length,
      filterFilesPreview: Array.isArray(filterFiles) ? filterFiles.slice(0, 30) : []
    });

    const overallStart = Date.now();
    const downloadStart = Date.now();
    const beforePromise = (async () => {
      const s = Date.now();
      const r = await downloadRepoZipAsArrayBuffer(baseOwner, baseRepo, baseBranch);
      return { ...r, durationMs: Date.now() - s };
    })();
    const afterPromise = (async () => {
      const s = Date.now();
      const r = await downloadRepoZipAsArrayBuffer(headOwner, headRepo, headBranch);
      return { ...r, durationMs: Date.now() - s };
    })();

    const [before, after] = await Promise.all([beforePromise, afterPromise]);
    const downloadDurationMs = Date.now() - downloadStart;

    if (!before.ok || !after.ok) {
      debugLog('generateStriffs download error', {
        baseOk: before.ok, headOk: after.ok,
        baseDurationMs: before.durationMs, headDurationMs: after.durationMs,
        totalDownloadMs: downloadDurationMs,
        baseError: before.error, headError: after.error
      });
      if (!before.ok) { safeReply({ ok: false, error: `Failed downloading base zip: ${before.error}` }); return; }
      if (!after.ok)  { safeReply({ ok: false, error: `Failed downloading head zip: ${after.error}` }); return; }
    }

    debugLog('generateStriffs download timings', {
      baseDownloadMs: before.durationMs,
      headDownloadMs: after.durationMs,
      totalDownloadMs: downloadDurationMs,
      filterFilesCount: filterFiles.length
    });

    const postStart = Date.now();
    const apiBase = await getApiBase();
    debugLog('generateStriffs using base', apiBase);
    const posted = await postZipsToLocal(
      `${apiBase}/api/v1/github/striffs`,
      before.arrayBuffer,
      after.arrayBuffer,
      filterFiles,
      { timeoutMs: 180000 }
    );
    const postDurationMs = Date.now() - postStart;
    const totalDurationMs = Date.now() - overallStart;

    debugLog('generateStriffs timings', {
      baseDownloadMs: before.durationMs,
      headDownloadMs: after.durationMs,
      totalDownloadMs: downloadDurationMs,
      postDurationMs,
      totalMs: totalDurationMs,
      filterFilesCount: filterFiles.length,
      ok: posted.ok === true
    });

    if (!posted.ok) { safeReply({ ok: false, error: posted.error, timings: { baseDownloadMs: before.durationMs, headDownloadMs: after.durationMs, totalDownloadMs: downloadDurationMs, postDurationMs, totalMs: totalDurationMs, filterFilesCount: filterFiles.length } }); return; }
    safeReply({
      ok: true,
      json: posted.json,
      timings: {
        type: 'generate',
        baseDownloadMs: before.durationMs,
        headDownloadMs: after.durationMs,
        totalDownloadMs: downloadDurationMs,
        postDurationMs,
        totalMs: totalDurationMs,
        filterFilesCount: filterFiles.length
      }
    });
  },
  downloadZip: async (msg, { safeReply }) => {
    const { url } = msg || {};
    if (!url) { safeReply({ success: false, error: 'missing url' }); return; }
    try {
      const r = await fetch(url, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ab = await r.arrayBuffer();
      safeReply({ success: true, buffer: Array.from(new Uint8Array(ab)) });
    } catch (e) {
      safeReply({ success: false, error: String(e?.message || e) });
    }
  },
  proxyFetch: async (msg, { safeReply }) => {
    // ADDED: returnHeaders support to surface OAuth scopes from GitHub responses
    const { url, method = 'GET', headers = {}, bodyType = 'text', body, timeoutMs = 20000, returnHeaders = false } = msg;
    if (!url) { safeReply({ ok: false, error: 'missing url' }); return; }

    const t = abortableTimeout(timeoutMs);
    try {
      const init = { method, headers, signal: t.signal, cache: 'no-cache' };
      if (method !== 'GET' && body != null) init.body = body;
      const res = await fetch(url, init);
      const status = res.status;

      let hdrs = undefined;
      if (returnHeaders) {
        const wanted = ['x-oauth-scopes','x-accepted-oauth-scopes','x-ratelimit-remaining','x-ratelimit-reset'];
        hdrs = {};
        for (const [k, v] of res.headers.entries()) {
          if (wanted.includes(k.toLowerCase())) hdrs[k] = v;
        }
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

  try {
    const type = msg?.type;
    if (!type || !handlers[type]) {
      safeReply({ ok: false, error: type ? `unknown message type ${type}` : 'missing message type' });
      return true;
    }
    const handler = handlers[type];
    Promise.resolve(handler(msg, { sender, safeReply })).catch(e => safeReply({ ok: false, error: String(e?.message || e) }));
    return true;
  } catch (e) {
    safeReply({ ok: false, error: String(e?.message || e) });
    return true;
  }
});
