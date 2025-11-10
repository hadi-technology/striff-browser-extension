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
      return { ok: false, error: `Local API POST failed: ${res.status} ${txt}` };
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
          'http://localhost:8081/api/v1/languages',
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

    // --- Tokened GET to local API (Striffs) ---
    if (msg.type === 'fetchStriffsWithToken') {
      (async () => {
        const { owner, repo, pull_number, updated_at, token } = msg;
        if (!owner || !repo || !pull_number || !token) {
          safeReply({ ok: false, error: 'missing args (owner/repo/pull_number/token)' });
          return;
        }
        const url = `http://localhost:8081/api/v1/github/striffs/owners/${owner}/repos/${repo}/pulls/${pull_number}?updated_at=${encodeURIComponent(updated_at || '')}`;

        const t = abortableTimeout(30000);
        try {
          const res = await fetch(url, { headers: { Authorization: `token ${token}` }, signal: t.signal, cache: 'no-cache' });
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            safeReply({ ok: false, error: `Local API returned ${res.status} ${text}` });
            return;
          }
          const json = await res.json();
          safeReply({ ok: true, json });
        } catch (e) {
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
          baseOwner, baseRepo, baseBranch, headOwner, headRepo, headBranch, filterFilesCount: filterFiles.length
        });

        const [before, after] = await Promise.all([
          downloadRepoZipAsArrayBuffer(baseOwner, baseRepo, baseBranch),
          downloadRepoZipAsArrayBuffer(headOwner, headRepo, headBranch),
        ]);

        if (!before.ok) { safeReply({ ok: false, error: `Failed downloading base zip: ${before.error}` }); return; }
        if (!after.ok)  { safeReply({ ok: false, error: `Failed downloading head zip: ${after.error}` }); return; }

        const posted = await postZipsToLocal(
          'http://localhost:8081/api/v1/github/striffs',
          before.arrayBuffer,
          after.arrayBuffer,
          filterFiles,
          { timeoutMs: 180000 }
        );

        if (!posted.ok) { safeReply({ ok: false, error: posted.error }); return; }
        safeReply({ ok: true, json: posted.json });
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
        const { url, method = 'GET', headers = {}, bodyType = 'text', body, timeoutMs = 20000 } = msg;
        if (!url) { safeReply({ ok: false, error: 'missing url' }); return; }

        const t = abortableTimeout(timeoutMs);
        try {
          const init = { method, headers, signal: t.signal, cache: 'no-cache' };
          if (method !== 'GET' && body != null) init.body = body;
          const res = await fetch(url, init);
          const status = res.status;
          if (bodyType === 'json') {
            const json = await res.json().catch(() => null);
            safeReply({ ok: res.ok, status, json });
          } else {
            const text = await res.text().catch(() => '');
            safeReply({ ok: res.ok, status, text });
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
