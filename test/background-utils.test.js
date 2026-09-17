const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CACHE_CLEAR_SEEN_KEY,
  INDEXEDDB_NAME,
  TEMP_CHANGED_FILES_PREFIX,
  buildCacheKeyPatterns,
  collectExpiredTempStorageKeys,
  isGithubPullRequestUrl,
  normalizeApiBase,
  parseTempChangedFilesTimestamp,
  parseTempResponseTimestamp,
  pickReturnHeaders,
  readApiErrorResponse,
  selectChromeStorageCacheKeys,
  shouldAllowProxyUrl,
  pullRequestFormFields,
  withoutUnexpectedAuthorization,
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

test('readApiErrorResponse does not pass a proxy HTML page off as the message', async () => {
  const nginx503 = '<html>\n<head><title>503 Service Temporarily Unavailable</title></head>\n'
    + '<body>\n<center><h1>503 Service Temporarily Unavailable</h1></center>\n</body>\n</html>\n'
    + '<!-- a padding to disable MSIE and Chrome friendly error page -->';
  // Labelled as HTML, and not labelled at all: both reached the toast verbatim.
  for (const contentType of ['text/html', '']) {
    const parsed = await readApiErrorResponse({
      status: 503,
      headers: { get: () => contentType },
      json: async () => null,
      text: async () => nginx503
    });
    assert.equal(parsed.error, 'The Striffs service returned HTTP 503.');
    assert.equal(parsed.errorCode, null);
  }
});

test('isGithubPullRequestUrl matches only pull request pages', () => {
  assert.equal(isGithubPullRequestUrl('https://github.com/openai/openai/pull/123/files'), true);
  assert.equal(isGithubPullRequestUrl('https://github.com/openai/openai/issues/123'), false);
});

test('withoutUnexpectedAuthorization keeps the token for GitHub API hosts only', () => {
  const headers = { Accept: 'application/vnd.github+json', Authorization: 'token secret' };
  assert.deepEqual(withoutUnexpectedAuthorization('https://api.github.com/repos/o/r/pulls/1', headers), headers);
  assert.deepEqual(withoutUnexpectedAuthorization('https://raw.githubusercontent.com/o/r/abc/A.java', headers), headers);
  // The proxy allows these, but they are not hosts the token is for.
  for (const url of [
    'https://codeload.github.com/o/r/zip/main',
    'https://striffs-config.tor1.cdn.digitaloceanspaces.com/config.json',
    'http://localhost:8080/api/v1/health',
    'https://api.striff.io/api/v1/languages',
    'not a url'
  ]) {
    assert.deepEqual(
      withoutUnexpectedAuthorization(url, { ...headers, authorization: 'token secret' }),
      { Accept: 'application/vnd.github+json' }
    );
  }
});

test('pullRequestFormFields names the pull request only when owner, repo and number are all usable', () => {
  assert.deepEqual(pullRequestFormFields({ owner: 'acme', repo: 'app.js', pullNumber: '7' }),
    [['owner', 'acme'], ['repo', 'app.js'], ['pull_number', '7']]);
  assert.deepEqual(pullRequestFormFields({ owner: 'acme', repo: 'app', pullNumber: 42 }),
    [['owner', 'acme'], ['repo', 'app'], ['pull_number', '42']]);
  assert.deepEqual(pullRequestFormFields({ owner: 'acme', repo: 'app' }), []);
  assert.deepEqual(pullRequestFormFields({ owner: 'acme/../x', repo: 'app', pullNumber: '7' }), []);
  assert.deepEqual(pullRequestFormFields({ owner: 'acme', repo: 'app', pullNumber: '0' }), []);
  assert.deepEqual(pullRequestFormFields(), []);
});
