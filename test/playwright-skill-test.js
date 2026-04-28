/**
 * Striffs Extension UI Tests
 * ==========================
 *
 * Launches Chrome directly (bypasses Playwright automation flags that block
 * extensions), then connects Playwright via CDP for assertions.
 *
 * Run:  HEADED=1 npm run test:ui
 *
 * Prerequisites:
 *   Run `npm run test:login` first to create a GitHub-authenticated profile.
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..');
const TEST_PR_URL = 'https://github.com/Zir0-93/striff-lib/pull/1/files';
const HEADED = (process.env.HEADED || '') === '1';
const HEADLESS = !HEADED;

// Profile: prefer login profile (has GitHub auth), else fresh
const LOGIN_PROFILE = path.resolve(__dirname, '.pw-profile-login');
const PROFILE_DIR = (process.env.PW_PROFILE || '').trim() ||
  (fs.existsSync(path.join(LOGIN_PROFILE, 'Default', 'Cookies'))
    ? LOGIN_PROFILE
    : path.resolve(__dirname, '.pw-profile-skill'));

const CDP_PORT = 9333;

const CHROME =
  process.env.CHROME_PATH ||
  (fs.existsSync('/usr/bin/google-chrome-stable') && '/usr/bin/google-chrome-stable') ||
  (fs.existsSync('/usr/bin/google-chrome') && '/usr/bin/google-chrome');

if (!CHROME) {
  console.error('No Chrome binary found. Set CHROME_PATH env var.');
  process.exit(1);
}

const log = (msg, type = 'info') => {
  const prefix = { info: '✓', error: '✗', warn: '⚠' }[type] || '•';
  console.log(`${prefix} ${msg}`);
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function runTests() {
  let ok = true;
  const fail = (msg) => { ok = false; log(msg, 'error'); };

  const hasLogin = PROFILE_DIR === LOGIN_PROFILE;
  console.log('Running Striffs Extension UI Tests\n');
  console.log(`  Headless: ${HEADLESS}`);
  console.log(`  Profile: ${PROFILE_DIR}`);
  console.log(`  GitHub auth: ${hasLogin ? 'yes' : 'no (run npm run test:login)'}`);
  console.log(`  Chrome: ${CHROME}`);

  // Remove lock files from previous runs
  for (const f of ['SingletonCookie', 'SingletonLock', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(PROFILE_DIR, f)); } catch {}
  }

  // Launch Chrome directly — no Playwright automation flags
  const chromeArgs = [
    `--user-data-dir=${PROFILE_DIR}`,
    `--remote-debugging-port=${CDP_PORT}`,
    `--load-extension=${EXT_PATH}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
  ];

  if (HEADLESS) {
    chromeArgs.push('--headless=new');
  }

  const chrome = spawn(CHROME, chromeArgs, { stdio: 'ignore', detached: false });

  // Cleanup on exit
  const cleanup = () => { try { chrome.kill(); } catch {} };
  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    // Wait for Chrome to start and extension to load
    await sleep(3000);

    // Connect Playwright via CDP
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const context = browser.contexts()[0];

    // Wait for extension service worker
    let sw = context.serviceWorkers()[0];
    if (!sw) {
      try { sw = await context.waitForEvent('serviceworker', { timeout: 10000 }); } catch {}
    }
    if (sw) log('Extension service worker detected');

    const page = await context.newPage();

    page.on('console', msg => {
      if (msg.type() === 'error') log(`Browser error: ${msg.text()}`, 'warn');
    });

    // Test 1: Load extension on GitHub PR page
    log('Test 1: Extension loads on GitHub PR page');
    await page.goto(TEST_PR_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for extension content script to inject (retry up to 15s)
    let toolbarSlot = null;
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      toolbarSlot = await page.$('#striffs-toolbar-slot');
      if (toolbarSlot) break;
    }

    const diffsBtn = await page.$('#diffs-btn');
    const striffsBtn = await page.$('#striffs-btn');

    if (toolbarSlot && diffsBtn && striffsBtn) {
      log('Extension loaded with toolbar and buttons');
    } else {
      fail('Extension did not load properly');
    }

    // Test 2: Buttons have correct labels and icons
    log('Test 2: Buttons have correct labels and icons');
    const diffsText = await page.$eval('#diffs-btn', el => el.textContent).catch(() => '');
    const striffsText = await page.$eval('#striffs-btn', el => el.textContent).catch(() => '');
    const diffsIcon = await page.$('#diffs-btn svg');
    const striffsIcon = await page.$('#striffs-btn svg');

    if (diffsText.includes('Diffs') && striffsText.includes('Striffs') &&
        diffsIcon && striffsIcon) {
      log('Both buttons have correct labels and SVG icons');
    } else {
      fail('Button labels or icons incorrect');
    }

    // Test 3: Diffs button active by default
    log('Test 3: Diffs button is active by default');
    const diffsActive = await page.$eval('#diffs-btn', el =>
      el.classList.contains('is-active')).catch(() => false);
    if (diffsActive) {
      log('Diffs button is active on initial load');
    } else {
      fail('Diffs button is NOT active on initial load');
    }

    // Test 4: Click Striffs and wait for diagram to render
    log('Test 4: Click Striffs — diagram renders');
    await page.click('#striffs-btn').catch(() => {});

    // Wait for the SVG diagram to appear (up to 30s for API call + render)
    const DIAGRAM_TIMEOUT = Number(process.env.DIAGRAM_TIMEOUT || '30000');
    let diagramRendered = false;
    const startTime = Date.now();
    while (Date.now() - startTime < DIAGRAM_TIMEOUT) {
      await sleep(1000);
      const svg = await page.$('#striffs-toolbar-slot svg');
      if (svg) {
        diagramRendered = true;
        break;
      }
    }

    if (diagramRendered) {
      log('Striffs diagram rendered successfully');
    } else {
      // Check what state the button is in
      const btnText = await page.$eval('#striffs-btn', el => el.textContent).catch(() => '');
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      fail(`Striffs diagram did not render after ${elapsed}s (button: "${btnText.trim()}")`);
    }

    // Take screenshot of Striffs view
    const screenshotPath = path.join(__dirname, '.screenshots');
    fs.mkdirSync(screenshotPath, { recursive: true });
    await page.screenshot({
      path: path.join(screenshotPath, `striffs-view-${Date.now()}.png`),
      fullPage: false
    });
    log('Screenshot of Striffs view captured');

    // Test 5: Switch back to Diffs
    log('Test 5: Switch back to Diffs view');
    await page.click('#diffs-btn').catch(() => {});
    await sleep(500);
    const diffsActiveAgain = await page.$eval('#diffs-btn', el =>
      el.classList.contains('is-active')).catch(() => false);
    if (diffsActiveAgain) {
      log('Diffs button is active after switching back');
    } else {
      fail('Diffs button NOT active after switching back');
    }

    await browser.close();
  } catch (error) {
    fail(`Unexpected error: ${error.message}`);
  } finally {
    cleanup();
  }

  console.log(`\n${ok ? 'All tests passed' : 'Some tests FAILED'}`);
  if (!ok) process.exitCode = 1;
}

module.exports = { runTests };

if (require.main === module) {
  runTests().catch(console.error);
}
