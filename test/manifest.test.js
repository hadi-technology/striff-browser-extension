const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));

test('manifest stays on MV3 with minimal extension permissions', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['storage']);
});

test('content scripts include shared metadata and config helpers before main bundle', () => {
  const scripts = manifest.content_scripts?.[0]?.js || [];
  assert.deepEqual(scripts, [
    'src/webext-shim.js',
    'src/pr-metadata-utils.js',
    'src/striffs-config-utils.js',
    'src/striffs.js'
  ]);
});
