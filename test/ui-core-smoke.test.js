const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const prMetadataBundlePath = path.join(__dirname, '..', 'src', 'pr-metadata-utils.js');
const bundlePath = path.join(__dirname, '..', 'src', 'striffs.js');
const bundleSource = [
  fs.readFileSync(prMetadataBundlePath, 'utf8'),
  fs.readFileSync(bundlePath, 'utf8')
].join('\n');
const UI_SMOKE_SKIP_CODE = 'UI_SMOKE_SKIPPED';
const BROWSER_LAUNCH_TIMEOUT_MS = 60000;
const CASE_RETRY_COUNT = 1;

function createUiSmokeSkipError(reason, cause) {
  const error = new Error(reason);
  error.code = UI_SMOKE_SKIP_CODE;
  if (cause) error.cause = cause;
  return error;
}

function shouldSkipUiSmokeError(error) {
  const message = String(error?.message || error);
  return error?.code === UI_SMOKE_SKIP_CODE
    || (error?.code === 'MODULE_NOT_FOUND' && /playwright/i.test(message))
    || /Executable doesn't exist/i.test(message)
    || /Please run(?:.|\n)*playwright install/i.test(message);
}

function getChromium() {
  try {
    return require('playwright').chromium;
  } catch (error) {
    throw createUiSmokeSkipError('Playwright is not installed. Skipping UI smoke test.', error);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ENABLED_REMOTE_CONFIG = {
  disableStriffs: false,
  message: '',
  supportedLanguages: 'java,typescript,python'
};

const DISABLED_REMOTE_CONFIG = {
  disableStriffs: true,
  message: 'Striffs disabled for maintenance',
  supportedLanguages: 'java,typescript,python'
};

const VALID_RESULT = {
  operationId: 'op-123',
  engagementWriteToken: 'eng-token-123',
  striffs: [
    {
      svgCode: [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 240">',
        '  <g class="entity" data-qualified-name="com.example.Widget">',
        '    <rect x="20" y="20" width="150" height="64" fill="#ffffff" stroke="#1f2937" stroke-width="2"></rect>',
        '    <text data-qualified-name="com.example.Widget" x="36" y="58">Widget</text>',
        '  </g>',
        '  <g class="entity" data-qualified-name="app-entrypoint">',
        '    <rect x="220" y="124" width="150" height="64" fill="#ffffff" stroke="#1f2937" stroke-width="2"></rect>',
        '    <text data-qualified-name="app-entrypoint" x="236" y="162">EntryPoint</text>',
        '  </g>',
        '</svg>'
      ].join('\n'),
      diagramComponents: [
        {
          uniqueName: 'com.example.Widget',
          sourceFile: 'src/main/java/com/example/Widget.java'
        },
        {
          uniqueName: 'app.entrypoint',
          sourceFile: 'src/index.ts'
        }
      ]
    }
  ]
};

const INVALID_MISSING_OPERATION_RESULT = {
  engagementWriteToken: 'eng-token-123',
  striffs: VALID_RESULT.striffs
};

const NO_CHANGES_RESULT = {
  operationId: 'op-empty',
  engagementWriteToken: 'eng-empty',
  striffs: []
};

function renderFixtureHtml({ unsupported = false, headerPathOnly = false } = {}) {
  const treeItems = unsupported
    ? [
        '<li id="file-tree-item-diff-readme" data-tree-entry-type="file">',
        '  <a class="ActionList-content" href="#diff-readme">',
        '    <span data-filterable-item-text>README.md</span>',
        '  </a>',
        '</li>'
      ].join('\n')
    : [
        '<li id="file-tree-item-diff-widget" data-tree-entry-type="file">',
        '  <a class="ActionList-content" href="#diff-widget">',
        '    <span data-filterable-item-text>src/main/java/com/example/Widget.java</span>',
        '  </a>',
        '</li>',
        '<li id="file-tree-item-diff-entry" data-tree-entry-type="file">',
        '  <a class="ActionList-content" href="#diff-entry">',
        '    <span data-filterable-item-text>src/index.ts</span>',
        '  </a>',
        '</li>',
        '<li id="file-tree-item-diff-readme" data-tree-entry-type="file">',
        '  <a class="ActionList-content" href="#diff-readme">',
        '    <span data-filterable-item-text>README.md</span>',
        '  </a>',
        '</li>'
      ].join('\n');

  const renderFileMenu = (viewHref) =>
    [
      '      <details class="js-file-header-dropdown dropdown details-overlay details-reset pr-2 pl-2">',
      '        <summary class="height-full striffs-file-menu-trigger" aria-haspopup="menu" role="button">',
      '          <div class="height-full d-flex flex-items-center Link--secondary">...</div>',
      '        </summary>',
      '        <details-menu class="dropdown-menu dropdown-menu-sw show-more-popover color-fg-default position-absolute f5 striffs-file-options-menu" role="menu">',
      '          <label role="menuitemradio" class="dropdown-item btn-link text-normal d-block tmp-pl-5" tabindex="0" aria-checked="true">Show comments</label>',
      '          <div role="none" class="dropdown-divider"></div>',
      `          <a href="${viewHref}" class="tmp-pl-5 dropdown-item btn-link" rel="nofollow" role="menuitem">View file</a>`,
      '          <button type="button" disabled role="menuitem" class="tmp-pl-5 dropdown-item btn-link">Edit file</button>',
      '          <button type="button" disabled role="menuitem" class="tmp-pl-5 dropdown-item btn-link">Delete file</button>',
      '        </details-menu>',
      '      </details>'
    ].join('\n');

  const renderDiffFile = ({ id, path: filePath, label, body }) =>
    [
      `  <div id="${id}" class="js-file" data-file-type="file"${headerPathOnly ? '' : ` data-path="${filePath}"`}>`,
      `    <div data-testid="file-header" class="file-header js-file-header file-header--expandable"${headerPathOnly ? ` data-path="${filePath}"` : ''}><a class="Link--primary" title="${label}">${label}</a>`,
      renderFileMenu(`/inclusionAI/AReaL/blob/mock/${filePath}`),
      '    </div>',
      `    <div class="blob-wrapper">${body}</div>`,
      '  </div>'
    ].join('\n');

  const unsupportedFile = renderDiffFile({
    id: 'diff-readme',
    path: 'README.md',
    label: 'README.md',
    body: 'README diff'
  });

  const supportedFiles = [
    renderDiffFile({
      id: 'diff-widget',
      path: 'src/main/java/com/example/Widget.java',
      label: 'src/main/java/com/example/Widget.java',
      body: 'Widget diff'
    }),
    renderDiffFile({
      id: 'diff-entry',
      path: 'src/index.ts',
      label: 'src/index.ts',
      body: 'Entry diff'
    }),
    renderDiffFile({
      id: 'diff-readme',
      path: 'README.md',
      label: 'README.md',
      body: 'README diff'
    })
  ].join('\n');

  const diffFiles = [
    '<div class="js-diff-progressive-container">',
    unsupported ? unsupportedFile : supportedFiles,
    '</div>'
  ].join('\n');

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <meta name="octolytics-dimension-pull_request_updated_at" content="2026-03-07T00:00:00Z">',
    '  <meta name="octolytics-dimension-repository_public" content="true">',
    '  <title>Striffs UI Harness</title>',
    '  <style>',
    '    body { margin: 0; font-family: Arial, sans-serif; background: #f6f8fa; color: #24292f; }',
    '    [data-testid="pr-toolbar"] { display: flex; align-items: center; gap: 12px; padding: 16px 24px; border-bottom: 1px solid #d0d7de; background: #fff; }',
    '    .toolbar-row { display: flex; align-items: center; gap: 12px; width: 100%; }',
    '    .toolbar-actions { display: inline-flex; align-items: center; gap: 8px; }',
    '    [data-testid="file-tree"] { padding: 16px 24px 0; }',
    '    [data-testid="file-tree"] ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }',
    '    [data-testid="file-tree"] a { color: #0969da; text-decoration: none; }',
    '    [data-testid="files-changed"] { padding: 16px 24px 32px; }',
    '    #files { display: grid; gap: 12px; }',
    '    .js-file { border: 1px solid #d0d7de; border-radius: 6px; background: #fff; overflow: hidden; }',
    '    .blob-wrapper { padding: 16px; min-height: 88px; border-top: 1px solid #d8dee4; }',
    '    [data-testid="file-header"] { padding: 12px 16px; background: #f6f8fa; font-weight: 600; display:flex; align-items:center; justify-content:space-between; gap:12px; }',
    '    .js-file-header-dropdown { position: relative; }',
    '    .striffs-file-menu-trigger { border: 1px solid #d0d7de; background:#fff; border-radius: 4px; cursor:pointer; padding:2px 6px; }',
    '    .striffs-file-options-menu { position:absolute; right:0; top:26px; z-index:20; background:#fff; border:1px solid #d0d7de; border-radius:6px; min-width: 185px; margin:0; display:none; }',
    '    .js-file-header-dropdown[open] .striffs-file-options-menu { display:block; }',
    '    .dropdown-item.btn-link { display:block; width:100%; text-align:left; border:0; background:#fff; padding:6px 10px; cursor:pointer; color:#24292f; text-decoration:none; font-size:13px; }',
    '    .dropdown-item.btn-link[disabled] { opacity:0.5; cursor:not-allowed; }',
    '    .dropdown-divider { height:1px; margin:4px 0; background:#d8dee4; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <div data-testid="pr-toolbar">',
    '    <div class="toolbar-row">',
    '      <div class="toolbar-actions">',
    '        <span class="ViewedFileProgress-module__FilesCountText">3 / 3 viewed</span>',
    '        <span id="commits_tab_counter" style="display:none"></span>',
    '      </div>',
    '    </div>',
    '  </div>',
    '  <div data-testid="file-tree">',
    '    <ul>',
         treeItems,
    '    </ul>',
    '  </div>',
    '  <div data-testid="files-changed">',
    '    <div id="files">',
         diffFiles,
    '    </div>',
    '  </div>',
    '  <script>',
    '    (() => {',
    '      try {',
    "        const key = '__striffsFixtureReloadCount';",
    "        const prev = Number(sessionStorage.getItem(key) || '0');",
    '        const next = prev + 1;',
    '        sessionStorage.setItem(key, String(next));',
    "        const commitCount = next > 1 ? '2' : '';",
    "        const el = document.getElementById('commits_tab_counter');",
    '        if (el) {',
    '          el.textContent = commitCount;',
    "          if (commitCount) el.setAttribute('title', commitCount);",
    "          else el.removeAttribute('title');",
    '        }',
    '      } catch {}',
    '    })();',
    '  </script>',
    '  <script src="/bundle.js"></script>',
    '</body>',
    '</html>'
  ].join('\n');
}

async function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/bundle.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(bundleSource);
      return;
    }
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
  const unsupported = url.searchParams.get('fixture') === 'unsupported';
  const headerPathOnly = url.searchParams.get('fixture') === 'header-path';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderFixtureHtml({ unsupported, headerPathOnly }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

async function installHarness(context, { mode }) {
  await context.addInitScript(
    ({ currentMode, validResult, invalidResult, noChangesResult, enabledConfig, disabledConfig }) => {
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const loadJson = (key, fallback) => {
        try {
          const raw = sessionStorage.getItem(key);
          return raw ? JSON.parse(raw) : clone(fallback);
        } catch {
          return clone(fallback);
        }
      };
      const saveJson = (key, value) => {
        try {
          sessionStorage.setItem(key, JSON.stringify(value));
        } catch {}
      };
      const pick = (store, keys) => {
        if (keys == null) return clone(store);
        if (Array.isArray(keys)) {
          const out = {};
          for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(store, key)) out[key] = store[key];
          }
          return out;
        }
        if (typeof keys === 'string') {
          return Object.prototype.hasOwnProperty.call(store, keys) ? { [keys]: store[keys] } : {};
        }
        if (typeof keys === 'object') {
          const out = {};
          for (const [key, fallback] of Object.entries(keys)) {
            out[key] = Object.prototype.hasOwnProperty.call(store, key) ? store[key] : fallback;
          }
          return out;
        }
        return {};
      };

      const localData = loadJson('__striffsHarnessLocalStore', { ghToken: 'gh-test' });
      if (!localData.ghToken) localData.ghToken = 'gh-test';
      const syncData = loadJson('__striffsHarnessSyncStore', {});
      const currentReloadCount = Number(sessionStorage.getItem('__striffsFixtureReloadCount') || '1');
      const persistedHarness = loadJson('__striffsHarnessState', {
        fetchStriffsCalls: 0,
        generateStriffsCalls: 0,
        sentMessages: [],
        engagementCalls: [],
        activeOperationId: '',
        activeEngagementToken: '',
        activeOperationReloadCount: 0
      });
      const storageListeners = [];
      const harness = {
        mode: currentMode,
        fetchStriffsCalls: Number(persistedHarness.fetchStriffsCalls || 0),
        generateStriffsCalls: Number(persistedHarness.generateStriffsCalls || 0),
        sentMessages: Array.isArray(persistedHarness.sentMessages) ? persistedHarness.sentMessages : [],
        engagementCalls: Array.isArray(persistedHarness.engagementCalls) ? persistedHarness.engagementCalls : [],
        activeOperationId: String(persistedHarness.activeOperationId || ''),
        activeEngagementToken: String(persistedHarness.activeEngagementToken || ''),
        activeOperationReloadCount: Number(persistedHarness.activeOperationReloadCount || 0)
      };

      const persistStores = () => {
        saveJson('__striffsHarnessLocalStore', localData);
        saveJson('__striffsHarnessSyncStore', syncData);
      };
      const persistHarness = () => {
        saveJson('__striffsHarnessState', {
          fetchStriffsCalls: harness.fetchStriffsCalls,
          generateStriffsCalls: harness.generateStriffsCalls,
          sentMessages: harness.sentMessages,
          engagementCalls: harness.engagementCalls,
          activeOperationId: harness.activeOperationId,
          activeEngagementToken: harness.activeEngagementToken,
          activeOperationReloadCount: harness.activeOperationReloadCount
        });
      };
      const notifyStorageListeners = (areaName, changes) => {
        if (!changes || Object.keys(changes).length === 0) return;
        for (const listener of storageListeners) {
          try {
            listener(changes, areaName);
          } catch {}
        }
      };
      const makeArea = (store, areaName) => ({
        get(keys, callback) {
          const result = pick(store, keys);
          if (typeof callback === 'function') setTimeout(() => callback(result), 0);
          return Promise.resolve(result);
        },
        set(items, callback) {
          const changes = {};
          for (const [key, value] of Object.entries(items || {})) {
            const oldValue = Object.prototype.hasOwnProperty.call(store, key) ? store[key] : undefined;
            store[key] = value;
            changes[key] = { oldValue, newValue: value };
          }
          persistStores();
          notifyStorageListeners(areaName, changes);
          if (typeof callback === 'function') setTimeout(callback, 0);
          return Promise.resolve();
        },
        remove(keys, callback) {
          const list = Array.isArray(keys) ? keys : [keys];
          const changes = {};
          for (const key of list) {
            if (!Object.prototype.hasOwnProperty.call(store, key)) continue;
            changes[key] = { oldValue: store[key], newValue: undefined };
            delete store[key];
          }
          persistStores();
          notifyStorageListeners(areaName, changes);
          if (typeof callback === 'function') setTimeout(callback, 0);
          return Promise.resolve();
        }
      });

      const localArea = makeArea(localData, 'local');
      const syncArea = makeArea(syncData, 'sync');

      const clearHarnessCaches = () => {
        try {
          const removeKeys = (store) => {
            const keys = [];
            for (let i = 0; i < store.length; i += 1) {
              const key = store.key(i);
              if (key && key.toLowerCase().startsWith('striffs')) keys.push(key);
            }
            keys.forEach((key) => store.removeItem(key));
          };
          removeKeys(localStorage);
          removeKeys(sessionStorage);
        } catch {}
        for (const key of Object.keys(localData)) {
          if (key === 'ghToken') continue;
          delete localData[key];
        }
        for (const key of Object.keys(syncData)) delete syncData[key];
        persistStores();
        return { ok: true };
      };

      const mintStriffsResult = (baseResponseJson) => {
        const requestCount = Number(harness.fetchStriffsCalls || 0) + Number(harness.generateStriffsCalls || 0);
        const opSuffix = String(requestCount);
        harness.activeOperationId = `op-${opSuffix}`;
        harness.activeEngagementToken = `eng-token-${opSuffix}`;
        harness.activeOperationReloadCount = currentReloadCount;
        persistHarness();
        const responseJson = clone(baseResponseJson);
        if (currentMode !== 'invalid-missing-operation') {
          responseJson.operationId = harness.activeOperationId;
          responseJson.engagementWriteToken = harness.activeEngagementToken;
        }
        return responseJson;
      };

      const handlers = {
        ping: () => ({ ok: true, pong: true, ts: Date.now() }),
        fetchRemoteConfig: () => ({
          ok: true,
          status: 200,
          json: clone(currentMode === 'remote-disabled' ? disabledConfig : enabledConfig)
        }),
        fetchSupportedLanguages: () => ({
          ok: true,
          text: 'java,typescript,python'
        }),
        getSupportedLanguagesCache: () => ({ ok: true, cached: {} }),
        fetchStriffsWithToken: () => {
          harness.fetchStriffsCalls += 1;
          const baseResponseJson =
            currentMode === 'invalid-missing-operation' ? invalidResult :
            currentMode === 'no-changes' ? noChangesResult :
            validResult;
          const responseJson = mintStriffsResult(baseResponseJson);
          const response = {
            ok: true,
            json: responseJson,
            timings: { type: 'token', durationMs: 8, status: 200 }
          };
          if (currentMode === 'delayed-valid') {
            return new Promise((resolve) => setTimeout(() => resolve(response), 250));
          }
          return response;
        },
        generateStriffs: () => {
          harness.generateStriffsCalls += 1;
          const baseResponseJson =
            currentMode === 'invalid-missing-operation' ? invalidResult :
            currentMode === 'no-changes' ? noChangesResult :
            validResult;
          const responseJson = mintStriffsResult(baseResponseJson);
          const response = {
            ok: true,
            json: responseJson,
            timings: { type: 'generate', durationMs: 12, status: 200 }
          };
          if (currentMode === 'delayed-valid') {
            return new Promise((resolve) => setTimeout(() => resolve(response), 250));
          }
          return response;
        },
        clearStriffsCaches: () => clearHarnessCaches(),
        recordEngagementEvent: (msg) => {
          const op = String(msg?.operationId || '');
          const token = String(msg?.engagementToken || '');
          const matchesActiveOperation =
            op &&
            token &&
            op === harness.activeOperationId &&
            token === harness.activeEngagementToken &&
            harness.activeOperationReloadCount === currentReloadCount;
          if (!matchesActiveOperation) {
            return {
              ok: false,
              status: 404,
              error: 'HTTP 404',
              body: '{"errorMessage":"Unknown operation id."}'
            };
          }
          harness.engagementCalls.push(clone(msg));
          persistHarness();
          return {
            ok: true,
            status: 200,
            json: {
              stored: true,
              id: `evt-${harness.engagementCalls.length}`
            }
          };
        }
      };

      const runtime = {
        lastError: null,
        sendMessage(msg, callback) {
          const safeMsg = clone(msg || {});
          harness.sentMessages.push(safeMsg);
          persistHarness();
          const handler = handlers[safeMsg.type];
          const response = handler
            ? handler(safeMsg)
            : { ok: false, error: `unknown message type ${safeMsg.type || ''}`.trim() };
          if (typeof callback === 'function') setTimeout(() => callback(response), 0);
          return true;
        }
      };

      Object.defineProperty(window, 'chrome', {
        configurable: true,
        value: {
          runtime,
          storage: {
            local: localArea,
            sync: syncArea,
            onChanged: {
              addListener(listener) {
                storageListeners.push(listener);
              }
            }
          }
        }
      });

      window.__striffsHarness = harness;
      window.__STRIFFS_DEBUG = true;
      try {
        localStorage.setItem('striffsTest', '1');
      } catch {}
    },
    {
      currentMode: mode,
      validResult: VALID_RESULT,
      invalidResult: INVALID_MISSING_OPERATION_RESULT,
      noChangesResult: NO_CHANGES_RESULT,
      enabledConfig: ENABLED_REMOTE_CONFIG,
      disabledConfig: DISABLED_REMOTE_CONFIG
    }
  );
}

async function launchBrowser() {
  const chromium = getChromium();
  try {
    return await chromium.launch({ headless: true, timeout: BROWSER_LAUNCH_TIMEOUT_MS });
  } catch (error) {
    if (shouldSkipUiSmokeError(error)) {
      throw createUiSmokeSkipError('Playwright Chromium is unavailable. Skipping UI smoke test.', error);
    }
    const wrapped = new Error(
      `Playwright Chromium launch failed. Install Chromium with "npx playwright install chromium" if needed. Original error: ${error.message}`
    );
    wrapped.cause = error;
    throw wrapped;
  }
}

async function openFixture(browser, baseUrl, { mode = 'valid', unsupported = false, headerPathOnly = false } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }
  });
  await installHarness(context, { mode });
  const page = await context.newPage();
  const url = new URL('/acme/widgets/pull/1/files', baseUrl);
  if (unsupported) url.searchParams.set('fixture', 'unsupported');
  if (headerPathOnly) url.searchParams.set('fixture', 'header-path');
  await page.goto(url.toString(), { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#striffs-btn', { timeout: 30000 });
  await page.waitForSelector('#diffs-btn', { timeout: 30000 });
  return { context, page };
}

async function waitForJson(handlePromise) {
  const handle = await handlePromise;
  return handle ? handle.jsonValue() : null;
}

function isRetryableUiSmokeError(error) {
  const message = String(error?.message || error);
  return /Timeout/i.test(message)
    || /Target page, context or browser has been closed/i.test(message)
    || /Navigation failed/i.test(message)
    || /locator\.[^(]+\(/i.test(message);
}

async function runSmokeCase(name, browser, baseUrl, testFn) {
  let lastError = null;
  for (let attempt = 1; attempt <= CASE_RETRY_COUNT + 1; attempt += 1) {
    try {
      await testFn(browser, baseUrl);
      return;
    } catch (error) {
      lastError = error;
      if (shouldSkipUiSmokeError(error)) throw error;
      const retryable = isRetryableUiSmokeError(error);
      if (!retryable || attempt > CASE_RETRY_COUNT) {
        error.message = `[${name}] ${error.message}`;
        throw error;
      }
      console.warn(`[ui smoke] ${name} failed on attempt ${attempt}; retrying once`);
      await delay(500);
    }
  }
  throw lastError;
}

async function testRemoteDisableFlow(browser, baseUrl) {
  const { context, page } = await openFixture(browser, baseUrl, { mode: 'remote-disabled' });
  try {
    const disabledState = await waitForJson(
      page.waitForFunction(() => {
        const S = window.Striffs;
        const btn = document.querySelector('#striffs-btn');
        if (!btn) return null;
        if (!btn.disabled || !S?.__disabledByRemote) return null;
        return {
          disabled: btn.disabled === true,
          classDisabled: btn.classList.contains('is-disabled'),
          title: btn.title || '',
          opacity: window.getComputedStyle(btn).opacity || '',
          remoteDisabled: Boolean(S.__disabledByRemote)
        };
      }, null, { timeout: 10000 })
    ).catch(() => null);

    if (!disabledState) {
      const diag = await page.evaluate(() => {
        const btn = document.querySelector('#striffs-btn');
        return {
          buttonFound: Boolean(btn),
          disabled: btn ? btn.disabled === true : false,
          classDisabled: btn ? btn.classList.contains('is-disabled') : false,
          title: btn?.title || '',
          opacity: btn ? window.getComputedStyle(btn).opacity || '' : '',
          remoteDisabled: Boolean(window.Striffs?.__disabledByRemote),
          remoteConfig: window.Striffs?.__remoteConfig || null,
          remoteConfigError: window.Striffs?.__remoteConfigFetchError || null,
          lastState: window.Striffs?.__lastStriffsButtonState || null
        };
      });
      assert.fail(`expected Striffs button to be disabled by remote config: ${JSON.stringify(diag)}`);
    }
    assert.strictEqual(disabledState.disabled, true);
    assert.strictEqual(disabledState.remoteDisabled, true);
    assert.match(disabledState.title, /maintenance/i);
    assert.ok(Number(disabledState.opacity) <= 0.7, 'expected disabled button to be greyed out');

    await page.click('#striffs-btn').catch(() => {});
    const fetchCalls = await page.evaluate(() => window.__striffsHarness?.fetchStriffsCalls || 0);
    assert.strictEqual(fetchCalls, 0, 'disabled button should not trigger Striffs generation');
  } finally {
    await context.close();
  }
}

async function testEnsureStriffContainerIsIdempotent(browser, baseUrl) {
  const { context, page } = await openFixture(browser, baseUrl, { mode: 'valid' });
  try {
    const state = await page.evaluate(() => {
      const first = window.Striffs?.ensureStriffContainer?.();
      const second = window.Striffs?.ensureStriffContainer?.();
      return {
        sameReference: first === second,
        viewCount: document.querySelectorAll('#striff-diagram-view').length,
        scrollCount: document.querySelectorAll('#striffs-scroll').length,
        contentCount: document.querySelectorAll('#striffs-content').length,
        controlsWrapCount: document.querySelectorAll('#striffs-controls-wrap').length,
        guideCount: document.querySelectorAll('#striffs-guide-btn').length,
        downloadCount: document.querySelectorAll('#striffs-download-btn').length
      };
    });

    assert.ok(state, 'expected idempotent container state');
    assert.strictEqual(state.sameReference, true);
    assert.strictEqual(state.viewCount, 1);
    assert.strictEqual(state.scrollCount, 1);
    assert.strictEqual(state.contentCount, 1);
    assert.strictEqual(state.controlsWrapCount, 1);
    assert.strictEqual(state.guideCount, 1);
    assert.strictEqual(state.downloadCount, 1);
  } finally {
    await context.close();
  }
}

async function testValidRenderTelemetryAndCache(browser, baseUrl) {
  const { context, page } = await openFixture(browser, baseUrl, { mode: 'valid' });
  try {
    const initialState = await page.evaluate(() => {
      const btn = document.querySelector('#striffs-btn');
      return btn ? { disabled: btn.disabled === true, title: btn.title || '' } : null;
    });
    assert.ok(initialState, 'expected Striffs button to render');
    assert.strictEqual(initialState.disabled, false);

    await page.click('#striffs-btn');

    const readyState = await waitForJson(
      page.waitForFunction(() => {
        const S = window.Striffs;
        if (!S?.__striffsReady) return null;
        const svg = document.querySelector('#striffs-content svg');
        if (!svg) return null;
        const ctx = S.__engagementCtx || {};
        const counters = S.getEngagementCounters?.() || {};
        return {
          ready: Boolean(S.__striffsReady),
          hasSvg: Boolean(svg),
          operationId: String(ctx.operationId || ''),
          engagementWriteToken: String(ctx.engagementWriteToken || ''),
          mappedCount: document.querySelectorAll("li[data-striffs-mapped='1']").length,
          disabledCount: document.querySelectorAll('li.striffs-file-disabled').length,
          diffMapSize: Number(document.documentElement.dataset.striffsDiffToComponentSize || 0),
          lastLoadSource: S.__lastLoadSource || null,
          counters
        };
      }, null, { timeout: 15000 })
    );

    assert.ok(readyState, 'expected Striffs render to complete');
    assert.strictEqual(readyState.ready, true);
    assert.strictEqual(readyState.hasSvg, true);
    assert.strictEqual(readyState.operationId, 'op-1');
    assert.strictEqual(readyState.engagementWriteToken, 'eng-token-1');
    assert.ok(readyState.mappedCount >= 2, 'expected mapped file-tree items after render');
    assert.ok(readyState.disabledCount >= 1, 'expected unmapped file-tree items to be disabled in Striffs view');
    assert.ok(readyState.diffMapSize >= 2, 'expected diff-to-component mapping to be populated');
    assert.ok(
      readyState.lastLoadSource === 'fresh' || readyState.lastLoadSource === 'cache',
      `unexpected initial load source ${readyState.lastLoadSource}`
    );

    await page.click('#file-tree-item-diff-widget a.ActionList-content');
    const fileTreeTelemetryState = await waitForJson(
      page.waitForFunction(() => {
        const calls = window.__striffsHarness?.engagementCalls || [];
        const hit = calls.find(
          (call) => call?.payload?.eventType === 'file_explorer_item_clicked_in_striffs_view'
        );
        if (!hit) return null;
        return {
          currentView: String(window.Striffs?.getCurrentView?.() || ''),
          event: hit?.payload?.event || null
        };
      }, null, { timeout: 8000 })
    );

    assert.ok(fileTreeTelemetryState, 'expected file-tree click telemetry in Striffs view');
    assert.strictEqual(fileTreeTelemetryState.currentView, 'striffs');
    assert.strictEqual(fileTreeTelemetryState.event?.filePath, '/src/main/java/com/example/Widget.java');
    assert.strictEqual(fileTreeTelemetryState.event?.mappedComponentId, 'com.example.Widget');
    assert.strictEqual(fileTreeTelemetryState.event?.hasMappedComponent, true);

    const striffView = page.locator('#striff-diagram-view');
    const striffViewBox = await striffView.boundingBox();
    assert.ok(striffViewBox, 'expected Striffs view bounding box for pan/zoom telemetry');
    const centerX = striffViewBox.x + (striffViewBox.width / 2);
    const centerY = striffViewBox.y + (striffViewBox.height / 2);

    await page.mouse.move(centerX, centerY);
    await page.mouse.wheel(0, -200);
    const zoomTelemetryState = await waitForJson(
      page.waitForFunction(() => {
        const calls = window.__striffsHarness?.engagementCalls || [];
        const zoomEvent = calls.find(
          (call) => call?.payload?.eventType === 'pan_zoom_operation'
            && call?.payload?.event?.operation === 'zoom'
        );
        if (!zoomEvent) return null;
        return zoomEvent.payload.event || null;
      }, null, { timeout: 8000 })
    );

    assert.ok(zoomTelemetryState, 'expected zoom telemetry event');
    assert.strictEqual(zoomTelemetryState.operation, 'zoom');
    assert.ok(Number(zoomTelemetryState.wheelSteps || 0) >= 1, 'expected zoom telemetry to record wheel steps');

    await page.mouse.move(centerX, centerY);
    await page.mouse.down();
    await page.mouse.move(centerX + 60, centerY + 35, { steps: 6 });
    await page.mouse.up();
    const panTelemetryState = await waitForJson(
      page.waitForFunction(() => {
        const calls = window.__striffsHarness?.engagementCalls || [];
        const panEvent = calls.find(
          (call) => call?.payload?.eventType === 'pan_zoom_operation'
            && call?.payload?.event?.operation === 'pan'
        );
        if (!panEvent) return null;
        return panEvent.payload.event || null;
      }, null, { timeout: 8000 })
    );

    assert.ok(panTelemetryState, 'expected pan telemetry event');
    assert.strictEqual(panTelemetryState.operation, 'pan');
    assert.ok(Number(panTelemetryState.distancePx || 0) > 10, 'expected pan telemetry to record distance');

    await page.click('#diffs-btn');
    await page.click('#striffs-btn');
    await page.waitForTimeout(350);
    await page.locator('g.entity[data-qualified-name="com.example.Widget"]').click({ force: true });
    const navigationState = await waitForJson(
      page.waitForFunction(() => {
        const d = document.documentElement?.dataset || {};
        if (String(d.striffsLastDiagramClickStatus || '') !== 'navigated') return null;
        return {
          hash: String(window.location.hash || ''),
          currentView: String(window.Striffs?.getCurrentView?.() || d.striffsCurrentView || ''),
          status: String(d.striffsLastDiagramClickStatus || ''),
          componentId: String(d.striffsLastDiagramClickComponent || ''),
          diffId: String(d.striffsLastDiagramClickDiffId || ''),
          diffElementFound: d.striffsLastDiagramClickDiffElementFound === '1'
        };
      }, null, { timeout: 8000 })
    );

    assert.ok(navigationState, 'expected mapped diagram click to produce navigation debug state');
    assert.strictEqual(navigationState.status, 'navigated');
    assert.strictEqual(navigationState.currentView, 'diffs');
    assert.strictEqual(navigationState.hash, '#diff-widget');
    assert.strictEqual(navigationState.componentId, 'com.example.Widget');
    assert.strictEqual(navigationState.diffId, 'diff-widget');
    assert.strictEqual(navigationState.diffElementFound, true);

    const engagementState = await waitForJson(
      page.waitForFunction(() => {
        const S = window.Striffs;
        const counters = S?.getEngagementCounters?.();
        const calls = window.__striffsHarness?.engagementCalls || [];
        const eventTypes = calls.map((call) => call?.payload?.eventType || null);
        const panZoomOperations = calls
          .filter((call) => call?.payload?.eventType === 'pan_zoom_operation')
          .map((call) => call?.payload?.event?.operation || null);
        const hasAllExpectedEvents =
          eventTypes.includes('file_explorer_item_clicked_in_striffs_view') &&
          eventTypes.includes('pan_zoom_operation') &&
          eventTypes.includes('diffs_button_pressed') &&
          eventTypes.includes('striffs_button_pressed') &&
          eventTypes.includes('diagram_component_clicked') &&
          panZoomOperations.includes('pan') &&
          panZoomOperations.includes('zoom');
        if (!counters || !hasAllExpectedEvents || counters.ack < 6) return null;
        return {
          counters,
          eventTypes,
          panZoomOperations
        };
      }, null, { timeout: 10000 })
    );

    assert.ok(engagementState, 'expected telemetry acknowledgements after UI interactions');
    assert.strictEqual(engagementState.counters.failed, 0);
    assert.ok(engagementState.eventTypes.includes('file_explorer_item_clicked_in_striffs_view'));
    assert.ok(engagementState.eventTypes.includes('pan_zoom_operation'));
    assert.ok(engagementState.eventTypes.includes('diffs_button_pressed'));
    assert.ok(engagementState.eventTypes.includes('striffs_button_pressed'));
    assert.ok(engagementState.eventTypes.includes('diagram_component_clicked'));
    assert.ok(engagementState.panZoomOperations.includes('pan'));
    assert.ok(engagementState.panZoomOperations.includes('zoom'));

    const engagementEnvelopeState = await waitForJson(
      page.waitForFunction(() => {
        const calls = window.__striffsHarness?.engagementCalls || [];
        const msg = calls.find((call) => call?.payload?.eventType === 'striffs_button_pressed');
        const payload = msg?.payload;
        if (!payload) return null;
        const hasStableEnvelope =
          Number(payload?.schemaVersion || 0) >= 2 &&
          String(payload?.operationId || '') === 'op-1' &&
          String(payload?.sessionId || '') !== '' &&
          String(payload?.eventId || '').startsWith('eng-') &&
          Number(payload?.occurredAtMs || 0) > 0 &&
          payload?.repository?.owner === 'acme' &&
          payload?.repository?.name === 'widgets' &&
          Number(payload?.repository?.pullNumber || 0) === 1 &&
          payload?.context?.currentView &&
          payload?.event?.type === 'striffs_button_pressed' &&
          payload?.metadata?.owner === 'acme';
        if (!hasStableEnvelope) return null;
        return {
          schemaVersion: Number(payload.schemaVersion || 0),
          operationId: String(payload.operationId || ''),
          pullNumber: Number(payload.repository?.pullNumber || 0)
        };
      }, null, { timeout: 8000 })
    );

    assert.ok(engagementEnvelopeState, 'expected telemetry payload to include stable analytics envelope');
    assert.ok(engagementEnvelopeState.schemaVersion >= 2);
    assert.strictEqual(engagementEnvelopeState.operationId, 'op-1');
    assert.strictEqual(engagementEnvelopeState.pullNumber, 1);

    await page.click('#striffs-btn');
    await page.waitForFunction(() => {
      const btn = document.querySelector('#striffs-download-btn');
      if (!btn) return false;
      const style = window.getComputedStyle(btn);
      return style.display !== 'none' && style.visibility !== 'hidden' && btn.getClientRects().length > 0;
    }, null, { timeout: 5000 });
    await page.locator('#striffs-download-btn').dispatchEvent('click');
    const saveState = await waitForJson(
      page.waitForFunction(() => {
        const d = document.documentElement?.dataset || {};
        const status = d.striffsSaveStatus || '';
        if (!status || status === 'started') return null;
        return {
          status,
          filename: d.striffsSaveFilename || '',
          href: d.striffsSaveHref || '',
          error: d.striffsSaveError || ''
        };
      }, null, { timeout: 5000 })
    );

    assert.ok(saveState, 'expected save button to report a result');
    assert.strictEqual(saveState.status, 'download-triggered');
    assert.strictEqual(saveState.filename, 'striffs-diagram.svg');
    assert.match(saveState.href, /^blob:/i);

    const fetchCountsBeforeReload = await page.evaluate(() => {
      const harness = window.__striffsHarness || {};
      return Number(harness.fetchStriffsCalls || 0) + Number(harness.generateStriffsCalls || 0);
    });
    assert.strictEqual(fetchCountsBeforeReload, 1, 'expected a single Striffs fetch before reload');

    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#striffs-btn', { timeout: 15000 });

    const cacheState = await waitForJson(
      page.waitForFunction(() => {
        const btn = document.querySelector('#striffs-btn');
        const loadSource = window.Striffs?.__lastLoadSource || null;
        const tooltip = btn?.title || '';
        const cached = loadSource === 'cache' || /loaded from cache/i.test(tooltip);
        return cached ? { loadSource, tooltip } : null;
      }, null, { timeout: 10000 })
    );

    assert.ok(cacheState, 'expected reload to restore Striffs from cache');

    const cacheRefreshState = await waitForJson(
      page.waitForFunction(() => {
        const harness = window.__striffsHarness || {};
        const fetchCalls = Number(harness.fetchStriffsCalls || 0) + Number(harness.generateStriffsCalls || 0);
        const ctx = window.Striffs?.__engagementCtx || {};
        if (fetchCalls < 2) return null;
        return {
          fetchCalls,
          operationId: String(ctx.operationId || ''),
          engagementWriteToken: String(ctx.engagementWriteToken || '')
        };
      }, null, { timeout: 10000 })
    );

    assert.ok(cacheRefreshState, 'expected cached render to refresh engagement context');
    assert.strictEqual(cacheRefreshState.fetchCalls, 2, 'cache reload should refresh engagement context after cached render');
    assert.strictEqual(cacheRefreshState.operationId, 'op-2');
    assert.strictEqual(cacheRefreshState.engagementWriteToken, 'eng-token-2');

    const postReloadViewState = await waitForJson(
      page.waitForFunction(() => {
        const view = document.getElementById('striff-diagram-view');
        const hasSvg = Boolean(document.querySelector('#striffs-content svg'));
        const ready = Boolean(window.Striffs?.__striffsReady);
        const currentView = window.Striffs?.getCurrentView?.() || '';
        if (!view || !hasSvg || !ready) return null;
        if (currentView !== 'diffs') return null;
        return {
          currentView,
          hasSvg,
          ready,
          viewHidden: view.style.display === 'none',
          fetchCalls: Number(window.__striffsHarness?.fetchStriffsCalls || 0) + Number(window.__striffsHarness?.generateStriffsCalls || 0)
        };
      }, null, { timeout: 10000 })
    );

    assert.ok(postReloadViewState, 'expected reload to keep Diffs active while cached Striffs stays ready');
    assert.strictEqual(postReloadViewState.currentView, 'diffs');
    assert.strictEqual(postReloadViewState.viewHidden, true);
    assert.strictEqual(postReloadViewState.fetchCalls, 2, 'cache reload should refresh engagement context once');

    await page.click('#striffs-btn');
    const postCacheTelemetryState = await waitForJson(
      page.waitForFunction(() => {
        const counters = window.Striffs?.getEngagementCounters?.();
        const calls = window.__striffsHarness?.engagementCalls || [];
        const hit = calls.find(
          (call) => call?.operationId === 'op-2'
            && call?.payload?.eventType === 'striffs_button_pressed'
        );
        if (!counters || !hit || counters.failed > 0) return null;
        return {
          counters,
          operationId: String(hit.operationId || ''),
          eventType: String(hit?.payload?.eventType || '')
        };
      }, null, { timeout: 10000 })
    );

    assert.ok(postCacheTelemetryState, 'expected telemetry to succeed after cached render refresh');
    assert.strictEqual(postCacheTelemetryState.operationId, 'op-2');
    assert.strictEqual(postCacheTelemetryState.eventType, 'striffs_button_pressed');
    assert.strictEqual(postCacheTelemetryState.counters.failed, 0);

    await page.click('#diffs-btn');

    await page.locator('#diff-widget .striffs-file-menu-trigger').dispatchEvent('click');
    const mappedMenuState = await waitForJson(
      page.waitForFunction(() => {
        const file = document.querySelector('#diff-widget');
        const item = file?.querySelector('[data-striffs-view-striff-option="1"]');
        if (!item) return null;
        return {
          disabled: item.disabled === true || item.getAttribute('aria-disabled') === 'true',
          title: item.getAttribute('title') || '',
          filePath: item.dataset.striffsFilePath || '',
          componentId: item.dataset.striffsComponentId || ''
        };
      }, null, { timeout: 8000 })
    );
    assert.ok(mappedMenuState, 'expected View Striff option for mapped file');
    assert.strictEqual(mappedMenuState.disabled, false);
    assert.strictEqual(mappedMenuState.filePath, '/src/main/java/com/example/Widget.java');
    assert.strictEqual(mappedMenuState.componentId, 'com.example.Widget');

    await page.locator('#diff-widget [data-striffs-view-striff-option="1"]').dispatchEvent('click');
    const mappedClickState = await waitForJson(
      page.waitForFunction(() => {
        const d = document.documentElement?.dataset || {};
        const currentView = window.Striffs?.getCurrentView?.() || '';
        if (String(d.striffsLastFileMenuStatus || '') !== 'focused') return null;
        if (currentView !== 'striffs') return null;
        const view = document.getElementById('striff-diagram-view');
        const rect = view?.getBoundingClientRect?.() || null;
        const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
        const viewCenterY = rect ? (rect.top + (rect.height / 2)) : null;
        return {
          currentView,
          status: String(d.striffsLastFileMenuStatus || ''),
          filePath: String(d.striffsLastFileMenuFile || ''),
          componentId: String(d.striffsLastFileMenuComponent || ''),
          enabled: d.striffsLastFileMenuEnabled === '1',
          viewVisible: Boolean(view && view.style.display !== 'none'),
          viewportHeight,
          viewCenterY
        };
      }, null, { timeout: 8000 })
    );
    assert.ok(mappedClickState, 'expected mapped View Striff click to focus Striffs view');
    assert.strictEqual(mappedClickState.currentView, 'striffs');
    assert.strictEqual(mappedClickState.filePath, '/src/main/java/com/example/Widget.java');
    assert.strictEqual(mappedClickState.componentId, 'com.example.Widget');
    assert.strictEqual(mappedClickState.enabled, true);
    assert.ok(Number.isFinite(mappedClickState.viewCenterY), 'expected Striffs view bounds after View Striff click');
    assert.ok(mappedClickState.viewportHeight > 0, 'expected viewport height after View Striff click');
    assert.ok(
      Math.abs(mappedClickState.viewCenterY - (mappedClickState.viewportHeight / 2)) < (mappedClickState.viewportHeight * 0.35),
      'expected View Striff click to bring Striffs view near the viewport center'
    );

    await page.click('#diffs-btn');
    await page.click('#diff-readme .striffs-file-menu-trigger');
    const unmappedMenuState = await waitForJson(
      page.waitForFunction(() => {
        const file = document.querySelector('#diff-readme');
        const item = file?.querySelector('[data-striffs-view-striff-option="1"]');
        if (!item) return null;
        return {
          disabled: item.disabled === true || item.getAttribute('aria-disabled') === 'true',
          title: item.getAttribute('title') || '',
          filePath: item.dataset.striffsFilePath || '',
          componentId: item.dataset.striffsComponentId || ''
        };
      }, null, { timeout: 8000 })
    );
    assert.ok(unmappedMenuState, 'expected View Striff option for unmapped file');
    assert.strictEqual(unmappedMenuState.disabled, true);
    assert.strictEqual(unmappedMenuState.filePath, '/README.md');
    assert.strictEqual(unmappedMenuState.componentId, '');
    assert.match(unmappedMenuState.title, /no mapped striff component/i);
  } finally {
    await context.close();
  }
}

async function testAutoGenerateOnReloadAfterPriorGeneration(browser, baseUrl) {
  const { context, page } = await openFixture(browser, baseUrl, { mode: 'valid' });
  try {
    await page.click('#striffs-btn');
    await page.waitForFunction(() => Boolean(window.Striffs?.__striffsReady), null, { timeout: 10000 });

    const beforeReload = await page.evaluate(() => {
      const S = window.Striffs;
      return {
        fetchCalls: window.__striffsHarness?.fetchStriffsCalls || 0,
        intent: Boolean(S?.hasAutoGenerateIntent?.()),
        cacheKey: S?.cacheKey?.() || '',
        chromeKey: S?.cacheStorageKey?.() || ''
      };
    });
    assert.strictEqual(beforeReload.fetchCalls, 1);
    assert.strictEqual(beforeReload.intent, true, 'expected prior successful generation to persist auto-generate intent');

    await page.evaluate(() => {
      const S = window.Striffs;
      const key = S?.cacheKey?.();
      const chromeKey = S?.cacheStorageKey?.();
      if (key) {
        localStorage.removeItem(key);
        localStorage.removeItem(`striffsCacheMeta:${key}`);
      }
      if (chromeKey && window.chrome?.storage?.local?.remove) {
        window.chrome.storage.local.remove(chromeKey);
      }
    });

    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#striffs-btn', { timeout: 15000 });

    const autoGeneratedState = await waitForJson(
      page.waitForFunction(() => {
        const S = window.Striffs;
        const fetchCalls = window.__striffsHarness?.fetchStriffsCalls || 0;
        const hasSvg = Boolean(document.querySelector('#striffs-content svg'));
        const ready = Boolean(S?.__striffsReady);
        const currentView = S?.getCurrentView?.() || '';
        const loadSource = S?.__lastLoadSource || '';
        if (!ready || !hasSvg || currentView !== 'diffs') return null;
        if (fetchCalls < 2) return null;
        return { fetchCalls, currentView, loadSource, ready, hasSvg };
      }, null, { timeout: 12000 })
    );

    assert.ok(autoGeneratedState, 'expected reload to auto-generate Striffs without opening Striffs view');
    assert.strictEqual(autoGeneratedState.fetchCalls, 2);
    assert.strictEqual(autoGeneratedState.currentView, 'diffs');
    assert.strictEqual(autoGeneratedState.loadSource, 'fresh');
  } finally {
    await context.close();
  }
}

async function testAutoOpenFromFreshCacheWithoutIntent(browser, baseUrl) {
  const { context, page } = await openFixture(browser, baseUrl, { mode: 'valid' });
  try {
    await page.click('#striffs-btn');
    await page.waitForFunction(() => Boolean(window.Striffs?.__striffsReady), null, { timeout: 10000 });

    const beforeReload = await page.evaluate(() => ({
      fetchCalls: Number(window.__striffsHarness?.fetchStriffsCalls || 0) + Number(window.__striffsHarness?.generateStriffsCalls || 0),
      intentKey: window.Striffs?.autoGenerateIntentKey?.() || '',
      cacheKey: window.Striffs?.cacheKey?.() || ''
    }));
    assert.strictEqual(beforeReload.fetchCalls, 1);
    assert.ok(beforeReload.intentKey, 'expected an auto-generate intent key');

    await page.evaluate(() => {
      const key = window.Striffs?.autoGenerateIntentKey?.();
      if (key) localStorage.removeItem(key);
    });

    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#striffs-btn', { timeout: 15000 });

    const cacheAutoOpenState = await waitForJson(
      page.waitForFunction(() => {
        const S = window.Striffs;
        if (!S) return null;
        const hasSvg = Boolean(document.querySelector('#striffs-content svg'));
        const ready = Boolean(S.__striffsReady);
        const currentView = S.getCurrentView?.() || '';
        const loadSource = S.__lastLoadSource || '';
        const fetchCalls = Number(window.__striffsHarness?.fetchStriffsCalls || 0) + Number(window.__striffsHarness?.generateStriffsCalls || 0);
        const hasIntent = Boolean(S.hasAutoGenerateIntent?.());
        if (!hasSvg || !ready || currentView !== 'diffs') return null;
        if (loadSource !== 'cache') return null;
        if (fetchCalls !== 2) return null;
        return { hasSvg, ready, currentView, loadSource, fetchCalls, hasIntent };
      }, null, { timeout: 10000 })
    );

    assert.ok(cacheAutoOpenState, 'expected fresh cache to remain ready while keeping Diffs active');
    assert.strictEqual(cacheAutoOpenState.fetchCalls, 2);
    assert.strictEqual(cacheAutoOpenState.loadSource, 'cache');
    assert.strictEqual(cacheAutoOpenState.currentView, 'diffs');
  } finally {
    await context.close();
  }
}

async function testViewStriffMenuIsDisabledWhenNotReady(browser, baseUrl) {
  const { context, page } = await openFixture(browser, baseUrl, { mode: 'valid' });
  try {
    await page.waitForSelector('#diff-widget .striffs-file-menu-trigger', { timeout: 10000 });
    await page.waitForFunction(
      () => Array.isArray(window.Striffs?.__supportedExtensionsForUi) && window.Striffs.__supportedExtensionsForUi.length > 0,
      null,
      { timeout: 10000 }
    );

    const initialState = await page.evaluate(() => ({
      ready: Boolean(window.Striffs?.__striffsReady),
      fetchCalls: window.__striffsHarness?.fetchStriffsCalls || 0
    }));
    assert.strictEqual(initialState.ready, false);
    assert.strictEqual(initialState.fetchCalls, 0);

    await page.click('#diff-readme .striffs-file-menu-trigger');
    const unmappedBeforeGenerate = await waitForJson(
      page.waitForFunction(() => {
        const item = document.querySelector('#diff-readme [data-striffs-view-striff-option="1"]');
        if (!item) return null;
        return {
          disabled: item.disabled === true || item.getAttribute('aria-disabled') === 'true',
          needsGenerate: item.dataset.striffsNeedsGenerate || '',
          title: item.getAttribute('title') || ''
        };
      }, null, { timeout: 8000 })
    );
    assert.ok(unmappedBeforeGenerate, 'expected README file menu option to render');
    assert.strictEqual(unmappedBeforeGenerate.disabled, true);
    assert.strictEqual(unmappedBeforeGenerate.needsGenerate, '0');
    assert.match(unmappedBeforeGenerate.title, /generate striffs first/i);

    await page.locator('#diff-widget .striffs-file-menu-trigger').dispatchEvent('click');
    const mappedBeforeGenerate = await waitForJson(
      page.waitForFunction(() => {
        const item = document.querySelector('#diff-widget [data-striffs-view-striff-option="1"]');
        if (!item) return null;
        return {
          disabled: item.disabled === true || item.getAttribute('aria-disabled') === 'true',
          needsGenerate: item.dataset.striffsNeedsGenerate || '',
          filePath: item.dataset.striffsFilePath || '',
          componentId: item.dataset.striffsComponentId || '',
          title: item.getAttribute('title') || ''
        };
      }, null, { timeout: 8000 })
    );
    assert.ok(mappedBeforeGenerate, 'expected mapped file menu option to render');
    assert.strictEqual(mappedBeforeGenerate.disabled, true);
    assert.strictEqual(mappedBeforeGenerate.needsGenerate, '0');
    assert.strictEqual(mappedBeforeGenerate.filePath, '/src/main/java/com/example/Widget.java');
    assert.strictEqual(mappedBeforeGenerate.componentId, '');
    assert.match(mappedBeforeGenerate.title, /generate striffs first/i);

    const finalState = await page.evaluate(() => ({
      ready: Boolean(window.Striffs?.__striffsReady),
      currentView: window.Striffs?.getCurrentView?.() || '',
      fetchCalls: Number(window.__striffsHarness?.fetchStriffsCalls || 0) + Number(window.__striffsHarness?.generateStriffsCalls || 0)
    }));
    assert.strictEqual(finalState.ready, false);
    assert.strictEqual(finalState.currentView, 'diffs');
    assert.strictEqual(finalState.fetchCalls, 0);
  } finally {
    await context.close();
  }
}

async function testViewStriffMenuSupportsHeaderScopedPath(browser, baseUrl) {
  const { context, page } = await openFixture(browser, baseUrl, { mode: 'valid', headerPathOnly: true });
  try {
    await page.click('#striffs-btn');
    await page.waitForFunction(() => Boolean(window.Striffs?.__striffsReady), null, { timeout: 10000 });

    await page.locator('#diff-widget .striffs-file-menu-trigger').dispatchEvent('click');
    const mappedMenuState = await waitForJson(
      page.waitForFunction(() => {
        const item = document.querySelector('#diff-widget [data-striffs-view-striff-option="1"]');
        if (!item) return null;
        return {
          disabled: item.disabled === true || item.getAttribute('aria-disabled') === 'true',
          filePath: item.dataset.striffsFilePath || '',
          componentId: item.dataset.striffsComponentId || ''
        };
      }, null, { timeout: 8000 })
    );

    assert.ok(mappedMenuState, 'expected View Striff option for header-scoped data-path file');
    assert.strictEqual(mappedMenuState.disabled, false);
    assert.strictEqual(mappedMenuState.filePath, '/src/main/java/com/example/Widget.java');
    assert.strictEqual(mappedMenuState.componentId, 'com.example.Widget');

    await page.locator('#diff-widget [data-striffs-view-striff-option="1"]').dispatchEvent('click');
    const mappedClickState = await waitForJson(
      page.waitForFunction(() => {
        const d = document.documentElement?.dataset || {};
        const currentView = window.Striffs?.getCurrentView?.() || '';
        if (String(d.striffsLastFileMenuStatus || '') !== 'focused') return null;
        if (currentView !== 'striffs') return null;
        const view = document.getElementById('striff-diagram-view');
        const rect = view?.getBoundingClientRect?.() || null;
        const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
        const viewCenterY = rect ? (rect.top + (rect.height / 2)) : null;
        return {
          currentView,
          filePath: String(d.striffsLastFileMenuFile || ''),
          componentId: String(d.striffsLastFileMenuComponent || ''),
          viewportHeight,
          viewCenterY
        };
      }, null, { timeout: 8000 })
    );

    assert.ok(mappedClickState, 'expected header-scoped View Striff click to focus Striffs view');
    assert.strictEqual(mappedClickState.currentView, 'striffs');
    assert.strictEqual(mappedClickState.filePath, '/src/main/java/com/example/Widget.java');
    assert.strictEqual(mappedClickState.componentId, 'com.example.Widget');
    assert.ok(Number.isFinite(mappedClickState.viewCenterY), 'expected Striffs view bounds after header-scoped View Striff click');
    assert.ok(mappedClickState.viewportHeight > 0, 'expected viewport height after header-scoped View Striff click');
    assert.ok(
      Math.abs(mappedClickState.viewCenterY - (mappedClickState.viewportHeight / 2)) < (mappedClickState.viewportHeight * 0.35),
      'expected header-scoped View Striff click to bring Striffs view near the viewport center'
    );
  } finally {
    await context.close();
  }
}

async function testMissingOperationIdFailsLoudly(browser, baseUrl) {
  const { context, page } = await openFixture(browser, baseUrl, { mode: 'invalid-missing-operation' });
  try {
    await page.click('#striffs-btn');

    const failureState = await waitForJson(
      page.waitForFunction(() => {
        const btn = document.querySelector('#striffs-btn');
        const toastHost = document.getElementById('striffs-global-toast');
        const toastText = toastHost ? toastHost.textContent || '' : '';
        const tooltip = btn?.title || '';
        const hasMissingOpError = /missing operationId/i.test(`${tooltip} ${toastText}`);
        if (!hasMissingOpError) return null;
        const ctx = window.Striffs?.__engagementCtx || {};
        return {
          tooltip,
          toastText,
          failure: Boolean(window.Striffs?.__lastStriffsButtonState?.failure),
          hasSvg: Boolean(document.querySelector('#striffs-content svg')),
          ready: Boolean(window.Striffs?.__striffsReady),
          operationId: String(ctx.operationId || ''),
          engagementWriteToken: String(ctx.engagementWriteToken || '')
        };
      }, null, { timeout: 10000 })
    );

    assert.ok(failureState, 'expected invalid result to surface a missing operationId error');
    assert.strictEqual(failureState.failure, true);
    assert.strictEqual(failureState.hasSvg, false);
    assert.strictEqual(failureState.ready, false);
    assert.strictEqual(failureState.operationId, '');
    assert.strictEqual(failureState.engagementWriteToken, '');
    assert.match(`${failureState.tooltip} ${failureState.toastText}`, /missing operationId/i);

    const harnessState = await page.evaluate(() => ({
      fetchStriffsCalls: window.__striffsHarness?.fetchStriffsCalls || 0,
      engagementCalls: (window.__striffsHarness?.engagementCalls || []).length
    }));
    assert.strictEqual(harnessState.fetchStriffsCalls, 1);
    assert.strictEqual(harnessState.engagementCalls, 0, 'invalid result should not send engagement events');
  } finally {
    await context.close();
  }
}

async function testNoChangesDisablesStriffsAndKeepsDiffs(browser, baseUrl) {
  const { context, page } = await openFixture(browser, baseUrl, { mode: 'no-changes' });
  try {
    await page.click('#striffs-btn');

    const noChangesState = await waitForJson(
      page.waitForFunction(() => {
        const btn = document.querySelector('#striffs-btn');
        const diffs = document.querySelector('#files .js-diff-progressive-container');
        const striffView = document.getElementById('striff-diagram-view');
        if (!btn) return null;
        if (!btn.disabled || !/no changes were found/i.test(btn.title || '')) return null;
        return {
          disabled: btn.disabled === true,
          tooltip: btn.title || '',
          ready: Boolean(window.Striffs?.__striffsReady),
          noChanges: Boolean(window.Striffs?.__striffsNoChanges),
          currentView: window.Striffs?.getCurrentView?.() || null,
          hasSvg: Boolean(document.querySelector('#striffs-content svg')),
          striffViewVisible: Boolean(striffView && striffView.style.display !== 'none'),
          diffsVisible: Boolean(diffs && diffs.offsetWidth > 0 && diffs.offsetHeight > 0)
        };
      }, null, { timeout: 10000 })
    );

    assert.ok(noChangesState, 'expected no-changes result to disable the Striffs button');
    assert.strictEqual(noChangesState.disabled, true);
    assert.strictEqual(noChangesState.ready, false);
    assert.strictEqual(noChangesState.noChanges, true);
    assert.strictEqual(noChangesState.currentView, 'diffs');
    assert.strictEqual(noChangesState.hasSvg, false);
    assert.strictEqual(noChangesState.striffViewVisible, false);
    assert.strictEqual(noChangesState.diffsVisible, true);

    await page.evaluate(() => {
      window.Striffs?.refreshSupportedFilesState?.();
    });

    const postRefreshState = await page.evaluate(() => {
      const btn = document.querySelector('#striffs-btn');
      return {
        disabled: btn?.disabled === true,
        tooltip: btn?.title || '',
        noChanges: Boolean(window.Striffs?.__striffsNoChanges)
      };
    });
    assert.strictEqual(postRefreshState.disabled, true);
    assert.match(postRefreshState.tooltip, /no changes were found/i);
    assert.strictEqual(postRefreshState.noChanges, true);
  } finally {
    await context.close();
  }
}

async function testReviewNotesArePassiveAndNonNavigable(browser, baseUrl) {
  const { context, page } = await openFixture(browser, baseUrl, { mode: 'valid' });
  try {
    await page.click('#striffs-btn');
    await page.waitForSelector('#striffs-content svg');

    await page.evaluate(() => {
      window.__lastNoteFeedback = null;
      window.Striffs.emitEngagementEvent = (eventType, eventPayload = {}, metadataPayload = {}) => {
        window.__lastNoteFeedback = {
          eventType,
          eventPayload,
          metadataPayload
        };
        return true;
      };
      const svg = document.querySelector('#striffs-content svg');
      if (!svg) return;
      const ns = 'http://www.w3.org/2000/svg';
      const note = document.createElementNS(ns, 'g');
      note.setAttribute('class', 'entity');
      note.setAttribute('data-qualified-name', 'pkg.AI_REVIEW_NOTE_note_repo_coordination.Component');
      note.innerHTML = [
        '<rect x="40" y="120" width="180" height="72" fill="#FBE1EC" stroke="#000000" stroke-width="2"></rect>',
        '<text data-qualified-name="pkg.AI_REVIEW_NOTE_note_repo_coordination.Component" x="52" y="152">Review the dependency edge</text>'
      ].join('');
      note.getBoundingClientRect = () => ({
        left: 40,
        top: 120,
        right: 220,
        bottom: 192,
        width: 180,
        height: 72
      });
      svg.appendChild(note);
      const wrap = svg.closest('.striff-svg-wrap');
      if (wrap) {
        wrap.getBoundingClientRect = () => ({
          left: 0,
          top: 0,
          right: 1200,
          bottom: 900,
          width: 1200,
          height: 900
        });
      }
      window.Striffs.positionReviewNoteFeedback?.();
    });

    const noteStyle = await page.locator('g.entity[data-qualified-name="pkg.AI_REVIEW_NOTE_note_repo_coordination.Component"]').evaluate((node) => {
      const style = window.getComputedStyle(node);
      return {
        cursor: style.cursor,
        pointerEvents: style.pointerEvents
      };
    });
    assert.strictEqual(noteStyle.pointerEvents, 'none');
    assert.strictEqual(noteStyle.cursor, 'default');

    await page.evaluate(() => {
      const note = document.querySelector('g.entity[data-qualified-name="pkg.AI_REVIEW_NOTE_note_repo_coordination.Component"]');
      note?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
    });
    const noteClickState = await waitForJson(
      page.waitForFunction(() => {
        const d = document.documentElement?.dataset || {};
        if (String(d.striffsLastDiagramClickStatus || '') !== 'ignored-note') return null;
        return {
          status: String(d.striffsLastDiagramClickStatus || ''),
          componentId: String(d.striffsLastDiagramClickComponent || ''),
          currentView: String(window.Striffs?.getCurrentView?.() || ''),
          hash: String(window.location.hash || ''),
          toast: String(document.querySelector('#striffs-toast')?.textContent || '').trim()
        };
      }, null, { timeout: 8000 })
    );

    assert.ok(noteClickState, 'expected note click to be ignored');
    assert.strictEqual(noteClickState.status, 'ignored-note');
    assert.strictEqual(noteClickState.componentId, 'pkg.AI_REVIEW_NOTE_note_repo_coordination.Component');
    assert.strictEqual(noteClickState.currentView, 'striffs');
    assert.strictEqual(noteClickState.hash, '');
    assert.strictEqual(noteClickState.toast, '');

    const feedbackButtons = await page.locator('.striffs-note-feedback button').count();
    assert.strictEqual(feedbackButtons, 2);
    await page.locator('.striffs-note-feedback button[data-vote="up"]').click({ force: true });
    const lastFeedback = await page.evaluate(() => window.__lastNoteFeedback);
    assert.ok(lastFeedback, 'expected note feedback click to emit engagement event');
    assert.strictEqual(lastFeedback.eventType, 'ai_note_feedback');
    assert.strictEqual(lastFeedback.eventPayload.noteId, 'note_repo_coordination');
    assert.strictEqual(lastFeedback.eventPayload.vote, 'up');
  } finally {
    await context.close();
  }
}

async function testDelayedSuccessClearsLoadingState(browser, baseUrl) {
  const { context, page } = await openFixture(browser, baseUrl, { mode: 'delayed-valid' });
  try {
    await page.click('#striffs-btn');

    const readyState = await waitForJson(
      page.waitForFunction(() => {
        const S = window.Striffs;
        const btn = document.querySelector('#striffs-btn');
        if (!S?.__striffsReady || !btn) return null;
        const lastState = S.__lastStriffsButtonState || {};
        if (lastState.loading) return null;
        return {
          ready: Boolean(S.__striffsReady),
          hasSvg: Boolean(document.querySelector('#striffs-content svg')),
          disabled: btn.disabled === true,
          tooltip: String(btn.title || ''),
          loading: Boolean(lastState.loading),
          success: Boolean(lastState.success),
          label: String(btn.textContent || '').trim()
        };
      }, null, { timeout: 10000 })
    );

    assert.ok(readyState, 'expected delayed successful render to complete');
    assert.strictEqual(readyState.ready, true);
    assert.strictEqual(readyState.hasSvg, true);
    assert.strictEqual(readyState.loading, false);
    assert.strictEqual(readyState.success, true);
    assert.strictEqual(readyState.disabled, false);
    assert.match(readyState.tooltip, /striffs loaded/i);
    assert.doesNotMatch(readyState.label, /generating|refreshing|loading/i);
  } finally {
    await context.close();
  }
}

module.exports = (async () => {
  try {
    const fixtureServer = await startFixtureServer();
    try {
      const browser = await launchBrowser();
      try {
        await runSmokeCase('remote disable flow', browser, fixtureServer.baseUrl, testRemoteDisableFlow);
        await runSmokeCase('ensure striff container is idempotent', browser, fixtureServer.baseUrl, testEnsureStriffContainerIsIdempotent);
        await runSmokeCase('valid render telemetry and cache', browser, fixtureServer.baseUrl, testValidRenderTelemetryAndCache);
        await runSmokeCase('auto generate on reload after prior generation', browser, fixtureServer.baseUrl, testAutoGenerateOnReloadAfterPriorGeneration);
        await runSmokeCase('auto open from fresh cache without intent', browser, fixtureServer.baseUrl, testAutoOpenFromFreshCacheWithoutIntent);
        await runSmokeCase('view striff menu is disabled when not ready', browser, fixtureServer.baseUrl, testViewStriffMenuIsDisabledWhenNotReady);
        await runSmokeCase('view striff menu supports header scoped path', browser, fixtureServer.baseUrl, testViewStriffMenuSupportsHeaderScopedPath);
        await runSmokeCase('missing operation id fails loudly', browser, fixtureServer.baseUrl, testMissingOperationIdFailsLoudly);
        await runSmokeCase('no changes disables striffs and keeps diffs', browser, fixtureServer.baseUrl, testNoChangesDisablesStriffsAndKeepsDiffs);
        await runSmokeCase('review notes are passive and non navigable', browser, fixtureServer.baseUrl, testReviewNotesArePassiveAndNonNavigable);
        await runSmokeCase('delayed success clears loading state', browser, fixtureServer.baseUrl, testDelayedSuccessClearsLoadingState);
        console.log('ui core smoke test passed');
        return { skipped: false };
      } finally {
        await browser.close();
      }
    } finally {
      await fixtureServer.close();
    }
  } catch (error) {
    if (shouldSkipUiSmokeError(error)) {
      console.warn(`ui core smoke test skipped: ${error.message}`);
      return { skipped: true, reason: error.message };
    }
    throw error;
  }
})();
