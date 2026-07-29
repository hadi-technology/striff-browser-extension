const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// background.js is an MV3 service worker, not a module — loading it registers
// the onMessage router as a side effect. Stub just enough of the worker
// environment (chrome.*, importScripts, fetch) to capture that router and
// drive the prefetch handlers directly.

function makeStorageArea() {
  const data = {};
  return {
    get(keys, cb) {
      const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(data);
      const out = {};
      for (const k of list) if (k in data) out[k] = data[k];
      if (typeof cb === 'function') { cb(out); return; }
      return Promise.resolve(out);
    },
    set(items, cb) {
      Object.assign(data, items);
      if (typeof cb === 'function') { cb(); return; }
      return Promise.resolve();
    },
    remove(keys, cb) {
      for (const k of [].concat(keys)) delete data[k];
      if (typeof cb === 'function') { cb(); return; }
      return Promise.resolve();
    },
  };
}

let onMessageListener = null;

globalThis.chrome = {
  runtime: {
    onInstalled: { addListener() {} },
    onMessage: { addListener(fn) { onMessageListener = fn; } },
    sendMessage(_msg, cb) { if (typeof cb === 'function') cb(); },
  },
  storage: {
    local: makeStorageArea(),
    session: makeStorageArea(),
    onChanged: { addListener() {} },
  },
  tabs: {
    query(_q, cb) { if (typeof cb === 'function') { cb([]); return; } return Promise.resolve([]); },
    sendMessage() {},
  },
};

globalThis.importScripts = (...files) => {
  for (const f of files) require(path.join(__dirname, '../src', f));
};

const fetchCalls = [];
let nextFetchResponse = () => new Response('{}', { status: 200 });
globalThis.fetch = async (url, init = {}) => {
  fetchCalls.push({ url: String(url), init });
  return nextFetchResponse();
};

require('../src/background.js');

function dispatch(msg) {
  return new Promise((resolve) => {
    const returned = onMessageListener(
      msg,
      { tab: { id: 1, url: 'https://github.com/openai/demo/pull/123/files' } },
      resolve
    );
    assert.equal(returned, true, 'router must return true to keep the reply channel open');
  });
}

test('prefetchStriffsWithToken fires a POST to the prefetch endpoint and replies ok on 200', async () => {
  assert.equal(typeof onMessageListener, 'function', 'background.js should register an onMessage listener');
  fetchCalls.length = 0;
  nextFetchResponse = () =>
    new Response(JSON.stringify({ queued: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const reply = await dispatch({
    type: 'prefetchStriffsWithToken',
    owner: 'openai',
    repo: 'demo',
    pull_number: 123,
    updated_at: '2026-05-02T10:11:12Z',
    token: 'tok-123',
  });

  assert.equal(reply.ok, true);
  assert.equal(reply.timings?.status, 200);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].init.method, 'POST');
  assert.match(
    fetchCalls[0].url,
    /\/api\/v1\/github\/striffs\/prefetch\/owners\/openai\/repos\/demo\/pulls\/123\?updated_at=/
  );
  assert.equal(fetchCalls[0].init.headers.Authorization, 'token tok-123');
});

test('prefetchStriffsWithToken replies ok:false with the status on an API error', async () => {
  fetchCalls.length = 0;
  nextFetchResponse = () =>
    new Response(JSON.stringify({ error: 'nope' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });

  const reply = await dispatch({
    type: 'prefetchStriffsWithToken',
    owner: 'openai',
    repo: 'demo',
    pull_number: 123,
    updated_at: '2026-05-02T10:11:12Z',
    token: 'tok-123',
  });

  assert.equal(reply.ok, false);
  assert.equal(reply.status, 500);
  assert.equal(fetchCalls.length, 1);
});

test('prefetchStriffsWithToken rejects missing args without firing a request', async () => {
  fetchCalls.length = 0;

  const reply = await dispatch({
    type: 'prefetchStriffsWithToken',
    owner: 'openai',
    repo: 'demo',
    // pull_number / updated_at missing
  });

  assert.equal(reply.ok, false);
  assert.match(String(reply.error), /missing args/);
  assert.equal(fetchCalls.length, 0, 'no network request should be made');
});
