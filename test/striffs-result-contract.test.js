const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const prMetadataPath = path.join(__dirname, '..', 'src', 'pr-metadata-utils.js');
const striffsPath = path.join(__dirname, '..', 'src', 'striffs.js');
const prMetadataSource = fs.readFileSync(prMetadataPath, 'utf8');
const striffsSource = fs.readFileSync(striffsPath, 'utf8');

function createStorageArea(initial = {}) {
  const data = { ...initial };
  const pick = (keys) => {
    if (keys == null) return { ...data };
    if (Array.isArray(keys)) {
      const out = {};
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(data, key)) out[key] = data[key];
      }
      return out;
    }
    if (typeof keys === 'string') {
      return Object.prototype.hasOwnProperty.call(data, keys) ? { [keys]: data[keys] } : {};
    }
    if (typeof keys === 'object') {
      const out = {};
      for (const [key, fallback] of Object.entries(keys)) {
        out[key] = Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback;
      }
      return out;
    }
    return {};
  };

  return {
    __data: data,
    get(keys, cb) {
      const result = pick(keys);
      if (typeof cb === 'function') cb(result);
      return Promise.resolve(result);
    },
    set(items, cb) {
      Object.assign(data, items || {});
      if (typeof cb === 'function') cb();
      return Promise.resolve();
    },
    remove(keys, cb) {
      const toRemove = Array.isArray(keys) ? keys : [keys];
      for (const key of toRemove) delete data[key];
      if (typeof cb === 'function') cb();
      return Promise.resolve();
    }
  };
}

function createElement() {
  const element = {
    style: { setProperty() {} },
    dataset: {},
    classList: {
      add() {},
      remove() {},
      contains() { return false; },
      toggle() { return false; }
    },
    appendChild() {},
    insertBefore() {},
    prepend() {},
    remove() {},
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    addEventListener() {},
    removeEventListener() {},
    scrollIntoView() {},
    focus() {},
    click() {},
    dispatchEvent() { return true; },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    },
    getBBox() {
      return { x: 0, y: 0, width: 0, height: 0 };
    },
    matches() { return false; },
    contains() { return false; },
    ownerSVGElement: null,
    parentElement: null,
    parentNode: null,
    innerHTML: '',
    textContent: '',
    value: '',
    clientWidth: 0,
    clientHeight: 0,
    scrollLeft: 0,
    scrollTop: 0,
    insertAdjacentHTML() {}
  };
  return element;
}

function createStorage() {
  const data = new Map();
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    }
  };
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function toPlainJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadStriffs() {
  const localStorage = createStorage();
  const sessionStorage = createStorage();
  const head = createElement();
  const body = createElement();
  const documentElement = createElement();
  body.parentNode = documentElement;

  const document = {
    head,
    body,
    documentElement,
    createElement() { return createElement(); },
    createElementNS() { return createElement(); },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {}
  };

  const chrome = {
    storage: {
      local: createStorageArea(),
      sync: createStorageArea(),
      onChanged: { addListener() {} }
    },
    runtime: {
      sendMessage() {},
      onMessage: { addListener() {} }
    }
  };

  const sandbox = {
    console: {
      log() {},
      info() {},
      warn() {},
      error() {}
    },
    setTimeout() { return 0; },
    clearTimeout() {},
    setInterval() { return 0; },
    clearInterval() {},
    MutationObserver: function MutationObserver() {
      this.observe = () => {};
      this.disconnect = () => {};
    },
    Event: function Event(type) { this.type = type; },
    URL: {
      createObjectURL() { return 'blob:test'; },
      revokeObjectURL() {}
    },
    Blob,
    FormData,
    localStorage,
    sessionStorage,
    location: {
      href: 'https://github.com/',
      pathname: '/',
      hash: ''
    },
    history: {
      pushState() {},
      replaceState() {}
    },
    navigator: {},
    performance: { now: () => 0 },
    crypto: { randomUUID: () => 'sess-test' },
    document,
    chrome,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; }
  };

  sandbox.window = sandbox;
  vm.runInNewContext(prMetadataSource, sandbox, { filename: prMetadataPath });
  vm.runInNewContext(striffsSource, sandbox, { filename: striffsPath });
  sandbox.window.Striffs.__testChrome = chrome;
  sandbox.window.Striffs.__testWindow = sandbox;
  return sandbox.window.Striffs;
}

function testValidationRequiresMetricsEnvelope() {
  const S = loadStriffs();

  assert.match(
    S.getStriffsResultValidationError({ striffs: [] }),
    /missing operationId/i
  );
  assert.match(
    S.getStriffsResultValidationError({ striffs: [], operationId: 'op-1' }),
    /missing engagement write token/i
  );
  assert.strictEqual(
    S.isValidStriffsResult({ striffs: [], operationId: 'op-1', engagementWriteToken: 'token-1' }),
    true
  );
}

function testExtractApiComponentRecordsRequiresStructuredDiagramComponents() {
  const S = loadStriffs();

  assert.deepStrictEqual(
    toPlainJson(S.extractApiComponentRecords({
      striffs: [
        {
          diagramComponents: [
            {
              uniqueName: 'com.example.Widget',
              sourceFile: 'src/main/java/com/example/Widget.java'
            }
          ]
        }
      ]
    })),
    [
      {
        striffIndex: 0,
        componentId: 'com.example.Widget',
        filePath: '/src/main/java/com/example/Widget.java'
      }
    ]
  );

  assert.deepStrictEqual(
    toPlainJson(S.extractApiComponentRecords({
      striffs: [
        {
          diagramCmpsJSON: '[{"uniqueName":"com.example.Legacy","sourceFile":"src/Legacy.java"}]'
        }
      ]
    })),
    []
  );
}

function testUpdateEngagementContextClearsStaleState() {
  const S = loadStriffs();
  S.__engagementCtx = {
    sessionId: 'sess-old',
    operationId: 'old-op',
    engagementWriteToken: 'old-token'
  };

  assert.strictEqual(
    S.updateEngagementContextFromResult({ striffs: [], engagementWriteToken: 'token-without-op' }),
    false
  );
  assert.strictEqual(S.__engagementCtx.operationId, null);
  assert.strictEqual(S.__engagementCtx.engagementWriteToken, null);
  assert.strictEqual(S.__lastEngagementContextError, 'missing operationId');

  assert.strictEqual(
    S.updateEngagementContextFromResult({ striffs: [], operationId: 'old-op' }),
    false
  );
  assert.strictEqual(S.__engagementCtx.operationId, 'old-op');
  assert.strictEqual(S.__engagementCtx.engagementWriteToken, null);
  assert.strictEqual(S.__lastEngagementContextError, 'missing engagementWriteToken');
}

function testDebugModeLogsBlockedEngagementCollection() {
  const S = loadStriffs();
  const logs = [];
  S.__debugEnabled = true;
  S.debugDump = (label, payload) => {
    logs.push({
      label,
      payload: payload ? JSON.parse(JSON.stringify(payload)) : payload
    });
  };

  assert.strictEqual(
    S.updateEngagementContextFromResult({ striffs: [], engagementWriteToken: 'token-without-op' }),
    false
  );
  assert.deepStrictEqual(logs.shift(), {
    label: 'engagement collection blocked',
    payload: {
      reason: 'missing operationId',
      hasOperationId: false,
      hasToken: true
    }
  });

  assert.strictEqual(
    S.updateEngagementContextFromResult({ striffs: [], operationId: 'op-1' }),
    false
  );
  assert.deepStrictEqual(logs.shift(), {
    label: 'engagement collection blocked',
    payload: {
      reason: 'missing engagementWriteToken',
      hasOperationId: true,
      hasToken: false,
      operationId: 'op-1'
    }
  });

  S.__engagementCtx = {
    sessionId: 'sess-1',
    operationId: null,
    engagementWriteToken: null
  };
  assert.strictEqual(S.emitEngagementEvent('diffs_button_pressed', { fromView: 'striffs' }), false);
  assert.deepStrictEqual(logs.shift(), {
    label: 'engagement collection blocked',
    payload: {
      reason: 'missing operation/token',
      type: 'diffs_button_pressed',
      hasOperationId: false,
      hasToken: false
    }
  });
}

function testEmitEngagementEventBuildsStableEnvelope() {
  const S = loadStriffs();
  const sent = [];

  S.__engagementCtx = {
    sessionId: 'sess-1',
    operationId: 'op-1',
    engagementWriteToken: 'token-1'
  };
  S.extractPRMetadata = () => ({
    owner: 'acme',
    repo: 'widgets',
    pull_number: '1'
  });
  S.getCurrentView = () => 'striffs';
  S.__striffsZoom = 1.5;
  S.bgRequest = async (msg = {}) => {
    sent.push(JSON.parse(JSON.stringify(msg)));
    return { ok: true, status: 200, json: { stored: true } };
  };

  const emitted = S.emitEngagementEvent(
    'pan_zoom_operation',
    {
      operation: 'zoom',
      wheelSteps: 2,
      invalidNumber: Number.POSITIVE_INFINITY
    },
    {
      viewportStart: { width: 900, height: 600 },
      dropped: undefined
    }
  );

  assert.strictEqual(emitted, true);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].type, 'recordEngagementEvent');
  assert.strictEqual(sent[0].operationId, 'op-1');
  assert.strictEqual(sent[0].engagementToken, 'token-1');

  const payload = sent[0].payload || {};
  assert.strictEqual(payload.schemaVersion, 2);
  assert.strictEqual(payload.eventType, 'pan_zoom_operation');
  assert.strictEqual(payload.operationId, 'op-1');
  assert.strictEqual(payload.sessionId, 'sess-1');
  assert.strictEqual(payload.source, 'striff-browser-extension');
  assert.ok(Number(payload.occurredAtMs) > 0);
  assert.match(String(payload.occurredAt || ''), /^\d{4}-\d{2}-\d{2}T/);
  assert.match(String(payload.eventId || ''), /^eng-/);
  assert.strictEqual(payload.repository?.owner, 'acme');
  assert.strictEqual(payload.repository?.name, 'widgets');
  assert.strictEqual(payload.repository?.pullNumber, 1);
  assert.strictEqual(payload.context?.currentView, 'striffs');
  assert.strictEqual(payload.context?.zoom, 1.5);
  assert.strictEqual(payload.attributes?.operation, 'zoom');
  assert.strictEqual(payload.attributes?.wheelSteps, 2);
  assert.strictEqual(payload.attributes?.invalidNumber, null);
  assert.deepStrictEqual(payload.extra?.viewportStart, { width: 900, height: 600 });

  // Keep legacy fields to avoid breaking existing consumers.
  assert.strictEqual(payload.event?.type, 'pan_zoom_operation');
  assert.strictEqual(payload.event?.operation, 'zoom');
  assert.strictEqual(payload.metadata?.owner, 'acme');
  assert.strictEqual(payload.metadata?.repo, 'widgets');
  assert.strictEqual(payload.metadata?.pull_number, 1);
}

async function testEmitEngagementEventTracksAckCounters() {
  const S = loadStriffs();
  const debugSnapshots = [];

  S.__engagementCtx = {
    sessionId: 'sess-1',
    operationId: 'op-1',
    engagementWriteToken: 'token-1'
  };
  S.extractPRMetadata = () => ({
    owner: 'acme',
    repo: 'widgets',
    pull_number: '1'
  });
  S.getCurrentView = () => 'striffs';
  S.bgRequest = async () => ({ ok: true, status: 200 });
  S.syncEngagementDebugState = () => {
    debugSnapshots.push({ ...S.getEngagementCounters() });
  };

  assert.strictEqual(
    S.emitEngagementEvent('striffs_button_pressed', { type: 'striffs_button_pressed' }),
    true
  );
  assert.deepStrictEqual(toPlainJson(S.getEngagementCounters()), {
    sent: 1,
    ack: 0,
    failed: 0,
    skipped: 0,
    lastEventType: 'striffs_button_pressed'
  });

  await flushMicrotasks();

  assert.deepStrictEqual(toPlainJson(S.getEngagementCounters()), {
    sent: 1,
    ack: 1,
    failed: 0,
    skipped: 0,
    lastEventType: 'striffs_button_pressed'
  });
  assert.ok(
    debugSnapshots.some((snapshot) =>
      snapshot.sent === 1
      && snapshot.ack === 1
      && snapshot.failed === 0
      && snapshot.skipped === 0
    ),
    'expected debug state to capture successful acknowledgement counters'
  );
}

async function testEmitEngagementEventTracksNonOkFailures() {
  const S = loadStriffs();
  const logs = [];

  S.__engagementCtx = {
    sessionId: 'sess-1',
    operationId: 'op-1',
    engagementWriteToken: 'token-1'
  };
  S.extractPRMetadata = () => ({
    owner: 'acme',
    repo: 'widgets',
    pull_number: '1'
  });
  S.getCurrentView = () => 'striffs';
  S.debugDump = (label, payload) => {
    logs.push({
      label,
      payload: payload ? JSON.parse(JSON.stringify(payload)) : payload
    });
  };
  S.bgRequest = async () => ({ ok: false, status: 403, error: 'HTTP 403' });

  assert.strictEqual(
    S.emitEngagementEvent('diffs_button_pressed', { type: 'diffs_button_pressed' }),
    true
  );

  await flushMicrotasks();

  assert.deepStrictEqual(toPlainJson(S.getEngagementCounters()), {
    sent: 1,
    ack: 0,
    failed: 1,
    skipped: 0,
    lastEventType: 'diffs_button_pressed'
  });
  assert.deepStrictEqual(logs.at(-1), {
    label: 'engagement send returned non-ok',
    payload: {
      type: 'diffs_button_pressed',
      response: { ok: false, status: 403, error: 'HTTP 403' }
    }
  });
}

async function testEmitEngagementEventTracksBridgeErrors() {
  const S = loadStriffs();
  const logs = [];

  S.__engagementCtx = {
    sessionId: 'sess-1',
    operationId: 'op-1',
    engagementWriteToken: 'token-1'
  };
  S.extractPRMetadata = () => ({
    owner: 'acme',
    repo: 'widgets',
    pull_number: '1'
  });
  S.getCurrentView = () => 'striffs';
  S.debugDump = (label, payload) => {
    logs.push({
      label,
      payload: payload ? JSON.parse(JSON.stringify(payload)) : payload
    });
  };
  S.bgRequest = async () => {
    throw new Error('bridge exploded');
  };

  assert.strictEqual(
    S.emitEngagementEvent('diagram_component_clicked', { type: 'diagram_component_clicked' }),
    true
  );

  await flushMicrotasks();

  assert.deepStrictEqual(toPlainJson(S.getEngagementCounters()), {
    sent: 1,
    ack: 0,
    failed: 1,
    skipped: 0,
    lastEventType: 'diagram_component_clicked'
  });
  assert.deepStrictEqual(logs.at(-1), {
    label: 'engagement send failed',
    payload: {
      type: 'diagram_component_clicked',
      error: 'bridge exploded'
    }
  });
}

function testEmitEngagementEventSkipsWhenPayloadCannotBeBuilt() {
  const S = loadStriffs();
  const logs = [];

  S.__engagementCtx = {
    sessionId: 'sess-1',
    operationId: 'op-1',
    engagementWriteToken: 'token-1'
  };
  S.buildEngagementPayload = () => null;
  S.logEngagementCollectionBlocked = (reason, extra) => {
    logs.push({ reason, extra: extra ? JSON.parse(JSON.stringify(extra)) : extra });
  };

  assert.strictEqual(
    S.emitEngagementEvent('pan_zoom_operation', { type: 'pan_zoom_operation' }),
    false
  );
  assert.deepStrictEqual(toPlainJson(S.getEngagementCounters()), {
    sent: 0,
    ack: 0,
    failed: 0,
    skipped: 1,
    lastEventType: null
  });
  assert.deepStrictEqual(logs.at(-1), {
    reason: 'failed to build engagement payload',
    extra: { type: 'pan_zoom_operation' }
  });
}

function testEmitEngagementEventSkipsWhenBridgeMissing() {
  const S = loadStriffs();
  const logs = [];

  S.__engagementCtx = {
    sessionId: 'sess-1',
    operationId: 'op-1',
    engagementWriteToken: 'token-1'
  };
  S.logEngagementCollectionBlocked = (reason, extra) => {
    logs.push({ reason, extra: extra ? JSON.parse(JSON.stringify(extra)) : extra });
  };
  S.bgRequest = null;

  assert.strictEqual(
    S.emitEngagementEvent('file_explorer_item_clicked_in_striffs_view', {
      type: 'file_explorer_item_clicked_in_striffs_view'
    }),
    false
  );
  assert.deepStrictEqual(toPlainJson(S.getEngagementCounters()), {
    sent: 0,
    ack: 0,
    failed: 0,
    skipped: 1,
    lastEventType: null
  });
  assert.deepStrictEqual(logs.at(-1), {
    reason: 'missing background bridge',
    extra: { type: 'file_explorer_item_clicked_in_striffs_view' }
  });
}

async function testAutoFetchFailsLoudlyWhenOperationIdMissing() {
  const S = loadStriffs();
  const buttonUpdates = [];
  const toasts = [];

  S.__disabledByRemote = false;
  S.getStoredToken = async () => 'gh-token';
  S.isPrivateRepo = () => false;
  S.extractPRMetadata = () => ({
    owner: 'acme',
    repo: 'widgets',
    pull_number: '1',
    updated_at: '2026-03-07T00:00:00Z',
    commit_count: 3
  });
  S.buildFilePathToDiffIdMapAsync = () => {};
  S.updateStriffButton = (payload) => { buttonUpdates.push(payload); };
  S.toast = (message, kind) => { toasts.push({ message, kind }); };
  S.bgRequest = async () => ({
    ok: true,
    json: {
      striffs: [],
      engagementWriteToken: 'token-without-operation-id'
    }
  });
  S.ensureStriffContainer = () => createElement();

  const ok = await S.autoFetchStriffs();

  assert.strictEqual(ok, false);
  assert.strictEqual(S.__striffsReady, false);
  assert.match(String(buttonUpdates.at(-1)?.tooltip || ''), /missing operationId/i);
  assert.match(String(toasts.at(-1)?.message || ''), /missing operationId/i);
}

async function testAutoFetchNoChangesKeepsDiffsOnly() {
  const S = loadStriffs();
  const buttonUpdates = [];
  let ensureCalls = 0;

  S.__disabledByRemote = false;
  S.getStoredToken = async () => 'gh-token';
  S.isPrivateRepo = () => false;
  S.extractPRMetadata = () => ({
    owner: 'acme',
    repo: 'widgets',
    pull_number: '1',
    updated_at: '2026-03-07T00:00:00Z',
    commit_count: 3
  });
  S.buildFilePathToDiffIdMapAsync = () => {};
  S.updateStriffButton = (payload) => { buttonUpdates.push(payload); };
  S.toast = () => {};
  S.bgRequest = async () => ({
    ok: true,
    json: {
      operationId: 'op-no-changes',
      engagementWriteToken: 'eng-no-changes',
      striffs: []
    }
  });
  S.ensureStriffContainer = () => {
    ensureCalls += 1;
    return createElement();
  };
  S.showDiffView = () => {
    S.__currentView = 'diffs';
  };

  const ok = await S.autoFetchStriffs();

  assert.strictEqual(ok, true);
  assert.strictEqual(S.__striffsReady, false);
  assert.strictEqual(S.__striffsNoChanges, true);
  assert.strictEqual(ensureCalls, 0, 'empty results should not create the Striffs container');
  assert.match(String(buttonUpdates.at(-1)?.tooltip || ''), /no changes were found/i);
  assert.strictEqual(Boolean(buttonUpdates.at(-1)?.disabled), true);
}

async function testAutoFetchUsesCacheWhenCommitCountChanges() {
  const S = loadStriffs();
  let commitCount = null;
  let bgCalls = 0;

  S.__disabledByRemote = false;
  S.getStoredToken = async () => 'gh-token';
  S.isPrivateRepo = () => false;
  S.extractPRMetadata = () => ({
    owner: 'acme',
    repo: 'widgets',
    pull_number: '1',
    updated_at: '2026-03-07T00:00:00Z',
    commit_count: commitCount
  });
  S.buildFilePathToDiffIdMapAsync = () => {};
  S.updateStriffButton = () => {};
  S.toast = () => {};
  S.ensureStriffContainer = () => createElement();
  S.renderStriffsInto = () => true;
  S.setAutoGenerateIntent = () => {};

  const cachedResult = {
    operationId: 'op-cache',
    engagementWriteToken: 'eng-cache',
    striffs: [
      {
        svgCode: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>',
        diagramComponents: []
      }
    ]
  };

  await S.storeDiagramInCache(cachedResult);
  const cacheStorageKey = S.cacheStorageKey?.();
  const seeded = cacheStorageKey ? await S.__testChrome.storage.local.get([cacheStorageKey]) : {};
  assert.ok(seeded?.[cacheStorageKey], 'expected storeDiagramInCache to seed chrome cache');
  commitCount = 2;
  S.bgRequest = async (msg = {}) => {
    const type = String(msg?.type || '');
    if (type === 'fetchStriffsWithToken' || type === 'generateStriffs') {
      bgCalls += 1;
      return { ok: true, json: cachedResult };
    }
    if (type === 'fetchSupportedLanguages') {
      return { ok: true, text: 'java,typescript,python' };
    }
    if (type === 'getSupportedLanguagesCache') {
      return { ok: true, cached: {} };
    }
    if (type === 'fetchRemoteConfig') {
      return {
        ok: true,
        status: 200,
        json: { disableStriffs: false, supportedLanguages: 'java,typescript,python' }
      };
    }
    if (type === 'recordEngagementEvent') {
      return { ok: true, status: 200, json: { stored: true } };
    }
    return { ok: true };
  };

  const ok = await S.autoFetchStriffs();

  assert.strictEqual(ok, true);
  assert.strictEqual(bgCalls, 0, 'expected cache reuse across commit-count changes');
  assert.strictEqual(S.__lastLoadSource, 'cache');
  assert.strictEqual(S.__striffsReady, true);
}

async function testSupportedLanguagesUsesLocalCacheBeforeNetwork() {
  const S = loadStriffs();
  const now = Date.now();
  let fetchSupportedLanguagesCalls = 0;
  let getSupportedLanguagesCacheCalls = 0;

  await S.__testChrome.storage.local.set({
    striffsSupportedLangs: 'java,typescript,python',
    striffsSupportedLangsFetchedAt: now
  });

  S.bgRequest = async (msg = {}) => {
    const type = String(msg?.type || '');
    if (type === 'fetchSupportedLanguages') {
      fetchSupportedLanguagesCalls += 1;
      return { ok: true, text: 'go,rust' };
    }
    if (type === 'getSupportedLanguagesCache') {
      getSupportedLanguagesCacheCalls += 1;
      return { ok: true, cached: {} };
    }
    return { ok: true };
  };

  const result = await S.fetchSupportedLanguagesFromApi();

  assert.strictEqual(result, 'java,typescript,python');
  assert.strictEqual(fetchSupportedLanguagesCalls, 0, 'local cache should prevent network fetch');
  assert.strictEqual(getSupportedLanguagesCacheCalls, 0, 'local cache should short-circuit before background cache lookup');
}

async function testSupportedLanguagesCachesFreshNetworkResult() {
  const S = loadStriffs();
  let fetchSupportedLanguagesCalls = 0;
  const networkResult = 'java,typescript,python';

  S.bgRequest = async (msg = {}) => {
    const type = String(msg?.type || '');
    if (type === 'getSupportedLanguagesCache') {
      return { ok: true, cached: {} };
    }
    if (type === 'fetchSupportedLanguages') {
      fetchSupportedLanguagesCalls += 1;
      return { ok: true, text: networkResult };
    }
    return { ok: true };
  };

  const first = await S.fetchSupportedLanguagesFromApi({ force: true });
  assert.strictEqual(first, networkResult);
  assert.strictEqual(fetchSupportedLanguagesCalls, 1);

  const stored = await S.storageGet('local', ['striffsSupportedLangs', 'striffsSupportedLangsFetchedAt']);
  assert.strictEqual(stored.striffsSupportedLangs, networkResult);
  assert.ok(Number(stored.striffsSupportedLangsFetchedAt) > 0);

  const second = await S.fetchSupportedLanguagesFromApi();
  assert.strictEqual(second, networkResult);
  assert.strictEqual(fetchSupportedLanguagesCalls, 1, 'second call should be served from cache');
}

async function testSupportedLanguagesReadsIsoTimestampCache() {
  const S = loadStriffs();
  const nowIso = new Date().toISOString();
  let fetchSupportedLanguagesCalls = 0;

  await S.__testChrome.storage.local.set({
    striffsSupportedLangs: 'java,typescript,python',
    striffsSupportedLangsFetchedAt: nowIso
  });

  S.bgRequest = async (msg = {}) => {
    const type = String(msg?.type || '');
    if (type === 'fetchSupportedLanguages') {
      fetchSupportedLanguagesCalls += 1;
      return { ok: true, text: 'go,rust' };
    }
    if (type === 'getSupportedLanguagesCache') {
      return { ok: true, cached: {} };
    }
    return { ok: true };
  };

  const result = await S.fetchSupportedLanguagesFromApi();
  assert.strictEqual(result, 'java,typescript,python');
  assert.strictEqual(fetchSupportedLanguagesCalls, 0, 'ISO timestamp cache should be treated as fresh');
}

async function testGlobalCacheClearFlagAppliesOncePerTimestamp() {
  const S = loadStriffs();
  let clearCalls = 0;
  const clearAt = Date.now();

  S.clearLocalDiagramCaches = async () => {
    clearCalls += 1;
  };

  await S.__testChrome.storage.local.set({ striffsCacheClearAt: clearAt });

  const first = await S.checkGlobalCacheClearFlag();
  assert.strictEqual(first, true);
  assert.strictEqual(clearCalls, 1);

  const seenAfterFirst = await S.storageGet('local', ['striffsCacheClearSeenAt']);
  assert.strictEqual(Number(seenAfterFirst?.striffsCacheClearSeenAt), clearAt);

  const second = await S.checkGlobalCacheClearFlag();
  assert.strictEqual(second, false, 'same clear timestamp should not be applied repeatedly');
  assert.strictEqual(clearCalls, 1, 'cache clear should run once per timestamp');

  await S.__testChrome.storage.local.set({ striffsCacheClearAt: clearAt + 1000 });
  const third = await S.checkGlobalCacheClearFlag();
  assert.strictEqual(third, true, 'newer clear timestamp should trigger a fresh clear');
  assert.strictEqual(clearCalls, 2);
}

function testFlashFocusAddsAndRemovesGlowClass() {
  const S = loadStriffs();
  const timers = [];
  const cleared = [];
  S.__testWindow.setTimeout = (fn, ms) => {
    timers.push({ fn, ms });
    return timers.length;
  };
  S.__testWindow.clearTimeout = (id) => {
    cleared.push(id);
  };

  const classNames = new Set();
  const group = {
    matches(selector) {
      return selector === 'g.entity[data-qualified-name]';
    },
    closest() {
      return null;
    },
    getAttribute(name) {
      return name === 'data-qualified-name' ? 'pkg.Component' : null;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10 };
    },
    classList: {
      add(name) {
        classNames.add(name);
      },
      remove(name) {
        classNames.delete(name);
      },
      contains(name) {
        return classNames.has(name);
      }
    }
  };
  const text = {
    matches() {
      return false;
    },
    closest(selector) {
      return selector === 'g.entity[data-qualified-name]' ? group : null;
    },
    getAttribute(name) {
      return name === 'data-qualified-name' ? 'pkg.Component' : null;
    }
  };

  S.flashFocus(text);
  assert.strictEqual(classNames.has(S.FOCUS_GLOW_CLASS), true, 'focus glow class should be applied immediately');
  assert.strictEqual(timers.length, 1, 'focus glow should schedule cleanup');
  assert.strictEqual(timers[0].ms, S.FOCUS_GLOW_DURATION_MS, 'focus glow should last for configured duration');

  S.flashFocus(text);
  assert.deepStrictEqual(cleared, [1], 're-focusing should clear the previous glow timeout');
  assert.strictEqual(timers.length, 2, 're-focusing should schedule a fresh cleanup timeout');

  timers[1].fn();
  assert.strictEqual(classNames.has(S.FOCUS_GLOW_CLASS), false, 'focus glow class should be removed after timeout');
}

function testExtractReviewNoteIdParsesStableIds() {
  const S = loadStriffs();
  assert.strictEqual(
    S.extractReviewNoteId('pkg.AI_REVIEW_NOTE_note_repo_coordination.Component'),
    'note_repo_coordination'
  );
  assert.strictEqual(S.extractReviewNoteId('pkg.Component'), null);
}

async function testPayloadTooLargeErrorShowsCorrectToastAndDisablesButton() {
  const S = loadStriffs();
  const buttonUpdates = [];
  const toasts = [];

  S.__disabledByRemote = false;
  S.getStoredToken = async () => 'gh-token';
  S.isPrivateRepo = () => false;
  S.extractPRMetadata = () => ({
    owner: 'acme',
    repo: 'widgets',
    pull_number: '1',
    updated_at: '2026-03-07T00:00:00Z',
    commit_count: 3
  });
  S.buildFilePathToDiffIdMapAsync = () => {};
  S.updateStriffButton = (payload) => { buttonUpdates.push(payload); };
  S.toast = (message, kind, options) => { toasts.push({ message, kind, options }); };
  S.bgRequest = async () => ({
    ok: false,
    error: 'API request failed: 413',
    detail: 'Too many changes for AI review'
  });
  S.ensureStriffContainer = () => createElement();

  const ok = await S.autoFetchStriffs();

  assert.strictEqual(ok, false);
  assert.strictEqual(S.__striffsReady, false);

  // Verify toast was shown with custom message
  assert.strictEqual(toasts.length, 1);
  assert.match(toasts[0].message, /Unable to generate AI review|too many changes/i);
  assert.strictEqual(toasts[0].kind, 'neutral');
  assert.strictEqual(toasts[0].options?.timeoutMs, 8000);

  // Verify button was updated with correct state
  const errorUpdate = buttonUpdates.find(u => u.tooltip?.includes('Unable to generate AI review'));
  assert.ok(errorUpdate, 'Expected button update with "Unable to generate AI review" tooltip');
  assert.strictEqual(errorUpdate.disabled, true);
  assert.strictEqual(errorUpdate.neutral, true);
}

module.exports = (async () => {
testValidationRequiresMetricsEnvelope();
testExtractApiComponentRecordsRequiresStructuredDiagramComponents();
testUpdateEngagementContextClearsStaleState();
  testDebugModeLogsBlockedEngagementCollection();
  testEmitEngagementEventBuildsStableEnvelope();
  await testEmitEngagementEventTracksAckCounters();
  await testEmitEngagementEventTracksNonOkFailures();
  await testEmitEngagementEventTracksBridgeErrors();
  testEmitEngagementEventSkipsWhenPayloadCannotBeBuilt();
  testEmitEngagementEventSkipsWhenBridgeMissing();
  await testAutoFetchFailsLoudlyWhenOperationIdMissing();
  await testAutoFetchNoChangesKeepsDiffsOnly();
  await testAutoFetchUsesCacheWhenCommitCountChanges();
  await testSupportedLanguagesUsesLocalCacheBeforeNetwork();
  await testSupportedLanguagesCachesFreshNetworkResult();
  await testSupportedLanguagesReadsIsoTimestampCache();
  await testGlobalCacheClearFlagAppliesOncePerTimestamp();
  testFlashFocusAddsAndRemovesGlowClass();
  testExtractReviewNoteIdParsesStableIds();
  await testPayloadTooLargeErrorShowsCorrectToastAndDisablesButton();
  console.log('striffs result contract test passed');
})();
