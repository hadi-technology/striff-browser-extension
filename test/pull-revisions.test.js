const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The upload route builds its request from two commits -- the pull request's head and the merge base
// of its base and head -- resolved from GitHub's API, never from branch names, which stop resolving
// once a merged pull request's branch is deleted. These declarations live inside the striffs.js
// content-script IIFE, which cannot be require()d in node, so they are extracted and run in a sandbox
// with GitHub stubbed at the fetch helpers. The parameter list is skipped by paren matching first,
// because several of them destructure `{ ... } = {}` there and a brace scan would stop inside it.
function extract(source, marker) {
  let start = source.indexOf(marker);
  assert.notEqual(start, -1, `could not find ${marker} in striffs.js`);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  let i = source.indexOf('(', start);
  for (let parens = 0; i < source.length; i += 1) {
    if (source[i] === '(') parens += 1;
    else if (source[i] === ')' && --parens === 0) break;
  }
  const braceStart = source.indexOf('{', i);
  for (let depth = 0, j = braceStart; j < source.length; j += 1) {
    if (source[j] === '{') depth += 1;
    else if (source[j] === '}' && --depth === 0) return source.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces extracting ${marker}`);
}

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'striffs.js'), 'utf8');
const code = [
  'function headerValue(',
  'function githubRateLimitError(',
  'function fetchGitHubApi(',
  'function resolvePullRevisions(',
  'function fetchHeadFileContent(',
  'function isAnonymousNotFoundError(',
  'function isUploadPathTooLargeError(',
  'const shouldPromptForTokenForZipLimit = ',
  'const describeApiError = '
].map((marker) => extract(src, marker)).join(';\n');

const PULL = { base: { sha: 'b'.repeat(40) }, head: { sha: 'h'.repeat(40) } };
const MERGE_BASE = 'm'.repeat(40);
const ok = (body) => ({ ok: true, status: 200, body, headers: {} });

// github: url -> response, as fetchJsonWithTimeout returns it. raw: url -> response, as
// fetchTextWithTimeout returns it.
function load({ github = {}, raw = {} } = {}) {
  const requests = [];
  const answer = (table, url) => {
    requests.push(url);
    for (const [pattern, resp] of Object.entries(table)) {
      if (url.includes(pattern)) return typeof resp === 'function' ? resp() : resp;
    }
    return { ok: false, status: 599, body: null, text: '', headers: {} };
  };
  const sandbox = {
    S: {},
    document: { documentElement: { dataset: {} } },
    timeoutFor: (_key, fallback) => fallback,
    normalizeChangedFilePath: (p) => String(p || '').replace(/^\/+/, ''),
    encodeGitHubPath: (p) => p.split('/').map(encodeURIComponent).join('/'),
    fetchJsonWithTimeout: async (url) => answer(github, url),
    fetchTextWithTimeout: async (url) => answer(raw, url),
    ZIP_LIMIT_ERROR_CODES: new Set(['ZIP_TOO_LARGE']),
    ZIP_REDUCE_SCOPE_ERROR_CODES: new Set(['ZIP_UPLOAD_TOO_LARGE']),
    TOKEN_GUIDANCE_ERROR_CODES: new Set(),
    // Its regex defeats the brace matching above, and these messages have no JSON to unwrap.
    extractHumanMessage: (raw) => String(raw || '').trim(),
    Date,
    Number,
    String
  };
  vm.runInNewContext(
    `const pullRevisions = new Map();\n${code};\n` +
    'this.api = { resolvePullRevisions, fetchHeadFileContent, describeApiError, githubRateLimitError };',
    sandbox
  );
  return { ...sandbox.api, requests, dataset: sandbox.document.documentElement.dataset };
}

const META = { owner: 'acme', repo: 'app', pull_number: '7', updated_at: '2026-09-23T00:00:00Z' };
const PULL_URL = 'https://api.github.com/repos/acme/app/pulls/7';
const COMPARE_URL = `https://api.github.com/repos/acme/app/compare/${PULL.base.sha}...${PULL.head.sha}?per_page=1`;

test("the upload is built from the head commit and the merge base, as GitHub reports them", async () => {
  const { resolvePullRevisions, requests, dataset } = load({
    github: { '/pulls/7': ok(PULL), '/compare/': ok({ merge_base_commit: { sha: MERGE_BASE } }) }
  });
  const revisions = await resolvePullRevisions(META, null);
  assert.deepEqual({ ...revisions }, { owner: 'acme', repo: 'app', headSha: PULL.head.sha, mergeBaseSha: MERGE_BASE });
  // The merge base of the pull request's own base and head commits, not of the branch names.
  assert.deepEqual(requests, [PULL_URL, COMPARE_URL]);
  assert.equal(dataset.striffsHeadSha, PULL.head.sha);
  assert.equal(dataset.striffsMergeBaseSha, MERGE_BASE);
});

test('a pull request revision is resolved once, and again after a push', async () => {
  const { resolvePullRevisions, requests } = load({
    github: { '/pulls/7': ok(PULL), '/compare/': ok({ merge_base_commit: { sha: MERGE_BASE } }) }
  });
  await resolvePullRevisions(META, null);
  await resolvePullRevisions(META, null);
  assert.equal(requests.length, 2);
  await resolvePullRevisions({ ...META, updated_at: '2026-09-23T01:00:00Z' }, null);
  assert.equal(requests.length, 4);
});

test('the hourly limit is reported as a rate limit, with the time it resets', async () => {
  const resetSeconds = Math.floor(Date.now() / 1000) + 1800;
  const { resolvePullRevisions } = load({
    github: {
      '/pulls/7': {
        ok: false,
        status: 403,
        body: { message: 'API rate limit exceeded for 203.0.113.9.' },
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSeconds) }
      }
    }
  });
  await assert.rejects(resolvePullRevisions(META, null), (err) => {
    assert.equal(err.errorCode, 'GITHUB_RATE_LIMITED');
    assert.equal(err.resetAt, resetSeconds * 1000);
    return true;
  });
});

test('a secondary rate limit is reported as one, timed by retry-after', async () => {
  const { resolvePullRevisions } = load({
    github: {
      '/pulls/7': {
        ok: false,
        status: 429,
        body: { message: 'You have exceeded a secondary rate limit.' },
        headers: { 'retry-after': '60' }
      }
    }
  });
  const before = Date.now();
  await assert.rejects(resolvePullRevisions(META, 'ghp_token'), (err) => {
    assert.equal(err.errorCode, 'GITHUB_RATE_LIMITED');
    assert.ok(err.resetAt >= before + 60000 && err.resetAt <= Date.now() + 60000);
    assert.equal(err.withToken, true);
    return true;
  });
});

test('a 403 that is not a rate limit is not reported as one', async () => {
  const { resolvePullRevisions } = load({
    github: { '/pulls/7': { ok: false, status: 403, body: { message: 'Resource not accessible' }, headers: { 'x-ratelimit-remaining': '41' } } }
  });
  await assert.rejects(resolvePullRevisions(META, null), { errorCode: 'PULL_REVISIONS_UNAVAILABLE', status: 403 });
});

test('a compare without a merge base fails rather than guessing one', async () => {
  const { resolvePullRevisions } = load({ github: { '/pulls/7': ok(PULL), '/compare/': ok({}) } });
  await assert.rejects(resolvePullRevisions(META, null), { errorCode: 'PULL_REVISIONS_UNAVAILABLE' });
});

test('changed files are read at the head commit from the pull request repository', async () => {
  const { fetchHeadFileContent, requests } = load({ raw: { 'raw.githubusercontent.com': { ok: true, status: 200, text: 'class A {}', headers: {} } } });
  const content = await fetchHeadFileContent({ owner: 'acme', repo: 'app', headSha: PULL.head.sha }, 'src/A.java');
  assert.equal(content, 'class A {}');
  assert.deepEqual(requests, [`https://raw.githubusercontent.com/acme/app/${PULL.head.sha}/src/A.java`]);
});

test('a changed file missing at the head commit means the repository is not publicly readable', async () => {
  const { fetchHeadFileContent } = load({ raw: { 'raw.githubusercontent.com': { ok: false, status: 404, text: '404: Not Found', headers: {} } } });
  await assert.rejects(
    fetchHeadFileContent({ owner: 'acme', repo: 'app', headSha: PULL.head.sha }, 'src/A.java'),
    { errorCode: 'HEAD_FILE_NOT_FOUND', status: 404 }
  );
});

test('raw.githubusercontent.com throttling is reported as a rate limit', async () => {
  const { fetchHeadFileContent } = load({ raw: { 'raw.githubusercontent.com': { ok: false, status: 429, text: '', headers: { 'retry-after': '30' } } } });
  await assert.rejects(
    fetchHeadFileContent({ owner: 'acme', repo: 'app', headSha: PULL.head.sha }, 'src/A.java'),
    { errorCode: 'GITHUB_RATE_LIMITED' }
  );
});

test('without a token, a rate limit asks for one and waits for it', () => {
  const { describeApiError } = load();
  const resetAt = Date.now() + 30 * 60000;
  const handled = describeApiError({ token: null, status: 403, errorCode: 'GITHUB_RATE_LIMITED', message: 'x', resetAt });
  assert.equal(handled.waitingForToken, true);
  assert.match(handled.toast, /Connect a GitHub token/);
  assert.match(handled.toast, /reload the page after /);
});

test('with a token, a rate limit says when to retry and does not ask for a token', () => {
  const { describeApiError } = load();
  const handled = describeApiError({ token: 'ghp_token', status: 403, errorCode: 'GITHUB_RATE_LIMITED', message: 'x', resetAt: null });
  assert.ok(!handled.waitingForToken);
  assert.doesNotMatch(handled.toast, /Connect/);
  assert.match(handled.toast, /reload the page later/);
});

test('without a token, a head file 404 asks for a token like a base ZIP 404', () => {
  const { describeApiError } = load();
  const handled = describeApiError({ token: null, status: 404, errorCode: 'HEAD_FILE_NOT_FOUND', message: 'x' });
  assert.match(handled.toast, /looks private/);
  assert.equal(handled.waitingForToken, true);
});
