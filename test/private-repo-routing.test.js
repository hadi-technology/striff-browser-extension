const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Which route a load takes for a private repository. requestPrimary lives inside the striffs.js
// content-script IIFE, which cannot be require()d in node, so the real declarations are extracted
// and run in a sandbox with the two request paths and GitHub's answer about the repository stubbed.
// The parameter list is skipped by paren matching first, because requestPrimary destructures
// `{ quiet = false } = {}` there and a brace scan would stop inside it.
function extractFunction(source, name) {
  const marker = `function ${name}(`;
  let start = source.indexOf(marker);
  assert.notEqual(start, -1, `could not find ${name} in striffs.js`);
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
  throw new Error(`unbalanced braces extracting ${name}`);
}

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'striffs.js'), 'utf8');
const code = ['isBaseZipNotFoundError', 'isUploadPathTooLargeError', 'requestPrimary']
  .map((name) => extractFunction(src, name))
  .join('\n');

// githubSaysPrivate: GitHub's answer, or undefined when there is no resolver to ask.
// pageSaysPrivate: the page's own signals, which can be missing after an in-place navigation.
function load({ githubSaysPrivate, pageSaysPrivate = false }) {
  const calls = [];
  const S = { POST_PRIMARY_ENABLED: true, isPrivateRepo: () => pageSaysPrivate, cinfo: () => {} };
  if (githubSaysPrivate !== undefined) {
    S.resolveRepoPrivacy = async () => { calls.push('github'); return githubSaysPrivate; };
  }
  const sandbox = {
    S,
    ZIP_LIMIT_ERROR_CODES: new Set(['ZIP_TOO_LARGE']),
    ZIP_REDUCE_SCOPE_ERROR_CODES: new Set(['ZIP_UPLOAD_TOO_LARGE']),
    requestWithZips: async () => { calls.push('zips'); return { via: 'zips' }; },
    requestWithToken: async () => { calls.push('token'); return { via: 'token' }; }
  };
  vm.runInNewContext(`${code}\nthis.requestPrimary = requestPrimary;`, sandbox);
  return { requestPrimary: sandbox.requestPrimary, calls };
}

test('a private repository with a token goes straight to the token GET, never to codeload', async () => {
  const { requestPrimary, calls } = load({ githubSaysPrivate: true });
  const result = await requestPrimary({ owner: 'acme', repo: 'app' }, 'ghp_token');
  assert.equal(result.via, 'token');
  assert.deepEqual([...calls], ['github', 'token']);
});

test('a private repository without a token asks for one, and downloads nothing', async () => {
  const { requestPrimary, calls } = load({ githubSaysPrivate: true });
  await assert.rejects(requestPrimary({ owner: 'acme', repo: 'app' }, ''), { errorCode: 'PRIVATE_REPO_TOKEN_REQUIRED' });
  assert.deepEqual([...calls], ['github']);
});

test("GitHub's answer outranks the page's: a public repository takes the upload route", async () => {
  const { requestPrimary, calls } = load({ githubSaysPrivate: false, pageSaysPrivate: true });
  const result = await requestPrimary({ owner: 'acme', repo: 'app' }, 'ghp_token');
  assert.equal(result.via, 'zips');
  assert.deepEqual([...calls], ['github', 'zips']);
});

test('with nothing to ask, the page decides, as before', async () => {
  const privatePage = load({ pageSaysPrivate: true });
  assert.equal((await privatePage.requestPrimary({}, 'ghp_token')).via, 'token');
  const publicPage = load({ pageSaysPrivate: false });
  assert.equal((await publicPage.requestPrimary({}, 'ghp_token')).via, 'zips');
});
