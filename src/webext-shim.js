// webext-shim.js
// Provides a chrome-style API using browser.* for Firefox/Safari while leaving native chrome untouched.
(() => {
  const root = typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window);
  if (root.chrome && root.chrome.runtime) return; // Chrome/Edge already expose chrome.*
  const b = root.browser;
  if (!b || !b.runtime) return; // Nothing to shim

  const wrapAsync = (fn) => (...args) => {
    const maybeCb = args.length && typeof args[args.length - 1] === 'function' ? args.pop() : null;
    let p;
    try {
      p = fn(...args);
    } catch (e) {
      if (maybeCb) {
        root.chrome.runtime.lastError = e;
        try { maybeCb(); } catch {}
      }
      return Promise.reject(e);
    }
    if (maybeCb && p && typeof p.then === 'function') {
      return p.then((res) => {
        root.chrome.runtime.lastError = undefined;
        try { maybeCb(res); } catch {}
        return res;
      }).catch((err) => {
        root.chrome.runtime.lastError = err;
        try { maybeCb(); } catch {}
        return Promise.reject(err);
      });
    }
    return p;
  };

  const storageArea = (area) => ({
    get: wrapAsync((keys) => b.storage[area].get(keys)),
    set: wrapAsync((items) => b.storage[area].set(items)),
    remove: wrapAsync((keys) => b.storage[area].remove(keys)),
  });

  const fallbackSessionStore = new Map();
  const normalizeStorageKeys = (keys) => {
    if (keys == null) return { mode: 'all', keys: null };
    if (Array.isArray(keys)) return { mode: 'list', keys };
    if (typeof keys === 'string') return { mode: 'list', keys: [keys] };
    if (typeof keys === 'object') return { mode: 'object', keys: Object.keys(keys), defaults: keys };
    return { mode: 'all', keys: null };
  };
  const readFallbackSession = (keys) => {
    const normalized = normalizeStorageKeys(keys);
    if (normalized.mode === 'all') {
      return Object.fromEntries(fallbackSessionStore.entries());
    }
    const out = {};
    for (const key of normalized.keys || []) {
      if (fallbackSessionStore.has(key)) out[key] = fallbackSessionStore.get(key);
      else if (normalized.mode === 'object') out[key] = normalized.defaults[key];
    }
    return out;
  };
  const writeFallbackSession = (items) => {
    for (const [key, value] of Object.entries(items || {})) {
      fallbackSessionStore.set(key, value);
    }
  };
  const removeFallbackSession = (keys) => {
    const normalized = normalizeStorageKeys(keys);
    for (const key of normalized.keys || []) fallbackSessionStore.delete(key);
  };
  const storageSessionArea = (() => {
    if (b.storage?.session) return storageArea('session');
    if (b.storage?.local) {
      return {
        get: wrapAsync(async (keys) => readFallbackSession(keys)),
        set: wrapAsync(async (items) => { writeFallbackSession(items); }),
        remove: wrapAsync(async (keys) => { removeFallbackSession(keys); }),
      };
    }
    return {
      get: wrapAsync(async (keys) => readFallbackSession(keys)),
      set: wrapAsync(async (items) => { writeFallbackSession(items); }),
      remove: wrapAsync(async (keys) => { removeFallbackSession(keys); }),
    };
  })();

  const tabsApi = {
    query: wrapAsync((queryInfo) => b.tabs.query(queryInfo)),
    sendMessage: (tabId, message, options, cb) => {
      // options is optional in Chrome; normalize signature
      if (typeof options === 'function') { cb = options; options = undefined; }
      const p = b.tabs.sendMessage(tabId, message, options);
      if (cb && p && typeof p.then === 'function') {
        return p.then((res) => { root.chrome.runtime.lastError = undefined; cb(res); return res; })
          .catch((err) => { root.chrome.runtime.lastError = err; cb(); return Promise.reject(err); });
      }
      return p;
    }
  };

  const runtimeApi = {
    ...b.runtime,
    lastError: undefined,
    sendMessage: (msg, cb) => {
      const p = b.runtime.sendMessage(msg);
      if (cb && p && typeof p.then === 'function') {
        return p.then((res) => { runtimeApi.lastError = undefined; cb(res); return res; })
          .catch((err) => { runtimeApi.lastError = err; cb(); return Promise.reject(err); });
      }
      return p;
    },
  };

  const execScript = (details) => {
    if (b.scripting && b.scripting.executeScript) {
      return b.scripting.executeScript(details);
    }
    // Fallback for MV2-style tabs.executeScript (Safari/Firefox legacy)
    if (b.tabs && b.tabs.executeScript) {
      const tabId = details?.target?.tabId;
      if (!tabId) throw new Error('executeScript requires target.tabId');
      if (details.func) {
        const args = Array.isArray(details.args) ? details.args : [];
        const serializedArgs = args.map((a) => {
          try { return JSON.stringify(a); } catch { return 'undefined'; }
        }).join(', ');
        const code = `(${details.func.toString()})(${serializedArgs});`;
        return b.tabs.executeScript(tabId, { code, frameId: details.target?.frameId });
      }
      if (details.files && details.files.length) {
        return b.tabs.executeScript(tabId, { file: details.files[0], frameId: details.target?.frameId });
      }
      throw new Error('executeScript requires func or files');
    }
    throw new Error('No scripting API available');
  };

  const scriptingApi = { executeScript: wrapAsync(execScript) };

  root.chrome = {
    runtime: runtimeApi,
    storage: {
      local: storageArea('local'),
      sync: storageArea('sync'),
      session: storageSessionArea,
      onChanged: b.storage?.onChanged,
    },
    tabs: tabsApi,
    scripting: scriptingApi,
    webNavigation: b.webNavigation,
  };
})();
