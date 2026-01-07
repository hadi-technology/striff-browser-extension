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

async function fetchText(url, { timeoutMs = 15000, init = {} } = {}) {
  const t = abortableTimeout(timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: t.signal, cache: 'no-cache' });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    t.cancel();
  }
}

async function fetchJson(url, { timeoutMs = 20000, init = {} } = {}) {
  const t = abortableTimeout(timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: t.signal, cache: 'no-cache' });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const json = await res.json();
    return { ok: true, status: res.status, json };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    t.cancel();
  }
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
  if ((area === 'local' || area === 'sync') && changes.ghToken) {
    tokenCache = null; // invalidate cache on any change to ghToken
    log('Token cache invalidated due to storage change.');
  }
});

// ------------------------------------------------------------
// Message Router (always safeReply + return true for async)
// ------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const safeReply = (payload) => {
    try { sendResponse(payload); }
    catch (e) { err('sendResponse failed:', e); }
  };

  try {
    if (!msg || !msg.type) {
      safeReply({ ok: false, error: 'missing message type' });
      return true;
    }

    // --- Tiny plumbing test ---
    if (msg.type === 'ping') {
      safeReply({ ok: true, pong: true, ts: Date.now() });
      return true;
    }

    // --- Keep the worker alive briefly (warmup/hold) ---
    if (msg.type === 'keepAlive') {
      setTimeout(() => safeReply({ ok: true, msg: 'kept alive' }), 2500);
      return true;
    }

    // --- Text list of languages from local API (fast & robust) ---
    if (msg.type === 'getLanguages') {
      (async () => {
        const candidates = [
          'http://localhost:8080/api/v1/languages',
        ];

        for (const u of candidates) {
          const r = await fetchText(u, { timeoutMs: 8000 });
          if (r.ok) {
            log('getLanguages OK from', u);
            safeReply({ ok: true, body: r.text });
            return;
          }
          warn('getLanguages failed', u, r.error || r.status);
        }

        // Fallback quick answer to verify message path even if API is down
        safeReply({
          ok: true,
          body: 'java, go, javascript, typescript, python, csharp, cpp, ruby, rust, php, kotlin'
        });
      })().catch(e => safeReply({ ok: false, error: String(e?.message || e) }));
      return true;
    }

    // --- Token utilities (ADDED) ---
    if (msg.type === 'getToken') {
      (async () => {
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
      })();
      return true;
    }

    if (msg.type === 'forgetToken') {
      (async () => {
        try {
          tokenCache = null;
          await clearTokenFromStorage();
          safeReply({ ok: true });
        } catch (e) {
          safeReply({ ok: false, error: String(e?.message || e) });
        }
      })();
      return true;
    }

    // --- Tokened GET to local API (Striffs) ---
    if (msg.type === 'fetchStriffsWithToken') {
      (async () => {
        const { owner, repo, pull_number, updated_at, token } = msg;
        if (!owner || !repo || !pull_number || !token) {
          safeReply({ ok: false, error: 'missing args (owner/repo/pull_number/token)' });
          return;
        }
        const apiBase = await getApiBase();
        log('fetchStriffsWithToken using base', apiBase);
        const url = `${apiBase}/api/v1/github/striffs/owners/${owner}/repos/${repo}/pulls/${pull_number}?updated_at=${encodeURIComponent(updated_at || '')}`;

        const t = abortableTimeout(180000);
        const started = Date.now();
        let lastStatus = null;
        try {
          const res = await fetch(url, { headers: { Authorization: `token ${token}` }, signal: t.signal, cache: 'no-cache' });
          lastStatus = res.status;
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            log('fetchStriffsWithToken timings', {
              owner, repo, pull_number,
              durationMs: Date.now() - started,
              status: res.status,
              ok: false
            });
            safeReply({ ok: false, error: `API request failed: ${res.status}`, detail: text });
            return;
          }
          const json = await res.json();
          log('fetchStriffsWithToken timings', {
            owner, repo, pull_number,
            durationMs: Date.now() - started,
            status: res.status,
            ok: true
          });
          safeReply({ ok: true, json, timings: { type: 'token', durationMs: Date.now() - started, status: res.status } });
        } catch (e) {
          log('fetchStriffsWithToken error', { durationMs: Date.now() - started, status: lastStatus, error: String(e?.message || e) });
          safeReply({ ok: false, error: String(e?.message || e) });
        } finally {
          t.cancel();
        }
      })().catch(e => safeReply({ ok: false, error: String(e?.message || e) }));
      return true;
    }

    // --- No-token path: download two zips + POST to local API ---
    if (msg.type === 'generateStriffs') {
      (async () => {
        const {
          baseOwner, baseRepo, baseBranch,
          headOwner, headRepo, headBranch,
          filterFiles = []
        } = msg;

        if (!baseOwner || !baseRepo || !baseBranch || !headOwner || !headRepo || !headBranch) {
          safeReply({ ok: false, error: 'missing repo/ref args' });
          return;
        }

        log('generateStriffs start', {
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
          log('generateStriffs download error', {
            baseOk: before.ok, headOk: after.ok,
            baseDurationMs: before.durationMs, headDurationMs: after.durationMs,
            totalDownloadMs: downloadDurationMs,
            baseError: before.error, headError: after.error
          });
          if (!before.ok) { safeReply({ ok: false, error: `Failed downloading base zip: ${before.error}` }); return; }
          if (!after.ok)  { safeReply({ ok: false, error: `Failed downloading head zip: ${after.error}` }); return; }
        }

        log('generateStriffs download timings', {
          baseDownloadMs: before.durationMs,
          headDownloadMs: after.durationMs,
          totalDownloadMs: downloadDurationMs,
          filterFilesCount: filterFiles.length
        });

        const postStart = Date.now();
        const apiBase = await getApiBase();
        log('generateStriffs using base', apiBase);
        const posted = await postZipsToLocal(
          `${apiBase}/api/v1/github/striffs`,
          before.arrayBuffer,
          after.arrayBuffer,
          filterFiles,
          { timeoutMs: 180000 }
        );
        const postDurationMs = Date.now() - postStart;
        const totalDurationMs = Date.now() - overallStart;

        log('generateStriffs timings', {
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
      })().catch(e => safeReply({ ok: false, error: String(e?.message || e) }));
      return true;
    }

    // --- Legacy downloader (keeps { success, buffer } shape) ---
    if (msg.type === 'downloadZip') {
      (async () => {
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
      })().catch(e => safeReply({ success: false, error: String(e?.message || e) }));
      return true;
    }

    // --- Optional generic proxy (use sparingly) ---
    if (msg.type === 'proxyFetch') {
      (async () => {
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
      })().catch(e => safeReply({ ok: false, error: String(e?.message || e) }));
      return true;
    }

    // --- Fallback ---
    safeReply({ ok: false, error: `unknown message type ${msg.type}` });
    return true;
  } catch (e) {
    safeReply({ ok: false, error: String(e?.message || e) });
    return true;
  }
});
