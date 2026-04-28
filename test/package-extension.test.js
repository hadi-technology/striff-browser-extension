const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const stageDir = path.join(root, 'dist', 'extension');

test('package script stages a production-shaped extension without popup debug ui or runtime overrides', () => {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'package-extension.mjs')], {
    cwd: root,
    stdio: 'pipe'
  });

  const stagedPopup = fs.readFileSync(path.join(stageDir, 'html', 'popup.html'), 'utf8');
  const stagedBundle = fs.readFileSync(path.join(stageDir, 'src', 'striffs.js'), 'utf8');
  const stagedBackground = fs.readFileSync(path.join(stageDir, 'src', 'background.js'), 'utf8');
  const stagedShared = fs.readFileSync(path.join(stageDir, 'html', 'shared.js'), 'utf8');

  assert.equal(fs.existsSync(path.join(stageDir, 'test')), false);
  assert.equal(stagedPopup.includes('debugToggle'), false);
  assert.equal(stagedPopup.includes('target="_blank" class="note-link"'), false);
  assert.equal(stagedBundle.includes('stored?.striffsTest === true'), false);
  assert.equal(stagedBundle.includes("striffsConfigUrl"), false);
  assert.equal(stagedBundle.includes("setApiBaseOverride = async (base)"), false);
  assert.equal(stagedBackground.includes("stored?.striffsApiBase"), false);
  assert.equal(stagedShared.includes('ghToken'), false);
  assert.equal(stagedShared.includes("striffsApiBase"), false);
});
