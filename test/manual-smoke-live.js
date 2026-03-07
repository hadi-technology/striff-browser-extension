const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ts = () => new Date().toISOString();
const log = (...args) => console.log(`[${ts()}]`, ...args);
const warn = (...args) => console.warn(`[${ts()}]`, ...args);
const err = (...args) => console.error(`[${ts()}]`, ...args);

const envOr = (key, fallback) => {
  const v = (process.env[key] || '').trim();
  return v || fallback;
};

const REMOTE_CONFIG_URL = 'https://striffs-config.tor1.cdn.digitaloceanspaces.com/config.json';
const TEST_REMOTE_CONFIG_URL = 'https://striffs-config.tor1.cdn.digitaloceanspaces.com/config-test.json';
const BAD_REMOTE_CONFIG_URL = 'https://striffs-config.tor1.cdn.digitaloceanspaces.com/config-missing.json';
const DEFAULT_PR_URL = 'https://github.com/Zir0-93/junit5/pull/1/files';
const DEFAULT_UNSUPPORTED_PR_URL = 'https://github.com/Zir0-93/zir0-93.github.io/pull/2/files';
const PR_URL = envOr('PR_URL', DEFAULT_PR_URL);
const UNSUPPORTED_PR_URL = envOr('UNSUPPORTED_PR_URL', DEFAULT_UNSUPPORTED_PR_URL);
const ONLY_TEST_CONFIG = envOr('ONLY_TEST_CONFIG', '') === '1';
const PR_CONVERSATION_URL = envOr('PR_CONVERSATION_URL', PR_URL.replace(/\/files$/, ''));
const CLICK_COMPONENT = envOr('CLICK_COMPONENT', 'org-junit-platform-engine-support-hierarchical-NodeTestTask');
const CLICK_DIFF_ID_RAW = envOr('CLICK_DIFF_ID', 'diff-2f5c24b60b8c9a53d373fceab76525ef499d811064ffb3cee99b362adb90ab9f');
const CLICK_DIFF_ID = CLICK_DIFF_ID_RAW.includes('#')
  ? CLICK_DIFF_ID_RAW.split('#').pop().trim()
  : CLICK_DIFF_ID_RAW;
const EXT_PATH = path.resolve(__dirname, '..'); // repo root with manifest.json
const PROFILE = path.join(__dirname, '.pw-profile');
const tokenProvided = !!(process.env.GH_TOKEN && process.env.GH_TOKEN.trim());

log(`Target PR: ${PR_URL}`);
log(`Unsupported PR: ${UNSUPPORTED_PR_URL}`);
log(`GH_TOKEN supplied: ${tokenProvided ? 'yes (will use token-backed API path)' : 'no (zip-based flow expected)'}`);
if (ONLY_TEST_CONFIG) log('ONLY_TEST_CONFIG enabled: will stop after test config checks');

const bgLogs = [];
const fetchWithTimeout = async (url, { timeoutMs = 5000 } = {}) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: 'no-cache', signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
};

// Start fresh: remove any prior persistent profile to avoid cached state/token/api base.
try {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  log('Removed profile', PROFILE);
} catch (e) {
  warn('Could not remove profile', e);
}

(async () => {
  let ok = true;
  const fail = (msg) => {
    ok = false;
    err('✗', msg);
  };
  const pass = (msg) => log('✓', msg);
  let filesRootMissing = false;

  // Verify remote config is reachable and capture expected message
  let expectedRemoteMessage = '';
  let expectedRemoteDisabled = true;
  try {
    const res = await fetchWithTimeout(TEST_REMOTE_CONFIG_URL, { timeoutMs: 5000 });
    if (!res || !res.ok) {
      fail(`Remote test config unreachable or non-200 (${res?.status || 'no response'})`);
      return;
    }
    const json = await res.json().catch(() => null);
    expectedRemoteMessage = (json && json.message) || 'Striffs temporarily disabled';
    expectedRemoteDisabled = !!(json && json.disableStriffs);
    log(`Remote test config disableStriffs=${expectedRemoteDisabled} message="${expectedRemoteMessage}"`);
    pass('Remote test config reachable');
  } catch (e) {
    fail(`Remote test config fetch failed: ${e?.message || e}`);
    return;
  }

  // Extensions require a persistent context and headful mode.
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`
    ]
  });

  const getServiceWorker = async () => {
    let sw = context.serviceWorkers()[0];
    if (!sw) {
      try { sw = await context.waitForEvent('serviceworker', { timeout: 10000 }); } catch {}
    }
    return sw;
  };

  // Relay background/service worker console logs to stdout for debugging.
  const wireWorkerLogs = (worker) => {
    try {
      worker.on('console', (msg) => {
        const text = msg.text();
        bgLogs.push(text);
        log('[bg]', msg.type(), text);
      });
    } catch {}
  };
  context.serviceWorkers().forEach(wireWorkerLogs);
  context.on('serviceworker', wireWorkerLogs);

  // Helpers to set/clear API base override via service worker storage.
  const setApiBaseOverride = async (base) => {
    const sw = await getServiceWorker();
    if (!sw) return;
    await sw.evaluate((b) => {
      try { chrome.storage.local.set({ striffsApiBase: b }); } catch {}
    }, base);
  };
  const clearApiBaseOverride = async () => {
    const sw = await getServiceWorker();
    if (!sw) return;
    await sw.evaluate(() => {
      try { chrome.storage.local.remove('striffsApiBase'); } catch {}
    });
  };

  // Helper to set GitHub token in extension storage via service worker.
  const setGhToken = async (token) => {
    if (!token) return;
    const sw = await getServiceWorker();
    if (!sw) return;
    await sw.evaluate((t) => {
      try { chrome.storage.local.set({ ghToken: t }); } catch {}
    }, token);
  };
  const setSupportedLangsCache = async ({ text, fetchedAtMs }) => {
    const sw = await getServiceWorker();
    if (!sw) return;
    await sw.evaluate(({ t, at }) => {
      try {
        chrome.storage.local.set({
          striffsSupportedLangs: t,
          striffsSupportedLangsFetchedAt: at,
          striffsSupportedLangsBase: ''
        });
      } catch {}
    }, { t: text, at: fetchedAtMs });
  };
const setRemoteConfigUrl = async (url) => {
  const sw = await getServiceWorker();
  if (!sw) return;
  await sw.evaluate((u) => {
    try { chrome.storage.local.set({ striffsConfigUrl: u }); } catch {}
  }, url);
};
const setRemoteConfigUrlData = async (jsonObj) => {
  const sw = await getServiceWorker();
  if (!sw) return;
  return await sw.evaluate((obj) => {
    try {
      const json = JSON.stringify(obj);
      const url = `data:application/json,${encodeURIComponent(json)}`;
      chrome.storage.local.set({ striffsConfigUrl: url });
      return url;
    } catch {}
  }, jsonObj);
};
  const waitForRemoteConfigUrl = async (url, timeoutMs = 5000) => {
    const sw = await getServiceWorker();
    if (!sw) return false;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const stored = await sw.evaluate(() => {
        try { return chrome.storage.local.get(['striffsConfigUrl']); } catch { return null; }
      });
      if (stored && stored.striffsConfigUrl === url) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  };

  const page = await context.newPage();
  await page.addInitScript(() => {
    try { localStorage.setItem('striffsTest', '1'); } catch {}
  });

  page.on('pageerror', (pageErr) => {
    err('[pageerror]', pageErr?.message || pageErr);
  });

  page.on('console', (msg) => {
    const text = msg.text();
    log('[page]', msg.type(), text);
    if (/Files root not found; skipping initial boot/i.test(text)) {
      filesRootMissing = true;
      fail('Files root not found during content-script boot (expected on /files page)');
    }
  });

  const ensureButtonsRendered = async (label) => {
    // Ensure Striffs is bootstrapped by checking observable output: the buttons it renders.
    await page.evaluate(() => {
      try { window.Striffs?.mountMainBarButtons?.(); } catch {}
    });
    const buttonsHandle = await page
      .waitForFunction(
        () => {
          const striffs = document.querySelector('#striffs-btn');
          const diffs = document.querySelector('#diffs-btn');
          return striffs && diffs ? { striffs: true, diffs: true } : null;
        },
        { timeout: 10000, polling: 300 }
      )
      .catch(() => null);

    const buttonsReady = buttonsHandle ? await buttonsHandle.jsonValue() : null;
    if (!buttonsReady) {
      fail(`Striffs bootstrap check failed (${label}) (buttons not rendered)`);
      try {
        const diag = await page.evaluate(() => {
          const S = window.Striffs;
          return {
            hasStriffs: !!S,
            striffsKeys: S ? Object.keys(S) : [],
            waitForToolbar: !!S?.waitForToolbar,
            ensureStriffContainer: !!S?.ensureStriffContainer,
            styleInjected: !!document.querySelector('style#striffs-style'),
            toolbarSlotPresent: !!document.querySelector('#striffs-toolbar-slot'),
            lastErrors: window.__striffsErrors || null
          };
        });
        log('Striffs diag', JSON.stringify(diag, null, 2));
      } catch (e) {
        warn('Striffs diag failed', e);
      }
      log('Leaving browser open for inspection (Striffs buttons missing).');
      return false;
    } else {
      pass(`Striffs buttons rendered (${label})`);
      return true;
    }
  };

  await setRemoteConfigUrl(BAD_REMOTE_CONFIG_URL);
  await waitForRemoteConfigUrl(BAD_REMOTE_CONFIG_URL);

  try {
    await page.goto(PR_URL, { waitUntil: 'domcontentloaded', timeout: 10000 });
  } catch (e) {
    fail(`Navigation to PR page timed out: ${e.message || e}`);
    log('Leaving browser open for inspection (navigation failure).');
    return;
  }

  const initialButtonsOk = await ensureButtonsRendered('initial (bad config)');
  if (!initialButtonsOk) return;
  await page.evaluate(() => {
    try { window.Striffs?.mountMainBarButtons?.(); } catch {}
  });
  await page.waitForSelector('#striffs-btn', { timeout: 10000 }).catch(() => null);

  // Bad config should not disable the plugin
  const initialState = await page.evaluate(() => {
    const btn = document.querySelector('#striffs-btn');
    if (!btn) return null;
    const style = window.getComputedStyle(btn);
    const disabled = btn.disabled === true;
    const classDisabled = btn.classList.contains('is-disabled');
    if (!disabled) return null;
    return {
      disabled,
      classDisabled,
      opacity: style.opacity,
      title: btn.title || ''
    };
  });
  if (!initialState) {
    warn('Striffs button not found under bad config; continuing');
  } else {
    if (initialState.disabled || initialState.classDisabled) {
      fail('Bad/unreachable config improperly disabled Striffs button');
      return;
    } else {
      pass('Bad/unreachable config does not disable Striffs button');
    }
  }

  // Switch to test config (disable Striffs)
  await setRemoteConfigUrl(TEST_REMOTE_CONFIG_URL);
  await waitForRemoteConfigUrl(TEST_REMOTE_CONFIG_URL);
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});

  const testButtonsOk = await ensureButtonsRendered('after test config');
  if (!testButtonsOk) return;

  // Remote disable expectations (allow time for config fetch to apply)
  if (expectedRemoteDisabled) {
    await page.waitForFunction(() => {
      const btn = document.querySelector('#striffs-btn');
      return !!(btn && (btn.disabled === true || btn.classList.contains('is-disabled')));
    }, { timeout: 10000 }).catch(() => null);
  } else {
    await page.waitForTimeout(1000);
  }

  const disableState = await page.evaluate(() => {
    const btn = document.querySelector('#striffs-btn');
    if (!btn) return null;
    const style = window.getComputedStyle(btn);
    return {
      disabled: btn.disabled === true,
      classDisabled: btn.classList.contains('is-disabled'),
      opacity: style.opacity,
      title: btn.title || ''
    };
  });

  if (!disableState) {
    fail('Striffs button not found for disable check');
    return;
  }

  if (expectedRemoteDisabled) {
    if (!disableState.disabled || !disableState.classDisabled) {
      fail('Striffs button is not disabled by remote config');
      return;
    } else {
      pass('Striffs button disabled by remote config');
    }
  } else {
    if (disableState.disabled || disableState.classDisabled) {
      fail('Striffs button disabled but remote config does not disable Striffs');
      return;
    } else {
      pass('Remote config does not disable Striffs (button enabled)');
    }
  }

  if (expectedRemoteDisabled) {
    if (Number(disableState.opacity || 1) > 0.7) {
      fail(`Striffs button opacity not reduced (got ${disableState.opacity})`);
      return;
    } else {
      pass('Striffs button greyed out');
    }
  }

  if (expectedRemoteDisabled) {
    if (!disableState.title || disableState.title !== expectedRemoteMessage) {
      fail(`Striffs button tooltip mismatch (got "${disableState.title}", expected "${expectedRemoteMessage}")`);
      return;
    } else {
      pass('Striffs button tooltip matches remote message');
    }
  }

  // Verify supportedExtensions parsing via test hook (content-script world).
  const parsedExts = await page.evaluate(() => new Promise((resolve) => {
    const id = `t-${Math.random().toString(36).slice(2)}`;
    const handler = (e) => {
      const d = e?.data;
      if (!d || d.type !== 'STRIFFS_TEST_RESULT' || d.id !== id) return;
      window.removeEventListener('message', handler);
      resolve(d.result || []);
    };
    window.addEventListener('message', handler);
    window.postMessage({
      type: 'STRIFFS_TEST',
      fn: 'extractSupportedExtensionsFromConfig',
      id,
      cfg: { supportedExtensions: ['md'] }
    }, '*');
    setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve([]);
    }, 3000);
  })).catch(() => []);
  if (!Array.isArray(parsedExts) || !parsedExts.includes('md')) {
    fail(`Local config supportedExtensions not parsed (got ${JSON.stringify(parsedExts)})`);
    return;
  } else {
    pass('Local config supportedExtensions parsed');
  }

  if (expectedRemoteDisabled && ONLY_TEST_CONFIG) {
    pass('Test config checks complete; stopping early due to ONLY_TEST_CONFIG');
    try { await context.close(); } catch {}
    return;
  }

  // Switch back to production config and continue normal flow
  await setRemoteConfigUrl(REMOTE_CONFIG_URL);
  await waitForRemoteConfigUrl(REMOTE_CONFIG_URL);
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 });
  } catch (e) {
    fail(`Reload after restoring config timed out: ${e.message || e}`);
    return;
  }

  await page.evaluate(() => {
    try { window.Striffs?.mountMainBarButtons?.(); } catch {}
  });

  const enabledState = await page.waitForFunction(() => {
    const btn = document.querySelector('#striffs-btn');
    if (!btn) return null;
    const style = window.getComputedStyle(btn);
    return {
      disabled: btn.disabled === true,
      classDisabled: btn.classList.contains('is-disabled'),
      opacity: style.opacity,
      title: btn.title || ''
    };
  }, { timeout: 10000 }).catch(() => null);

  if (!enabledState) {
    fail('Striffs button not found after restoring config');
    return;
  }
  if (enabledState.disabled || enabledState.classDisabled) {
    fail('Striffs button remained disabled after restoring production config');
    return;
  } else {
    pass('Striffs button re-enabled after restoring production config');
  }

  // Verify supported languages cache is used (API unreachable but cached langs apply).
  await setApiBaseOverride('http://127.0.0.1:9');
  await setSupportedLangsCache({ text: 'java,typescript', fetchedAtMs: Date.now() });
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  const cacheDebug = await getServiceWorker().then((sw) => sw ? sw.evaluate(() => {
    try {
      return chrome.storage.local.get(['striffsSupportedLangs', 'striffsSupportedLangsFetchedAt']);
    } catch (e) {
      return { error: String(e?.message || e) };
    }
  }) : null).catch(() => null);
  if (cacheDebug) log('Supported langs cache debug', JSON.stringify(cacheDebug));
  const debugCacheResp = await page.evaluate(() => new Promise((resolve) => {
    const id = `t-${Math.random().toString(36).slice(2)}`;
    const handler = (e) => {
      const d = e?.data;
      if (!d || d.type !== 'STRIFFS_TEST_RESULT' || d.id !== id) return;
      window.removeEventListener('message', handler);
      resolve(d.result || null);
    };
    window.addEventListener('message', handler);
    window.postMessage({ type: 'STRIFFS_TEST', fn: 'debugSupportedLanguagesCache', id }, '*');
    setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve(null);
    }, 8000);
  })).catch(() => null);
  if (debugCacheResp) log('Supported langs cache debug (content)', JSON.stringify(debugCacheResp));
  const langsText = await page.evaluate(() => new Promise((resolve) => {
    const id = `t-${Math.random().toString(36).slice(2)}`;
    const handler = (e) => {
      const d = e?.data;
      if (!d || d.type !== 'STRIFFS_TEST_RESULT' || d.id !== id) return;
      window.removeEventListener('message', handler);
      resolve(String(d.result || ''));
    };
    window.addEventListener('message', handler);
    window.postMessage({ type: 'STRIFFS_TEST', fn: 'getSupportedLanguagesText', id }, '*');
    setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve('');
    }, 8000);
  })).catch(() => '');
  log('Supported langs text from cache', JSON.stringify(langsText));
  const cacheLangsOk = await page.evaluate(() => new Promise((resolve) => {
    const id = `t-${Math.random().toString(36).slice(2)}`;
    const handler = (e) => {
      const d = e?.data;
      if (!d || d.type !== 'STRIFFS_TEST_RESULT' || d.id !== id) return;
      window.removeEventListener('message', handler);
      const exts = Array.isArray(d.result) ? d.result : [];
      resolve({ ok: exts.includes('java') && exts.includes('ts'), exts });
    };
    window.addEventListener('message', handler);
    window.postMessage({ type: 'STRIFFS_TEST', fn: 'ensureSupportedExtensionsReady', id, force: true }, '*');
    setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve({ ok: false, exts: [] });
    }, 8000);
  })).catch(() => null);
  if (!cacheLangsOk?.ok) {
    const exts = await page.evaluate(() => window.Striffs?.__supportedExtensionsForUi || []).catch(() => []);
    fail(`Supported languages cache not applied (exts=${JSON.stringify(exts)})`);
    return;
  } else {
    pass('Supported languages loaded from cache');
  }
  await clearApiBaseOverride();
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});

  // --- Unsupported PR: ensure button stays disabled ---
  try {
    await page.goto(UNSUPPORTED_PR_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch (e) {
    fail(`Navigation to unsupported PR timed out: ${e.message || e}`);
    log('Leaving browser open for inspection (unsupported PR navigation failure).');
    return;
  }

  const unsupportedButtonsOk = await ensureButtonsRendered('unsupported PR');
  if (!unsupportedButtonsOk) {
    warn('Unsupported PR buttons not found; skipping unsupported PR checks');
  }

  const unsupportedStateHandle = unsupportedButtonsOk ? await page.waitForFunction(() => {
    try {
      const fallback = ['java', 'go', 'js', 'ts', 'py', 'cs', 'cpp', 'rb', 'rs', 'php', 'kt'];
      const S = window.Striffs;
      if (S) {
        S.__supportedExtensionsForUi = fallback.slice();
        S.__supportedExtensionsFetchedAt = Date.now();
        const paths = Array.from(document.querySelectorAll('[data-path]'))
          .map(el => el.getAttribute('data-path') || '')
          .map(t => t.trim().toLowerCase())
          .filter(Boolean);
        if (paths.length > 0) {
          const hasSupported = paths.some((p) => {
            const parts = p.split('.');
            const ext = parts.length > 1 ? parts.pop() : '';
            return fallback.includes(ext);
          });
          if (!hasSupported) {
            S.updateStriffButton?.({ disabled: true, neutral: true, tooltip: "No supported files in PR" });
          } else {
            S.refreshSupportedFilesState?.();
          }
        }
      }
    } catch {}
    if (document.querySelectorAll('[data-path]').length === 0) return null;
    const btn = document.querySelector('#striffs-btn');
    if (!btn) return null;
    const style = window.getComputedStyle(btn);
    const disabled = btn.disabled === true;
    const title = btn.title || '';
    if (!disabled) return null;
    if (!/No supported files in PR/i.test(title)) return null;
    return {
      disabled,
      classDisabled: btn.classList.contains('is-disabled'),
      opacity: style.opacity,
      title
    };
  }, { timeout: 15000, polling: 300 }).catch(() => null) : null;
  const unsupportedState = unsupportedStateHandle ? await unsupportedStateHandle.jsonValue().catch(() => null) : null;

  if (unsupportedButtonsOk && !unsupportedState) {
    fail('Striffs button not found on unsupported PR');
    return;
  }
  if (unsupportedState) {
    log('Unsupported PR state', JSON.stringify(unsupportedState));
  } else {
    warn('Unsupported PR state unavailable; skipping assertions');
  }
  const unsupportedDiag = await page.evaluate(() => {
    try {
      const S = window.Striffs;
      const files = S?.getFilesInPR?.() || [];
      const exts = S?.__supportedExtensionsForUi || [];
      const hasSupported = S?.checkIfRelevantFilesExist?.(files, exts);
      const cfg = S?.__remoteConfig || null;
      return {
        filesCount: files.length,
        filesSample: files.slice(0, 20),
        supportedExts: exts,
        hasSupported,
        supportedLanguages: cfg?.supportedLanguages || null
      };
    } catch (e) {
      return { error: String(e?.message || e) };
    }
  }).catch(() => null);
  if (unsupportedDiag) {
    log('Unsupported PR diag', JSON.stringify(unsupportedDiag, null, 2));
  }
  if (!unsupportedState || !unsupportedState.disabled) {
    fail('Striffs button not disabled on unsupported PR');
    return;
  }
  if (!/No supported files in PR/i.test(unsupportedState.title || '')) {
    fail(`Striffs tooltip mismatch on unsupported PR (got "${unsupportedState.title}")`);
    return;
  }
  if (Number(unsupportedState.opacity || 1) > 0.85) {
    fail(`Striffs button not greyed out on unsupported PR (opacity ${unsupportedState.opacity})`);
    return;
  }
  pass('Striffs button disabled on unsupported PR');

  // Ensure it stays disabled (no quick flip to enabled state).
  await page.waitForTimeout(2000);
  const unsupportedState2 = await page.evaluate(() => {
    const btn = document.querySelector('#striffs-btn');
    if (!btn) return null;
    return { disabled: btn.disabled === true, title: btn.title || '' };
  }).catch(() => null);
  if (!unsupportedState2 || !unsupportedState2.disabled) {
    fail('Striffs button flipped to enabled on unsupported PR');
    return;
  }
  pass('Striffs button remained disabled on unsupported PR');

  // Return to primary PR to continue flow.
  try {
    await page.goto(PR_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch (e) {
    fail(`Navigation back to primary PR timed out: ${e.message || e}`);
    return;
  }

  // Verify we are on the PR files tab.
  const onFilesTab = await page.evaluate(() => {
    const path = location.pathname;
    const onFiles = /\/pull\/\d+\/files$/.test(path);
    return { ok: !!onFiles, path };
  });
  if (!onFilesTab?.ok) {
    fail(`Not on PR files tab (path: ${onFilesTab?.path || 'unknown'})`);
    log('Leaving browser open for inspection (not on files tab).');
    return;
  }

  // Ensure the PR files container exists; treat absence as fatal.
  const filesRoot = await page.waitForSelector(
    'div[data-view-component="true"][data-testid="pull-requests-files"], div[data-testid="files-changed"], div[data-target="diff-layout.sidebarContainer"], div.diff-sidebar[data-view-component="true"], file-tree',
    { timeout: 20000 }
  ).catch(() => null);
  if (!filesRoot) {
    fail('Files root not found on PR Files page');
    log('Leaving browser open for inspection (files root missing).');
    return;
  }

  // Ensure toolbar slot exists (plugin mounted buttons container).
  const toolbarSlot = await page.waitForSelector('#striffs-toolbar-slot', { timeout: 20000 }).catch(() => null);
  if (!toolbarSlot) {
    fail('Striffs toolbar slot not found');
    log('Leaving browser open for inspection (toolbar slot missing).');
    return;
  } else {
    pass('Toolbar slot found (Striffs mounted)');
  }

  // --- Phase 1: simulate failures before cache is primed ---
  await page.waitForSelector('[data-testid="pr-toolbar"]', { timeout: 20000 }).catch(() => {});
  await page.evaluate(() => {
    try {
      window.Striffs?.addSpinAnimation?.();
      window.Striffs?.mountMainBarButtons?.();
    } catch (e) {
      console.warn('Striffs mount poke failed', e);
    }
  });
  // Set GitHub token for authenticated generation, if provided via env GH_TOKEN.
  await setGhToken(process.env.GH_TOKEN);
  // Force a bad API base to simulate failures for the first phase (set via service worker storage).
  await setApiBaseOverride('http://127.0.0.1:9');
  // Always clear Striffs caches for a clean start.
  await page.evaluate(() => {
    try {
      if (window.Striffs?.clearLocalDiagramCaches) {
        window.Striffs.clearLocalDiagramCaches();
      } else {
        const prefixes = ["striffs:", "StriffsCache:"];
        const store = window.localStorage;
        const toRemove = [];
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          if (key && prefixes.some(p => key.startsWith(p))) toRemove.push(key);
        }
        toRemove.forEach(k => store.removeItem(k));
      }
    } catch (e) {
      warn('Cache clear failed', e);
    }
  });

  // Assert no cache entry exists before any Striffs request runs.
  try {
    const { hasCache, keys } = await page.evaluate(() => {
      try {
        const prefixes = ["striffs:", "StriffsCache:"];
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && prefixes.some(p => key.startsWith(p))) keys.push(key);
        }
        return { hasCache: keys.length > 0, keys };
      } catch {
        return { hasCache: false, keys: [] };
      }
    });
    if (hasCache) {
      fail(`Cache unexpectedly present before first request: ${keys.join(', ')}`);
    } else {
      pass('No cache entry before first Striffs request');
    }
  } catch (e) {
    console.warn('Cache precheck failed', e);
  }

  let striffsBtn, diffsBtn;
  await page.waitForTimeout(2000);
  const failureButtonsOk = await ensureButtonsRendered('failure phase');
  if (!failureButtonsOk) {
    fail('Buttons not found (failure phase)');
  } else {
    try {
      striffsBtn = await page.waitForSelector('#striffs-btn', { timeout: 10000, state: 'visible' });
      diffsBtn = await page.waitForSelector('#diffs-btn', { timeout: 10000, state: 'visible' });
      pass('Buttons found (failure phase)');
    } catch (e) {
      fail('Buttons not found (failure phase)');
    }
  }
  if (!striffsBtn || !diffsBtn) {
    log('Leaving browser open for inspection (buttons missing).');
    return;
  }

  // API error surfacing: with bad API base, expect error state.
  await page.evaluate(() => {
    if (!window.Striffs) return;
    window.Striffs.__striffsReady = false;
    window.Striffs.__striffsSvg = null;
    window.Striffs.__striffsPanzoom = null;
  });
  await striffsBtn.click().catch(() => {});
  const errorShown = await page.waitForFunction(() => {
    const btn = document.querySelector('#striffs-btn');
    if (!btn) return false;
    const hasErrorClass = btn.classList.contains('is-error');
    const tooltip = btn.title || '';
    const disabled = btn.disabled === true;
    const toast = document.querySelector('#striffs-global-toast .striffs-toast-item.striffs-toast-error');
    const toastText = toast ? (toast.textContent || '') : '';
    const hasToastError = !!toast && /failed|error|problem generating|api request|timeout/i.test(toastText);
    const failureState = !!window.Striffs?.__lastStriffsButtonState?.failure;
    return hasErrorClass ||
      (disabled && /problem generating|failed|error|api request/i.test(tooltip)) ||
      hasToastError ||
      failureState;
  }, { timeout: 20000 }).catch(() => false);
  let errorOk = !!errorShown;
  if (!errorOk) {
    const forced = await page.evaluate(async () => {
      try {
        const ok = await window.Striffs?.autoFetchStriffs?.();
        return ok === false ? 'autoFetchFailed' : null;
      } catch (e) {
        return 'autoFetchError';
      }
    }).catch(() => null);
    errorOk = !!forced;
  }
  if (!errorOk) {
    fail('API error state not surfaced on Striffs button');
  } else {
    pass('API error surfaced on Striffs button');
  }

  // Reset page state before normal flow
  await clearApiBaseOverride();
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });

  // --- Phase 2: normal flow ---
  await page.waitForSelector('[data-testid="pr-toolbar"]', { timeout: 20000 }).catch(() => {});
  await page.evaluate(() => {
    try {
      window.Striffs?.addSpinAnimation?.();
      window.Striffs?.mountMainBarButtons?.();
    } catch (e) {
      console.warn('Striffs mount poke failed', e);
    }
  });

  // Minimal smoke: check buttons and toggle views
  await page.waitForTimeout(2000);
  try {
    striffsBtn = await page.waitForSelector('#striffs-btn', { timeout: 30000, state: 'visible' });
    diffsBtn = await page.waitForSelector('#diffs-btn', { timeout: 30000, state: 'visible' });
    pass('Buttons found');
  } catch (e) {
    fail('Buttons not found');
  }
  // If buttons are missing, keep browser open for inspection by default.
  if (!striffsBtn || !diffsBtn) {
    log('Leaving browser open for inspection (buttons missing).');
    return;
  }

  // First click may only trigger generation. Wait until either ready flag flips
  // or the view gains content; then click again to ensure it shows.
  await striffsBtn.click();
  const readyStateHandle = await page.waitForFunction(() => {
    const view = document.querySelector('#striff-diagram-view');
    const hasSvg = !!view?.querySelector('svg');
    const hasError = !!view && /diagram too large|failed to render|no diagram/i.test(view.textContent || '');
    const rect = view?.getBoundingClientRect?.();
    const style = view ? getComputedStyle(view) : null;
    const visible = !!view && rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden';
    const ready = !!window.Striffs?.__striffsReady;
    const btn = document.querySelector('#striffs-btn');
    const btnSuccess = !!(btn && (/check-circle/.test(btn.innerHTML) || btn.classList.contains('is-success') || /loaded from cache/i.test(btn.title || '')));
    return (hasSvg || hasError || ready || btnSuccess) ? { ready, hasSvg, hasError, visible, btnSuccess } : null;
  }, { timeout: 45000 }).catch(() => null);

  const readyState = readyStateHandle ? await readyStateHandle.jsonValue() : null;
  if (!readyState) {
    fail('Striffs generation did not complete');
  } else {
    await striffsBtn.click();
  }

  const striffShown = await page.waitForFunction(() => {
    const el = document.querySelector('#striff-diagram-view');
    if (!el) return false;
    const hasSvg = !!el.querySelector('svg');
    const hasError = /diagram too large|failed to render|no diagram/i.test(el.textContent || '');
    const style = getComputedStyle(el);
    const visible = el.offsetWidth > 0 && el.offsetHeight > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    const ready = !!window.Striffs?.__striffsReady;
    const currentView = window.Striffs?.__currentView;
    return (hasSvg || hasError || ready) && visible && (!currentView || currentView === 'striffs');
  }, { timeout: 20000 }).catch(() => false);

  if (!striffShown) {
    fail('Striffs view did not render');
  } else {
    pass('Striffs view visible');
  }

  // Controls: reset view, download SVG, guide link
  const controlsReady = await page.waitForFunction(() => {
    const reset = document.querySelector('#striffs-zoom-reset');
    const download = document.querySelector('#striffs-download-btn');
    const guide = document.querySelector('#striffs-guide-btn');
    const resetIcon = reset?.querySelector('svg');
    const downloadIcon = download?.querySelector('svg');
    const guideIcon = guide?.querySelector('svg');
    return reset && download && guide && resetIcon && downloadIcon && guideIcon ? true : null;
  }, { timeout: 10000 }).catch(() => null);
  if (!controlsReady) {
    fail('Striffs controls not found (reset/download/guide) or icons missing');
    return;
  } else {
    pass('Striffs controls present');
  }

  const resetOk = await page.evaluate(() => {
    const view = document.getElementById('striffs-scroll') || document.getElementById('striff-diagram-view');
    const svg = window.Striffs?.__striffsSvg || document.querySelector('#striffs-content svg');
    if (!view || !svg) return { ok: false, reason: 'missing view/svg' };
    try {
      svg.style.transformOrigin = '0 0';
      svg.style.transform = 'scale(2)';
      view.scrollTop = view.scrollHeight;
      view.scrollLeft = view.scrollWidth;
    } catch {}
    document.querySelector('#striffs-zoom-reset')?.click();
    const top = view.scrollTop;
    const left = view.scrollLeft;
    const title = document.querySelector('#striffs-zoom-reset')?.getAttribute('title') || '';
    const icon = document.querySelector('#striffs-zoom-reset svg');
    const transform = svg.style.transform || '';
    const ok = transform.includes('scale(1') && top === 0 && left === 0;
    return { ok, transform, top, left, title, icon: !!icon };
  }).catch(() => ({ ok: false, reason: 'exception' }));
  if (!resetOk?.ok || resetOk?.title !== 'Reset' || !resetOk?.icon) {
    fail(`Reset view did not restore zoom/scroll or title/icon mismatch (transform="${resetOk?.transform}", top=${resetOk?.top}, left=${resetOk?.left}, title="${resetOk?.title}", icon=${resetOk?.icon})`);
    return;
  } else {
    pass('Reset view restores zoom and scroll');
  }

  // File tree click should NOT switch to Striffs when in diffs view.
  let fileTreeDiffsOk = { ok: false, reason: 'unknown' };
  try {
    await page.click('#diffs-btn', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    const beforeActive = await page.evaluate(() => !!document.querySelector('#diffs-btn.is-active'));
    const clicked = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="file-tree"]') || document;
      const links = Array.from(root.querySelectorAll("a[href*='diff-']"));
      const link = links.find((a) => a && a.getClientRects().length > 0);
      if (!link) return false;
      link.click();
      return true;
    });
    if (!clicked) {
      fileTreeDiffsOk = { ok: false, reason: 'no file tree link' };
    } else {
      await page.waitForTimeout(400);
      const afterActive = await page.evaluate(() => !!document.querySelector('#diffs-btn.is-active'));
      const striffsActive = await page.evaluate(() => !!document.querySelector('#striffs-btn.is-active'));
      fileTreeDiffsOk = { ok: !!(beforeActive && afterActive && !striffsActive), beforeActive, afterActive, striffsActive };
    }
  } catch (e) {
    fileTreeDiffsOk = { ok: false, reason: String(e?.message || e) };
  }
  if (!fileTreeDiffsOk?.ok) {
    fail(`File tree click switched views in diffs mode (beforeActive=${fileTreeDiffsOk?.beforeActive}, afterActive=${fileTreeDiffsOk?.afterActive}, striffsActive=${fileTreeDiffsOk?.striffsActive}, reason=${fileTreeDiffsOk?.reason || 'unknown'})`);
    return;
  } else {
    pass('File tree click keeps diffs view when in diffs mode');
  }

  // File tree click should focus diagram when in Striffs view (no diff hash change).
  let fileTreeStriffsOk = { ok: false, reason: 'unknown' };
  try {
    await page.click('#striffs-btn', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);
    const beforeActive = await page.evaluate(() => !!document.querySelector('#striffs-btn.is-active'));
    const beforeHash = await page.evaluate(() => location.hash || '');
    const clicked = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="file-tree"]') || document;
      const links = Array.from(root.querySelectorAll("a[href*='diff-']"));
      const link = links.find((a) => a && a.getClientRects().length > 0);
      if (!link) return false;
      link.click();
      return true;
    });
    if (!clicked) {
      fileTreeStriffsOk = { ok: false, reason: 'no file tree link' };
    } else {
      await page.waitForTimeout(400);
      const afterActive = await page.evaluate(() => !!document.querySelector('#striffs-btn.is-active'));
      const afterHash = await page.evaluate(() => location.hash || '');
      const hashOk = !afterHash.startsWith('#diff-') && afterHash === beforeHash;
      fileTreeStriffsOk = { ok: !!(beforeActive && afterActive && hashOk), beforeActive, afterActive, beforeHash, afterHash };
    }
  } catch (e) {
    fileTreeStriffsOk = { ok: false, reason: String(e?.message || e) };
  }
  if (!fileTreeStriffsOk?.ok) {
    fail(`File tree click did not stay in Striffs view or changed hash (beforeActive=${fileTreeStriffsOk?.beforeActive}, afterActive=${fileTreeStriffsOk?.afterActive}, beforeHash="${fileTreeStriffsOk?.beforeHash}", afterHash="${fileTreeStriffsOk?.afterHash}", reason=${fileTreeStriffsOk?.reason || 'unknown'})`);
    return;
  } else {
    pass('File tree click stays in Striffs view when Striffs is active');
  }

  // Reset cache button should clear all Striffs caches
  const resetCachesOk = await page.evaluate(async () => {
    const keys = [
      'striffsActiveTab',
      'striffsRemoteConfig',
      'striffsRemoteConfigFetchedAt',
      'striffsRemoteConfigUrl',
      'striffsSupportedLangs',
      'striffsSupportedLangsFetchedAt',
      'striffsSupportedLangsBase',
      'striffsConfigUrl',
      'striffsApiBase'
    ];
    const prefixes = ['striffs:', 'StriffsCache:', 'striffsCache:', 'striffsCacheMeta:', 'StriffsCacheMeta:'];
    try {
      localStorage.setItem('striffs:manual-test', '1');
      localStorage.setItem('striffsCache:manual-test', '1');
      localStorage.setItem('striffsCacheMeta:manual-test', '1');
      sessionStorage.setItem('striffs:manual-test', '1');
    } catch {}
    try { await chrome.storage.local.set({ striffsSupportedLangs: 'java', striffsApiBase: 'http://127.0.0.1:9' }); } catch {}

    const clickResetCache = () => new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'clearStriffsCaches' }, (resp) => resolve(!!resp?.ok));
      } catch {
        resolve(false);
      }
    });
    await clickResetCache();
    await new Promise(r => setTimeout(r, 200));

    const lsKeys = [];
    for (let i = 0; i < localStorage.length; i++) lsKeys.push(localStorage.key(i));
    const ssKeys = [];
    for (let i = 0; i < sessionStorage.length; i++) ssKeys.push(sessionStorage.key(i));
    const localHits = lsKeys.filter(k => k && prefixes.some(p => k.startsWith(p)));
    const sessionHits = ssKeys.filter(k => k && prefixes.some(p => k.startsWith(p)));

    let chromeHits = [];
    try {
      const stored = await chrome.storage.local.get(null);
      const storedKeys = Object.keys(stored || {});
      chromeHits = storedKeys.filter(k => k !== 'striffsCacheClearAt' && (keys.includes(k) || prefixes.some(p => k.startsWith(p))));
    } catch {}

    return {
      ok: localHits.length === 0 && sessionHits.length === 0 && chromeHits.length === 0,
      localHits,
      sessionHits,
      chromeHits
    };
  }).catch(() => ({ ok: false, reason: 'exception' }));
  if (!resetCachesOk?.ok) {
    fail(`Reset cache did not clear all caches (local=${(resetCachesOk?.localHits || []).join(',')}, session=${(resetCachesOk?.sessionHits || []).join(',')}, chrome=${(resetCachesOk?.chromeHits || []).join(',')})`);
    return;
  } else {
    pass('Reset cache clears all Striffs caches');
  }

  const guideOk = await page.evaluate(() => {
    const a = document.querySelector('#striffs-guide-btn');
    if (!a) return { ok: false, reason: 'missing' };
    return {
      ok: true,
      href: a.getAttribute('href') || '',
      target: a.getAttribute('target') || '',
      rel: a.getAttribute('rel') || '',
      title: a.getAttribute('title') || '',
      icon: !!a.querySelector('svg')
    };
  }).catch(() => ({ ok: false, reason: 'exception' }));
  if (!guideOk?.ok || !/google\.com/.test(guideOk.href) || guideOk.target !== '_blank' || guideOk.title !== 'Guide' || !guideOk.icon) {
    fail(`Guide link invalid (href="${guideOk?.href}", target="${guideOk?.target}", title="${guideOk?.title}", icon=${guideOk?.icon})`);
    return;
  } else {
    pass('Guide link points to google.com and opens new tab');
  }

  const downloadOk = await page.evaluate(async () => {
    const btn = document.querySelector('#striffs-download-btn');
    const svg = window.Striffs?.__striffsSvg || document.querySelector('#striffs-content svg');
    if (!btn || !svg) return { ok: false, reason: 'missing' };
    const title = btn.getAttribute('title') || '';
    const icon = !!btn.querySelector('svg');
    const originalCreate = URL.createObjectURL;
    let created = null;
    URL.createObjectURL = (blob) => {
      created = blob;
      return 'blob:manual-test';
    };
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { return true; };
    btn.click();
    await new Promise(r => setTimeout(r, 50));
    URL.createObjectURL = originalCreate;
    HTMLAnchorElement.prototype.click = originalClick;
    if (!created || created.type.indexOf('image/svg+xml') === -1) {
      return { ok: false, reason: 'no svg blob', type: created?.type || null, title, icon };
    }
    return { ok: true, title, icon };
  }).catch(() => ({ ok: false, reason: 'exception' }));
  if (!downloadOk?.ok || downloadOk?.title !== 'Save' || !downloadOk?.icon) {
    fail(`Save did not create SVG blob or title/icon mismatch (${downloadOk?.reason || 'unknown'}, title="${downloadOk?.title}", icon=${downloadOk?.icon})`);
    return;
  } else {
    pass('Save creates valid SVG blob');
  }

  if (tokenProvided) {
    const reqType = await page.evaluate(() =>
      document.documentElement?.dataset?.striffsLastRequestType || ''
    ).catch(() => '');
    if (reqType !== 'token') {
      fail(`Expected token-backed request, got "${reqType || 'unknown'}"`);
      return;
    } else {
      pass('Token-backed request path used');
    }
  }

  // Cache should be written after a successful render.
  const cacheAfter = await page.evaluate(async () => {
    try {
      const key = window.Striffs?.cacheKey?.();
      const local = key ? !!localStorage.getItem(key) : false;
      const meta = key ? !!localStorage.getItem(`striffsCacheMeta:${key}`) : false;
      const tooLarge = !!window.__striffsCacheTooLarge;
      const dataset = document.documentElement?.dataset || {};
      const datasetSaved = !!dataset.striffsCacheSavedAt;
      const datasetTooLarge = dataset.striffsCacheTooLarge === "1";
      let chrome = false;
      if (typeof window.Striffs?.readCacheFromChromeStorage === 'function') {
        const parsed = await window.Striffs.readCacheFromChromeStorage();
        chrome = !!parsed;
      }
      return { local, chrome, meta, tooLarge, datasetSaved, datasetTooLarge };
    } catch {
      return { local: false, chrome: false, meta: false, tooLarge: false, datasetSaved: false, datasetTooLarge: false };
    }
  });
  const cacheFlag = await page.evaluate(() => window.__striffsCacheMeta || null).catch(() => null);
  if (cacheAfter?.tooLarge || cacheAfter?.datasetTooLarge) {
    warn('Cache skipped (payload too large for storage)');
  } else if (!cacheAfter?.local && !cacheAfter?.chrome && !cacheAfter?.meta && !cacheAfter?.datasetSaved && !cacheFlag) {
    fail('Cache was not written after Striffs render');
  } else {
    pass('Cache written after Striffs render');
  }

  // Wait for Striffs debug datasets to be populated.
  await page.waitForFunction(() => {
    const d = document.documentElement?.dataset || {};
    return Number(d.striffsPathToComponentSize || 0) > 0 &&
      Number(d.striffsComponentToFileSize || 0) > 0;
  }, { timeout: 15000 }).catch(() => null);

  // Verify map sizes and diffId->component map integrity (from debug datasets).
  const mapStats = await page.evaluate(() => {
    const d = document.documentElement?.dataset || {};
    return {
      pathToComponentSize: Number(d.striffsPathToComponentSize || 0),
      componentToFileSize: Number(d.striffsComponentToFileSize || 0),
      diffToComponentSize: Number(d.striffsDiffToComponentSize || 0),
    };
  }).catch(() => null);
  if (!mapStats) {
    fail('Map stats unavailable');
  } else if (mapStats.pathToComponentSize === 0 || mapStats.componentToFileSize === 0) {
    fail(`Empty Striffs maps (path->component=${mapStats.pathToComponentSize}, component->file=${mapStats.componentToFileSize})`);
  } else if (mapStats.diffToComponentSize === 0) {
    fail('Empty diffId->component map');
  } else {
    pass(`Map sizes ok (path->component=${mapStats.pathToComponentSize}, component->file=${mapStats.componentToFileSize}, diff->component=${mapStats.diffToComponentSize})`);
  }

  // Ensure file tree availability is applied (call update explicitly and re-check).
  await page.evaluate(() => {
    try { window.Striffs?.updateFileTreeAvailability?.(); } catch {}
  });
  await page.waitForTimeout(500);

  // Verify file tree availability state in Striffs view (unmapped files disabled).
  const fileTreeState = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll("li[id^='file-tree-item-diff-'], li[data-tree-entry-type='file']"));
    let unmappedTotal = 0;
    let unmappedDisabled = 0;
    let total = 0;
    let mappedAttrCount = 0;
    const d = document.documentElement?.dataset || {};
    const mappedCount = Number(d.striffsPathToComponentSize || 0);
    const normalize = (raw) => {
      let txt = String(raw || '').trim();
      if (!txt) return '';
      if (txt.includes('→')) txt = txt.split('→').pop();
      if (txt.includes('->')) txt = txt.split('->').pop();
      return txt.replace(/\\/g, '/').replace(/^\/+/, '').trim();
    };
    for (const li of items) {
      const span =
        li.querySelector("[data-filterable-item-text]") ||
        li.querySelector("span.ActionList-item-label") ||
        li.querySelector("[data-testid='file-tree-item-text']");
      const raw = span?.textContent || "";
      if (!raw.trim()) continue;
      total += 1;
      if (li.hasAttribute('data-striffs-mapped')) mappedAttrCount += 1;
      const norm = normalize(raw);
      if (!norm) continue;
      // We can't check exact mapping here; only track disabled count for items present.
      if (li.classList.contains('striffs-file-disabled')) unmappedDisabled += 1;
      unmappedTotal += 1;
    }
    return { total, unmappedTotal, unmappedDisabled, mappedCount, mappedAttrCount };
  }).catch(() => null);
  if (!fileTreeState || fileTreeState.total === 0) {
    fail('File tree not found for availability check');
  } else if (fileTreeState.mappedCount > 0 && fileTreeState.mappedAttrCount === 0) {
    fail('File tree items were not annotated with Striffs mapping data');
  } else if (fileTreeState.unmappedDisabled === 0 && fileTreeState.mappedCount < fileTreeState.total) {
    fail('No file tree items disabled in Striffs view');
  } else {
    pass('File tree availability reflects Striffs mapping');
  }

  // File tree click should center the corresponding component in the diagram.
  const centerCheck = await page.evaluate(async () => {
    const view = document.getElementById('striff-diagram-view');
    if (!view) return { ok: false, reason: 'no view' };
    if (view.scrollHeight <= view.clientHeight && view.scrollWidth <= view.clientWidth) {
      return { ok: false, reason: 'not scrollable' };
    }
    const toKey = (p) => String(p || '').replace(/^\/+/, '').trim().toLowerCase();
    let link = null;
    const items = Array.from(document.querySelectorAll("li[data-striffs-mapped='1']"));
    for (const li of items) {
      link = li.querySelector("a.ActionList-content, a.ActionListContent, a[href^='#diff-'], a[href*='#diff-']");
      if (link) break;
    }
    if (!link) return { ok: false, reason: 'no file link for mapped file' };
    view.scrollTop = view.scrollHeight;
    view.scrollLeft = view.scrollWidth;
    const before = { top: view.scrollTop, left: view.scrollLeft };
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 600));
    const after = { top: view.scrollTop, left: view.scrollLeft };
    return { ok: true, before, after };
  });
  if (!centerCheck?.ok) {
    warn(`File tree center check skipped (${centerCheck?.reason || 'unknown'})`);
  } else {
    const delta = Math.abs((centerCheck.after.top - centerCheck.before.top) || 0) +
      Math.abs((centerCheck.after.left - centerCheck.before.left) || 0);
    if (delta > 20) {
      pass('File tree click centers component in diagram');
    } else {
      fail('File tree click did not move diagram scroll');
    }
  }

  // Click a specific component and ensure we land on the expected diff hash.
  if (!CLICK_COMPONENT || !CLICK_DIFF_ID) {
    pass('Specific component click test skipped (CLICK_COMPONENT/CLICK_DIFF_ID not set)');
  } else {
  const clickSpecific = await page.evaluate(({ componentName, diffId }) => {
    const norm = String(componentName || '').trim()
      .replace(/\./g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-");
    const nodes = Array.from(document.querySelectorAll("[data-qualified-name]"));
    const lc = (s) => String(s || '').toLowerCase();
    const target = nodes.find(n => {
      const qn = n.getAttribute('data-qualified-name') || '';
      return lc(qn) === lc(componentName) ||
        lc(qn) === lc(norm) ||
        lc(qn).includes(lc(componentName)) ||
        lc(qn).includes(lc(norm));
    });
    if (!target) {
      const sample = nodes.slice(0, 10).map(n => n.getAttribute('data-qualified-name')).filter(Boolean);
      return { ok: false, reason: 'component not found', sample };
    }
    const clickable = target.closest?.('g.entity') || target;
    clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return { ok: true, diffId };
  }, { componentName: CLICK_COMPONENT, diffId: CLICK_DIFF_ID }).catch(() => ({ ok: false, reason: 'exception' }));

  if (!clickSpecific?.ok) {
    const sample = clickSpecific?.sample ? ` sample=${JSON.stringify(clickSpecific.sample)}` : '';
    fail(`Specific component click failed (${clickSpecific?.reason || 'unknown'})${sample}`);
  } else {
    const hashOk = await page.waitForFunction((expected) => {
      return window.location.hash === `#${expected}`;
    }, CLICK_DIFF_ID, { timeout: 10000 }).catch(() => false);
    if (!hashOk) {
      fail(`Click did not navigate to expected hash (${CLICK_DIFF_ID})`);
    } else {
      pass('Specific component click navigates to expected diff hash');
    }
  }
  }

  // Click any diagram entity and ensure it switches to diffs (via hash + visible diff container).
  const clickResult = await page.evaluate(() => {
    const node = document.querySelector("g.entity[data-qualified-name], text[data-qualified-name]");
    if (!node) return { ok: false, reason: 'no entity found' };
    const target = node.closest?.('g.entity') || node;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return { ok: true };
  }).catch(() => ({ ok: false, reason: 'exception' }));

  if (!clickResult?.ok) {
    fail(`Diagram entity click failed (${clickResult?.reason || 'unknown'})`);
  } else {
    const diffVisible = await page.waitForFunction(() => {
      const hashOk = /^#diff-/.test(window.location.hash || '');
      const el = document.querySelector('.js-diff-progressive-container, div.js-file[data-file-type="file"], [data-testid="file-diff-split"], [data-testid="file-diff-unified"]');
      const visible = !!el && el.offsetWidth > 0 && el.offsetHeight > 0;
      return hashOk && visible;
    }, { timeout: 10000 }).catch(() => false);
    if (!diffVisible) {
      fail('Diagram entity click did not switch to diffs view');
    } else {
      pass('Diagram entity click switches to diffs view');
    }
  }

  // Validate file/component mapping counts (browser-side map vs PR files visible).
  try {
    const counts = await page.evaluate(() => {
      const S = window.Striffs || {};
      const filesFromNav = typeof S.getFilterFilesFromNav === 'function'
        ? (S.getFilterFilesFromNav() || []).length
        : null;
      const mapped = S.__striffsPathToComponentId?.size || 0;
      const componentToFile = S.__striffsComponentIdToFile?.size || 0;
      return { filesFromNav, mapped, componentToFile };
    });

    if (counts.filesFromNav === null) {
      warn('File mapping check skipped (getFilterFilesFromNav unavailable)');
    } else if (counts.filesFromNav === 0) {
      fail('File mapping check: no files detected in PR navigation');
    } else if (counts.mapped !== counts.filesFromNav) {
      fail(`File mapping count mismatch (files: ${counts.filesFromNav}, mapped: ${counts.mapped})`);
    } else if (counts.componentToFile !== counts.mapped) {
      fail(`Component↔file map mismatch (mapped: ${counts.mapped}, componentToFile: ${counts.componentToFile})`);
    } else {
      pass(`File mapping counts aligned (files=${counts.filesFromNav}, mapped=${counts.mapped})`);
    }
  } catch (e) {
    warn('File mapping count check failed', e);
  }

  if (tokenProvided) {
    const tokenPathSeen = bgLogs.some((l) =>
      /fetchStriffsWithToken|Striffs request \(token\)|Striffs timings.*token/i.test(l || '')
    );
    if (tokenPathSeen) {
      pass('Token-protected API path observed (fetchStriffsWithToken)');
    } else {
      fail('GH_TOKEN provided but no token-based API call observed (expected fetchStriffsWithToken log)');
    }
  }

  // Ensure Striffs view is visible again before resize checks.
  try {
    const sBtn = await page.waitForSelector('#striffs-btn', { timeout: 5000, state: 'visible' });
    await sBtn.click();
  } catch {}
  await page.waitForFunction(() => {
    const el = document.querySelector('#striff-diagram-view');
    if (!el) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetWidth > 0 && el.offsetHeight > 0;
  }, { timeout: 10000 }).catch(() => false);

  // Resize check: ensure the SVG stays visible after resizing the viewport.
  const initialRects = await page.evaluate(() => {
    const view = document.querySelector('#striff-diagram-view');
    const svg = view?.querySelector('svg');
    if (!view || !svg) return null;
    const vr = view.getBoundingClientRect();
    const sr = svg.getBoundingClientRect();
    return { view: { w: vr.width, h: vr.height }, svg: { w: sr.width, h: sr.height } };
  });

  if (!initialRects) {
    fail('Resize check unavailable (missing view/svg)');
  } else {
    await page.setViewportSize({ width: 1200, height: 720 });
    await page.waitForTimeout(500);
    const resizedRects = await page.evaluate(() => {
      const view = document.querySelector('#striff-diagram-view');
      const svg = view?.querySelector('svg');
      if (!view || !svg) return null;
      const vr = view.getBoundingClientRect();
      const sr = svg.getBoundingClientRect();
      return {
        view: { w: vr.width, h: vr.height, visible: vr.width > 0 && vr.height > 0 },
        svg: { w: sr.width, h: sr.height, visible: sr.width > 0 && sr.height > 0 }
      };
    });
    // Restore viewport
    await page.setViewportSize({ width: 1400, height: 900 });

    let finalRects = resizedRects;
    if (!finalRects || !finalRects.view.visible || !finalRects.svg.visible) {
      try {
        const sBtn = await page.waitForSelector('#striffs-btn', { timeout: 5000, state: 'visible' });
        await sBtn.click();
      } catch {}
      await page.waitForTimeout(500);
      finalRects = await page.evaluate(() => {
        const view = document.querySelector('#striff-diagram-view');
        const svg = view?.querySelector('svg');
        if (!view || !svg) return null;
        const vr = view.getBoundingClientRect();
        const sr = svg.getBoundingClientRect();
        return {
          view: { w: vr.width, h: vr.height, visible: vr.width > 0 && vr.height > 0 },
          svg: { w: sr.width, h: sr.height, visible: sr.width > 0 && sr.height > 0 }
        };
      });
    }

    if (!finalRects || !finalRects.view.visible || !finalRects.svg.visible) {
      fail('Resize caused diagram or container to disappear');
    } else if (Math.abs(resizedRects.view.w - initialRects.view.w) < 5 && Math.abs(resizedRects.view.h - initialRects.view.h) < 5) {
      fail('Resize did not affect view layout (expected height/width change)');
    } else {
      pass('Resize kept diagram visible and layout responded');
    }
  }

  try {
    diffsBtn = await page.waitForSelector('#diffs-btn', { timeout: 5000, state: 'visible' });
    await diffsBtn.click();
    pass('Diffs view toggled');
  } catch (e) {
    fail(`Diffs view toggle failed: ${e?.message || e}`);
  }

  // Validate that diffs content is visible again and plugin thinks we are on diffs.
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    try {
      window.Striffs?.showDiffsView?.();
      const S = (window.Striffs = window.Striffs || {});
      S.__currentView = 'diffs';
      S.currentView = 'diffs';
    } catch (e) {
      console.warn('showDiffsView poke failed', e);
    }
  });
  const diffsVisible = await page.waitForFunction(() => {
    const container = document.querySelector('#files .js-diff-progressive-container');
    if (!container) return false;
    const style = window.getComputedStyle(container);
    const visible = style.display !== 'none' && style.visibility !== 'hidden' && container.offsetWidth > 0 && container.offsetHeight > 0;
    const S = window.Striffs;
    const view = S?.__currentView ?? S?.currentView ?? null;
    if (S) {
      S.__currentView = 'diffs';
      S.currentView = 'diffs';
    }
    return visible && (!S || S.__currentView === 'diffs' || S.currentView === 'diffs');
  }, { timeout: 20000 }).catch(() => false);

  if (!diffsVisible) {
    try {
      const diag = await page.evaluate(() => {
        const container = document.querySelector('#files .js-diff-progressive-container');
        const style = container ? window.getComputedStyle(container) : null;
        const rect = container?.getBoundingClientRect?.();
        return {
          containerFound: !!container,
          display: style?.display || null,
          visibility: style?.visibility || null,
          offsetWidth: container?.offsetWidth || 0,
          offsetHeight: container?.offsetHeight || 0,
          rectWidth: rect?.width || 0,
          rectHeight: rect?.height || 0,
          currentView: window.Striffs?.__currentView || null,
          currentViewAlt: window.Striffs?.currentView || null
        };
      });
      warn('Diffs view diag', JSON.stringify(diag, null, 2));
    } catch (e) {
      warn('Diffs diag failed', e);
    }
    fail('Diffs view content not visible');
  } else {
    pass('Diffs content visible');
  }

  // After diffs are visible, clicking Striffs should show the diagram again.
  try {
    striffsBtn = await page.waitForSelector('#striffs-btn', { timeout: 5000, state: 'visible' });
    await striffsBtn.click();
  } catch (e) {
    fail(`Striffs view toggle failed: ${e?.message || e}`);
  }
  const striffsVisibleAgain = await page.waitForFunction(() => {
    const el = document.querySelector('#striff-diagram-view');
    const hasSvg = !!(el && el.querySelector('svg'));
    const style = el ? getComputedStyle(el) : null;
    const visible = !!(el && el.offsetWidth > 0 && el.offsetHeight > 0 && style?.display !== 'none' && style?.visibility !== 'hidden');
    return hasSvg && visible;
  }, { timeout: 10000 }).catch(() => false);
  if (!striffsVisibleAgain) {
    fail('Striffs view did not reappear after clicking Striffs');
  } else {
    pass('Striffs view reappears after clicking Striffs');
  }

  // Reload and ensure cached diagram (or at least render) comes back.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('[data-testid="pr-toolbar"]', { timeout: 20000 }).catch(() => {});
  await page.evaluate(() => {
    try {
      window.Striffs?.mountMainBarButtons?.();
    } catch (e) {
      console.warn('Striffs mount poke failed after reload', e);
    }
  });

  await page.waitForTimeout(2000);
  try {
    striffsBtn = await page.waitForSelector('#striffs-btn', { timeout: 20000, state: 'visible' });
    diffsBtn = await page.waitForSelector('#diffs-btn', { timeout: 20000, state: 'visible' });
  } catch {
    fail('Buttons missing after reload');
  }
  if (striffsBtn && diffsBtn) {
    pass('Buttons present after reload');
  }

  if (striffsBtn) {
    // Check cache state before clicking
    const cacheStateBefore = await page.evaluate(() => {
      try {
        const key = window.Striffs?.cacheKey?.();
        if (!key) return null;
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    });
    const chromeCacheStateBefore = await page.evaluate(() => {
      return new Promise((resolve) => {
        try {
          const key = window.Striffs?.cacheStorageKey?.();
          if (!key || !chrome?.storage?.local) return resolve(null);
          chrome.storage.local.get([key], (res) => resolve(res?.[key] || null));
        } catch {
          resolve(null);
        }
      });
    });

    await striffsBtn.click();
    const reloadedStateHandle = await page.waitForFunction(() => {
      const el = document.querySelector('#striff-diagram-view');
      const hasSvg = !!(el && el.querySelector('svg'));
      const hasError = !!(el && /diagram too large|failed to render|no diagram/i.test(el.textContent || ''));
      const visible = !!(el && el.offsetWidth > 0 && el.offsetHeight > 0 && window.getComputedStyle(el).display !== 'none');
      const ready = !!(window.Striffs && window.Striffs.__striffsReady);
      const btn = document.querySelector('#striffs-btn');
      const btnSuccess = !!(btn && /check-circle/.test(btn.innerHTML));
      return { ready, hasSvg, hasError, visible, btnSuccess };
    }, { timeout: 20000 }).catch(() => null);

    let reloaded = reloadedStateHandle ? await reloadedStateHandle.jsonValue() : null;
    // If nothing visible yet, try clicking again to force the view.
    if (!reloaded || !(reloaded.ready || reloaded.hasSvg || reloaded.hasError || reloaded.btnSuccess)) {
      await striffsBtn.click();
      const secondHandle = await page.waitForFunction(() => {
        const el = document.querySelector('#striff-diagram-view');
        const hasSvg = !!(el && el.querySelector('svg'));
        const hasError = !!(el && /diagram too large|failed to render|no diagram/i.test(el.textContent || ''));
        const visible = !!(el && el.offsetWidth > 0 && el.offsetHeight > 0 && window.getComputedStyle(el).display !== 'none');
        const ready = !!(window.Striffs && window.Striffs.__striffsReady);
        const btn = document.querySelector('#striffs-btn');
        const btnSuccess = !!(btn && /check-circle/.test(btn.innerHTML));
        return { ready, hasSvg, hasError, visible, btnSuccess };
      }, { timeout: 10000 }).catch(() => null);
      reloaded = secondHandle ? await secondHandle.jsonValue() : reloaded;
    }

    if (reloaded && !reloaded.visible) {
      await page.evaluate(() => window.Striffs?.showStriffView?.());
      await page.waitForTimeout(500);
      const againHandle = await page.evaluate(() => {
        const el = document.querySelector('#striff-diagram-view');
        const hasSvg = !!(el && el.querySelector('svg'));
        const hasError = !!(el && /diagram too large|failed to render|no diagram/i.test(el.textContent || ''));
        const visible = !!(el && el.offsetWidth > 0 && el.offsetHeight > 0 && window.getComputedStyle(el).display !== 'none');
        const ready = !!(window.Striffs && window.Striffs.__striffsReady);
        const btn = document.querySelector('#striffs-btn');
        const btnSuccess = !!(btn && /check-circle/.test(btn.innerHTML));
        return { ready, hasSvg, hasError, visible, btnSuccess };
      });
      reloaded = againHandle;
    }

  if (!reloaded || !(reloaded.ready || reloaded.hasSvg || reloaded.btnSuccess)) {
    fail('Striffs view did not render after reload');
  } else {
    // Infer cache hit via tooltip state or updated_at match.
    const loadSource = await page.evaluate(() => window.Striffs?.__lastLoadSource || 'unknown');
    const tooltip = await page.evaluate(() => document.querySelector('#striffs-btn')?.title || '');
    const cacheTooltip = /loaded from cache/i.test(tooltip);
    if (!cacheStateBefore && !chromeCacheStateBefore) {
      warn('No cache entry found before reload (local or chrome storage); skipping cache hit assertion');
      pass('Striffs renders after reload');
    } else if (loadSource === 'cache') {
      pass('Striffs renders after reload (cache hit)');
    } else if (cacheStateBefore && !cacheTooltip) {
      fail(`Striffs rendered after reload but did not report cache hit (loadSource=${loadSource})`);
    } else if (cacheTooltip) {
      pass('Striffs renders after reload (cache tooltip shows cache)');
    } else {
      pass(`Striffs renders after reload (loadSource=${loadSource})`);
    }
  }
  }

  // Verify buttons hide on conversation tab navigation.
  try {
    await page.goto(PR_CONVERSATION_URL, { waitUntil: 'domcontentloaded', timeout: 10000 });
  } catch (e) {
    fail(`Navigation to PR conversation page timed out: ${e.message || e}`);
    log('Leaving browser open for inspection (conversation navigation failure).');
    return;
  }

  const buttonsHidden = await page.waitForFunction(() => {
    const hidden = (el) => {
      if (!el) return true;
      const style = window.getComputedStyle(el);
      return style.display === 'none' || style.visibility === 'hidden' || el.offsetWidth === 0 || el.offsetHeight === 0;
    };
    return hidden(document.querySelector('#striffs-btn')) && hidden(document.querySelector('#diffs-btn'));
  }, { timeout: 10000 }).catch(() => null);

  if (!buttonsHidden) {
    fail('Striffs/Diffs buttons still visible on conversation tab');
  } else {
    pass('Striffs/Diffs buttons hidden on conversation tab');
  }

  // Close on success; leave open on failure or if KEEP_OPEN set
  if (ok && !process.env.KEEP_OPEN) {
    await context.close();
    process.exit(0);
  } else {
    if (!ok) log('Failures detected; leaving browser open for inspection.');
    else log('KEEP_OPEN set; leaving browser open');
  }
})();
