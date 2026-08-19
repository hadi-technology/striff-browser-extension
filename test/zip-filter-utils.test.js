const test = require('node:test');
const assert = require('node:assert/strict');

const utils = require('../src/zip-filter-utils.js');
const fflate = require('../lib/fflate.min.js');

const MANIFEST = utils.DEFAULT_MANIFEST;

test('keeps every source and documentation extension the manifest names', () => {
  const keep = utils.compile(MANIFEST);
  for (const ext of MANIFEST.sourceExtensions) {
    assert.equal(keep(`repo/src/Thing.${ext}`), true, `${ext} must survive`);
  }
  for (const ext of MANIFEST.docExtensions) {
    assert.equal(keep(`repo/docs/adr-001.${ext}`), true, `${ext} must survive`);
  }
});

test('keeps build manifests at any depth including the archive root', () => {
  const keep = utils.compile(MANIFEST);
  assert.equal(keep('repo/package.json'), true);
  assert.equal(keep('repo/packages/core/tsconfig.json'), true);
  assert.equal(keep('repo/packages/core/tsconfig.build.json'), true);
  assert.equal(keep('repo/packages/core/jsconfig.json'), true);
  // Without these TypeScript resolves no imports at all, and the failure is silent.
  assert.equal(keep('repo/config.json'), false);
});

test('drops what is never read', () => {
  const keep = utils.compile(MANIFEST);
  assert.equal(keep('repo/docs/images/screenshot.png'), false);
  assert.equal(keep('repo/tools/installer.exe'), false);
  assert.equal(keep('repo/LICENSE'), false);
  assert.equal(keep('repo/src/'), false);
  assert.equal(keep(''), false);
});

test('drops build output and vendored trees', () => {
  const keep = utils.compile(MANIFEST);
  assert.equal(keep('repo/web/node_modules/left-pad/index.ts'), false);
  assert.equal(keep('repo/vendor/x/y.py'), false);
  assert.equal(keep('repo/service/target/classes/A.java'), false);
  assert.equal(keep('repo/web/dist/bundle.ts'), false);
});

test('keeps test source, which the server-side detectors read', () => {
  // The server excludes test trees when cataloguing documentation, and that exclusion is
  // deliberately not in this manifest: dropping test source makes UNTESTED_CONTRACT_CHANGE report
  // "no test exists" for code that has one.
  const keep = utils.compile(MANIFEST);
  assert.equal(keep('repo/src/test/java/com/x/ThingTest.java'), true);
  assert.equal(keep('repo/tests/test_spider.py'), true);
  assert.equal(keep('repo/src/__tests__/thing.spec.ts'), true);
});

test('filterZip repacks only the kept entries', () => {
  const zipped = fflate.zipSync({
    'repo/src/A.java': fflate.strToU8('class A {}'),
    'repo/docs/adr.md': fflate.strToU8('# ADR'),
    'repo/package.json': fflate.strToU8('{}'),
    'repo/docs/img/big.png': new Uint8Array(200000),
    'repo/web/node_modules/x/i.ts': fflate.strToU8('export const x = 1;')
  });

  const result = utils.filterZip(zipped.buffer, MANIFEST, { fflateImpl: fflate });
  assert.equal(result.ok, true);
  assert.equal(result.keptCount, 3);
  assert.equal(result.totalCount, 5);
  assert.ok(result.bytesAfter < result.bytesBefore);

  const back = fflate.unzipSync(new Uint8Array(result.buffer));
  assert.deepEqual(Object.keys(back).sort(),
    ['repo/docs/adr.md', 'repo/package.json', 'repo/src/A.java']);
  assert.equal(fflate.strFromU8(back['repo/src/A.java']), 'class A {}');
});

test('filterZip reports rather than throws when it cannot read the archive', () => {
  const result = utils.filterZip(new Uint8Array([1, 2, 3]).buffer, MANIFEST, { fflateImpl: fflate });
  assert.equal(result.ok, false);
  assert.ok(result.reason);
});

test('filterZip reports rather than throws when fflate is missing', () => {
  const result = utils.filterZip(new Uint8Array([1]).buffer, MANIFEST, { fflateImpl: null });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'fflate-unavailable');
});

test('loadManifest prefers the server and caches what it got', async () => {
  const served = { ...MANIFEST, version: 99, sourceExtensions: ['java'] };
  const stored = {};
  const storage = {
    get: async (keys) => ({ ...stored }),
    set: async (obj) => Object.assign(stored, obj)
  };
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    assert.equal(url, 'https://api.striff.io/api/v1/zip-filter');
    return { ok: true, json: async () => served };
  };

  const first = await utils.loadManifest('https://api.striff.io/', { fetchImpl, storage, now: () => 1000 });
  assert.equal(first.source, 'network');
  assert.equal(first.manifest.version, 99);

  const second = await utils.loadManifest('https://api.striff.io', { fetchImpl, storage, now: () => 2000 });
  assert.equal(second.source, 'cache');
  assert.equal(calls, 1, 'a cached manifest must not re-fetch inside the TTL');
});

test('loadManifest falls back to filtering rather than to uploading everything', async () => {
  // Failing open would turn a manifest outage into a total outage: the unfiltered archive is
  // refused by the server ceiling anyway.
  const fetchImpl = async () => { throw new Error('offline'); };
  const storage = { get: async () => ({}), set: async () => {} };
  const result = await utils.loadManifest('https://api.striff.io', { fetchImpl, storage });
  assert.equal(result.source, 'default');
  assert.deepEqual(result.manifest, utils.DEFAULT_MANIFEST);
});

test('loadManifest ignores a malformed response', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ sourceExtensions: [] }) });
  const storage = { get: async () => ({}), set: async () => {} };
  const result = await utils.loadManifest('https://api.striff.io', { fetchImpl, storage });
  assert.equal(result.source, 'default');
});

test('the built-in fallback matches the extensions the API serves today', () => {
  // Not a second source of truth: if this drifts from the server the fallback path silently
  // filters by rules the analysis no longer agrees with.
  assert.deepEqual(MANIFEST.sourceExtensions, ['cs', 'java', 'py', 'ts', 'tsx']);
  assert.deepEqual(MANIFEST.docExtensions, ['adoc', 'md', 'mdx', 'rst']);
  assert.equal(MANIFEST.maxUploadBytes, 15 * 1024 * 1024);
});
