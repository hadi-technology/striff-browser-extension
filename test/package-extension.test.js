const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const stageDir = path.join(root, 'dist', 'extension');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const popupHtml = fs.readFileSync(path.join(root, 'html', 'popup.html'), 'utf8');

test('popup issue links match package.json bugs URL', () => {
  const expectedIssuesUrl = packageJson.bugs.url;
  const matches = Array.from(popupHtml.matchAll(/href="(https:\/\/github\.com\/[^"]+\/issues)"/g)).map((m) => m[1]);
  assert.equal(matches.length >= 2, true);
  assert.deepEqual(new Set(matches), new Set([expectedIssuesUrl]));
});

test('package script stages a production-shaped extension without popup debug ui or runtime overrides', () => {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'package-extension.mjs')], {
    cwd: root,
    stdio: 'pipe'
  });

  const stagedPopup = fs.readFileSync(path.join(stageDir, 'html', 'popup.html'), 'utf8');
  const stagedBundle = fs.readFileSync(path.join(stageDir, 'src', 'striffs.js'), 'utf8');
  const stagedBackground = fs.readFileSync(path.join(stageDir, 'src', 'background.js'), 'utf8');
  const stagedShared = fs.readFileSync(path.join(stageDir, 'html', 'shared.js'), 'utf8');
  const sourceBackground = fs.readFileSync(path.join(root, 'src', 'background.js'), 'utf8');

  assert.equal(fs.existsSync(path.join(stageDir, 'test')), false);
  // background.js loads these with importScripts inside a try/catch that swallows a miss, so a file
  // left out of the package fails neither the build nor the worker -- it just quietly stops
  // filtering archives, or stops waiting for queued analyses. Checked here instead.
  for (const required of ['src/zip-filter-utils.js', 'src/analysis-job-client.js', 'lib/fflate.min.js']) {
    assert.equal(fs.existsSync(path.join(stageDir, required)), true, `${required} must be packaged`);
  }
  for (const imported of ['./zip-filter-utils.js', './analysis-job-client.js', '../lib/fflate.min.js']) {
    assert.equal(stagedBackground.includes(imported), true, `${imported} must still be imported`);
  }
  assert.equal(stagedPopup.includes('debugToggle'), false);
  assert.equal(stagedPopup.includes('target="_blank" class="note-link"'), false);
  assert.equal(stagedBundle.includes('stored?.striffsTest === true'), false);
  assert.equal(stagedBundle.includes("striffsConfigUrl"), false);
  assert.equal(stagedBundle.includes("setApiBaseOverride = async (base)"), false);
  assert.equal(sourceBackground.includes("const DEV_DEFAULT_API_BASE = 'https://api.striff.io';"), true);
  assert.equal(stagedBackground.includes("http://localhost:8080"), false);
  assert.equal(stagedBackground.includes("async function getApiBase(defaultBase = 'https://api.striff.io')"), true);
  assert.equal(stagedBackground.includes("stored?.striffsApiBase"), false);
  assert.equal(stagedShared.includes('ghToken'), false);
  assert.equal(stagedShared.includes("striffsApiBase"), false);
});
