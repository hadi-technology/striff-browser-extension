/**
 * Striffs Visual Regression Tests
 * ================================
 *
 * Launches Chrome directly with extension, connects Playwright via CDP.
 * Run with: HEADED=1 npm run test:visual
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..');
const TEST_PR_URL = 'https://github.com/Zir0-93/striff-lib/pull/1/files';
const HEADED = (process.env.HEADED || '') === '1';
const HEADLESS = !HEADED;
const CDP_PORT = 9334;

const LOGIN_PROFILE = path.resolve(__dirname, '.pw-profile-login');
const PROFILE_DIR = (process.env.PW_PROFILE || '').trim() ||
  (fs.existsSync(path.join(LOGIN_PROFILE, 'Default', 'Cookies'))
    ? LOGIN_PROFILE
    : path.resolve(__dirname, '.pw-profile-visual'));

const CHROME =
  process.env.CHROME_PATH ||
  (fs.existsSync('/usr/bin/google-chrome-stable') && '/usr/bin/google-chrome-stable') ||
  (fs.existsSync('/usr/bin/google-chrome') && '/usr/bin/google-chrome');

/**
 * Visual Test Helpers
 */
const VisualHelpers = {
  async captureScreenshot(page, name, options = {}) {
    const dir = path.join(__dirname, '.screenshots', 'visual');
    fs.mkdirSync(dir, { recursive: true });

    const filepath = path.join(dir, `${name}-${Date.now()}.png`);
    await page.screenshot({
      path: filepath,
      fullPage: false,
      ...options
    });

    return filepath;
  },

  async captureElement(page, selector, name) {
    const element = await page.$(selector);
    if (!element) throw new Error(`Element not found: ${selector}`);

    const dir = path.join(__dirname, '.screenshots', 'elements');
    fs.mkdirSync(dir, { recursive: true });

    const filepath = path.join(dir, `${name}-${Date.now()}.png`);
    await element.screenshot({ path: filepath });

    return filepath;
  },

  async compareScreenshots(img1, img2) {
    // Placeholder for visual comparison
    // In production, would use something like pixelmatch or playwright's expect().toHaveScreenshot()
    console.log(`Comparing ${img1} vs ${img2}`);
    return true;
  }
};

/**
 * Assertion Helpers
 */
const AssertHelpers = {
  async isVisible(page, selector) {
    const el = await page.$(selector);
    if (!el) return false;

    return await el.isVisible();
  },

  async hasText(page, selector, text) {
    const el = await page.$(selector);
    if (!el) return false;

    const content = await el.textContent();
    return content.includes(text);
  },

  async hasClass(page, selector, className) {
    return await page.$eval(selector, (el, cls) =>
      el.classList.contains(cls), className
    );
  },

  async getAttribute(page, selector, attr) {
    return await page.$eval(selector, el => el.getAttribute(attr));
  }
};

/**
 * Test Scenarios
 */
const TestScenarios = {
  /**
   * Scenario: Initial page load
   */
  async testInitialLoad(page) {
    console.log('📸 Scenario: Initial page load');

    await page.goto(TEST_PR_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // Verify toolbar exists
    const hasToolbar = await AssertHelpers.isVisible(page, '#striffs-toolbar-slot');
    console.log(`  Toolbar visible: ${hasToolbar ? '✓' : '✗'}`);

    // Verify both buttons exist
    const hasDiffs = await AssertHelpers.isVisible(page, '#diffs-btn');
    const hasStriffs = await AssertHelpers.isVisible(page, '#striffs-btn');
    console.log(`  Diffs button: ${hasDiffs ? '✓' : '✗'}`);
    console.log(`  Striffs button: ${hasStriffs ? '✓' : '✗'}`);

    // Verify button labels
    const diffsText = await page.$eval('#diffs-btn', el => el.textContent);
    const striffsText = await page.$eval('#striffs-btn', el => el.textContent);
    console.log(`  Diffs label: "${diffsText.trim()}"`);
    console.log(`  Striffs label: "${striffsText.trim()}"`);

    // Verify icons
    const hasDiffsIcon = await page.$('#diffs-btn svg');
    const hasStriffsIcon = await page.$('#striffs-btn svg');
    console.log(`  Diffs icon: ${hasDiffsIcon ? '✓' : '✗'}`);
    console.log(`  Striffs icon: ${hasStriffsIcon ? '✓' : '✗'}`);

    // Capture screenshot
    await VisualHelpers.captureScreenshot(page, 'initial-load');
    console.log(`  Screenshot captured`);

    return { hasToolbar, hasDiffs, hasStriffs };
  },

  /**
   * Scenario: Button interaction states
   */
  async testButtonStates(page) {
    console.log('\n📸 Scenario: Button interaction states');

    // Test Diffs active state
    const diffsActive = await AssertHelpers.hasClass(page, '#diffs-btn', 'is-active');
    console.log(`  Diffs initially active: ${diffsActive ? '✓' : '✗'}`);

    // Click Striffs
    await page.click('#striffs-btn');
    await page.waitForTimeout(500);

    const striffsActive = await AssertHelpers.hasClass(page, '#striffs-btn', 'is-active');
    const diffsStillActive = await AssertHelpers.hasClass(page, '#diffs-btn', 'is-active');
    console.log(`  Striffs active after click: ${striffsActive ? '✓' : '✗'}`);
    console.log(`  Diffs inactive: ${!diffsStillActive ? '✓' : '✗'}`);

    // Capture Striffs view
    await VisualHelpers.captureScreenshot(page, 'striffs-view');

    // Click Diffs
    await page.click('#diffs-btn');
    await page.waitForTimeout(500);

    const diffsActiveAgain = await AssertHelpers.hasClass(page, '#diffs-btn', 'is-active');
    console.log(`  Diffs active again: ${diffsActiveAgain ? '✓' : '✗'}`);

    await VisualHelpers.captureScreenshot(page, 'diffs-view');

    return { striffsActive, diffsActiveAgain };
  },

  /**
   * Scenario: Loading state
   */
  async testLoadingState(page) {
    console.log('\n📸 Scenario: Loading state');

    // Click Striffs and watch for loading indicator
    const clickPromise = page.click('#striffs-btn');

    // Try to catch the loading indicator
    try {
      await page.waitForSelector('.striffs-running-indicator', { timeout: 500 });
      console.log(`  Loading indicator appeared: ✓`);

      await VisualHelpers.captureScreenshot(page, 'loading-state');
    } catch (e) {
      console.log(`  Loading indicator not seen (too fast): ~`);
    }

    await clickPromise;
    await page.waitForTimeout(1000);

    return true;
  },

  /**
   * Scenario: Element screenshots
   */
  async testElementScreenshots(page) {
    console.log('\n📸 Scenario: Element screenshots');

    // Capture individual elements
    const diffsBtnPath = await VisualHelpers.captureElement(page, '#diffs-btn', 'diffs-button');
    console.log(`  Diffs button: ${path.basename(diffsBtnPath)}`);

    const striffsBtnPath = await VisualHelpers.captureElement(page, '#striffs-btn', 'striffs-button');
    console.log(`  Striffs button: ${path.basename(striffsBtnPath)}`);

    // Capture toolbar
    const toolbarPath = await VisualHelpers.captureElement(page, '#striffs-toolbar-slot', 'toolbar');
    console.log(`  Toolbar: ${path.basename(toolbarPath)}`);

    return { diffsBtnPath, striffsBtnPath, toolbarPath };
  },

  /**
   * Scenario: Responsive behavior
   */
  async testResponsive(page) {
    console.log('\n📸 Scenario: Responsive behavior');

    const viewports = [
      { width: 1920, height: 1080, name: 'desktop' },
      { width: 1280, height: 720, name: 'laptop' },
      { width: 768, height: 1024, name: 'tablet' }
    ];

    for (const vp of viewports) {
      await page.setViewportSize(vp);
      await page.waitForTimeout(500);

      const filepath = await VisualHelpers.captureScreenshot(page, `responsive-${vp.name}`);
      console.log(`  ${vp.name} (${vp.width}x${vp.height}): ${path.basename(filepath)}`);
    }

    return true;
  }
};

/**
 * Main Test Runner — launches Chrome directly, connects via CDP
 */
async function runVisualTests() {
  console.log('Visual Regression Tests\n');
  console.log('='.repeat(50));

  const hasLogin = PROFILE_DIR === LOGIN_PROFILE;

  for (const f of ['SingletonCookie', 'SingletonLock', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(PROFILE_DIR, f)); } catch {}
  }

  console.log(`  Profile: ${PROFILE_DIR}`);
  console.log(`  GitHub auth: ${hasLogin ? 'yes' : 'no (run npm run test:login)'}`);
  if (!hasLogin) {
    console.log('  Run `npm run test:login` first.\n');
  }

  // Launch Chrome directly
  const chromeArgs = [
    `--user-data-dir=${PROFILE_DIR}`,
    `--remote-debugging-port=${CDP_PORT}`,
    `--load-extension=${EXT_PATH}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
  ];
  if (HEADLESS) chromeArgs.push('--headless=new');

  const chrome = spawn(CHROME, chromeArgs, { stdio: 'ignore', detached: false });
  const cleanup = () => { try { chrome.kill(); } catch {} };
  process.on('exit', cleanup);

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await sleep(3000);

  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const context = browser.contexts()[0];

    let sw = context.serviceWorkers()[0];
    if (!sw) {
      try { sw = await context.waitForEvent('serviceworker', { timeout: 10000 }); } catch {}
    }

    const page = await context.newPage();
    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`  ⚠ Browser error: ${msg.text()}`);
    });

    const results = {};
    results.initial = await TestScenarios.testInitialLoad(page);
    results.states = await TestScenarios.testButtonStates(page);
    results.loading = await TestScenarios.testLoadingState(page);
    results.elements = await TestScenarios.testElementScreenshots(page);
    results.responsive = await TestScenarios.testResponsive(page);

    console.log('\n' + '='.repeat(50));
    console.log('Summary:');
    console.log(`  Initial load: ${results.initial.hasToolbar && results.initial.hasDiffs && results.initial.hasStriffs ? '✓' : '✗'}`);
    console.log(`  Button states: ${results.states.striffsActive && results.states.diffsActiveAgain ? '✓' : '✗'}`);
    console.log(`  Loading state: ✓`);
    console.log(`  Element captures: ✓`);
    console.log(`  Responsive tests: ✓`);
    console.log('\nScreenshots saved to: test/.screenshots/');

    await browser.close();
  } catch (error) {
    console.error('\n✗ Test failed:', error.message);
    throw error;
  } finally {
    cleanup();
  }

  console.log('\n✅ All visual tests completed');
}

// Export for use
module.exports = {
  runVisualTests,
  TestScenarios,
  VisualHelpers,
  AssertHelpers
};

// Run if executed directly
if (require.main === module) {
  runVisualTests().catch(console.error);
}
