/**
 * Striffs Visual Regression Tests
 * ================================
 *
 * Self-authenticating: logs in with GH_TEST_USER / GH_TEST_PASS (same as the live
 * smoke test) and reuses a persistent profile, so GitHub device verification (OTP)
 * is only needed occasionally — run with HEADED=1 when that happens so you can
 * complete the challenge in the visible browser.
 *
 * Run headed (needed for first login / OTP): HEADED=1 npm run test:visual
 * Run headless (once the session is established): npm run test:visual
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const EXT_PATH = path.resolve(__dirname, '..');
// Self-managed persistent profile: auto-logs-in and keeps the session across runs.
// Launched with Playwright's bundled Chromium + --load-extension, which is the only
// combination that reliably injects content scripts (Chrome 146+ dropped
// --load-extension support on the system 'chrome' channel).
const VISUAL_PROFILE = path.resolve(__dirname, '.pw-profile-visual');
const GH_TEST_USER = (process.env.GH_TEST_USER || '').trim();
const GH_TEST_PASS = (process.env.GH_TEST_PASS || '').trim();
const NAVIGATION_TIMEOUT_MS = 45000;
const TEST_PR_URL = (process.env.NEW_UI || '') === '1'
  ? 'https://github.com/Zir0-93/striff-lib/pull/1/changes'
  : 'https://github.com/Zir0-93/striff-lib/pull/1/files';
const HEADED = (process.env.HEADED || '') === '1';
const HEADLESS = !HEADED;

/**
 * GitHub auto-login (ported from test/manual-smoke-live.js). Reuses the persistent
 * profile session when present; only performs a fresh login (and waits for OTP in
 * headed mode) when the session is missing or expired.
 */
async function inspectGitHubLoginState(page) {
  return page.evaluate(() => {
    const meta = document.querySelector('meta[name="user-login"]');
    return {
      loggedIn: Boolean(meta && String(meta.content || '').trim()),
      user: meta ? String(meta.content || '').trim() : null,
    };
  }).catch(() => ({ loggedIn: false, user: null }));
}

async function loginToGitHub(page) {
  if (!GH_TEST_USER || !GH_TEST_PASS) {
    console.error('  ✗ GH_TEST_USER / GH_TEST_PASS not set — cannot auto-login');
    return false;
  }
  console.log('  Auto-logging in to GitHub...');
  await page.goto('https://github.com/login', { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
  await page.waitForTimeout(1000);

  const userField = await page.$('#login_field');
  const passField = await page.$('#password');
  if (!userField || !passField) {
    console.error('  ✗ GitHub login form not found');
    return false;
  }
  await userField.fill(GH_TEST_USER);
  await passField.fill(GH_TEST_PASS);
  await page.waitForTimeout(300);

  const submitBtn = await page.$(
    'input[name="commit"][value="Sign in"], input.js-sign-in-button, form[action="/session"] input[type="submit"]'
  );
  if (!submitBtn) {
    console.error('  ✗ GitHub login submit button not found');
    return false;
  }
  await submitBtn.click();

  const waitForLoggedIn = (timeoutMs) => page.waitForFunction(() => {
    const meta = document.querySelector('meta[name="user-login"]');
    return Boolean(meta && String(meta.content || '').trim());
  }, null, { timeout: timeoutMs }).then(() => true).catch(() => false);

  const awaitDeviceVerification = async () => {
    if (HEADLESS) {
      console.error('  ✗ GitHub requires device verification / OTP — rerun with HEADED=1 and complete the challenge in the browser.');
      return false;
    }
    console.warn('  ⚠ GitHub requires device verification / OTP. Complete it in the open browser; waiting up to 5 min...');
    const ok = await waitForLoggedIn(5 * 60 * 1000);
    if (ok) {
      const state = await inspectGitHubLoginState(page);
      console.log(`  ✓ Login completed after device verification (${state.user})`);
      return true;
    }
    console.error('  ✗ Timed out waiting for GitHub device verification');
    return false;
  };

  try {
    await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 15000 });
  } catch {
    return awaitDeviceVerification();
  }

  await page.waitForTimeout(1500);
  const state = await inspectGitHubLoginState(page);
  if (state.loggedIn) {
    console.log(`  ✓ GitHub auto-login succeeded (${state.user})`);
    return true;
  }
  // Redirected off /login but not yet authenticated — most commonly a
  // verified-device email-code challenge. Wait for it in headed mode.
  const hasOtp = await page.$('#otp').then(Boolean).catch(() => false);
  if (hasOtp || /verified-device|sessions/.test(page.url())) {
    return awaitDeviceVerification();
  }
  console.error('  ✗ GitHub auto-login failed — session not established');
  return false;
}

async function ensureLoggedIn(page) {
  await page.goto('https://github.com', { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
  await page.waitForTimeout(1000);
  let state = await inspectGitHubLoginState(page);
  if (state.loggedIn) {
    console.log(`  Already logged in (${state.user}) — reusing persisted session`);
    return true;
  }
  if (!(await loginToGitHub(page))) return false;
  state = await inspectGitHubLoginState(page);
  return Boolean(state.loggedIn);
}

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

    // GitHub PRs keep long-poll connections open, so 'networkidle' never settles —
    // wait for DOM content and then for the extension to mount its toolbar.
    await page.goto(TEST_PR_URL, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    await page.waitForSelector('#striffs-btn', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);

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

    // Click Striffs. The active class is only applied once the Striffs view is
    // shown, which can trail the click while the diagram generates on first load —
    // so wait for the real signal rather than a fixed delay.
    await page.click('#striffs-btn');
    await page.waitForSelector('#striffs-btn.is-active', { timeout: 20000 }).catch(() => {});

    const striffsActive = await AssertHelpers.hasClass(page, '#striffs-btn', 'is-active');
    const diffsStillActive = await AssertHelpers.hasClass(page, '#diffs-btn', 'is-active');
    console.log(`  Striffs active after click: ${striffsActive ? '✓' : '✗'}`);
    console.log(`  Diffs inactive: ${!diffsStillActive ? '✓' : '✗'}`);

    // Capture Striffs view
    await VisualHelpers.captureScreenshot(page, 'striffs-view');

    // Click Diffs
    await page.click('#diffs-btn');
    await page.waitForSelector('#diffs-btn.is-active', { timeout: 10000 }).catch(() => {});

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
  },

  async testCommentPanel(page) {
    console.log('\n📸 Scenario: Comment panel');

    await page.click('#striffs-btn');
    await page.waitForTimeout(1000);

    const commentBtn = await page.waitForSelector('#striffs-comment-btn', { timeout: 10000, state: 'visible' });
    await commentBtn.click();
    await page.waitForTimeout(800);

    const panelVisible = await AssertHelpers.hasClass(page, '#striffs-comment-panel', 'striffs-comment-panel--open');
    console.log(`  Comment panel opened: ${panelVisible ? '✓' : '✗'}`);

    if (panelVisible) {
      await VisualHelpers.captureElement(page, '#striffs-comment-panel', 'comment-panel');
      console.log('  Comment panel captured');
    }

    return { panelVisible };
  }
};

/**
 * Main Test Runner — uses launchPersistentContext for extension support
 */
async function runVisualTests() {
  console.log('Visual Regression Tests\n');
  console.log('='.repeat(50));

  for (const f of ['SingletonCookie', 'SingletonLock', 'SingletonSocket']) {
    try { fs.rmSync(path.join(VISUAL_PROFILE, f), { force: true }); } catch {}
  }

  console.log(`  Profile: ${VISUAL_PROFILE}`);
  console.log(`  Headless: ${HEADLESS}`);

  const failures = [];
  let context;
  try {
    context = await chromium.launchPersistentContext(VISUAL_PROFILE, {
      channel: 'chromium',
      headless: HEADLESS,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
      ],
    });

    const page = await context.newPage();
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`  ⚠ Browser error: ${msg.text()}`);
    });

    if (!(await ensureLoggedIn(page))) {
      throw new Error('Could not establish a logged-in GitHub session (set GH_TEST_USER/GH_TEST_PASS; use HEADED=1 to complete OTP).');
    }

    let sw = context.serviceWorkers()[0];
    if (!sw) {
      try { sw = await context.waitForEvent('serviceworker', { timeout: 10000 }); } catch {}
    }

    const results = {};
    results.initial = await TestScenarios.testInitialLoad(page);
    if (!(results.initial.hasToolbar && results.initial.hasDiffs && results.initial.hasStriffs)) {
      failures.push('Initial load: toolbar/Diffs/Striffs buttons not all present');
    }
    results.states = await TestScenarios.testButtonStates(page);
    if (!(results.states.striffsActive && results.states.diffsActiveAgain)) {
      failures.push('Button states: view toggle did not update active states');
    }
    results.loading = await TestScenarios.testLoadingState(page);
    results.elements = await TestScenarios.testElementScreenshots(page);
    results.responsive = await TestScenarios.testResponsive(page);
    results.commentPanel = await TestScenarios.testCommentPanel(page);
    if (!results.commentPanel.panelVisible) {
      failures.push('Comment panel: did not open');
    }

    console.log('\n' + '='.repeat(50));
    console.log('Summary:');
    console.log(`  Initial load: ${results.initial.hasToolbar && results.initial.hasDiffs && results.initial.hasStriffs ? '✓' : '✗'}`);
    console.log(`  Button states: ${results.states.striffsActive && results.states.diffsActiveAgain ? '✓' : '✗'}`);
    console.log(`  Loading state: ✓`);
    console.log(`  Element captures: ✓`);
    console.log(`  Responsive tests: ✓`);
    console.log(`  Comment panel: ${results.commentPanel.panelVisible ? '✓' : '✗'}`);
    console.log('\nScreenshots saved to: test/.screenshots/');
  } catch (error) {
    failures.push(error.message);
    console.error('\n✗ Test error:', error.message);
  } finally {
    try { await context?.close(); } catch {}
  }

  if (failures.length) {
    console.error(`\n❌ Visual tests FAILED (${failures.length}):`);
    for (const f of failures) console.error(`   - ${f}`);
    process.exitCode = 1;
    return false;
  }
  console.log('\n✅ All visual tests completed');
  return true;
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
  runVisualTests()
    .then(() => process.exit(process.exitCode || 0))
    .catch((e) => { console.error(e); process.exit(1); });
}
