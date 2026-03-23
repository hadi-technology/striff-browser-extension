const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const manifestPath = path.join(__dirname, '..', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const permissions = new Set(Array.isArray(manifest.permissions) ? manifest.permissions : []);
const hostPermissions = new Set(Array.isArray(manifest.host_permissions) ? manifest.host_permissions : []);

assert.ok(permissions.has('storage'), 'manifest must keep storage permission');
assert.ok(permissions.has('tabs'), 'manifest must include tabs permission for cache reset fan-out');
assert.ok(permissions.has('scripting'), 'manifest must include scripting permission for page-world cache reset');

assert.ok(hostPermissions.has('*://github.com/*'), 'manifest must include github.com host permission');
assert.ok(hostPermissions.has('*://*.github.com/*'), 'manifest must include wildcard github host permission');
assert.ok(hostPermissions.has('http://localhost/*'), 'manifest must include localhost host permission');
assert.ok(hostPermissions.has('http://127.0.0.1/*'), 'manifest must include 127.0.0.1 host permission');

console.log('manifest permissions test passed');
