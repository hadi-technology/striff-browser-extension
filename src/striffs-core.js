// Striffs — core (state, logging, messaging, storage, languages)
(() => {
  const S = (window.Striffs = window.Striffs || {});

  // ---------- Constants / State ----------
  S.MAX_UNAUTH_ZIP_SIZE_MB = 50;
  S.CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

  S.__striffsSvg = null;
  S.__striffsPanzoom = null;
  S.__striffsPathToComponentId = new Map();
  S.__striffsComponentIdToFile = new Map();
  S.__filePathToDiffId = new Map(); // "/path" -> diffId (no '#')
  S.__striffsReady = false;
  S.__lastFetchedUpdatedAt = null;
  S.__styleInjected = false;

  // ---------- Logging ----------
  S.clog  = (...a) => { try { console.log('[Striffs]', ...a); } catch {} };
  S.cinfo = (...a) => { try { console.info('[Striffs]', ...a); } catch {} };
  S.cwarn = (...a) => { try { console.warn('[Striffs]', ...a); } catch {} };
  S.cerr  = (...a) => { try { console.error('[Striffs]', ...a); } catch {} };

  // ---------- Utils ----------
  S.sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ---------- Messaging (MV3-hardened) ----------
  S.sendMessageWithTimeout = function sendMessageWithTimeout(msg, timeoutMs = 7000) {
    return new Promise((resolve) => {
      let settled = false;
      const t = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ ok: false, error: `timeout after ${timeoutMs}ms` });
        }
      }, timeoutMs);

      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (settled) return;
          settled = true;
          clearTimeout(t);
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else if (resp == null || (typeof resp !== 'object' && typeof resp !== 'boolean')) {
            resolve({ ok: false, error: 'empty/invalid response from background' });
          } else {
            resolve(resp);
          }
        });
      } catch (e) {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve({ ok: false, error: String(e?.message || e) });
      }
    });
  };

  S.waitForBackgroundReady = async function waitForBackgroundReady({ attempts = 5, delayMs = 150 } = {}) {
    let d = delayMs;
    for (let i = 0; i < attempts; i++) {
      const r = await S.sendMessageWithTimeout({ type: 'ping' }, 1000);
      if (r?.ok) return true;
      await S.sleep(d);
      d = Math.min(Math.floor(d * 1.8), 1200);
    }
    return false;
  };

  S.bgRequest = async function bgRequest(msg, timeoutMs) {
    const first = await S.sendMessageWithTimeout(msg, timeoutMs);
    const err = String(first?.error || '');
    if (first?.ok === true || first?.success === true) return first;

    // Retry once on classic MV3 startup/port races
    if (/timeout|port closed|Receiving end does not exist|No service worker/i.test(err)) {
      await S.waitForBackgroundReady({ attempts: 4, delayMs: 150 });
      return await S.sendMessageWithTimeout(msg, timeoutMs);
    }
    return first;
  };

  // ---------- Storage / Token ----------
  S.getStoredToken = async () =>
    new Promise((resolve) => {
      try {
        chrome.storage.sync.get(["ghToken"], (result) => resolve(result?.ghToken || null));
      } catch (e) {
        S.cerr('chrome.storage.sync.get failed:', e);
        resolve(null);
      }
    });

  // ---------- Languages via background ----------
  let __cachedExts = null;

  S.parseLangsToExts = (text) => {
    const langs = String(text || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const langToExt = {
      java:"java", golang:"go", go:"go", javascript:"js", typescript:"ts", python:"py",
      csharp:"cs", cpp:"cpp", cplusplus:"cpp", ruby:"rb", rust:"rs", php:"php", kotlin:"kt"
    };
    return langs.map(l => langToExt[l]).filter(Boolean);
  };

  S.fetchSupportedExtensions = async () => {
    if (Array.isArray(__cachedExts)) return __cachedExts;
    await S.waitForBackgroundReady({ attempts: 5, delayMs: 150 });
    const resp = await S.bgRequest({ type: 'getLanguages' }, 12000);
    const ok = resp?.ok === true || resp?.success === true;
    if (!ok) {
      S.cwarn('getLanguages failed:', resp?.error);
      return [];
    }
    const text = resp.body ?? resp.text ?? '';
    const exts = S.parseLangsToExts(text);
    __cachedExts = exts;
    S.cinfo('Supported extensions:', exts);
    return exts;
  };
})();
