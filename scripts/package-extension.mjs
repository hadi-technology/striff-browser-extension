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

async function rewriteFile(relPath, transform, { description = relPath, mustChange = true, mustNotContain = [] } = {}) {
  const target = path.join(stageDir, relPath);
  const current = await fs.readFile(target, 'utf8');
  const next = transform(current);
  if (mustChange && next === current) {
    throw new Error(`Packaging rewrite did not change ${description}`);
  }
  for (const marker of mustNotContain) {
    if (next.includes(marker)) {
      throw new Error(`Packaging rewrite for ${description} left forbidden marker: ${marker}`);
    }
  }
  await fs.writeFile(target, next, 'utf8');
}

function stripPopupDebugSection(html) {
  return html.replace(/\n\s*<div class="section">\s*<label class="debug-label"[^>]*for="debugToggle"[^>]*>[\s\S]*?<\/div>\s*/m, '\n');
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
  // Dev default is already api.striff.io — just strip the storage-based override
  // so the extension always uses the hardcoded base in production.
  return source.replace(
    /const DEV_DEFAULT_API_BASE = 'https:\/\/api\.striff\.io';\n\n\/\/ API base override via chrome\.storage\.local key "striffsApiBase"\nasync function getApiBase\(defaultBase = DEV_DEFAULT_API_BASE\) \{[\s\S]*?return normalizeApiBase\(defaultBase\);\n\}/,
    "async function getApiBase(defaultBase = 'https://api.striff.io') {\n  return normalizeApiBase(defaultBase);\n}"
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
await rewriteFile('html/popup.html', stripPopupDebugSection, {
  description: 'popup debug section',
  mustNotContain: ['id="debugToggle"']
});
await rewriteFile('src/striffs.js', disableBundledTestHooks, {
  description: 'bundled test hooks',
  mustNotContain: ['stored?.striffsTest === true', 'if (!S.isTest?.()) return;']
});
await rewriteFile('src/striffs.js', stripStriffsRuntimeOverrides, {
  description: 'Striffs runtime overrides',
  mustNotContain: ['S.setApiBaseOverride = async (base)', 'S.clearApiBaseOverride = async () => new Promise']
});
await rewriteFile('src/striffs.js', stripOverrideCacheKeys, {
  description: 'Striffs override cache keys',
  mustNotContain: ['"striffsConfigUrl"', '"striffsApiBase"']
});
await rewriteFile('src/background.js', stripBackgroundRuntimeOverrides, {
  description: 'background runtime overrides',
  mustNotContain: ['stored?.striffsApiBase', "chrome.storage.local.get(['striffsApiBase'])"]
});
await rewriteFile('src/background.js', stripOverrideCacheKeys, {
  description: 'background override cache keys',
  mustNotContain: ['"striffsConfigUrl"', '"striffsApiBase"']
});
await rewriteFile('src/background-utils.js', stripOverrideCacheKeys, {
  description: 'background-utils override cache keys',
  mustNotContain: ['"striffsConfigUrl"', '"striffsApiBase"']
});
await rewriteFile('html/shared.js', stripOverrideCacheKeys, {
  description: 'shared override cache keys',
  mustChange: false,
  mustNotContain: ['"striffsConfigUrl"', '"striffsApiBase"']
});

try {
  await execFileAsync('zip', ['-qr', zipPath, '.'], { cwd: stageDir });
  console.log(`Packaged extension zip at ${zipPath}`);
} catch (_) {
  console.warn('zip command unavailable; staged unpacked extension instead.');
  console.warn(`Use directory: ${stageDir}`);
}
