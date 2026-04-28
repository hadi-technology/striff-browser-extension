/**
 * Setup Chrome profile with extension + GitHub login
 * ================================================
 *
 * Opens Chrome with the Striffs extension pre-loaded AND the extension
 * management page so you can verify it's loaded. Also opens GitHub login.
 *
 * Usage: node test/login-github.js
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PROFILE_DIR = path.resolve(__dirname, '.pw-profile-login');
const EXT_PATH = path.resolve(__dirname, '..');

// Remove lock files from previous runs but keep data
for (const f of ['SingletonCookie', 'SingletonLock', 'SingletonSocket']) {
  try { fs.unlinkSync(path.join(PROFILE_DIR, f)); } catch {}
}

console.log('Opening Chrome with Striffs extension pre-loaded.');
console.log(`Extension path: ${EXT_PATH}`);
console.log(`Profile directory: ${PROFILE_DIR}`);
console.log('\nTwo tabs will open:');
console.log('  - chrome://extensions (verify "Striffs for GitHub" is listed & enabled)');
console.log('  - https://github.com/login (log into GitHub)');
console.log('\nClose Chrome when both steps are done.\n');

const CHROME =
  process.env.CHROME_PATH ||
  (fs.existsSync('/usr/bin/google-chrome-stable') && '/usr/bin/google-chrome-stable') ||
  (fs.existsSync('/usr/bin/google-chrome') && '/usr/bin/google-chrome');

if (!CHROME) {
  console.error('No Chrome binary found. Set CHROME_PATH env var.');
  process.exit(1);
}

const chrome = spawn(CHROME, [
  `--user-data-dir=${PROFILE_DIR}`,
  `--load-extension=${EXT_PATH}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  'chrome://extensions',
  'https://github.com/login'
], { stdio: 'ignore', detached: false });

chrome.on('exit', () => {
  // Verify the extension was loaded
  const extDir = path.join(PROFILE_DIR, 'Default', 'Extensions');
  const hasStriffs = fs.existsSync(extDir) &&
    fs.readdirSync(extDir).some(id => {
      try {
        const versions = fs.readdirSync(path.join(extDir, id));
        return versions.some(v => {
          const mp = path.join(extDir, id, v, 'manifest.json');
          if (!fs.existsSync(mp)) return false;
          const m = JSON.parse(fs.readFileSync(mp, 'utf-8'));
          return m.name === 'Striffs for GitHub';
        });
      } catch { return false; }
    });

  if (hasStriffs) {
    console.log('Striffs for GitHub extension detected in profile.');
    console.log('GitHub auth cookies should also be saved.');
    console.log(`Profile: ${PROFILE_DIR}`);
  } else {
    console.log('Warning: Striffs extension not detected in profile.');
    console.log('The --load-extension flag should have loaded it automatically.');
    console.log('If it failed, try manually loading via chrome://extensions.');
  }

  console.log('\nNow run tests with:');
  console.log('  HEADED=1 npm run test:ui');
  console.log('  npm run test:visual');
});
