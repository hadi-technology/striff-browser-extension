import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');
const stageDir = path.join(distDir, 'extension');
const zipPath = path.join(distDir, 'striffs-extension.zip');

async function rewriteFile(relPath, transform) {
  const target = path.join(stageDir, relPath);
  const current = await fs.readFile(target, 'utf8');
  const next = transform(current);
  await fs.writeFile(target, next, 'utf8');
}

function stripPopupDebugSection(html) {
  return html.replace(/\n\s*<div class="section">\s*<label class="debug-label"[\s\S]*?<\/div>\s*/m, '\n');
}

function disableBundledTestHooks(source) {
  return source
    .replace(/S\.__testModeEnabled = stored\?\.striffsTest === true;/g, 'S.__testModeEnabled = false;')
    .replace(/if \(!S\.isTest\?\.\(\)\) return;/g, 'if (true) return;');
}

function stripStriffsRuntimeOverrides(source) {
  return source
    .replace(
      /S\.getRemoteConfigUrl = async function getRemoteConfigUrl\(\) \{[\s\S]*?return override \|\| S\.REMOTE_CONFIG_URL;\n  \};/,
      "S.getRemoteConfigUrl = async function getRemoteConfigUrl() {\n    return S.REMOTE_CONFIG_URL;\n  };"
    )
    .replace(
      /S\.setApiBaseOverride = async \(base\) => new Promise\(\(resolve\) => \{[\s\S]*?\n  \}\);/,
      "S.setApiBaseOverride = async () => false;"
    )
    .replace(
      /S\.clearApiBaseOverride = async \(\) => new Promise\(\(resolve\) => \{[\s\S]*?\n  \}\);/,
      "S.clearApiBaseOverride = async () => false;"
    );
}

function stripBackgroundRuntimeOverrides(source) {
  return source.replace(
    /async function getApiBase\(defaultBase = 'http:\/\/localhost:8080'\) \{[\s\S]*?return normalizeApiBase\(defaultBase\);\n\}/,
    "async function getApiBase(defaultBase = 'http://localhost:8080') {\n  return normalizeApiBase(defaultBase);\n}"
  );
}

function stripOverrideCacheKeys(source) {
  return source
    .replace(/\s*"striffsConfigUrl",\n/g, '\n')
    .replace(/\s*"striffsApiBase"\n/g, '\n');
}

async function rmIfExists(target) {
  await fs.rm(target, { recursive: true, force: true });
}

async function copyRelative(relPath) {
  const src = path.join(root, relPath);
  const dest = path.join(stageDir, relPath);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(src, dest, { recursive: true });
}

await rmIfExists(stageDir);
await rmIfExists(zipPath);
await fs.mkdir(stageDir, { recursive: true });

for (const relPath of ['manifest.json', 'html', 'icons', 'lib', 'src']) {
  await copyRelative(relPath);
}

await rmIfExists(path.join(stageDir, 'html', 'config-local-test.json'));
await rewriteFile('html/popup.html', stripPopupDebugSection);
await rewriteFile('src/striffs.js', disableBundledTestHooks);
await rewriteFile('src/striffs.js', stripStriffsRuntimeOverrides);
await rewriteFile('src/striffs.js', stripOverrideCacheKeys);
await rewriteFile('src/background.js', stripBackgroundRuntimeOverrides);
await rewriteFile('src/background.js', stripOverrideCacheKeys);
await rewriteFile('src/background-utils.js', stripOverrideCacheKeys);
await rewriteFile('html/shared.js', stripOverrideCacheKeys);

try {
  await execFileAsync('zip', ['-qr', zipPath, '.'], { cwd: stageDir });
  console.log(`Packaged extension zip at ${zipPath}`);
} catch (_) {
  console.warn('zip command unavailable; staged unpacked extension instead.');
  console.warn(`Use directory: ${stageDir}`);
}
