const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CACHE_CLEAR_SEEN_KEY,
  INDEXEDDB_NAME,
  TEMP_CHANGED_FILES_PREFIX,
  buildArtifactPrefetchUrl,
  buildCacheKeyPatterns,
  buildGitHubPrefetchUrl,
  collectExpiredTempStorageKeys,
  isGithubPullRequestUrl,
  normalizeApiBase,
  parseTempChangedFilesTimestamp,
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

test('buildGitHubPrefetchUrl targets the prefetch endpoint and encodes query values', () => {
  assert.equal(
    buildGitHubPrefetchUrl(' https://striff.io/// ', 'openai', 'demo repo', 123, '2026-05-02T10:11:12Z'),
    'https://striff.io/api/v1/github/striffs/prefetch/owners/openai/repos/demo%20repo/pulls/123?updated_at=2026-05-02T10%3A11%3A12Z'
  );
});

test('buildArtifactPrefetchUrl targets the artifact prefetch endpoint and includes optional query values', () => {
  assert.equal(
    buildArtifactPrefetchUrl('https://striff.io/', {
      owner: 'openai',
      repo: 'demo repo',
      pullNumber: 123,
      updatedAt: '2026-05-03T10:11:12Z'
    }),
    'https://striff.io/api/v1/github/striffs/prefetch-artifacts?updated_at=2026-05-03T10%3A11%3A12Z&owner=openai&repo=demo+repo&pull_number=123'
  );
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
    [CACHE_CLEAR_SEEN_KEY]: 2,
    striffsDebug: true,
    'striffs:abc': {},
    'striffsCacheMeta:xyz': {},
    [`${TEMP_CHANGED_FILES_PREFIX}123:files`]: [],
    striffsApiBase: 'https://striff.io',
    unrelated: 'keep'
  });
  assert.deepEqual(keys.sort(), ['striffs:abc', 'striffsApiBase', 'striffsCacheMeta:xyz', `${TEMP_CHANGED_FILES_PREFIX}123:files`].sort());
});

test('temp storage parsing and cleanup removes expired response and changed-files payloads', () => {
  const now = 1_000_000;
  const fresh = 'striffsTempResponse:999900:fresh';
  const stale = 'striffsTempResponse:100000:stale';
  const freshChanged = `${TEMP_CHANGED_FILES_PREFIX}999950:fresh`;
  const staleChanged = `${TEMP_CHANGED_FILES_PREFIX}100050:stale`;
  assert.equal(parseTempResponseTimestamp(fresh), 999900);
  assert.equal(parseTempChangedFilesTimestamp(freshChanged), 999950);
  assert.equal(parseTempResponseTimestamp('nope'), null);
  assert.equal(parseTempChangedFilesTimestamp('nope'), null);
  assert.deepEqual(
    collectExpiredTempStorageKeys({ [fresh]: {}, [stale]: {}, [freshChanged]: {}, [staleChanged]: {}, other: {} }, now, 5_000),
    [stale, staleChanged]
  );
});

test('buildCacheKeyPatterns keeps cache names and IndexedDB name in sync', () => {
  const patterns = buildCacheKeyPatterns('owner/repo#1');
  assert.equal(INDEXEDDB_NAME, 'striffs-cache-db');
  assert.equal(patterns.localStorageKeyPattern.test('owner/repo#1'), true);
  assert.equal(patterns.localStorageKeyPattern.test('striffsCacheMeta:owner/repo#1'), true);
  assert.equal(patterns.localStorageKeyPattern.test('striffsCache:owner/repo#1:view'), true);
  assert.equal(patterns.chromeStorageKeyPattern.test('striffs:owner/repo#1'), true);
  assert.equal(patterns.chromeStorageKeyPattern.test('striffsCacheMeta:owner/repo#1'), true);
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
