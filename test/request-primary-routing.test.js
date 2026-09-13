const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// requestPrimary lives inside the striffs.js content-script IIFE, which cannot be require()d in
// node. Extract the real declarations and run them in a sandbox with the two request paths stubbed.
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

function load({ zipError }) {
  const calls = [];
  const sandbox = {
    // The page check misreading a private repo as public -- the case under test.
    S: { POST_PRIMARY_ENABLED: true, isPrivateRepo: () => false, cinfo: () => {} },
    ZIP_LIMIT_ERROR_CODES: new Set(['ZIP_TOO_LARGE']),
    ZIP_REDUCE_SCOPE_ERROR_CODES: new Set(['ZIP_UPLOAD_TOO_LARGE']),
    requestWithZips: async () => { calls.push('zips'); throw zipError; },
    requestWithToken: async () => { calls.push('token'); return { via: 'token' }; }
  };
  vm.runInNewContext(`${code}\nthis.requestPrimary = requestPrimary;`, sandbox);
  return { requestPrimary: sandbox.requestPrimary, calls };
}

const baseZipNotFound = () =>
  Object.assign(new Error('Failed downloading base zip: Failed to download zip: 404'), {
    status: null,
    errorCode: 'BASE_ZIP_NOT_FOUND'
  });

test('a base ZIP 404 falls back to the token GET when a token is stored', async () => {
  const { requestPrimary, calls } = load({ zipError: baseZipNotFound() });
  const result = await requestPrimary({}, 'ghp_token');
  assert.equal(result.via, 'token');
  assert.deepEqual([...calls], ['zips', 'token']);
});

test('a base ZIP 404 without a token is rethrown for describeApiError', async () => {
  const { requestPrimary, calls } = load({ zipError: baseZipNotFound() });
  await assert.rejects(requestPrimary({}, ''), { errorCode: 'BASE_ZIP_NOT_FOUND' });
  assert.deepEqual([...calls], ['zips']);
});

test('an unrelated upload failure is not retried on the token GET', async () => {
  const zipError = Object.assign(new Error('boom'), { status: 500, errorCode: 'INTERNAL_ERROR' });
  const { requestPrimary, calls } = load({ zipError });
  await assert.rejects(requestPrimary({}, 'ghp_token'), { errorCode: 'INTERNAL_ERROR' });
  assert.deepEqual([...calls], ['zips']);
});
