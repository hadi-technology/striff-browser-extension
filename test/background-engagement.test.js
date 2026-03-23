const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const backgroundPath = path.join(__dirname, '..', 'src', 'background.js');
const backgroundSource = fs.readFileSync(backgroundPath, 'utf8');

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
      for (const key of toRemove) {
        delete data[key];
      }
      if (typeof cb === 'function') cb();
      return Promise.resolve();
    }
  };
}

function loadBackground({ localData = {}, fetchImpl }) {
  let messageListener = null;
  const local = createStorageArea(localData);
  const sync = createStorageArea();
  const chrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        }
      },
      lastError: null
    },
    storage: {
      local,
      sync,
      onChanged: { addListener() {} }
    },
    tabs: {
      query: async () => [],
      sendMessage: async () => ({ ok: true })
    },
    scripting: {
      executeScript: async () => true
    }
  };
  const sandbox = {
    chrome,
    fetch: fetchImpl,
    console,
    AbortController,
    Blob,
    FormData,
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(backgroundSource, sandbox, { filename: backgroundPath });
  assert.ok(messageListener, 'expected background onMessage listener to be registered');

  const dispatch = (msg) =>
    new Promise((resolve) => {
      const keepAlive = messageListener(msg, {}, resolve);
      assert.strictEqual(keepAlive, true, 'expected background listener to stay alive for async replies');
    });

  return { dispatch, local };
}

async function testRecordEngagementPostsPayloadToConfiguredApiBase() {
  const fetchCalls = [];
  const fetchImpl = async (url, options) => {
    fetchCalls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ stored: true, id: 'evt-1' })
    };
  };
  const { dispatch } = loadBackground({
    localData: { striffsApiBase: 'http://collector.test:9090' },
    fetchImpl
  });
  const payload = {
    eventType: 'diagram_component_clicked',
    event: { type: 'diagram_component_clicked', componentQualifiedName: 'com.example.Widget' },
    metadata: { currentView: 'striffs', zoom: 1.25 }
  };

  const response = await dispatch({
    type: 'recordEngagementEvent',
    operationId: 'op-123',
    engagementToken: 'eng-token',
    payload
  });

  assert.strictEqual(response.ok, true);
  assert.strictEqual(response.status, 200);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(response.json)), {
    stored: true,
    id: 'evt-1'
  });
  assert.strictEqual(fetchCalls.length, 1, 'expected a single engagement POST');
  assert.strictEqual(
    fetchCalls[0].url,
    'http://collector.test:9090/api/v1/striffs/op-123/engagement'
  );
  assert.strictEqual(fetchCalls[0].options.method, 'POST');
  assert.strictEqual(fetchCalls[0].options.headers['Content-Type'], 'application/json');
  assert.strictEqual(fetchCalls[0].options.headers['X-Striff-Engagement-Token'], 'eng-token');
  assert.deepStrictEqual(JSON.parse(fetchCalls[0].options.body), payload);
}

async function testRecordEngagementRejectsMissingTokenWithoutFetch() {
  let fetchCalled = false;
  const { dispatch } = loadBackground({
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error('fetch should not be called');
    }
  });

  const response = await dispatch({
    type: 'recordEngagementEvent',
    operationId: 'op-123',
    payload: { eventType: 'diffs_button_pressed', event: { type: 'diffs_button_pressed' } }
  });

  assert.strictEqual(response.ok, false);
  assert.strictEqual(response.error, 'missing engagementToken');
  assert.strictEqual(fetchCalled, false, 'fetch should not be called when token is missing');
}

async function testRecordEngagementSurfacesNonOkResponses() {
  const { dispatch } = loadBackground({
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      text: async () => 'bad token'
    })
  });

  const response = await dispatch({
    type: 'recordEngagementEvent',
    operationId: 'op-123',
    engagementToken: 'bad-token',
    payload: { eventType: 'diffs_button_pressed', event: { type: 'diffs_button_pressed' } }
  });

  assert.strictEqual(response.ok, false);
  assert.strictEqual(response.status, 403);
  assert.strictEqual(response.error, 'HTTP 403');
  assert.strictEqual(response.body, 'bad token');
}

module.exports = (async () => {
  await testRecordEngagementPostsPayloadToConfiguredApiBase();
  await testRecordEngagementRejectsMissingTokenWithoutFetch();
  await testRecordEngagementSurfacesNonOkResponses();
  console.log('background engagement test passed');
})();
