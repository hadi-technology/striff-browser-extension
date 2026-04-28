const test = require('node:test');
const assert = require('node:assert/strict');

const {
  collectExpiredTempResponseKeys,
  isGithubPullRequestUrl,
  normalizeApiBase,
  parseTempResponseTimestamp,
  pickReturnHeaders,
  readApiErrorResponse,
  selectChromeStorageCacheKeys,
  shouldAllowProxyUrl,
} = require('../src/background-utils.js');

test('normalizeApiBase trims whitespace and trailing slashes', () => {
  assert.equal(normalizeApiBase(' https://striff.io/// '), 'https://striff.io');
  assert.equal(normalizeApiBase(''), '');
});

test('shouldAllowProxyUrl allows static hosts, loopback, and configured api origin only', () => {
  assert.equal(shouldAllowProxyUrl('https://api.github.com/user', ''), true);
  assert.equal(shouldAllowProxyUrl('http://localhost:8080/api/v1/health', ''), true);
  assert.equal(shouldAllowProxyUrl('https://striff.io/api/v1/languages', 'https://striff.io/'), true);
  assert.equal(shouldAllowProxyUrl('https://evil.example.com/data', 'https://striff.io/'), false);
  assert.equal(shouldAllowProxyUrl('ftp://api.github.com/user', ''), false);
});

test('selectChromeStorageCacheKeys removes extension caches and keeps tokens/debug flags', () => {
  const keys = selectChromeStorageCacheKeys({
    ghToken: 'secret',
    striffsCacheClearAt: 1,
    striffsDebug: true,
    'striffs:abc': {},
    'striffsCacheMeta:xyz': {},
    striffsApiBase: 'https://striff.io',
    unrelated: 'keep'
  });
  assert.deepEqual(keys.sort(), ['striffs:abc', 'striffsApiBase', 'striffsCacheMeta:xyz'].sort());
});

test('temp response key parsing and cleanup only removes expired temp payloads', () => {
  const now = 1_000_000;
  const fresh = 'striffsTempResponse:999900:fresh';
  const stale = 'striffsTempResponse:100000:stale';
  assert.equal(parseTempResponseTimestamp(fresh), 999900);
  assert.equal(parseTempResponseTimestamp('nope'), null);
  assert.deepEqual(
    collectExpiredTempResponseKeys({ [fresh]: {}, [stale]: {}, other: {} }, now, 5_000),
    [stale]
  );
});

test('pickReturnHeaders keeps only the expected response headers', () => {
  const headers = new Map([
    ['content-type', 'application/json'],
    ['x-oauth-scopes', 'repo'],
    ['x-ratelimit-remaining', '4999'],
    ['server', 'GitHub.com']
  ]);
  const picked = pickReturnHeaders({ entries: () => headers.entries() });
  assert.deepEqual(picked, {
    'content-type': 'application/json',
    'x-oauth-scopes': 'repo',
    'x-ratelimit-remaining': '4999'
  });
});

test('readApiErrorResponse prefers structured json error payloads', async () => {
  const jsonRes = {
    status: 403,
    headers: { get: () => 'application/json; charset=utf-8' },
    json: async () => ({ errorMessage: 'Forbidden', errorCode: 'ACCESS_DENIED' }),
    text: async () => ''
  };
  const textRes = {
    status: 500,
    headers: { get: () => 'text/plain' },
    json: async () => null,
    text: async () => 'server exploded'
  };

  assert.deepEqual(await readApiErrorResponse(jsonRes), {
    detail: { errorMessage: 'Forbidden', errorCode: 'ACCESS_DENIED' },
    error: 'Forbidden',
    errorCode: 'ACCESS_DENIED'
  });
  assert.deepEqual(await readApiErrorResponse(textRes), {
    detail: 'server exploded',
    error: 'server exploded',
    errorCode: null
  });
});

test('isGithubPullRequestUrl matches only pull request pages', () => {
  assert.equal(isGithubPullRequestUrl('https://github.com/openai/openai/pull/123/files'), true);
  assert.equal(isGithubPullRequestUrl('https://github.com/openai/openai/issues/123'), false);
});
