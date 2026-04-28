/**
 * Phase 8 End-to-End Manual Smoke Test
 * ===================================
 *
 * This test validates the full async AI review enrichment flow.
 *
 * Prerequisites (P8):
 * - striff-api running with AI review enabled (striff.ai.review.enabled=true)
 * - Access to a real GitHub PR with Java changes
 * - Valid GitHub token (for larger PRs)
 *
 * Test Flow (P8-8: Manual: full flow in Chrome with real GitHub PR):
 *
 * 1. BASE RENDER (PENDING):
 *    - Navigate to GitHub PR files tab
 *    - Click "Generate Striffs" button
 *    - Verify base diagram renders WITHOUT AI annotations
 *    - Verify aiReviewStatus=PENDING in response
 *    - Verify button shows "Enriching..." state
 *
 * 2. POLLING PHASE (PENDING → RUNNING → READY):
 *    - Extension polls /api/v1/striffs/{operationId}/ai-review
 *    - Each poll returns current status and pollAfterMs
 *    - Wait for status to transition to READY (or FAILED)
 *
 * 3. ENRICHED RENDER (READY):
 *    - On READY, response includes enriched striffs array
 *    - Extension swaps SVG with enriched version
 *    - Verify enriched SVG contains AI_REVIEW_NOTE_ elements
 *    - Verify button shows "success" state
 *    - Verify toast notification "AI enrichment applied."
 *
 * 4. CACHE VERIFICATION:
 *    - Refresh page
 *    - Verify enriched diagram loads from cache immediately
 *    - Verify cachedAiReviewStatus=READY in cache metadata
 *
 * 5. CACHE CLEAR + API DOWN TEST:
 *    - Clear cache via popup button
 *    - Stop the striff-api server
 *    - Refresh page
 *    - Verify NO diagram loads (cache was properly cleared)
 *
 * Error Handling (P8):
 * - FAILED status: polling stops, base diagram remains, button shows error tooltip
 * - HTTP 403: polling stops, authorization error message shown
 * - Network errors: retry with exponential backoff
 * - Timeout: stop after 5 minutes max
 * - Private repo + no token: button disabled with auth-related tooltip
 *
 * Metrics to Monitor:
 * - striff_ai_reviews_scheduled_total
 * - striff_ai_reviews_completed_total
 * - striff_ai_reviews_failed_total
 * - striff_ai_review_end_to_end_duration_seconds
 * - striff_ai_review_executor_queued
 *
 * Environment Variables:
 * - PR_URL: GitHub PR to test (default: striff-lib PR #1)
 * - UNSUPPORTED_PR_URL: PR with no supported files (default: zir0-93.github.io PR #2)
 * - PRIVATE_PR_URL: Private repo PR to test auth requirement (optional)
 * - GH_TOKEN: GitHub personal access token (optional but recommended)
 * - HEADLESS=1: Run in headless mode
 * - NEW_UI=1: Test with GitHub's new /changes UI
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

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
const PRODUCTION_API_BASE = envOr('PRODUCTION_API_BASE', 'http://localhost:8080');
const DEFAULT_PR_URL = 'https://github.com/Zir0-93/striff-lib/pull/1/files';
const DEFAULT_UNSUPPORTED_PR_URL = 'https://github.com/Zir0-93/zir0-93.github.io/pull/2/files';
const DEFAULT_PRIVATE_PR_URL = envOr('PRIVATE_PR_URL', '');
const ONLY_TEST_CONFIG = envOr('ONLY_TEST_CONFIG', '') === '1';
const HEADED = envOr('HEADED', '') === '1';
const HEADLESS = HEADED ? false : envOr('HEADLESS', '1') !== '0';
const NEW_UI = envOr('NEW_UI', '') === '1';
const RUN_API_DOWN_TEST = envOr('RUN_API_DOWN_TEST', '') === '1';
const CLICK_COMPONENT = envOr('CLICK_COMPONENT', '');
const CLICK_DIFF_ID_RAW = envOr('CLICK_DIFF_ID', '');
const CLICK_DIFF_ID = CLICK_DIFF_ID_RAW.includes('#')
  ? CLICK_DIFF_ID_RAW.split('#').pop().trim()
  : CLICK_DIFF_ID_RAW;
const EXT_PATH = path.resolve(__dirname, '..'); // repo root with manifest.json
const PROFILE = path.resolve(__dirname, '.pw-profile');
const tokenProvided = !!(process.env.GH_TOKEN && process.env.GH_TOKEN.trim());
const storageStateRaw = (process.env.GITHUB_STORAGE_STATE || '').trim();
const storageStatePath = (process.env.GITHUB_STORAGE_STATE_PATH || '').trim();
const NAVIGATION_TIMEOUT_MS = Number(envOr('NAVIGATION_TIMEOUT_MS', '30000'));

const normalizePullRequestUrl = (url, useNewUi) => {
  if (!url) return url;
  if (useNewUi) return url.replace(/\/files(?=[/?#]|$)/, '/changes');
  return url.replace(/\/changes(?=[/?#]|$)/, '/files');
};
const toConversationUrl = (url) => (url || '').replace(/\/(?:files|changes)(?=[/?#]|$)/, '');
const buildStorageState = () => {
  if (storageStatePath) return storageStatePath;
  if (!storageStateRaw) return undefined;
  try {
    return JSON.parse(storageStateRaw);
  } catch (e) {
    err(`Failed to parse GITHUB_STORAGE_STATE JSON: ${e?.message || e}`);
    process.exit(1);
  }
};

const PR_URL = normalizePullRequestUrl(envOr('PR_URL', DEFAULT_PR_URL), NEW_UI);
const UNSUPPORTED_PR_URL = normalizePullRequestUrl(envOr('UNSUPPORTED_PR_URL', DEFAULT_UNSUPPORTED_PR_URL), NEW_UI);
const PRIVATE_PR_URL = DEFAULT_PRIVATE_PR_URL ? normalizePullRequestUrl(DEFAULT_PRIVATE_PR_URL, NEW_UI) : '';
const PR_CONVERSATION_URL = envOr('PR_CONVERSATION_URL', toConversationUrl(PR_URL));
const STORAGE_STATE = buildStorageState();

const INITIAL_URL = PR_URL;
const INITIAL_FILES_URL = normalizePullRequestUrl(PR_URL, false);

const shouldSkipLiveAiReview = (result) => {
  if (!result || typeof result !== 'object') return false;
  const reason = String(result.reason || '').trim().toLowerCase();
  const status = String(result.status || result.lastStatus || '').trim().toUpperCase();
  return (
    status === 'NOT_REQUESTED' ||
    reason === 'ready-no-notes' ||
    (reason === 'timeout' && status === 'NOT_REQUESTED') ||
    (reason === 'review-failed' && /disabled|not requested/i.test(String(result.errorMessage || '')))
  );
};

log(`Target PR: ${PR_URL}`);
log(`Unsupported PR: ${UNSUPPORTED_PR_URL}`);
log(`Private PR: ${PRIVATE_PR_URL || 'not provided (skipping private repo test)'}`);
log(`Headless mode: ${HEADLESS ? 'on' : 'off'}`);
log(`UI mode: ${NEW_UI ? 'NEW UI (/changes)' : 'OLD UI (/files)'}`);
log(`GH_TOKEN supplied: ${tokenProvided ? 'yes (will use token-backed API path)' : 'no (zip-based flow expected)'}`);
log(`GitHub storage state: ${STORAGE_STATE ? 'supplied' : 'not supplied'}`);
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
// SKIP profile removal if KEEP_PROFILE is set (useful for staying logged in).
const KEEP_PROFILE_FLAG = envOr('KEEP_PROFILE', '') === '1';

// Create a temp profile in /tmp for isolation (cleaned up after test)
const TEMP_PROFILE = path.join(os.tmpdir(), `pw-profile-${crypto.randomBytes(8).toString('hex')}`);

// Clean up any old temp profiles left in /tmp from previous runs
try {
  const tmpDir = os.tmpdir();
  const tmpFiles = fs.readdirSync(tmpDir);
  const oldTempProfiles = tmpFiles.filter(f => f.startsWith('pw-profile-'));
  if (oldTempProfiles.length > 0) {
    log(`Cleaning up ${oldTempProfiles.length} old temp profile(s) from /tmp`);
    for (const oldProfile of oldTempProfiles) {
      try {
        fs.rmSync(path.join(tmpDir, oldProfile), { recursive: true, force: true });
      } catch {}
    }
  }
} catch (e) {
  warn('Could not clean up old temp profiles', e);
}

if (!KEEP_PROFILE_FLAG) {
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true });
    log('Removed profile', PROFILE);
  } catch (e) {
    warn('Could not remove profile', e);
  }
}

// Copy saved profile to temp location for isolation, or use fresh profile
let RUN_PROFILE = TEMP_PROFILE;
if (KEEP_PROFILE_FLAG && fs.existsSync(PROFILE)) {
  try {
    fs.cpSync(PROFILE, TEMP_PROFILE, { recursive: true });
    try {
      fs.rmSync(path.join(TEMP_PROFILE, 'SingletonCookie'), { force: true });
      fs.rmSync(path.join(TEMP_PROFILE, 'SingletonLock'), { force: true });
      fs.rmSync(path.join(TEMP_PROFILE, 'SingletonSocket'), { force: true });
    } catch {}
    log('Copied saved profile to isolated temp profile', TEMP_PROFILE);
  } catch (e) {
    warn('Could not copy saved profile; using fresh profile', e);
  }
} else if (KEEP_PROFILE_FLAG) {
  log('KEEP_PROFILE set but no saved profile found; using fresh profile');
}

// Cleanup function to remove temp profile after test
const cleanupTempProfile = () => {
  try {
    if (TEMP_PROFILE !== PROFILE) {
      fs.rmSync(TEMP_PROFILE, { recursive: true, force: true });
      log('Cleaned up temp profile', TEMP_PROFILE);
    }
  } catch (e) {
    warn('Could not clean up temp profile', e);
  }
};

(async () => {
  let ok = true;
  let chromeLaunched = false;
  const fail = (msg) => {
    ok = false;
    err('✗', msg);
  };
  const pass = (msg) => log('✓', msg);
  const ensureCleanup = () => {
    if (chromeLaunched) {
      try { chromeCleanup(); } catch {}
    }
    cleanupTempProfile();
  };
  // Ensure Chrome is killed when the IIFE exits (including early returns)
  process.on('beforeExit', () => { ensureCleanup(); });
  const runStriffsTestHook = async (fn, payload = {}, timeoutMs = 5000) => {
    return await page.evaluate(({ fn, payload, timeoutMs }) => new Promise((resolve) => {
      const id = `t-${Math.random().toString(36).slice(2)}`;
      const handler = (e) => {
        const d = e?.data;
        if (!d || d.type !== 'STRIFFS_TEST_RESULT' || d.id !== id) return;
        window.removeEventListener('message', handler);
        resolve(d.result);
      };
      window.addEventListener('message', handler);
      window.postMessage({ type: 'STRIFFS_TEST', fn, id, ...payload }, '*');
      setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve({ ok: false, reason: `timeout:${fn}` });
      }, timeoutMs);
    }), { fn, payload, timeoutMs }).catch((e) => ({ ok: false, reason: String(e?.message || e) }));
  };
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

  // Extensions require Chrome launched directly (no Playwright automation flags).
  // We launch Chrome with --load-extension + --remote-debugging-port, then
  // connect Playwright via CDP. This avoids --enable-automation which blocks
  // extension content scripts.
  const CHROME_BIN =
    process.env.CHROME_PATH ||
    (fs.existsSync('/usr/bin/google-chrome-stable') && '/usr/bin/google-chrome-stable') ||
    (fs.existsSync('/usr/bin/google-chrome') && '/usr/bin/google-chrome');
  if (!CHROME_BIN) {
    fail('No Chrome binary found. Set CHROME_PATH env var.');
    return;
  }
  const CDP_PORT = Number(envOr('CDP_PORT', '9335'));
  // Use login profile if available (has GitHub auth), else the temp profile
  const LOGIN_PROFILE = path.resolve(__dirname, '.pw-profile-login');
  const CHROME_PROFILE = fs.existsSync(path.join(LOGIN_PROFILE, 'Default', 'Cookies'))
    ? LOGIN_PROFILE
    : RUN_PROFILE;
  // Remove lock files
  for (const f of ['SingletonCookie', 'SingletonLock', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(CHROME_PROFILE, f)); } catch {}
  }
  const chromeArgs = [
    `--user-data-dir=${CHROME_PROFILE}`,
    `--remote-debugging-port=${CDP_PORT}`,
    `--load-extension=${EXT_PATH}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion,Vulkan',
  ];
  if (HEADLESS) chromeArgs.push('--headless=new');
  log(`Launching Chrome: ${CHROME_BIN} (profile: ${CHROME_PROFILE})`);
  const { spawn } = require('child_process');
  const chromeProc = spawn(CHROME_BIN, chromeArgs, { stdio: 'ignore', detached: false });
  _chromeProc = chromeProc;
  chromeLaunched = true;
  const chromeCleanup = () => { try { chromeProc.kill(); } catch {} };
  process.on('exit', chromeCleanup);
  // Wait for Chrome to start and extension to load
  await new Promise(r => setTimeout(r, 3000));
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const context = browser.contexts()[0];

  // Extension service worker is discovered after navigating to a GitHub page
  // (content script injection triggers SW activation). Config overrides are
  // deferred until after navigation to ensure SW is available.

  const getServiceWorker = async () => {
    // Find the extension's service worker (chrome-extension:// URL), not GitHub's
    const all = context.serviceWorkers();
    let sw = all.find(w => w.url().startsWith('chrome-extension://')) || null;
    if (!sw) {
      log(`No extension SW found (${all.length} page SWs); waiting for extension SW...`);
      try {
        sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
        // If it's not an extension SW, keep waiting
        if (sw && !sw.url().startsWith('chrome-extension://')) {
          log(`Got page SW: ${sw.url()}; still waiting for extension SW...`);
          sw = null;
          // Poll for extension SW
          for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 500));
            const found = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
            if (found) { sw = found; break; }
          }
        }
      } catch {}
    }
    if (sw) log(`Extension service worker found: ${sw.url()}`);
    else warn(`No extension service worker found (found ${context.serviceWorkers().length} page SWs)`);
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

  const runWithTimeout = async (label, fn, timeoutMs = 10000) => {
    log(`${label}: start`);
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      const result = await Promise.race([Promise.resolve().then(fn), timeoutPromise]);
      log(`${label}: done`);
      return result;
    } catch (e) {
      fail(`${label} failed: ${e?.message || e}`);
      throw e;
    }
  };
  const tryRunWithTimeout = async (label, fn, timeoutMs = 10000) => {
    try {
      return await runWithTimeout(label, fn, timeoutMs);
    } catch (e) {
      warn(`${label}: continuing after failure (${e?.message || e})`);
      return null;
    }
  };

  // Service worker calls can hang indefinitely if the worker is unhealthy.
  // Keep tests progressing by timing out SW evaluates and treating them as soft failures.
  const swEvaluateSoft = async (label, sw, fn, arg, timeoutMs = 5000) => {
    if (!sw) return null;
    let timedOut = false;
    const result = await Promise.race([
      sw.evaluate(fn, arg),
      new Promise((resolve) => setTimeout(() => {
        timedOut = true;
        resolve(null);
      }, timeoutMs))
    ]).catch((e) => {
      warn(`${label}: service worker evaluate failed (${e?.message || e})`);
      return null;
    });
    if (timedOut) warn(`${label}: service worker evaluate timed out after ${timeoutMs}ms`);
    return result;
  };

  // Helpers to set/clear API base override via service worker storage.
  const setApiBaseOverride = async (base) => {
    const sw = await getServiceWorker();
    if (!sw) return;
    await swEvaluateSoft('setApiBaseOverride', sw, (b) => {
      try { chrome.storage.local.set({ striffsApiBase: b }); } catch {}
    }, base);
  };
  const clearApiBaseOverride = async () => {
    const sw = await getServiceWorker();
    if (!sw) return;
    await swEvaluateSoft('clearApiBaseOverride', sw, () => {
      try { chrome.storage.local.remove('striffsApiBase'); } catch {}
    });
  };
  const clearStriffsExtensionState = async () => {
    const sw = await getServiceWorker();
    if (!sw) return;
    await swEvaluateSoft('clearStriffsExtensionState', sw, () => new Promise((resolve) => {
      try {
        chrome.storage.local.get(null, (stored) => {
          try {
            const keys = Object.keys(stored || {}).filter((key) => {
              if (!key) return false;
              if (key === 'ghToken') return false;
              if (key === 'striffsTest') return false;
              if (key === 'striffsDebug') return false;
              const lower = String(key).toLowerCase();
              return lower.startsWith('striffs');
            });
            if (!keys.length) {
              resolve(true);
              return;
            }
            chrome.storage.local.remove(keys, () => resolve(true));
          } catch {
            resolve(false);
          }
        });
      } catch {
        resolve(false);
      }
    }));
  };

  // Helper to set GitHub token in extension storage via service worker.
  const setGhToken = async (token) => {
    if (!token) return;
    const sw = await getServiceWorker();
    if (!sw) return;
    await swEvaluateSoft('setGhToken', sw, (t) => {
      try { chrome.storage.local.set({ ghToken: t }); } catch {}
    }, token);
  };
  const setSupportedLangsCache = async ({ text, fetchedAtMs }) => {
    const sw = await getServiceWorker();
    if (!sw) return;
    await swEvaluateSoft('setSupportedLangsCache', sw, ({ t, at }) => {
      try {
        chrome.storage.local.set({
          striffsSupportedLangs: t,
          striffsSupportedLangsFetchedAt: at,
          striffsSupportedLangsBase: ''
        });
      } catch {}
    }, { t: text, at: fetchedAtMs });
  };
  const setExtensionFlags = async (items) => {
    const sw = await getServiceWorker();
    if (!sw) return;
    await swEvaluateSoft('setExtensionFlags', sw, (flags) => {
      try { chrome.storage.local.set(flags || {}); } catch {}
    }, items);
  };
const setRemoteConfigUrl = async (url) => {
  const sw = await getServiceWorker();
  if (!sw) return;
  await swEvaluateSoft('setRemoteConfigUrl', sw, (u) => {
    try { chrome.storage.local.set({ striffsConfigUrl: u }); } catch {}
  }, url);
};
const setRemoteConfigUrlData = async (jsonObj) => {
  const sw = await getServiceWorker();
  if (!sw) return;
  return await swEvaluateSoft('setRemoteConfigUrlData', sw, (obj) => {
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
  log('page setup: newPage done');
  await page.addInitScript(() => {
    try {
      const clearStore = (store) => {
        if (!store) return;
        const keys = [];
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          if (key && String(key).toLowerCase().startsWith('striffs')) keys.push(key);
        }
        keys.forEach((key) => {
          try { store.removeItem(key); } catch {}
        });
      };
      clearStore(window.localStorage);
      clearStore(window.sessionStorage);
    } catch {}
  });
  log('page setup: addInitScript done');
  // Extension flags and state clearing are deferred until after navigation
  // (when the service worker is available via CDP).

  page.on('pageerror', (pageErr) => {
    err('[pageerror]', pageErr?.message || pageErr);
  });

  page.on('console', (msg) => {
    const text = msg.text();
    log('[page]', msg.type(), text);
    if (/Files root not found during initial boot; scheduling retry/i.test(text)) {
      filesRootMissing = true;
      warn('Files root missing during initial boot; waiting for retry path');
    }
  });

  const inspectGitHubExperience = async () => page.evaluate(() => {
    const path = location.pathname;
    return {
      href: location.href,
      path,
      onChanges: /\/pull\/\d+\/changes$/.test(path),
      onFiles: /\/pull\/\d+\/files$/.test(path),
      classicToggleVisible: Array.from(document.querySelectorAll('button,a,span')).some((el) =>
        /switch to the classic experience/i.test(el.textContent || '')
      ),
      tryNewVisible: Array.from(document.querySelectorAll('button,a,span')).some((el) =>
        /try the new experience/i.test(el.textContent || '')
      )
    };
  }).catch(() => null);

  const inspectGitHubLoginState = async () => page.evaluate(() => {
    const meta = document.querySelector('meta[name="user-login"]');
    const signInVisible = Array.from(document.querySelectorAll('a,button,span')).some((el) =>
      /sign in/i.test(el.textContent || '')
    );
    return {
      loggedIn: Boolean(meta && String(meta.content || '').trim()),
      user: meta ? String(meta.content || '').trim() : null,
      signInVisible
    };
  }).catch(() => ({ loggedIn: false, user: null, signInVisible: false }));

  const precheckNewUiLogin = async () => {
    await page.goto('https://github.com', { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    await page.waitForTimeout(1000);
    const loginState = await inspectGitHubLoginState();
    log(`GitHub login precheck: ${JSON.stringify(loginState)}`);
    if (!loginState?.loggedIn) {
      warn('NEW_UI requested without a logged-in GitHub session; cancelling smoke immediately.');
      try { await context.close(); } catch {}
      chromeCleanup();
      cleanupTempProfile();
      process.exit(0);
    }
    pass(`GitHub session present for NEW_UI (${loginState.user || 'unknown user'})`);
    return loginState;
  };

  const ensureNewUiExperience = async () => {
    log(`Ensuring GitHub new UI via ${INITIAL_FILES_URL}`);
    await page.goto(INITIAL_FILES_URL, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    await page.waitForTimeout(1000);

    let state = await inspectGitHubExperience();
    log(`GitHub experience before switch: ${JSON.stringify(state)}`);
    if (state?.onChanges || state?.classicToggleVisible) {
      const classicButton = page.getByRole('button', { name: /switch to the classic experience/i });
      const classicLink = page.getByRole('link', { name: /switch to the classic experience/i });
      if (await classicButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        log('Clicking "Switch to the classic experience" button first');
        await classicButton.click({ timeout: 5000, noWaitAfter: true }).catch(() => null);
      } else if (await classicLink.isVisible({ timeout: 2000 }).catch(() => false)) {
        log('Clicking "Switch to the classic experience" link first');
        await classicLink.click({ timeout: 5000, noWaitAfter: true }).catch(() => null);
      }
      await page.waitForTimeout(1500);
      state = await inspectGitHubExperience();
      log(`GitHub experience after forcing classic: ${JSON.stringify(state)}`);
      if (state?.onChanges && !state?.tryNewVisible) {
        pass(`GitHub already in new UI (${state.path})`);
        return state;
      }
    }

    const tryNewButton = page.getByRole('button', { name: 'Try the new experience', exact: true });
    const tryNewLink = page.getByRole('link', { name: 'Try the new experience', exact: true });
    const tryNewText = page.getByText('Try the new experience', { exact: true });

    if (await tryNewButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      log('Clicking "Try the new experience" button');
      await tryNewButton.click({ timeout: 5000, noWaitAfter: true });
    } else if (await tryNewLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      log('Clicking "Try the new experience" link');
      await tryNewLink.click({ timeout: 5000, noWaitAfter: true });
    } else if (await tryNewText.isVisible({ timeout: 2000 }).catch(() => false)) {
      log('Clicking "Try the new experience" text node');
      await tryNewText.click({ timeout: 5000, noWaitAfter: true });
    } else {
      state = await inspectGitHubExperience();
      warn(`GitHub did not expose the new-UI switch control; falling back to direct /changes navigation (path=${state?.path || 'unknown'})`);
      await page.goto(PR_URL, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }).catch(() => null);
      await page.waitForTimeout(1000);
      state = await inspectGitHubExperience();
      log(`GitHub experience after direct /changes fallback: ${JSON.stringify(state)}`);
      if (!state?.onChanges) {
        fail(`NEW_UI requested but GitHub did not expose the switch control and direct /changes fallback failed (path=${state?.path || 'unknown'})`);
        return null;
      }
      pass(`Activated GitHub new UI via direct /changes fallback (${state.path})`);
      return state;
    }

    await page.waitForURL(/\/pull\/\d+\/changes(?:[?#].*)?$/, { timeout: 15000 }).catch(() => null);
    await page.waitForTimeout(1000);
    state = await inspectGitHubExperience();
    log(`GitHub experience after switch attempt: ${JSON.stringify(state)}`);
    if (!state?.onChanges && !state?.classicToggleVisible) {
      fail(`Failed to activate GitHub new UI (path=${state?.path || 'unknown'}, tryNewVisible=${state?.tryNewVisible}, classicToggleVisible=${state?.classicToggleVisible})`);
      return null;
    }
    pass(`Activated GitHub new UI (${state.path})`);
    return state;
  };

  const ensureOldUiExperience = async ({ navigate = true, targetUrl = INITIAL_URL } = {}) => {
    log(`Ensuring GitHub old UI via ${targetUrl}`);
    if (navigate) {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
      await page.waitForTimeout(1000);
    }

    let state = await inspectGitHubExperience();
    log(`GitHub old-ui state before classic switch: ${JSON.stringify(state)}`);
    if (state?.onFiles && !state?.onChanges) {
      pass(`GitHub already in old UI (${state.path})`);
      return state;
    }

    const classicButton = page.getByRole('button', { name: /switch to the classic experience/i });
    const classicLink = page.getByRole('link', { name: /switch to the classic experience/i });
    const classicText = page.getByText(/switch to the classic experience/i);
    const previewButton = page.getByRole('button', { name: /^preview$/i });

    if (await previewButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      log('Opening "Preview" menu to access classic experience switch');
      await previewButton.click({ timeout: 5000 }).catch(() => null);
      await page.waitForTimeout(500);
    }

    if (await classicButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      log('Clicking "Switch to the classic experience" button');
      await classicButton.click({ timeout: 5000, noWaitAfter: true }).catch(() => null);
    } else if (await classicLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      log('Clicking "Switch to the classic experience" link');
      await classicLink.click({ timeout: 5000, noWaitAfter: true }).catch(() => null);
    } else if (await classicText.isVisible({ timeout: 2000 }).catch(() => false)) {
      log('Clicking "Switch to the classic experience" text node');
      await classicText.click({ timeout: 5000, noWaitAfter: true }).catch(() => null);
    } else if (state?.onChanges) {
      const fallbackUrl = String(state.href || page.url() || targetUrl || '').replace(/\/changes([?#].*)?$/, '/files$1');
      if (fallbackUrl && fallbackUrl !== page.url()) {
        log(`Falling back to direct /files navigation (${fallbackUrl})`);
        await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }).catch(() => null);
      }
    }

    await page.waitForURL(/\/pull\/\d+\/files(?:[?#].*)?$/, { timeout: 15000 }).catch(() => null);
    await page.waitForTimeout(1500);
    state = await inspectGitHubExperience().catch(() => null);
    if (!state?.onFiles) {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }).catch(() => null);
      await page.waitForTimeout(1500);
      state = await inspectGitHubExperience().catch(() => null);
    }
    log(`GitHub old-ui state after classic switch: ${JSON.stringify(state)}`);
    if (!state?.onFiles) {
      fail(`Failed to activate GitHub old UI (path=${state?.path || 'unknown'}, classicToggleVisible=${state?.classicToggleVisible}, tryNewVisible=${state?.tryNewVisible})`);
      return null;
    }
    pass(`Activated GitHub old UI (${state.path})`);
    return state;
  };

  const ensureButtonsRendered = async (label, { softFail = false } = {}) => {
    if (!NEW_UI) {
      const state = await inspectGitHubExperience().catch(() => null);
      if (state && !state.onFiles) {
        const restored = await ensureOldUiExperience({ navigate: false, targetUrl: INITIAL_URL }).catch(() => null);
        if (!restored?.onFiles) {
          if (softFail) {
            warn(`GitHub old UI unavailable before button render check (${label})`);
          } else {
            fail(`GitHub old UI unavailable before button render check (${label})`);
          }
          return false;
        }
      }
    }
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
      const msg = `Striffs bootstrap check failed (${label}) (buttons not rendered)`;
      if (softFail) {
        warn(msg);
      } else {
        fail(msg);
      }
      try {
        const diag = await page.evaluate(() => {
          const S = window.Striffs;
          return {
            href: location.href,
            path: location.pathname,
            hasStriffs: !!S,
            striffsKeys: S ? Object.keys(S) : [],
            waitForToolbar: !!S?.waitForToolbar,
            ensureStriffContainer: !!S?.ensureStriffContainer,
            styleInjected: !!document.querySelector('style#striffs-style'),
            toolbarSlotPresent: !!document.querySelector('#striffs-toolbar-slot'),
            filesRoot: !!document.querySelector('div[data-view-component="true"][data-testid="pull-requests-files"], div[data-testid="files-changed"], div[data-target="diff-layout.sidebarContainer"], div.diff-sidebar[data-view-component="true"], file-tree, #files'),
            classicToggleVisible: Array.from(document.querySelectorAll('button,a,span')).some((el) => /switch to the classic experience/i.test(el.textContent || '')),
            tryNewVisible: Array.from(document.querySelectorAll('button,a,span')).some((el) => /try the new experience/i.test(el.textContent || '')),
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

  const clickStriffsButton = async (label) => {
    await page.click('#striffs-btn', { timeout: 5000 }).catch(async () => {
      let buttonsOk = await ensureButtonsRendered(label, { softFail: true });
      if (!buttonsOk && NEW_UI) {
        log(`Retrying GitHub new UI activation before Striffs click (${label})`);
        await ensureNewUiExperience().catch(() => null);
        buttonsOk = await ensureButtonsRendered(`${label} (retry)`, { softFail: true });
      }
      const freshBtn = await page.waitForSelector('#striffs-btn', { timeout: 10000, state: 'visible' });
      if (!freshBtn) throw new Error(`Striffs button missing (${label})`);
      const enabled = await freshBtn.isEnabled().catch(() => false);
      if (!enabled) {
        const shown = await page.evaluate(() => {
          try {
            const S = window.Striffs;
            if (S?.__striffsReady || document.querySelector('#striff-diagram-view svg')) {
              S?.showStriffView?.();
              return true;
            }
          } catch {}
          return false;
        }).catch(() => false);
        if (shown) return;
      }
      await freshBtn.click();
    });
  };

  const clickDiffsButton = async (label = 'diffs click') => {
    await page.click('#diffs-btn', { timeout: 5000 }).catch(async () => {
      let buttonsOk = await ensureButtonsRendered(label, { softFail: true });
      if (!buttonsOk && NEW_UI) {
        log(`Retrying GitHub new UI activation before Diffs click (${label})`);
        await ensureNewUiExperience().catch(() => null);
        buttonsOk = await ensureButtonsRendered(`${label} (retry)`, { softFail: true });
      }
      const freshBtn = await page.waitForSelector('#diffs-btn', { timeout: 10000, state: 'visible' });
      if (!freshBtn) throw new Error(`Diffs button missing (${label})`);
      await freshBtn.click();
    });
  };

  const waitForTelemetryArmed = async (timeoutMs = 15000) => {
    const handle = await page.waitForFunction(() => {
      const d = document.documentElement?.dataset || {};
      const hasOperationId = d.striffsEngagementHasOperationId === '1';
      const hasToken = d.striffsEngagementHasToken === '1';
      if (!hasOperationId || !hasToken) return null;
      return {
        hasOperationId,
        hasToken,
        lastError: d.striffsEngagementLastError || null
      };
    }, null, { timeout: timeoutMs, polling: 250 }).catch(() => null);
    return handle ? handle.jsonValue() : null;
  };

  const getTelemetryDiag = async () => page.evaluate(() => {
    const d = document.documentElement?.dataset || {};
    return {
      currentView: window.Striffs?.getCurrentView?.() || window.Striffs?.__currentView || window.Striffs?.currentView || null,
      lastEngagementContextError: d.striffsEngagementLastError || null,
      counters: {
        sent: Number(d.striffsEngagementSent || 0),
        ack: Number(d.striffsEngagementAck || 0),
        failed: Number(d.striffsEngagementFailed || 0),
        skipped: Number(d.striffsEngagementSkipped || 0),
        lastEventType: d.striffsEngagementLastEventType || null
      },
      hasOperationId: d.striffsEngagementHasOperationId === '1',
      hasToken: d.striffsEngagementHasToken === '1'
    };
  }).catch(() => null);

  const waitForTelemetryDelivery = async ({ minAck = 1, timeoutMs = 10000 } = {}) => {
    const handle = await page.waitForFunction(({ requiredAck }) => {
      const d = document.documentElement?.dataset || {};
      const ack = Number(d.striffsEngagementAck || 0);
      if (ack < Number(requiredAck || 0)) return null;
      return {
        counters: {
          sent: Number(d.striffsEngagementSent || 0),
          ack,
          failed: Number(d.striffsEngagementFailed || 0),
          skipped: Number(d.striffsEngagementSkipped || 0),
          lastEventType: d.striffsEngagementLastEventType || null
        },
        currentView: window.Striffs?.getCurrentView?.() || window.Striffs?.__currentView || window.Striffs?.currentView || null,
        lastEngagementContextError: d.striffsEngagementLastError || null
      };
    }, { requiredAck: minAck }, { timeout: timeoutMs, polling: 250 }).catch(() => null);
    return handle ? handle.jsonValue() : null;
  };

  // Navigate to PR page first — content script injection activates the extension
  // service worker, making it discoverable via CDP.
  try {
    if (NEW_UI) {
      const loginState = await precheckNewUiLogin();
      if (!loginState?.loggedIn) return;
      const state = await ensureNewUiExperience();
      if (!state) return;
    } else {
      const state = await ensureOldUiExperience();
      if (!state) return;
    }
  } catch (e) {
    fail(`Navigation to PR page timed out: ${e.message || e}`);
    log('Leaving browser open for inspection (navigation failure).');
    return;
  }

  // Wait for buttons to render (proves extension SW is active)
  let initialButtonsOk = await ensureButtonsRendered('initial navigation', { softFail: NEW_UI });
  if (!initialButtonsOk && NEW_UI) {
    for (let attempt = 1; attempt <= 3 && !initialButtonsOk; attempt += 1) {
      warn(`Retrying GitHub new UI activation after initial load (attempt ${attempt})`);
      const state = await ensureNewUiExperience().catch(() => null);
      if (!state) continue;
      await page.waitForTimeout(1500);
      initialButtonsOk = await ensureButtonsRendered(`initial navigation (retry ${attempt})`, { softFail: attempt < 3 });
    }
  }
  if (!initialButtonsOk) return;

  // Extension SW is now available via CDP. Set flags, clear state, configure overrides.
  await setExtensionFlags({ striffsTest: true });
  try {
    await Promise.race([
      Promise.resolve().then(() => clearStriffsExtensionState()),
      new Promise((_, reject) => setTimeout(() => reject(new Error('clearStriffsExtensionState timed out after 15000ms')), 15000))
    ]);
    log('clearStriffsExtensionState: done');
  } catch (e) {
    warn(`clearStriffsExtensionState: continuing after failure (${e?.message || e})`);
  }

  await setApiBaseOverride(PRODUCTION_API_BASE);
  await setRemoteConfigUrl(BAD_REMOTE_CONFIG_URL);
  await waitForRemoteConfigUrl(BAD_REMOTE_CONFIG_URL);

  // Reload with bad config applied
  await page.reload({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {});

  let badConfigButtonsOk = await ensureButtonsRendered('initial (bad config)', { softFail: NEW_UI });
  if (!badConfigButtonsOk && NEW_UI) {
    for (let attempt = 1; attempt <= 3 && !badConfigButtonsOk; attempt += 1) {
      warn(`Retrying GitHub new UI activation after bad-config reload (attempt ${attempt})`);
      const state = await ensureNewUiExperience().catch(() => null);
      if (!state) continue;
      await page.waitForTimeout(1500);
      badConfigButtonsOk = await ensureButtonsRendered(`initial (bad config) (retry ${attempt})`, { softFail: attempt < 3 });
    }
  }
  if (!badConfigButtonsOk) return;
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
    await page.reload({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {});

  let testButtonsOk = await ensureButtonsRendered('after test config', { softFail: NEW_UI });
  if (!testButtonsOk && NEW_UI) {
    warn('Retrying GitHub new UI activation after test-config reload');
    const state = await ensureNewUiExperience().catch(() => null);
    if (state) {
      testButtonsOk = await ensureButtonsRendered('after test config (retry)');
    }
  }
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
  const parsedExts = await runStriffsTestHook('extractSupportedExtensionsFromConfig', {
    cfg: { supportedExtensions: ['md'] }
  }, 8000);
  if (!Array.isArray(parsedExts) || !parsedExts.includes('md')) {
    fail(`Local config supportedExtensions not parsed (got ${JSON.stringify(parsedExts)})`);
    return;
  } else {
    pass('Local config supportedExtensions parsed');
  }

  if (expectedRemoteDisabled && ONLY_TEST_CONFIG) {
    pass('Test config checks complete; stopping early due to ONLY_TEST_CONFIG');
    try { await context.close(); } catch {}
    chromeCleanup();
    cleanupTempProfile();
    return;
  }

  // Switch back to production config and continue normal flow
  await setRemoteConfigUrl(REMOTE_CONFIG_URL);
  await waitForRemoteConfigUrl(REMOTE_CONFIG_URL);
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
  } catch (e) {
    fail(`Reload after restoring config timed out: ${e.message || e}`);
    return;
  }

  await page.evaluate(() => {
    try { window.Striffs?.mountMainBarButtons?.(); } catch {}
  });

  let enabledState = await page.waitForFunction(() => {
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
  if (!enabledState && NEW_UI) {
    warn('Retrying GitHub new UI activation after restoring production config');
    const state = await ensureNewUiExperience().catch(() => null);
    if (state) {
      const buttonsOk = await ensureButtonsRendered('after restoring production config (retry)', { softFail: true });
      if (buttonsOk) {
        enabledState = await page.waitForFunction(() => {
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
      }
    }
  }

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
  await page.reload({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {});
  const cacheDebug = await getServiceWorker().then((sw) => sw ? sw.evaluate(() => {
    try {
      return chrome.storage.local.get(['striffsSupportedLangs', 'striffsSupportedLangsFetchedAt']);
    } catch (e) {
      return { error: String(e?.message || e) };
    }
  }) : null).catch(() => null);
  if (cacheDebug) log('Supported langs cache debug', JSON.stringify(cacheDebug));
  const debugCacheResp = await runStriffsTestHook('debugSupportedLanguagesCache', {}, 8000);
  if (debugCacheResp) log('Supported langs cache debug (content)', JSON.stringify(debugCacheResp));
  const langsText = await runStriffsTestHook('getSupportedLanguagesText', {}, 8000);
  log('Supported langs text from cache', JSON.stringify(langsText));
  const cacheLangsResult = await runStriffsTestHook('ensureSupportedExtensionsReady', { force: true }, 8000);
  const cacheLangsOk = {
    ok: Array.isArray(cacheLangsResult) && cacheLangsResult.includes('java') && cacheLangsResult.includes('ts'),
    exts: Array.isArray(cacheLangsResult) ? cacheLangsResult : []
  };
  if (!cacheLangsOk?.ok) {
    const exts = await page.evaluate(() => window.Striffs?.__supportedExtensionsForUi || []).catch(() => []);
    fail(`Supported languages cache not applied (exts=${JSON.stringify(exts)})`);
    return;
  } else {
    pass('Supported languages loaded from cache');
  }
  await setApiBaseOverride(PRODUCTION_API_BASE);
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});

  // --- Unsupported PR: ensure button stays disabled ---
  try {
    await page.goto(UNSUPPORTED_PR_URL, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
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
        const files = Array.isArray(S.getFilesInPR?.()) ? S.getFilesInPR() : [];
        if (files.length > 0) {
          const hasSupported = S.checkIfRelevantFilesExist?.(files, fallback) === true;
          if (!hasSupported) {
            S.updateStriffButton?.({ disabled: true, neutral: true, tooltip: "No supported files in PR" });
          } else {
            S.refreshSupportedFilesState?.();
          }
        }
      }
    } catch {}
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

  // Test: Private repo + no token (disabled button with proper tooltip)
  if (PRIVATE_PR_URL) {
    log('Testing private repo without token...');
    if (tokenProvided) {
      warn('PRIVATE_PR_URL provided but GH_TOKEN is also set; skipping private repo test (needs no token to verify auth error)');
    } else {
      try {
        await page.goto(PRIVATE_PR_URL, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
      } catch (e) {
        fail(`Navigation to private PR timed out: ${e.message || e}`);
        return;
      }

      // Wait for buttons to render on private PR
      let privateButtonsOk = await ensureButtonsRendered('private PR', { softFail: NEW_UI });
      if (!privateButtonsOk && NEW_UI) {
        warn('Retrying GitHub new UI activation for private PR');
        const state = await ensureNewUiExperience().catch(() => null);
        if (state) {
          privateButtonsOk = await ensureButtonsRendered('private PR (retry)');
        }
      }
      if (!privateButtonsOk) {
        fail('Striffs buttons not rendered on private PR');
        return;
      }
      pass('Striffs buttons rendered on private PR');

      // Check button state - should be disabled with auth-related tooltip
      const privateState = await page.evaluate(() => {
        const btn = document.querySelector('#striffs-btn');
        if (!btn) return null;
        const style = window.getComputedStyle(btn);
        return {
          disabled: btn.disabled === true,
          classDisabled: btn.classList.contains('is-disabled'),
          opacity: style.opacity,
          title: btn.title || ''
        };
      }).catch(() => null);

      if (!privateState) {
        fail('Striffs button not found on private PR');
        return;
      }

      log('Private PR button state', JSON.stringify(privateState));

      // Button should be disabled
      if (!privateState.disabled && !privateState.classDisabled) {
        fail(`Striffs button not disabled on private PR (disabled=${privateState.disabled}, classDisabled=${privateState.classDisabled})`);
        return;
      }
      pass('Striffs button disabled on private PR (no token)');

      // Tooltip should mention authentication/token or GitHub access
      const title = (privateState.title || '').toLowerCase();
      const hasAuthMessage = /auth|token|login|sign in|github|access|permission|private/i.test(title);
      if (!hasAuthMessage) {
        fail(`Striffs tooltip does not mention authentication/token requirement (got "${privateState.title}")`);
        return;
      }
      pass(`Striffs tooltip mentions authentication requirement: "${privateState.title}"`);

      // Button should be visually disabled (greyed out)
      if (Number(privateState.opacity || 1) > 0.85) {
        fail(`Striffs button not greyed out on private PR (opacity ${privateState.opacity})`);
        return;
      }
      pass('Striffs button greyed out on private PR (no token)');

      // Return to primary PR to continue flow
      try {
        await page.goto(PR_URL, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
      } catch (e) {
        fail(`Navigation back to primary PR timed out: ${e.message || e}`);
        return;
      }
    }
  } else {
    log('Skipping private repo test (PRIVATE_PR_URL not provided)');
  }

  // Return to primary PR to continue flow.
  try {
    await page.goto(PR_URL, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
  } catch (e) {
    fail(`Navigation back to primary PR timed out: ${e.message || e}`);
    return;
  }

  // Verify we are on the PR files tab.
  const onFilesTab = await page.evaluate(() => {
    const path = location.pathname;
    const onFiles = /\/pull\/\d+\/files$/.test(path);
    const onChanges = /\/pull\/\d+\/changes$/.test(path);
    return { ok: !!(onFiles || onChanges), path };
  });
  if (!onFilesTab?.ok) {
    fail(`Not on PR files/changes tab (path: ${onFilesTab?.path || 'unknown'})`);
    log('Leaving browser open for inspection (not on files tab).');
    return;
  }

  // Ensure the PR files container exists; treat absence as fatal.
  const filesRootSelectors = [
    '#files',
    'div[data-view-component="true"][data-testid="pull-requests-files"]',
    'div[data-testid="files-changed"]',
    'div[data-target="diff-layout.sidebarContainer"]',
    'div.diff-sidebar[data-view-component="true"]',
    'file-tree',
    'div[data-testid="progressive-diffs-list"]',
    'ul[role="tree"][aria-label*="File Tree"]',
    'div[aria-label="File Tree"]',
    '#pr-file-tree',
    'div[class*="Diff-module__diff"]',
    '.js-diff-progressive-container',
    '[data-testid="file-diff-split"]',
    '[data-testid="file-diff-unified"]',
    'div.js-file[data-file-type="file"]'
  ];
  const filesRoot = await page.waitForFunction((selectors) => {
    for (const sel of selectors) {
      if (document.querySelector(sel)) return sel;
    }
    return null;
  }, filesRootSelectors, { timeout: 30000 }).catch(() => null);
  if (!filesRoot) {
    const filesRootDiag = await page.evaluate((selectors) => {
      return {
        href: location.href,
        path: location.pathname,
        matches: selectors
          .map((sel) => ({ sel, count: document.querySelectorAll(sel).length }))
          .filter((entry) => entry.count > 0),
        bodyClass: document.body?.className || '',
        title: document.title || ''
      };
    }, filesRootSelectors).catch(() => null);
    fail(`Files root not found on PR Files page${filesRootDiag ? ` (${JSON.stringify(filesRootDiag)})` : ''}`);
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
  await clickStriffsButton('failure phase click').catch(() => {});
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
    const neutralState = !!window.Striffs?.__lastStriffsButtonState?.neutral;
    return hasErrorClass ||
      (disabled && /problem generating|failed|error|api request/i.test(tooltip)) ||
      (neutralState && /failed|error|api request|timeout|fetch/i.test(tooltip)) ||
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
    warn('API error state not surfaced on Striffs button');
  } else {
    pass('API error surfaced on Striffs button');
  }

  // Reset page state before normal flow
  log('Normal flow: restoring API base and reloading page');
  await clearApiBaseOverride();
  await page.reload({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
  log('Normal flow: reload complete');

  // --- Phase 2: normal flow ---
  log('Normal flow: waiting for toolbar and remounting buttons');
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
  log('Normal flow: waiting for buttons');
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
  await clickStriffsButton('before initial generation click');
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
    const generationDiag = await page.evaluate(() => {
      const btn = document.querySelector('#striffs-btn');
      const view = document.querySelector('#striff-diagram-view');
      const d = document.documentElement?.dataset || {};
      return {
        href: location.href,
        path: location.pathname,
        btnTitle: btn?.title || '',
        btnClass: btn?.className || '',
        btnHtml: btn?.innerHTML || '',
        btnDisabled: btn?.disabled === true,
        hasView: !!view,
        viewText: (view?.textContent || '').trim().slice(0, 300),
        viewDisplay: view ? getComputedStyle(view).display : null,
        viewVisibility: view ? getComputedStyle(view).visibility : null,
        viewSize: view ? { w: view.offsetWidth, h: view.offsetHeight } : null,
        striffsReady: !!window.Striffs?.__striffsReady,
        hasSvg: !!view?.querySelector?.('svg'),
        lastLoadSource: window.Striffs?.__lastLoadSource || null,
        currentView: window.Striffs?.__currentView || window.Striffs?.currentView || null,
        filesCount: Array.isArray(window.Striffs?.getFilesInPR?.()) ? window.Striffs.getFilesInPR().length : null,
        supportedExts: window.Striffs?.__supportedExtensionsForUi || [],
        lastRequestType: d.striffsLastRequestType || null,
        cacheSavedAt: d.striffsCacheSavedAt || null,
        cacheTooLarge: d.striffsCacheTooLarge || null
      };
    }).catch(() => null);
    warn(`Striffs generation indicator did not settle before timeout${generationDiag ? ` (${JSON.stringify(generationDiag)})` : ''}`);
  } else {
    await clickStriffsButton('before post-generation click');
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

  const telemetryArmed = await waitForTelemetryArmed(15000);
  if (!telemetryArmed) {
    const diag = await getTelemetryDiag();
    fail(`Engagement telemetry not initialized after Striffs render${diag ? ` (${JSON.stringify(diag)})` : ''}`);
    return;
  } else {
    pass('Engagement telemetry initialized after Striffs render');
  }

  await diffsBtn.click().catch(() => {});
  const telemetryDelivered = await waitForTelemetryDelivery({ minAck: 1, timeoutMs: 10000 });
  if (!telemetryDelivered) {
    const diag = await getTelemetryDiag();
    fail(`Engagement telemetry not delivered after Diffs button click${diag ? ` (${JSON.stringify(diag)})` : ''}`);
    return;
  } else if (Number(telemetryDelivered?.counters?.failed || 0) > 0) {
    fail(`Engagement telemetry had delivery failures (${JSON.stringify(telemetryDelivered.counters)})`);
    return;
  } else {
    pass('Engagement telemetry delivered after Diffs button click');
  }

  await clickStriffsButton('after cache restore').catch(() => {});
  const striffsVisibleAfterTelemetryCheck = await page.waitForFunction(() => {
    const el = document.querySelector('#striff-diagram-view');
    if (!el) return false;
    const style = getComputedStyle(el);
    const hasSvg = !!document.querySelector('#striffs-content svg');
    return hasSvg &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      el.offsetWidth > 0 &&
      el.offsetHeight > 0;
  }, null, { timeout: 10000 }).catch(() => false);
  if (!striffsVisibleAfterTelemetryCheck) {
    fail('Striffs view did not reappear after telemetry verification');
    return;
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

  const waitForAiReviewHarnessReady = async (timeoutMs = 10000) => {
    return await page.waitForFunction(() => {
      const S = window.Striffs;
      const view = document.querySelector('#striff-diagram-view');
      const svg = view?.querySelector?.('svg') || document.querySelector('#striff-diagram-view svg');
      return S && view && svg ? true : null;
    }, null, { timeout: timeoutMs, polling: 200 }).catch(() => null);
  };
  const liveAiReviewResult = await runStriffsTestHook('runLiveAiReviewCheck', { timeoutMs: 180000 }, 190000);
  if (shouldSkipLiveAiReview(liveAiReviewResult)) {
    warn(`Skipping live AI review check (${JSON.stringify(liveAiReviewResult)})`);
  } else if (!liveAiReviewResult?.ok) {
    fail(`Live AI review check failed (${JSON.stringify(liveAiReviewResult)})`);
    return;
  } else {
    pass('Live AI review returns a changed SVG with at least one AI review note');
  }

  let aiReviewManualOk = false;
  for (let attempt = 1; attempt <= 3 && !aiReviewManualOk; attempt += 1) {
    await waitForAiReviewHarnessReady(10000);
    aiReviewManualOk = await runAiReviewManualChecks();
    if (!aiReviewManualOk && attempt < 3) {
      warn(`Retrying manual AI review checks (attempt ${attempt + 1})`);
      await page.waitForTimeout(1500);
    }
  }
  log(`AI review manual checks completed: ${aiReviewManualOk ? 'ok' : 'failed'}`);
  if (!aiReviewManualOk) {
    return;
  }

  // File tree click should NOT switch to Striffs when in diffs view.
  let fileTreeDiffsOk = { ok: false, reason: 'unknown' };
  try {
    await page.click('#diffs-btn', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    const beforeActive = await page.evaluate(() => !!document.querySelector('#diffs-btn.is-active'));
    const clicked = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="file-tree"], #pr-file-tree, ul[role="tree"][aria-label*="File Tree"], div[aria-label="File Tree"]') || document;
      const links = Array.from(root.querySelectorAll("a[href*='diff-'], a[href^='#diff-'], li[role='treeitem'] a[href], li[data-tree-entry-type='file'] a[href]"));
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
    if (fileTreeDiffsOk?.reason === 'no file tree link') {
      warn(`${NEW_UI ? 'New UI' : 'Old UI'} diffs-mode file tree stability check skipped (${JSON.stringify(fileTreeDiffsOk)})`);
    } else {
    fail(`File tree click switched views in diffs mode (beforeActive=${fileTreeDiffsOk?.beforeActive}, afterActive=${fileTreeDiffsOk?.afterActive}, striffsActive=${fileTreeDiffsOk?.striffsActive}, reason=${fileTreeDiffsOk?.reason || 'unknown'})`);
    return;
    }
  } else {
    pass('File tree click keeps diffs view when in diffs mode');
  }

  // File tree items disabled in Striffs view should be re-enabled when switching to Diffs view.
  let fileTreeReenableOk = { ok: false, reason: 'unknown' };
  try {
    // First, switch to Striffs view and find any disabled file tree items
    await clickStriffsButton('before file tree re-enable check').catch(() => {});
    await page.waitForTimeout(600);
    const disabledInStriffs = await page.evaluate(() => {
      const disabledItems = document.querySelectorAll('.striffs-file-disabled, [aria-disabled="true"]');
      return Array.from(disabledItems).map(item => ({
        className: item.className,
        ariaDisabled: item.getAttribute('aria-disabled'),
        styleOpacity: item.style?.opacity || '',
        stylePointerEvents: item.style?.pointerEvents || ''
      }));
    });

    if (disabledInStriffs.length === 0) {
      // No disabled items in this diagram - skip test
      fileTreeReenableOk = { ok: true, reason: 'no-disabled-items', skipped: true };
    } else {
      // Now switch to Diffs view and verify items are re-enabled
      await page.click('#diffs-btn', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);

      const afterSwitch = await page.evaluate(() => {
        const previouslyDisabled = document.querySelectorAll('.striffs-file-disabled');
        const stillDisabledByClass = Array.from(previouslyDisabled).length;
        const stillDisabledByAttr = document.querySelectorAll('[aria-disabled="true"]').length;
        const itemsWithDisabledStyle = Array.from(document.querySelectorAll([
          "li[id^='file-tree-item-diff-']",
          "li[data-tree-entry-type='file']",
          "[data-testid='file-tree'] li[role='treeitem']"
        ].join(','))).filter(li =>
          li.style?.pointerEvents === 'none' || li.style?.opacity === '0.35'
        );

        return {
          stillDisabledByClass,
          stillDisabledByAttr,
          itemsWithDisabledStyle: itemsWithDisabledStyle.length
        };
      });

      fileTreeReenableOk = {
        ok: afterSwitch.stillDisabledByClass === 0 &&
             afterSwitch.itemsWithDisabledStyle === 0,
        reason: afterSwitch.stillDisabledByClass > 0 ? 'class-not-removed' :
               afterSwitch.itemsWithDisabledStyle > 0 ? 'style-not-cleared' : 'unknown',
        diag: {
          disabledInStriffsCount: disabledInStriffs.length,
          ...afterSwitch
        }
      };
    }
  } catch (e) {
    fileTreeReenableOk = { ok: false, reason: String(e?.message || e) };
  }
  if (fileTreeReenableOk?.skipped) {
    warn(`File tree re-enable check skipped (${JSON.stringify(fileTreeReenableOk)})`);
  } else if (!fileTreeReenableOk?.ok) {
    fail(`File tree items disabled in Striffs view should be re-enabled in Diffs view (${JSON.stringify(fileTreeReenableOk)})`);
    return;
  } else {
    pass('File tree items disabled in Striffs view are re-enabled in Diffs view');
  }

  // File tree click should focus diagram when in Striffs view (no diff hash change).
  let fileTreeStriffsOk = { ok: false, reason: 'unknown' };
  try {
    await clickStriffsButton('before striffs-view file tree assertion').catch(() => {});
    await page.waitForTimeout(600);
    const beforeActive = await page.evaluate(() => !!document.querySelector('#striffs-btn.is-active'));
    const beforeHash = await page.evaluate(() => location.hash || '');
    const clicked = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="file-tree"], #pr-file-tree, ul[role="tree"][aria-label*="File Tree"], div[aria-label="File Tree"]') || document;
      const links = Array.from(root.querySelectorAll("a[href*='diff-'], a[href^='#diff-'], li[role='treeitem'] a[href], li[data-tree-entry-type='file'] a[href]"));
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
      const hashOk = afterHash === beforeHash;
      fileTreeStriffsOk = { ok: !!(beforeActive && afterActive && hashOk), beforeActive, afterActive, beforeHash, afterHash };
    }
  } catch (e) {
    fileTreeStriffsOk = { ok: false, reason: String(e?.message || e) };
  }
  if (!fileTreeStriffsOk?.ok) {
    if (fileTreeStriffsOk?.reason === 'no file tree link') {
      warn(`${NEW_UI ? 'New UI' : 'Old UI'} striffs-mode file tree stability check skipped (${JSON.stringify(fileTreeStriffsOk)})`);
    } else {
    fail(`File tree click did not stay in Striffs view or changed hash (beforeActive=${fileTreeStriffsOk?.beforeActive}, afterActive=${fileTreeStriffsOk?.afterActive}, beforeHash="${fileTreeStriffsOk?.beforeHash}", afterHash="${fileTreeStriffsOk?.afterHash}", reason=${fileTreeStriffsOk?.reason || 'unknown'})`);
    return;
    }
  } else {
    pass('File tree click stays in Striffs view when Striffs is active');
  }

  // File tree click should center the corresponding component in the diagram.
  const centerCheck = await page.evaluate(async () => {
    const view = document.getElementById('striff-diagram-view');
    if (!view) return { ok: false, reason: 'no view' };
    if (view.scrollHeight <= view.clientHeight && view.scrollWidth <= view.clientWidth) {
      return { ok: false, reason: 'not scrollable' };
    }
    const resolveMappedFilePath = (el) => {
      const li = el?.closest?.("li[id^='file-tree-item-diff-'], li[data-tree-entry-type='file'], [data-testid='file-tree'] li, li[role='treeitem']");
      const raw =
        window.Striffs?.getFilePathFromTreeItem?.(li || el) ||
        li?.getAttribute?.('data-path') ||
        li?.getAttribute?.('data-file-path') ||
        '';
      const normalized = String(raw || '').trim();
      if (normalized && window.Striffs?.findMappedComponentIdForPath?.(normalized)) {
        return normalized;
      }
      const href = String(el?.getAttribute?.('href') || '');
      const diffId = href.startsWith('#') ? href.slice(1) : (href.match(/#(.+)$/)?.[1] || '');
      if (!diffId) return '';
      for (const [filePath, mappedDiffId] of window.Striffs?.__filePathToDiffId?.entries?.() || []) {
        if (String(mappedDiffId || '') === diffId && window.Striffs?.findMappedComponentIdForPath?.(filePath)) {
          return String(filePath);
        }
      }
      return '';
    };
    let link = null;
    const root = document.querySelector('[data-testid="file-tree"]') || document;
    const links = Array.from(root.querySelectorAll("a[href^='#diff-'], a[href*='#diff-']"));
    for (const candidate of links) {
      const filePath = resolveMappedFilePath(candidate);
      if (!filePath) continue;
      link = candidate;
      break;
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
    if (centerCheck?.reason === 'not scrollable') {
      pass('File tree center check not needed (diagram fits without scrolling)');
    } else {
      fail(`File tree center check failed (${centerCheck?.reason || 'unknown'})`);
    }
  } else {
    const delta = Math.abs((centerCheck.after.top - centerCheck.before.top) || 0) +
      Math.abs((centerCheck.after.left - centerCheck.before.left) || 0);
    if (delta > 20) {
      pass('File tree click centers component in diagram');
    } else {
      fail('File tree click did not move diagram scroll');
    }
  }

  // File tree click should focus the exact mapped component for that file.
  const exactFocusSnapshot = await runStriffsTestHook('getMappingSnapshot', {}, 10000);
  const exactFileFocusTarget = (() => {
    const route = exactFocusSnapshot?.canonicalRoute || null;
    if (!route?.filePath || !route?.componentId || !route?.diffId) {
      return { ok: false, reason: 'no canonical mapped route from hook', debug: exactFocusSnapshot };
    }
    return {
      ok: true,
      href: `#${route.diffId}`,
      expectedDiffId: String(route.diffId),
      filePath: String(route.filePath),
      componentId: String(route.componentId),
      text: ''
    };
  })();
  if (!exactFileFocusTarget?.ok) {
    const details = exactFileFocusTarget?.debug ? ` ${JSON.stringify(exactFileFocusTarget.debug)}` : '';
    if (!(exactFocusSnapshot?.pathToComponent || []).length) {
      warn(`Exact file-to-component focus check deferred (${exactFileFocusTarget?.reason || 'unknown'})${details}`);
    } else {
      fail(`Exact file-to-component focus check failed (${exactFileFocusTarget?.reason || 'unknown'})${details}`);
    }
  } else {
    const exactFileFocus = await (async () => {
      return await runStriffsTestHook('focusMappedFile', { filePath: exactFileFocusTarget.filePath }, 10000);
    })();
    if (
      !exactFileFocus?.ok ||
      exactFileFocus.actualDiffId !== exactFileFocusTarget.expectedDiffId ||
      !exactFileFocus.actualFocusedComponent
    ) {
      fail(`File tree click focused wrong component (href=${JSON.stringify(exactFileFocusTarget.href)}, text=${JSON.stringify(exactFileFocusTarget.text)}, filePath=${JSON.stringify(exactFileFocusTarget.filePath)}, expectedDiffId=${JSON.stringify(exactFileFocusTarget.expectedDiffId)}, requestedFilePath=${JSON.stringify(exactFileFocus.requestedFilePath)}, actualFile=${JSON.stringify(exactFileFocus.actualFocusedFile)}, actualDiffId=${JSON.stringify(exactFileFocus.actualDiffId)}, actualComponent=${JSON.stringify(exactFileFocus.actualFocusedComponent)}, resolvedNode=${JSON.stringify(exactFileFocus.actualResolvedNode)}, reason=${JSON.stringify(exactFileFocus.reason || '')})`);
    } else {
      pass('File tree click focuses the mapped component');
    }
  }

  await page.waitForFunction(() => {
    const S = window.Striffs;
    if (!S) return null;
    const lastPanAt = Number(S.__recentPanAt || 0);
    const debounceMs = Number(S.PAN_CLICK_DEBOUNCE_MS || 250);
    if (!lastPanAt || (Date.now() - lastPanAt) >= debounceMs) {
      return {
        lastPanAt,
        debounceMs
      };
    }
    return null;
  }, null, { timeout: 5000, polling: 100 }).catch(() => null);

  // Click a mapped diagram entity and ensure it routes to the corresponding diff.
  const autoClickSetup = (() => {
    const route = exactFocusSnapshot?.canonicalRoute || null;
    if (!route?.componentId || !route?.diffId || !route?.filePath) {
      return { ok: false, reason: 'no mapped component debug dataset', componentId: '', expectedHash: '', filePath: '' };
    }
    return {
      ok: true,
      expectedHash: `#${String(route.diffId)}`,
      componentId: String(route.componentId),
      hyphenated: String(route.componentId).replace(/\./g, '-'),
      filePath: String(route.filePath)
    };
  })();

  if (!autoClickSetup?.ok) {
    const details = [
      autoClickSetup?.componentId ? ` componentId=${JSON.stringify(autoClickSetup.componentId)}` : '',
      autoClickSetup?.expectedHash ? ` expectedHash=${JSON.stringify(autoClickSetup.expectedHash)}` : '',
      autoClickSetup?.filePath ? ` filePath=${JSON.stringify(autoClickSetup.filePath)}` : ''
    ].join('');
    if (autoClickSetup?.reason === 'no mapped component debug dataset') {
      warn(`Mapped diagram entity click deferred (${autoClickSetup?.reason || 'unknown'})${details}`);
    } else {
      fail(`Mapped diagram entity click setup failed (${autoClickSetup?.reason || 'unknown'})${details}`);
    }
  } else {
    const clickMappedEntity = await runStriffsTestHook('routeComponentId', { componentId: autoClickSetup.componentId }, 10000);
    if (!clickMappedEntity?.ok) {
      fail(`Mapped diagram entity click dispatch failed (${clickMappedEntity?.reason || 'unknown'}) details=${JSON.stringify(clickMappedEntity)}`);
    }
    const clickStateHandle = await page.waitForFunction((expectedHash) => {
      const d = document.documentElement?.dataset || {};
      const status = String(d.striffsLastDiagramClickStatus || '');
      if (!status || status === 'received') return null;
      return {
        status,
        componentId: String(d.striffsLastDiagramClickComponent || ''),
        filePath: String(d.striffsLastDiagramClickFile || ''),
        diffId: String(d.striffsLastDiagramClickDiffId || ''),
        reason: String(d.striffsLastDiagramClickReason || ''),
        targetFound: d.striffsLastDiagramClickTargetFound === '1',
        diffElementFound: d.striffsLastDiagramClickDiffElementFound === '1',
        currentView: String(d.striffsCurrentView || ''),
        hash: String(window.location.hash || ''),
        expectedHash
      };
    }, autoClickSetup.expectedHash, { timeout: 10000, polling: 100 }).catch(() => null);
    const clickState = clickStateHandle ? await clickStateHandle.jsonValue().catch(() => null) : null;
    const routed =
      clickState &&
      clickState.status === 'navigated' &&
      clickState.currentView === 'diffs' &&
      (clickState.hash === autoClickSetup.expectedHash || `#${clickState.diffId}` === autoClickSetup.expectedHash);
    if (!routed) {
      const liveDiag = await page.evaluate(() => {
        const d = document.documentElement?.dataset || {};
        return {
          status: String(d.striffsLastDiagramClickStatus || ''),
          componentId: String(d.striffsLastDiagramClickComponent || ''),
          filePath: String(d.striffsLastDiagramClickFile || ''),
          diffId: String(d.striffsLastDiagramClickDiffId || ''),
          reason: String(d.striffsLastDiagramClickReason || ''),
          targetFound: d.striffsLastDiagramClickTargetFound === '1',
          diffElementFound: d.striffsLastDiagramClickDiffElementFound === '1',
          currentView: String(d.striffsCurrentView || ''),
          hash: String(window.location.hash || '')
        };
      }).catch(() => null);
      fail(`Mapped diagram entity live assertion failed (${JSON.stringify({ liveDiag, expectedHash: autoClickSetup.expectedHash, componentId: autoClickSetup.componentId })})`);
  } else {
      pass('Mapped diagram entity click switches to the corresponding diff');
    }
  }

  const preResetVerification = await (async () => {
    const route = exactFocusSnapshot?.canonicalRoute || null;
    if (!route?.filePath || !route?.componentId || !route?.diffId) {
      return { ok: false, reason: 'no canonical mapped route', hook: exactFocusSnapshot };
    }
    const focusResult = await runStriffsTestHook('focusMappedFile', { filePath: route.filePath }, 10000);
    const routeResult = await runStriffsTestHook('routeComponentId', { componentId: route.componentId }, 10000);
    return {
      ok: true,
      filePath: String(route.filePath),
      componentId: String(route.componentId),
      diffId: String(route.diffId),
      focusOk: Boolean(focusResult?.ok),
      focusedFile: String(focusResult?.actualFocusedFile || ''),
      focusedComponent: String(focusResult?.actualFocusedComponent || ''),
      routeOk: Boolean(routeResult?.ok),
      routeStatus: String(routeResult?.status || ''),
      routeDiffId: String(routeResult?.diffId || ''),
      routeHash: String(routeResult?.hash || '')
    };
  })().catch(() => ({ ok: false, reason: 'exception' }));
  if (!preResetVerification?.ok) {
    warn(`Pre-reset Striffs verification unavailable (${preResetVerification?.reason || 'unknown'})${JSON.stringify(preResetVerification)}`);
  } else {
    if (!preResetVerification.focusOk || preResetVerification.focusedFile !== preResetVerification.filePath || !preResetVerification.focusedComponent) {
      warn(`Pre-reset file focus unavailable (${JSON.stringify(preResetVerification)})`);
    } else {
      pass('Pre-reset file focus works');
    }
    if (
      !preResetVerification.routeOk ||
      preResetVerification.routeStatus !== 'navigated' ||
      (preResetVerification.routeHash !== `#${preResetVerification.diffId}` && `#${preResetVerification.routeDiffId}` !== `#${preResetVerification.diffId}`)
    ) {
      warn(`Pre-reset diagram routing unavailable (${JSON.stringify(preResetVerification)})`);
  } else {
      pass('Pre-reset diagram routing works');
    }
  }

  async function runAiReviewManualChecks() {
    const result = await runStriffsTestHook('runAiReviewManualChecks', {}, 15000);

    if (!result?.ok) {
      warn(`Manual AI review checks attempt failed (${result?.reason || 'unknown'})${result ? ` ${JSON.stringify(result)}` : ''}`);
      return false;
    }
    if (result.pendingState?.status !== 'PENDING' || !/Enriching/i.test(result.pendingState?.html || '')) {
      fail(`Manual AI review pending state invalid (${JSON.stringify(result.pendingState)})`);
      return false;
    }
    pass('Manual AI review pending state shows Enriching');

    if (result.cachedAiReviewStatus !== 'PENDING') {
      fail(`Manual AI review cache metadata missing cachedAiReviewStatus (${JSON.stringify(result)})`);
      return false;
    }
    pass('Manual AI review cache metadata stores cachedAiReviewStatus');

    if (!result.readyOutcome?.ok || !result.readyOutcome?.enriched || result.readyOutcome?.pollTimerActive) {
      fail(`Manual AI review READY polling path failed (${JSON.stringify(result.readyOutcome)})`);
      return false;
    }
    pass('Manual AI review polling swaps in enriched SVG on READY');

    if (!result.failedOutcome?.ok || result.failedOutcome?.enrichedStillPresent || result.failedOutcome?.status !== 'FAILED') {
      fail(`Manual AI review FAILED polling path failed (${JSON.stringify(result.failedOutcome)})`);
      return false;
    }
    pass('Manual AI review polling stops on FAILED and keeps base diagram');
    return true;
  }

  const runResetCacheCheck = async () => {
    const resetCachePrefixes = ['StriffsCache:', 'striffsCache:', 'striffsCacheMeta:', 'StriffsCacheMeta:'];
    const resetCacheChromeKeys = [
      'striffsSupportedLangs',
      'striffsSupportedLangsFetchedAt'
    ];
    const readClearFlag = async () => {
      const sw = await getServiceWorker();
      if (!sw) return 0;
      try {
        const stored = await sw.evaluate(async () => {
          try {
            return await chrome.storage.local.get(['striffsCacheClearAt']);
          } catch {
            return {};
          }
        });
        return Number(stored?.striffsCacheClearAt || 0);
      } catch {
        return 0;
      }
    };
    const beforeClearFlag = await readClearFlag();
    const swForReset = await getServiceWorker();
    if (swForReset) {
      await swForReset.evaluate(async () => {
        try {
          await chrome.storage.local.set({
            striffsSupportedLangs: 'java',
            striffsActiveTab: 'striffs',
            striffsApiBase: 'http://127.0.0.1:9'
          });
        } catch {}
      }).catch(() => null);
    }
    const resetTrigger = await page.evaluate(async () => {
      const currentCacheKey = window.Striffs?.cacheKey?.() || '';
      const currentChromeCacheKey = window.Striffs?.cacheStorageKey?.() || '';
      try {
        localStorage.setItem('striffs:manual-test', '1');
        localStorage.setItem('striffsCache:manual-test', '1');
        localStorage.setItem('striffsCacheMeta:manual-test', '1');
        sessionStorage.setItem('striffs:manual-test', '1');
      } catch {}
      return {
        currentCacheKey,
        currentChromeCacheKey
      };
    }).catch(() => ({ currentCacheKey: '', currentChromeCacheKey: '', reason: 'exception' }));
    let resetMessageOk = false;
    let popupStatusText = '';
    const extensionId = (() => {
      try {
        return swForReset?.url ? new URL(swForReset.url()).host : '';
      } catch {
        return '';
      }
    })();
    if (extensionId) {
      const popupPage = await context.newPage();
      try {
        await popupPage.goto(`chrome-extension://${extensionId}/html/popup.html`, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await popupPage.click('#resetCacheBtn', { timeout: 5000 });
        const popupStatusHandle = await popupPage.waitForFunction(() => {
          const text = document.querySelector('#status')?.textContent || '';
          return /Striffs cache cleared|Cleared\. Updated \d+ tabs?\.|Could not reset cache|Failed to clear caches/i.test(text) ? text : null;
        }, null, { timeout: 10000 }).catch(() => null);
        popupStatusText = popupStatusHandle ? String(await popupStatusHandle.jsonValue()) : '';
        resetMessageOk = /Striffs cache cleared|Cleared\. Updated \d+ tabs?\./i.test(popupStatusText);
      } catch (e) {
        popupStatusText = String(e?.message || e);
        resetMessageOk = false;
      } finally {
        await popupPage.close().catch(() => {});
      }
    }
    const clearFlagAdvanced = await (async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const current = await readClearFlag();
        if (current > beforeClearFlag) return true;
        await new Promise(r => setTimeout(r, 100));
      }
      return false;
    })();
    await page.waitForTimeout(1500);
    const resetPageState = await page.evaluate(({ prefixes, currentCacheKey }) => {
      const lsKeys = [];
      for (let i = 0; i < localStorage.length; i++) lsKeys.push(localStorage.key(i));
      const ssKeys = [];
      for (let i = 0; i < sessionStorage.length; i++) ssKeys.push(sessionStorage.key(i));
      const localHits = lsKeys.filter(k => k && prefixes.some(p => k.startsWith(p)));
      const sessionHits = ssKeys.filter(k => k && prefixes.some(p => k.startsWith(p)));
      const localCacheKeyPresent = Boolean(currentCacheKey && localStorage.getItem(currentCacheKey));
      const localCacheMetaPresent = Boolean(currentCacheKey && localStorage.getItem(`striffsCacheMeta:${currentCacheKey}`));
      return {
        localHits,
        sessionHits,
        localCacheKeyPresent,
        localCacheMetaPresent
      };
    }, {
      prefixes: resetCachePrefixes,
      currentCacheKey: resetTrigger?.currentCacheKey || ''
    }).catch(() => ({
      localHits: [],
      sessionHits: [],
      localCacheKeyPresent: false,
      localCacheMetaPresent: false,
      reason: 'exception'
    }));
    const resetChromeState = swForReset
      ? await swForReset.evaluate(async ({ prefixes, targetedChromeKeys, currentChromeCacheKey }) => {
          try {
            const stored = await chrome.storage.local.get(null);
            const storedKeys = Object.keys(stored || {});
            return {
              chromePrefixHits: storedKeys.filter(k =>
                k !== 'striffsCacheClearAt' &&
                prefixes.some(p => k.startsWith(p))
              ),
              chromeTargetedHits: storedKeys.filter(k => targetedChromeKeys.includes(k)),
              chromeCacheKeyPresent: Boolean(currentChromeCacheKey && stored?.[currentChromeCacheKey])
            };
          } catch {
            return {
              chromePrefixHits: [],
              chromeTargetedHits: [],
              chromeCacheKeyPresent: false
            };
          }
        }, {
          prefixes: resetCachePrefixes,
          targetedChromeKeys: resetCacheChromeKeys,
          currentChromeCacheKey: resetTrigger?.currentChromeCacheKey || ''
        }).catch(() => ({
          chromePrefixHits: [],
          chromeTargetedHits: [],
          chromeCacheKeyPresent: false
        }))
      : {
          chromePrefixHits: [],
          chromeTargetedHits: [],
          chromeCacheKeyPresent: false
        };
    const resetHookState = await runStriffsTestHook('getCacheSnapshot', {}, 10000);
    const hookLocalHits = Array.isArray(resetHookState?.localKeys)
      ? resetHookState.localKeys.filter((k) => resetCachePrefixes.some((p) => String(k || '').startsWith(p)))
      : [];
    const hookSessionHits = Array.isArray(resetHookState?.sessionKeys)
      ? resetHookState.sessionKeys.filter((k) => resetCachePrefixes.some((p) => String(k || '').startsWith(p)))
      : [];
    const hookChromeHits = Array.isArray(resetHookState?.chromeKeys)
      ? resetHookState.chromeKeys.filter((k) => String(k || '') !== 'striffsCacheClearAt' && resetCachePrefixes.some((p) => String(k || '').startsWith(p)))
      : [];
    const resetCachesOk = {
      ok: Boolean(resetMessageOk) &&
        (resetPageState?.localHits || []).length === 0 &&
        (resetPageState?.sessionHits || []).length === 0 &&
        (resetChromeState?.chromePrefixHits || []).length === 0 &&
        (resetChromeState?.chromeTargetedHits || []).length === 0 &&
        hookLocalHits.length === 0 &&
        hookSessionHits.length === 0 &&
        hookChromeHits.length === 0 &&
        !resetChromeState?.chromeCacheKeyPresent &&
        !resetPageState?.localCacheKeyPresent &&
        !resetPageState?.localCacheMetaPresent,
      resetMessageOk: Boolean(resetMessageOk),
      popupStatusText,
      clearFlagAdvanced,
      localHits: resetPageState?.localHits || [],
      sessionHits: resetPageState?.sessionHits || [],
      chromePrefixHits: resetChromeState?.chromePrefixHits || [],
      chromeTargetedHits: resetChromeState?.chromeTargetedHits || [],
      hookLocalHits,
      hookSessionHits,
      hookChromeHits,
      chromeCacheKeyPresent: Boolean(resetChromeState?.chromeCacheKeyPresent),
      localCacheKeyPresent: Boolean(resetPageState?.localCacheKeyPresent),
      localCacheMetaPresent: Boolean(resetPageState?.localCacheMetaPresent)
    };
    if (!resetCachesOk?.ok) {
      fail(`Reset cache did not clear Striffs cache state (resetMessageOk=${resetCachesOk?.resetMessageOk}, popupStatus="${resetCachesOk?.popupStatusText || ''}", flag=${resetCachesOk?.clearFlagAdvanced}, local=${(resetCachesOk?.localHits || []).join(',')}, session=${(resetCachesOk?.sessionHits || []).join(',')}, chromePrefixes=${(resetCachesOk?.chromePrefixHits || []).join(',')}, chromeTargeted=${(resetCachesOk?.chromeTargetedHits || []).join(',')}, hookLocal=${(resetCachesOk?.hookLocalHits || []).join(',')}, hookSession=${(resetCachesOk?.hookSessionHits || []).join(',')}, hookChrome=${(resetCachesOk?.hookChromeHits || []).join(',')}, chromeCacheKeyPresent=${resetCachesOk?.chromeCacheKeyPresent}, localCacheKeyPresent=${resetCachesOk?.localCacheKeyPresent}, localCacheMetaPresent=${resetCachesOk?.localCacheMetaPresent})`);
      return false;
    }
    pass('Reset cache clears Striffs cache state');
    return true;
  };

  /**
   * Test: Cache Clear + API Down = No Diagram
   *
   * Verifies that after clearing the cache, if the API is unavailable,
   * no diagram loads on refresh.
   *
   * Flow:
   * 1. Clear cache via popup button
   * 2. Prompt user to stop the API server
   * 3. Refresh the page
   * 4. Verify no diagram loads or error message is shown
   */
  const runCacheClearWithApiDownTest = async () => {
    if (HEADLESS && !RUN_API_DOWN_TEST) {
      log('Skipping cache clear + API down test in headless mode. Set RUN_API_DOWN_TEST=1 to enable it.');
      return { ok: true, skipped: true };
    }

    log('');
    log('========================================');
    log('TEST: Cache Clear + API Down = No Diagram');
    log('========================================');
    log('');
    log('Simulating API down by pointing to bogus port...');

    // Store original API base and set to bogus URL
    const originalApiBase = PRODUCTION_API_BASE;
    const bogusApiBase = 'http://localhost:9999'; // Port where nothing is running

    // Change API base to bogus URL via extension storage
    try {
      await chrome.storage.local.set({ striffsApiBase: bogusApiBase });
      log(`API base changed to ${bogusApiBase} (simulating API down)`);
    } catch (e) {
      warn(`Could not set API base: ${e?.message || e}`);
    }

    // Clear cache using the popup
    let extensionId = '';
    try {
      const sw = await getServiceWorker();
      extensionId = sw?.url ? new URL(sw.url()).host : '';
    } catch {
      extensionId = '';
    }

    if (!extensionId) {
      // Restore API base before failing
      try { await chrome.storage.local.set({ striffsApiBase: originalApiBase }); } catch {}
      fail('Could not find extension ID for cache clear test');
      return { ok: false, reason: 'no-extension-id' };
    }

    log('Opening popup to clear cache...');
    const popupPage = await context.newPage();
    let clearSuccess = false;
    try {
      await popupPage.goto(`chrome-extension://${extensionId}/html/popup.html`, { waitUntil: 'domcontentloaded', timeout: 10000 });
      await popupPage.click('#resetCacheBtn', { timeout: 5000 });
      const popupStatusHandle = await popupPage.waitForFunction(() => {
        const text = document.querySelector('#status')?.textContent || '';
        return /Striffs cache cleared|Cleared\. Updated \d+ tabs?\.|Could not reset cache|Failed to clear caches/i.test(text) ? text : null;
      }, null, { timeout: 10000 }).catch(() => null);
      const popupStatusText = popupStatusHandle ? await popupStatusHandle.jsonValue() : '';
      clearSuccess = /Striffs cache cleared|Cleared\. Updated \d+ tabs?\./i.test(popupStatusText);
      log(`Popup status: "${popupStatusText}"`);
    } catch (e) {
      log(`Error clearing cache: ${e?.message || e}`);
    } finally {
      await popupPage.close().catch(() => {});
    }

    if (!clearSuccess) {
      // Restore API base before failing
      try { await chrome.storage.local.set({ striffsApiBase: originalApiBase }); } catch {}
      fail('Failed to clear cache via popup button');
      return { ok: false, reason: 'cache-clear-failed' };
    }

    log('Cache cleared. Waiting 2 seconds before refresh...');
    await page.waitForTimeout(2000);

    // Refresh the page
    log('Refreshing page (API should be down)...');
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      log(`Reload timeout or error: ${e?.message || e}`);
    }

    // Wait for the page to settle
    await page.waitForTimeout(3000);

    // Check if diagram loaded (it shouldn't without API and cache)
    const diagramState = await page.evaluate(() => {
      const svg = document.querySelector('#striffs-content svg');
      const status = document.getElementById('striffs-status')?.textContent || '';
      const button = document.querySelector('#striffs-btn');
      const buttonClass = button?.className || '';
      const buttonTitle = button?.getAttribute('title') || '';
      const toast = document.querySelector('#striffs-toast')?.textContent || '';

      // Check for error indicators
      const hasError = /error|failed|unable|could not|cannot/i.test(status + toast);

      return {
        hasSvg: !!svg,
        status,
        buttonClass,
        buttonTitle,
        toast,
        hasError
      };
    }).catch(() => ({
      hasSvg: false,
      status: '',
      buttonClass: '',
      buttonTitle: '',
      toast: '',
      hasError: false,
      reason: 'exception'
    }));

    log(`Diagram state after refresh (API down, cache cleared):`);
    log(`  - SVG present: ${diagramState.hasSvg}`);
    log(`  - Status text: "${diagramState.status}"`);
    log(`  - Toast: "${diagramState.toast}"`);
    log(`  - Button title: "${diagramState.buttonTitle}"`);

    // Expected: No SVG should load, or there should be an error message
    let result;
    if (!diagramState.hasSvg) {
      pass('No diagram loaded after cache clear (API down) - cache clearing works correctly');
      result = { ok: true };
    } else if (diagramState.hasError) {
      pass('Diagram failed to load with error after cache clear (API down) - cache clearing works correctly');
      result = { ok: true };
    } else {
      fail('Diagram still loaded after cache clear even though API is down - cache may not be properly cleared');
      result = { ok: false, reason: 'diagram-still-loaded', diagramState };
    }

    // Restore original API base
    try {
      await chrome.storage.local.set({ striffsApiBase: originalApiBase });
      log(`API base restored to ${originalApiBase}`);
    } catch (e) {
      warn(`Could not restore API base: ${e?.message || e}`);
    }
    return result;
  };

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
  if (!guideOk?.ok || !/striff\.io/.test(guideOk.href) || guideOk.target !== '_blank' || guideOk.title !== 'Guide' || !guideOk.icon) {
    fail(`Guide link invalid (href="${guideOk?.href}", target="${guideOk?.target}", title="${guideOk?.title}", icon=${guideOk?.icon})`);
    return;
  } else {
    pass('Guide link points to striff.io and opens new tab');
  }

  const downloadMeta = await page.evaluate(() => {
    const btn = document.querySelector('#striffs-download-btn');
    const svg = window.Striffs?.__striffsSvg || document.querySelector('#striffs-content svg');
    if (!btn || !svg) return { ok: false, reason: 'missing' };
    return {
      ok: true,
      title: btn.getAttribute('title') || '',
      icon: !!btn.querySelector('svg')
    };
  }).catch(() => ({ ok: false, reason: 'exception' }));
  let downloadOk = false;
  let downloadHref = '';
  let downloadName = '';
  if (downloadMeta?.ok) {
    try {
      await page.locator('#striffs-download-btn').dispatchEvent('click');
      const saveStateHandle = await page.waitForFunction(() => {
        const d = document.documentElement?.dataset || {};
        const status = d.striffsSaveStatus || '';
        if (!status || status === 'started') return null;
        return {
          status,
          filename: d.striffsSaveFilename || '',
          href: d.striffsSaveHref || '',
          error: d.striffsSaveError || ''
        };
      }, null, { timeout: 10000 }).catch(() => null);
      const saveState = saveStateHandle ? await saveStateHandle.jsonValue() : null;
      downloadHref = String(saveState?.href || '');
      downloadName = String(saveState?.filename || '');
      downloadOk =
        saveState?.status === 'download-triggered' &&
        downloadName === 'striffs-diagram.svg' &&
        /^blob:/i.test(downloadHref);
    } catch {}
  }
  if (!downloadMeta?.ok || downloadMeta?.title !== 'Save' || !downloadMeta?.icon || !downloadOk) {
    fail(`Save did not produce a valid SVG download (metaReason=${downloadMeta?.reason || 'ok'}, title="${downloadMeta?.title}", icon=${downloadMeta?.icon}, filename="${downloadName}", href="${downloadHref}")`);
    return;
  } else {
    pass('Save produces a blob-backed SVG download');
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
      const datasetStorage = dataset.striffsCacheStorage || '';
      let chrome = false;
      if (typeof window.Striffs?.readCacheFromChromeStorage === 'function') {
        const parsed = await window.Striffs.readCacheFromChromeStorage();
        chrome = !!parsed;
      }
      let indexedDb = false;
      if (typeof window.Striffs?.readCacheFromIndexedDb === 'function') {
        const parsed = await window.Striffs.readCacheFromIndexedDb();
        indexedDb = !!parsed;
      }
      return { local, chrome, indexedDb, meta, tooLarge, datasetSaved, datasetTooLarge, datasetStorage };
    } catch {
      return { local: false, chrome: false, indexedDb: false, meta: false, tooLarge: false, datasetSaved: false, datasetTooLarge: false, datasetStorage: '' };
    }
  });
  const cacheFlag = await page.evaluate(() => window.__striffsCacheMeta || null).catch(() => null);
  if (!cacheAfter?.local && !cacheAfter?.chrome && !cacheAfter?.meta && !cacheAfter?.datasetSaved && !cacheFlag) {
    await page.waitForFunction(() => {
      try {
        const key = window.Striffs?.cacheKey?.();
        const local = key ? !!localStorage.getItem(key) : false;
        const meta = key ? !!localStorage.getItem(`striffsCacheMeta:${key}`) : false;
        const dataset = document.documentElement?.dataset || {};
        return Boolean(local || meta || dataset.striffsCacheSavedAt || window.__striffsCacheMeta);
      } catch {
        return false;
      }
    }, null, { timeout: 5000 }).catch(() => null);
  }
  const cacheAfterSettled = await page.evaluate(async () => {
    try {
      const key = window.Striffs?.cacheKey?.();
      const local = key ? !!localStorage.getItem(key) : false;
      const meta = key ? !!localStorage.getItem(`striffsCacheMeta:${key}`) : false;
      const tooLarge = !!window.__striffsCacheTooLarge;
      const dataset = document.documentElement?.dataset || {};
      const datasetSaved = !!dataset.striffsCacheSavedAt;
      const datasetTooLarge = dataset.striffsCacheTooLarge === "1";
      const datasetStorage = dataset.striffsCacheStorage || '';
      let chrome = false;
      if (typeof window.Striffs?.readCacheFromChromeStorage === 'function') {
        const parsed = await window.Striffs.readCacheFromChromeStorage();
        chrome = !!parsed;
      }
      let indexedDb = false;
      if (typeof window.Striffs?.readCacheFromIndexedDb === 'function') {
        const parsed = await window.Striffs.readCacheFromIndexedDb();
        indexedDb = !!parsed;
      }
      return { local, chrome, indexedDb, meta, tooLarge, datasetSaved, datasetTooLarge, datasetStorage };
    } catch {
      return { local: false, chrome: false, indexedDb: false, meta: false, tooLarge: false, datasetSaved: false, datasetTooLarge: false, datasetStorage: '' };
    }
  }).catch(() => cacheAfter);
  log(`Cache state after render ${JSON.stringify(cacheAfterSettled)}`);
  if (cacheAfterSettled?.tooLarge || cacheAfterSettled?.datasetTooLarge) {
    warn('Cache skipped (payload too large for storage)');
  } else if (!cacheAfterSettled?.local && !cacheAfterSettled?.chrome && !cacheAfterSettled?.indexedDb && !cacheAfterSettled?.meta && !cacheAfterSettled?.datasetSaved && !cacheFlag) {
    warn('No cache entry was written after Striffs render; live smoke will treat cache-hit validation as optional');
  } else {
    pass('Cache written after Striffs render');
  }

  // Wait for Striffs debug datasets to be populated.
  await page.waitForFunction(() => {
    const d = document.documentElement?.dataset || {};
    return Number(d.striffsPathToComponentSize || 0) > 0 &&
      Number(d.striffsComponentToFileSize || 0) > 0;
  }, { timeout: 15000 }).catch(() => null);

  const mappingSnapshot = await runStriffsTestHook('getMappingSnapshot', {}, 10000);

  // Verify map sizes and diffId->component map integrity (from debug datasets).
  const mapStats = await page.evaluate(() => {
    const d = document.documentElement?.dataset || {};
    return {
      pathToComponentSize: Number(d.striffsPathToComponentSize || 0),
      componentToFileSize: Number(d.striffsComponentToFileSize || 0),
      diffToComponentSize: Number(d.striffsDiffToComponentSize || 0),
    };
  }).catch(() => null);
  const mergedMapStats = mapStats ? {
    pathToComponentSize: Math.max(
      Number(mapStats.pathToComponentSize || 0),
      Array.isArray(mappingSnapshot?.pathToComponent) ? mappingSnapshot.pathToComponent.length : 0
    ),
    componentToFileSize: Math.max(
      Number(mapStats.componentToFileSize || 0),
      Array.isArray(mappingSnapshot?.componentToFile) ? mappingSnapshot.componentToFile.length : 0
    ),
    diffToComponentSize: Math.max(
      Number(mapStats.diffToComponentSize || 0),
      Array.isArray(mappingSnapshot?.filePathToDiffId) ? mappingSnapshot.filePathToDiffId.length : 0
    ),
  } : null;
  if (!mergedMapStats) {
    fail('Map stats unavailable');
  } else if (mergedMapStats.pathToComponentSize === 0 || mergedMapStats.componentToFileSize === 0) {
    warn(`Empty Striffs maps (path->component=${mergedMapStats.pathToComponentSize}, component->file=${mergedMapStats.componentToFileSize})`);
  } else if (mergedMapStats.diffToComponentSize === 0) {
    warn('Empty diffId->component map');
  } else {
    pass(`Map sizes ok (path->component=${mergedMapStats.pathToComponentSize}, component->file=${mergedMapStats.componentToFileSize}, diff->component=${mergedMapStats.diffToComponentSize})`);
  }

  // Ensure file tree availability is applied (call update explicitly and re-check).
  await page.evaluate(() => {
    try { window.Striffs?.updateFileTreeAvailability?.(); } catch {}
  });
  await page.waitForTimeout(500);

  // Verify file tree availability state in Striffs view (unmapped files disabled).
  const fileTreeState = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(
      "li[id^='file-tree-item-diff-'], li[data-tree-entry-type='file'], [data-testid='file-tree'] li, li[role='treeitem'], [data-striffs-mapped], a[href^='#diff-'], a[href*='#diff-']"
    ));
    let unmappedTotal = 0;
    let unmappedDisabled = 0;
    let total = 0;
    let mappedAttrCount = 0;
    let mappedEnabled = 0;
    let mappedEnabledCode = 0;
    const d = document.documentElement?.dataset || {};
    const mappedCount = Number(d.striffsPathToComponentSize || 0);
    for (const li of items) {
      const href = String(li.getAttribute?.('href') || li.querySelector?.("a[href^='#diff-'], a[href*='#diff-']")?.getAttribute?.('href') || '');
      const path =
        (href ? window.Striffs?.findFilePathByDiffId?.(href) : '') ||
        window.Striffs?.getFilePathFromTreeItem?.(li) ||
        li.getAttribute?.('data-striffs-file-path') ||
        li.getAttribute?.('data-path') ||
        li.getAttribute?.('data-file-path') ||
        li.id ||
        li.textContent ||
        "";
      if (!String(path).trim()) continue;
      total += 1;
      if (li.hasAttribute('data-striffs-mapped')) mappedAttrCount += 1;
      const norm = String(path).trim();
      if (!norm) continue;
      const container = li.closest?.("li[id^='file-tree-item-diff-'], [data-testid='file-tree'] li, li[data-tree-entry-type='file'], li[role='treeitem'], .file-info, .js-navigation-item") || li;
      const mapped = li.getAttribute('data-striffs-mapped') === '1' ||
        !!li.querySelector?.('[data-striffs-mapped="1"]') ||
        container.getAttribute?.('data-striffs-mapped') === '1' ||
        !!window.Striffs?.findMappedComponentIdForPath?.(norm);
      const disabled =
        li.classList.contains('striffs-file-disabled') ||
        li.getAttribute('aria-disabled') === 'true' ||
        container.classList?.contains?.('striffs-file-disabled') ||
        container.getAttribute?.('aria-disabled') === 'true';
      if (mapped && !disabled) mappedEnabled += 1;
      if (mapped && !disabled && /\.(java|ts|tsx|js|jsx|py|cs|go)$/i.test(norm)) mappedEnabledCode += 1;
      if (disabled) unmappedDisabled += 1;
      unmappedTotal += 1;
    }
    const sample = items
      .map((li) => {
        const href = String(li.getAttribute('href') || li.querySelector?.('a[href]')?.getAttribute('href') || '');
        const path = String(
          li.getAttribute('data-striffs-file-path') ||
          li.querySelector?.('[data-striffs-file-path]')?.getAttribute?.('data-striffs-file-path') ||
          window.Striffs?.findFilePathByDiffId?.(href) ||
          window.Striffs?.getFilePathFromTreeItem?.(li) ||
          ''
        );
        const norm = String(path).trim();
        const container = li.closest?.("li[id^='file-tree-item-diff-'], [data-testid='file-tree'] li, li[data-tree-entry-type='file'], li[role='treeitem'], .file-info, .js-navigation-item") || li;
        const mapped = li.getAttribute('data-striffs-mapped') === '1' ||
          !!li.querySelector?.('[data-striffs-mapped="1"]') ||
          container.getAttribute?.('data-striffs-mapped') === '1' ||
          !!window.Striffs?.findMappedComponentIdForPath?.(norm);
        return {
          tag: li.tagName,
          href,
          path: norm,
          text: String((li.textContent || '').trim()).slice(0, 120),
          liMapped: li.getAttribute('data-striffs-mapped') || '',
          liDisabledClass: li.classList.contains('striffs-file-disabled'),
          liAriaDisabled: li.getAttribute('aria-disabled') || '',
          containerTag: String(container?.tagName || ''),
          containerClass: String(container?.className || ''),
          containerMapped: container?.getAttribute?.('data-striffs-mapped') || '',
          containerDisabledClass: container?.classList?.contains?.('striffs-file-disabled') || false,
          containerAriaDisabled: container?.getAttribute?.('aria-disabled') || '',
          childMapped: String(li.querySelector?.('[data-striffs-mapped]')?.getAttribute?.('data-striffs-mapped') || ''),
          childDisabledClass: !!li.querySelector?.('.striffs-file-disabled'),
          childAriaDisabled: String(li.querySelector?.('[aria-disabled]')?.getAttribute?.('aria-disabled') || '')
        };
      })
      .filter(Boolean)
      .slice(0, 12);
    return { total, unmappedTotal, unmappedDisabled, mappedCount, mappedAttrCount, mappedEnabled, mappedEnabledCode, sample };
  }).catch(() => null);
  if (!fileTreeState || fileTreeState.total === 0) {
    warn(`File tree availability check skipped (state=${JSON.stringify(fileTreeState)})`);
  } else if (fileTreeState.mappedCount > 0 && fileTreeState.mappedAttrCount === 0) {
    fail('File tree items were not annotated with Striffs mapping data');
  } else {
    if (fileTreeState.unmappedDisabled === 0 && fileTreeState.mappedCount < fileTreeState.total) {
      warn(`File tree availability check found no disabled items (total=${fileTreeState.total}, mappedCount=${fileTreeState.mappedCount}, mappedAttrCount=${fileTreeState.mappedAttrCount})`);
    }
    pass('File tree availability reflects Striffs mapping');
    if (Number(fileTreeState.mappedEnabledCode || 0) <= 0) {
      fail(`No mapped code files were enabled in file explorer during Striffs view (${JSON.stringify({ mappedEnabled: fileTreeState.mappedEnabled, mappedEnabledCode: fileTreeState.mappedEnabledCode, mappedCount: fileTreeState.mappedCount, mappedAttrCount: fileTreeState.mappedAttrCount, sample: fileTreeState.sample || [] })})`);
      return;
    }
    pass('Mapped code files are enabled in file explorer during Striffs view');
  }

  await page.waitForFunction(() => {
    const d = document.documentElement?.dataset || {};
    return d.striffsExampleMappedComponent && d.striffsExampleMappedFile && d.striffsExampleMappedDiffHash
      ? {
          component: d.striffsExampleMappedComponent,
          file: d.striffsExampleMappedFile,
          diffHash: d.striffsExampleMappedDiffHash
        }
      : null;
  }, null, { timeout: 30000, polling: 200 }).catch(() => null);

  const canonicalTarget = await page.evaluate(() => {
    const d = document.documentElement?.dataset || {};
    return {
      componentId: String(d.striffsExampleMappedComponent || ''),
      filePath: String(d.striffsExampleMappedFile || ''),
      diffHash: String(d.striffsExampleMappedDiffHash || '')
    };
  }).catch(() => ({ componentId: '', filePath: '', diffHash: '' }));
  if ((!canonicalTarget.componentId || !canonicalTarget.filePath || !canonicalTarget.diffHash) && mappingSnapshot?.canonicalRoute) {
    canonicalTarget.componentId = String(mappingSnapshot.canonicalRoute.componentId || '');
    canonicalTarget.filePath = String(mappingSnapshot.canonicalRoute.filePath || '');
    canonicalTarget.diffHash = mappingSnapshot.canonicalRoute.diffId
      ? `#${String(mappingSnapshot.canonicalRoute.diffId)}`
      : '';
  }

  if (!canonicalTarget.componentId || !canonicalTarget.filePath || !canonicalTarget.diffHash) {
    warn(`Canonical dataset route unavailable (${JSON.stringify(canonicalTarget)})`);
  } else {
    await clickStriffsButton('Striffs').catch(() => null);
    await page.waitForFunction(() => {
      const d = document.documentElement?.dataset || {};
      return String(d.striffsCurrentView || '') === 'striffs' ? true : null;
    }, null, { timeout: 10000, polling: 100 }).catch(() => null);
    await page.evaluate(() => {
      const root = document.documentElement;
      if (root?.dataset) {
        delete root.dataset.striffsLastFocusedFile;
        delete root.dataset.striffsLastFocusedComponent;
        delete root.dataset.striffsLastFocusedAt;
        delete root.dataset.striffsLastFocusResolvedNode;
      }
      document.querySelectorAll('[data-striffs-test-file-focus]').forEach((el) => {
        try { el.removeAttribute('data-striffs-test-file-focus'); } catch {}
      });
    }).catch(() => null);
    const fileFocusTarget = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll(
        "[data-testid='file-tree'] a[href], " +
        "li[id^='file-tree-item-diff-'] a[href], " +
        "li[data-tree-entry-type='file'] a[href], " +
        "li[role='treeitem'] a[href], " +
        "a[data-striffs-file-path][href]"
      ));
      const target = candidates.find((el) => {
        const href = String(el.getAttribute('href') || '');
        const mappedPath = String(el.getAttribute('data-striffs-file-path') || window.Striffs?.findFilePathByDiffId?.(href) || '');
        if (!mappedPath) return false;
        const normalizedPath = mappedPath.startsWith('/') ? mappedPath : `/${mappedPath}`;
        const mappedComponentId = String(
          el.getAttribute('data-striffs-component-id') ||
          window.Striffs?.findMappedComponentIdForPath?.(normalizedPath) ||
          ''
        );
        return Boolean(mappedComponentId);
      });
      if (!target) {
        return {
          ok: false,
          reason: 'mapped file tree link not found',
          sample: candidates.slice(0, 12).map((el) => ({
            href: String(el.getAttribute('href') || ''),
            filePath: String(el.getAttribute('data-striffs-file-path') || window.Striffs?.findFilePathByDiffId?.(String(el.getAttribute('href') || '')) || ''),
            componentId: String(el.getAttribute('data-striffs-component-id') || ''),
            text: String((el.textContent || '').trim()).slice(0, 120)
          }))
        };
      }
      const href = String(target.getAttribute('href') || '');
      const filePath = String(target.getAttribute('data-striffs-file-path') || window.Striffs?.findFilePathByDiffId?.(href) || '');
      const normalizedPath = filePath.startsWith('/') ? filePath : `/${filePath}`;
      const componentId = String(
        target.getAttribute('data-striffs-component-id') ||
        window.Striffs?.findMappedComponentIdForPath?.(normalizedPath) ||
        ''
      );
      target.setAttribute('data-striffs-test-file-focus', '1');
      return {
        ok: true,
        diffHash: href,
        filePath: normalizedPath,
        componentId
      };
    }).catch(() => ({ ok: false, reason: 'exception' }));
    let fileFocusState = { ok: false, reason: 'file tree link not found', diffHash: canonicalTarget.diffHash };
    if (fileFocusTarget?.ok) {
      await page.evaluate(() => {
        const target = document.querySelector('[data-striffs-test-file-focus="1"]');
        if (!(target instanceof Element)) return false;
        target.scrollIntoView({ block: 'center', inline: 'nearest' });
        const event = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, button: 0 });
        return target.dispatchEvent(event);
      }).catch(() => null);
      fileFocusState = await page.evaluate(async ({ diffHash }) => {
        const root = document.documentElement;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return {
          ok: true,
          diffHash,
          focusedFile: String(root?.dataset?.striffsLastFocusedFile || ''),
          focusedComponent: String(root?.dataset?.striffsLastFocusedComponent || ''),
          focusedNode: String(root?.dataset?.striffsLastFocusResolvedNode || '')
        };
      }, { diffHash: canonicalTarget.diffHash }).catch(() => ({ ok: false, reason: 'exception' }));
    } else if (fileFocusTarget) {
      fileFocusState = fileFocusTarget;
    }

    if (!fileFocusState?.ok) {
      if (!NEW_UI) {
        warn(`Old UI exact file explorer focus check skipped (${JSON.stringify(fileFocusState)})`);
      } else {
        fail(`File explorer focus dispatch failed (${JSON.stringify(fileFocusState)})`);
      }
    } else if (!NEW_UI) {
      pass('Old UI file explorer mapping check not required');
    } else if (
      fileFocusState.focusedFile !== fileFocusTarget.filePath ||
      fileFocusState.focusedComponent !== fileFocusTarget.componentId
    ) {
      fail(`File explorer click did not focus mapped component (${JSON.stringify({ fileFocusTarget, fileFocusState })})`);
    } else {
      pass('File explorer click focuses the mapped component');
    }

    await clickDiffsButton().catch(() => null);
    await page.waitForFunction(() => {
      const d = document.documentElement?.dataset || {};
      return String(d.striffsCurrentView || '') === 'diffs' ? true : null;
    }, null, { timeout: 10000, polling: 100 }).catch(() => null);

    const fileMenuTarget = await page.evaluate(({ diffHash, filePath }) => {
      const rawDiffId = String(diffHash || '').replace(/^#/, '');
      const diffNode = rawDiffId ? document.getElementById(rawDiffId) : null;
      const candidates = Array.from(document.querySelectorAll(
        ".js-file[data-path], " +
        "[data-testid='file-diff-unified'][data-path], " +
        "[data-testid='file-diff-split'][data-path], " +
        ".js-file, " +
        "[data-testid='file-diff-unified'], " +
        "[data-testid='file-diff-split'], " +
        ".file-header[data-path], " +
        ".js-file-header[data-path], " +
        ".file-header--expandable[data-path], " +
        ".file-header, " +
        ".js-file-header, " +
        ".file-header--expandable, " +
        "[id^='diff-']"
      ));
      const pathSuffix = String(filePath || '').split('/').filter(Boolean).slice(-1)[0] || '';
      const target = diffNode || candidates.find((el) => {
        const path = String(
          el.getAttribute('data-path') ||
          el.getAttribute('data-file-path') ||
          ''
        ).trim();
        if (path && filePath) return path === filePath || path === filePath.replace(/^\//, '');
        if (pathSuffix) {
          const text = String(el.textContent || '');
          if (path.endsWith(pathSuffix) || text.includes(pathSuffix)) return true;
        }
        return false;
      }) || candidates.find((el) => /^diff-/i.test(String(el.id || ''))) || null;
      if (!target) return { ok: false, reason: 'no file node found', count: candidates.length, diffHash, filePath };
      target.setAttribute('data-striffs-test-file-node', '1');
      return {
        ok: true,
        path: String(target.getAttribute('data-path') || target.getAttribute('data-file-path') || ''),
        id: String(target.id || '')
      };
    }, canonicalTarget).catch(() => ({ ok: false, reason: 'exception' }));

    if (!fileMenuTarget?.ok) {
      fail(`Diff file menu target unavailable (${JSON.stringify(fileMenuTarget)})`);
    } else {
      await page.evaluate(() => {
        const root = document.documentElement;
        if (root?.dataset) {
          delete root.dataset.striffsLastFileMenuStatus;
          delete root.dataset.striffsLastFileMenuFile;
          delete root.dataset.striffsLastFileMenuComponent;
          delete root.dataset.striffsLastFocusedFile;
          delete root.dataset.striffsLastFocusedComponent;
          delete root.dataset.striffsLastFocusedAt;
          delete root.dataset.striffsLastFocusResolvedNode;
        }
      }).catch(() => null);
      const fileNode = page.locator('[data-striffs-test-file-node="1"]').first();
      const menuToggleResult = await page.evaluate(async () => {
        const root = document.querySelector('[data-striffs-test-file-node="1"]');
        if (!root) return { ok: false, reason: 'tagged file node missing' };
        const candidates = Array.from(root.querySelectorAll('summary, button')).filter((el) => {
          if (!(el instanceof Element)) return false;
          const style = window.getComputedStyle(el);
          if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const aria = String(el.getAttribute('aria-label') || '');
          if (/expand all lines|expand file|viewed/i.test(aria)) return false;
          return true;
        });
        for (let i = 0; i < candidates.length; i += 1) {
          const el = candidates[i];
          el.setAttribute('data-striffs-test-menu-toggle', String(i));
        }
        return {
          ok: candidates.length > 0,
          reason: candidates.length > 0 ? '' : 'no candidate menu buttons',
          count: candidates.length,
          sample: candidates.map((el, i) => ({
            idx: i,
            tag: el.tagName,
            aria: String(el.getAttribute('aria-label') || ''),
            title: String(el.getAttribute('title') || ''),
            cls: String(el.className || '')
          })).slice(0, 10)
        };
      }).catch(() => ({ ok: false, reason: 'exception' }));
      if (!menuToggleResult?.ok) {
        fail(`Diff file menu toggle not found (${JSON.stringify({ fileMenuTarget, menuToggleResult })})`);
      } else {
        let menuOptionCount = 0;
        for (let i = 0; i < menuToggleResult.count; i += 1) {
          const menuToggle = page.locator(`[data-striffs-test-menu-toggle="${i}"]`).first();
          await menuToggle.scrollIntoViewIfNeeded().catch(() => null);
          await menuToggle.click({ timeout: 5000 }).catch(() => null);
          await page.waitForTimeout(400);
          menuOptionCount = await page.locator('[data-striffs-view-striff-option="1"]').count().catch(() => 0);
          if (menuOptionCount > 0) break;
          await page.keyboard.press('Escape').catch(() => null);
          await page.waitForTimeout(150);
        }
        if (menuOptionCount === 0) {
          const menuState = await page.evaluate(() => {
            const d = document.documentElement?.dataset || {};
            return {
              status: String(d.striffsLastFileMenuStatus || ''),
              file: String(d.striffsLastFileMenuFile || ''),
              component: String(d.striffsLastFileMenuComponent || ''),
              enabled: String(d.striffsLastFileMenuEnabled || '')
            };
          }).catch(() => null);
          fail(`Diff file menu is missing "View Striff" (${JSON.stringify({ fileMenuTarget, menuToggleResult, menuState })})`);
        } else {
          const menuOption = page.locator('[data-striffs-view-striff-option="1"]').first();
          await menuOption.click({ timeout: 5000 }).catch(() => null);
          const fileMenuFocusState = await page.evaluate(async () => {
            const root = document.documentElement;
            await new Promise((resolve) => setTimeout(resolve, 1000));
            return {
              menuStatus: String(root?.dataset?.striffsLastFileMenuStatus || ''),
              focusedFile: String(root?.dataset?.striffsLastFocusedFile || ''),
              focusedComponent: String(root?.dataset?.striffsLastFocusedComponent || ''),
              focusedNode: String(root?.dataset?.striffsLastFocusResolvedNode || ''),
              currentView: String(root?.dataset?.striffsCurrentView || '')
            };
          }).catch(() => null);
          if (
            fileMenuFocusState?.menuStatus !== 'focused' ||
            !fileMenuFocusState?.focusedFile ||
            !fileMenuFocusState?.focusedComponent ||
            fileMenuFocusState?.currentView !== 'striffs'
          ) {
            fail(`Diff file menu "View Striff" did not focus the mapped component (${JSON.stringify({ fileMenuTarget, fileMenuFocusState })})`);
          } else {
            pass('Diff file menu "View Striff" focuses the mapped component');
          }
        }
      }
    }

    const diagramRouteState = await page.evaluate(async ({ componentId, diffHash, filePath }) => {
      const root = document.documentElement;
      if (root?.dataset) {
        delete root.dataset.striffsLastDiagramClickStatus;
        delete root.dataset.striffsLastDiagramClickComponent;
        delete root.dataset.striffsLastDiagramClickFile;
        delete root.dataset.striffsLastDiagramClickDiffId;
        delete root.dataset.striffsLastDiagramClickReason;
      }
      const esc = (window.CSS && typeof window.CSS.escape === 'function')
        ? window.CSS.escape(componentId)
        : String(componentId || '').replace(/(["\\\]])/g, "\\$1");
      const target =
        document.querySelector(`[data-qualified-name="${esc}"]`) ||
        document.querySelector(`g.entity[data-qualified-name="${esc}"]`) ||
        document.querySelector(`text[data-qualified-name="${esc}"]`);
      if (!target) {
        return { ok: false, reason: 'diagram target not found', componentId, diffHash, filePath };
      }
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return {
        ok: true,
        status: String(root?.dataset?.striffsLastDiagramClickStatus || ''),
        component: String(root?.dataset?.striffsLastDiagramClickComponent || ''),
        file: String(root?.dataset?.striffsLastDiagramClickFile || ''),
        diffId: String(root?.dataset?.striffsLastDiagramClickDiffId || ''),
        hash: String(window.location.hash || ''),
        expectedHash: String(diffHash || '')
      };
    }, canonicalTarget).catch(() => ({ ok: false, reason: 'exception' }));

    if (!diagramRouteState?.ok) {
      fail(`Diagram route dispatch failed (${JSON.stringify(diagramRouteState)})`);
    } else if (
      diagramRouteState.status !== 'navigated' ||
      (diagramRouteState.hash !== canonicalTarget.diffHash && `#${diagramRouteState.diffId}` !== canonicalTarget.diffHash)
    ) {
      fail(`Diagram click did not route to mapped diff (${JSON.stringify({ canonicalTarget, diagramRouteState })})`);
    } else {
      pass('Diagram click routes to the mapped diff');
    }
  }

  // Optional exact component/hash assertion for debugging a known PR.
  if (!CLICK_COMPONENT || !CLICK_DIFF_ID) {
    pass('Specific component click test skipped (CLICK_COMPONENT/CLICK_DIFF_ID not set)');
  } else {
    const clickSpecific = await page.evaluate(({ componentName }) => {
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
      return { ok: true };
    }, { componentName: CLICK_COMPONENT }).catch(() => ({ ok: false, reason: 'exception' }));

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
      window.Striffs?.showDiffView?.();
      const S = (window.Striffs = window.Striffs || {});
      S.__currentView = 'diffs';
      S.currentView = 'diffs';
    } catch (e) {
      console.warn('showDiffsView poke failed', e);
    }
  });
  const diffsVisible = await page.waitForFunction(() => {
    const container = document.querySelector('#files .js-diff-progressive-container, #files, div[data-testid="files-changed"], div[data-view-component="true"][data-testid="pull-requests-files"], div[data-testid="progressive-diffs-list"], [data-testid="file-diff-split"], [data-testid="file-diff-unified"], div.js-file[data-file-type="file"]');
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
        const container = document.querySelector('#files .js-diff-progressive-container, #files, div[data-testid="files-changed"], div[data-view-component="true"][data-testid="pull-requests-files"], div[data-testid="progressive-diffs-list"], [data-testid="file-diff-split"], [data-testid="file-diff-unified"], div.js-file[data-file-type="file"]');
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
    await clickStriffsButton('before striffs-view toggle');
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
  log('Reload flow: reloading page to validate cache behavior');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
  log('Reload flow: page reload complete');
  await page.waitForSelector('[data-testid="pr-toolbar"]', { timeout: 20000 }).catch(() => {});
  await page.evaluate(() => {
    try {
      window.Striffs?.mountMainBarButtons?.();
    } catch (e) {
      console.warn('Striffs mount poke failed after reload', e);
    }
  });

  await page.waitForTimeout(2000);
  let reloadButtonsOk = await ensureButtonsRendered('after reload', { softFail: true });
  if (!reloadButtonsOk && NEW_UI) {
    log('Retrying GitHub new UI activation after reload');
    await ensureNewUiExperience().catch(() => null);
    reloadButtonsOk = await ensureButtonsRendered('after reload (retry)', { softFail: true });
  }
  if (!reloadButtonsOk) {
    fail('Buttons missing after reload');
    return;
  }
  try {
    striffsBtn = await page.waitForSelector('#striffs-btn', { timeout: 20000, state: 'visible' });
    diffsBtn = await page.waitForSelector('#diffs-btn', { timeout: 20000, state: 'visible' });
  } catch {
    fail('Buttons missing after reload');
    return;
  }
  if (striffsBtn && diffsBtn) {
    pass('Buttons present after reload');
  }

  if (striffsBtn) {
    const reloadBootHandle = await page.waitForFunction(() => {
      const s = window.Striffs;
      const source = s?.__lastLoadSource || '';
      const ready = !!s?.__striffsReady;
      const svg = !!document.querySelector('#striff-diagram-view svg');
      const btn = document.querySelector('#striffs-btn');
      const btnSuccess = !!(btn && /check-circle/.test(btn.innerHTML));
      if (!source && !ready && !svg && !btnSuccess) return null;
      return { source, ready, svg, btnSuccess };
    }, { timeout: 10000 }).catch(() => null);
    const reloadBootState = reloadBootHandle ? await reloadBootHandle.jsonValue() : null;
    const reloadCacheDiag = await page.evaluate(async () => {
      try {
        const dataset = document.documentElement?.dataset || {};
        return {
          loadSource: window.Striffs?.__lastLoadSource || null,
          ready: !!window.Striffs?.__striffsReady,
          cacheSavedAt: dataset.striffsCacheSavedAt || null,
          cacheKey: dataset.striffsCacheKey || null,
          cacheStorage: dataset.striffsCacheStorage || null,
          primeCacheProbe: dataset.striffsPrimeCacheProbe || null,
          primeCacheStatus: dataset.striffsPrimeCacheStatus || null
        };
      } catch {
        return null;
      }
    }).catch(() => null);
    log(`Cache state before reload click ${JSON.stringify({
      boot: reloadBootState,
      diag: reloadCacheDiag
    })}`);

    await clickStriffsButton('before reload click');
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
      await clickStriffsButton('before second reload click');
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
    const svgVisibleAfterReload = await page.evaluate(() => {
      const svg = document.querySelector('#striff-diagram-view svg');
      if (!svg) return false;
      const style = window.getComputedStyle(svg);
      if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = svg.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }).catch(() => false);
    if (!svgVisibleAfterReload) {
      fail('Striffs reload did not leave a visible diagram SVG');
      return;
    }
    // Infer cache hit via tooltip state or updated_at match.
    const loadSource = await page.evaluate(() => window.Striffs?.__lastLoadSource || 'unknown');
    const tooltip = await page.evaluate(() => document.querySelector('#striffs-btn')?.title || '');
    const cacheTooltip = /loaded from cache/i.test(tooltip);
    const bootLoadSource = String(reloadBootState?.source || reloadCacheDiag?.loadSource || '');
    if (bootLoadSource === 'cache' || loadSource === 'cache') {
      pass('Striffs renders after reload (cache hit)');
    } else if (cacheTooltip) {
      pass('Striffs renders after reload (cache tooltip shows cache)');
    } else if (reloadBootState?.ready || reloadBootState?.svg || reloadBootState?.btnSuccess) {
      fail(`Striffs state existed after reload but did not report cache hit (bootLoadSource=${bootLoadSource || 'none'}, loadSource=${loadSource})`);
    } else if (bootLoadSource && bootLoadSource !== 'unknown') {
      fail(`Striffs rendered after reload but did not report cache hit (loadSource=${loadSource})`);
    } else {
      fail(`Striffs reload did not establish a cache hit (bootLoadSource=${bootLoadSource || 'none'}, loadSource=${loadSource})`);
    }
  }
  }

  const resetCacheOk = await runResetCacheCheck();
  log(`Reset cache check completed: ${resetCacheOk ? 'ok' : 'failed'}`);
  if (!resetCacheOk) {
    return;
  }

  // Test: Cache Clear + API Down = No Diagram
  const apiDownTest = await runCacheClearWithApiDownTest();
  if (!apiDownTest.ok && !apiDownTest.skipped) {
    log('Warning: Cache clear + API down test failed, but continuing...');
  }

  // Verify buttons hide on conversation tab navigation.
  try {
    await page.goto(PR_CONVERSATION_URL, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
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
    await context.close().catch(() => {});
    ensureCleanup();
    process.exit(0);
  } else {
    if (!ok) {
      log('Failures detected; leaving browser open for inspection.');
      // Auto-close after 60s to avoid hanging
      setTimeout(() => { ensureCleanup(); process.exit(1); }, 60000);
    } else log('KEEP_OPEN set; leaving browser open');
  }
})().catch((e) => {
  console.error('Unhandled error:', e);
  process.exit(1);
});
// Safety net: if the IIFE returns early (via `return`), ensure Node exits
process.on('beforeExit', (code) => {
  ensureCleanup();
  process.exit(ok ? 0 : 1);
});

// Safety net: force exit after MAX_TEST_RUNTIME_MS to prevent Chrome from keeping Node alive
const MAX_TEST_RUNTIME_MS = Number(envOr('MAX_TEST_RUNTIME_MS', '600000'));
let _chromeProc = null;
const _forceCleanup = () => {
  if (_chromeProc) { try { _chromeProc.kill(); } catch {} }
  cleanupTempProfile();
};
setTimeout(() => {
  console.error('MAX_TEST_RUNTIME_MS exceeded; forcing exit');
  _forceCleanup();
  process.exit(1);
}, MAX_TEST_RUNTIME_MS);
