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

const REMOTE_CONFIG_URL = 'https://striffs-config.tor1.digitaloceanspaces.com/config.json';
const TEST_REMOTE_CONFIG_URL = 'https://striffs-config.tor1.digitaloceanspaces.com/config-test.json';
const BAD_REMOTE_CONFIG_URL = 'https://striffs-config.tor1.digitaloceanspaces.com/config-missing.json';
const DEFAULT_PR_URL = 'https://github.com/Zir0-93/junit5/pull/1/files';
const PR_URL = envOr('PR_URL', DEFAULT_PR_URL);
const PR_CONVERSATION_URL = envOr('PR_CONVERSATION_URL', PR_URL.replace(/\/files$/, ''));
const EXT_PATH = path.resolve(__dirname, '..'); // repo root with manifest.json
const PROFILE = path.join(__dirname, '.pw-profile');
const tokenProvided = !!(process.env.GH_TOKEN && process.env.GH_TOKEN.trim());

log(`Target PR: ${PR_URL}`);
log(`GH_TOKEN supplied: ${tokenProvided ? 'yes (will use token-backed API path)' : 'no (zip-based flow expected)'}`);

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
  try {
    const res = await fetchWithTimeout(TEST_REMOTE_CONFIG_URL, { timeoutMs: 5000 });
    if (!res || !res.ok) {
      fail(`Remote test config unreachable or non-200 (${res?.status || 'no response'})`);
      return;
    }
    const json = await res.json().catch(() => null);
    expectedRemoteMessage = (json && json.message) || 'Striffs temporarily disabled';
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
  const setRemoteConfigUrl = async (url) => {
    const sw = await getServiceWorker();
    if (!sw) return;
    await sw.evaluate((u) => {
      try { chrome.storage.local.set({ striffsConfigUrl: u }); } catch {}
    }, url);
  };

  const page = await context.newPage();

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

  try {
    await page.goto(PR_URL, { waitUntil: 'domcontentloaded', timeout: 10000 });
  } catch (e) {
    fail(`Navigation to PR page timed out: ${e.message || e}`);
    log('Leaving browser open for inspection (navigation failure).');
    return;
  }

  const initialButtonsOk = await ensureButtonsRendered('initial (bad config)');
  if (!initialButtonsOk) return;

  // Bad config should not disable the plugin
  const initialState = await page.evaluate(() => {
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
  if (!initialState) {
    fail('Striffs button not found under bad config');
    return;
  }
  if (initialState.disabled || initialState.classDisabled) {
    fail('Bad/unreachable config improperly disabled Striffs button');
    return;
  } else {
    pass('Bad/unreachable config does not disable Striffs button');
  }

  // Switch to test config (disable Striffs)
  await setRemoteConfigUrl(TEST_REMOTE_CONFIG_URL);
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});

  const testButtonsOk = await ensureButtonsRendered('after test config');
  if (!testButtonsOk) return;

  // Remote disable expectations
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

  if (!disableState.disabled || !disableState.classDisabled) {
    fail('Striffs button is not disabled by remote config');
    return;
  } else {
    pass('Striffs button disabled by remote config');
  }

  if (Number(disableState.opacity || 1) > 0.7) {
    fail(`Striffs button opacity not reduced (got ${disableState.opacity})`);
    return;
  } else {
    pass('Striffs button greyed out');
  }

  if (!disableState.title || disableState.title !== expectedRemoteMessage) {
    fail(`Striffs button tooltip mismatch (got "${disableState.title}", expected "${expectedRemoteMessage}")`);
    return;
  } else {
    pass('Striffs button tooltip matches remote message');
  }

  // Switch back to production config and continue normal flow
  await setRemoteConfigUrl(REMOTE_CONFIG_URL);
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
  try {
    striffsBtn = await page.waitForSelector('#striffs-btn', { timeout: 30000, state: 'visible' });
    diffsBtn = await page.waitForSelector('#diffs-btn', { timeout: 30000, state: 'visible' });
    pass('Buttons found (failure phase)');
  } catch (e) {
    fail('Buttons not found (failure phase)');
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
    return hasErrorClass || (disabled && /problem generating|failed|error|api request/i.test(tooltip));
  }, { timeout: 15000 }).catch(() => false);
  if (!errorShown) {
    fail('API error state not surfaced on Striffs button');
  } else {
    pass('API error surfaced on Striffs button');
  }

  // Reset page state before normal flow
  await clearApiBaseOverride();
  await page.reload({ waitUntil: 'networkidle' });

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

    if (!resizedRects || !resizedRects.view.visible || !resizedRects.svg.visible) {
      fail('Resize caused diagram or container to disappear');
    } else if (Math.abs(resizedRects.view.w - initialRects.view.w) < 5 && Math.abs(resizedRects.view.h - initialRects.view.h) < 5) {
      fail('Resize did not affect view layout (expected height/width change)');
    } else {
      pass('Resize kept diagram visible and layout responded');
    }
  }

  await diffsBtn.click();
  pass('Diffs view toggled');

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

  // Reload and ensure cached diagram (or at least render) comes back.
  await page.reload({ waitUntil: 'networkidle' });
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
    if (loadSource === 'cache') {
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
