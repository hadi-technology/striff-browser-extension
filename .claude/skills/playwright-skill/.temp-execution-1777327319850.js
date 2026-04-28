const { chromium } = require('playwright');
const path = require('path');

const STATE_PATH = '/home/zir0/git/striff-browser-extension/test/.github-storage-state.json';

(async () => {
  console.log('Opening GitHub login page...');
  console.log('Please log in to GitHub in the browser window.\n');

  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  await page.goto('https://github.com/login', { waitUntil: 'domcontentloaded' });

  // Poll for login detection
  let saved = false;
  while (browser.isConnected()) {
    try {
      const result = await page.evaluate(() => {
        const meta = document.querySelector('meta[name="user-login"]');
        return {
          loggedIn: !!(meta && meta.content),
          user: meta ? meta.content : null,
          href: location.href
        };
      }).catch(() => null);

      if (result?.loggedIn) {
        await context.storageState({ path: STATE_PATH });
        console.log(`\n✅ GitHub auth saved for @${result.user}`);
        console.log(`   Storage state: ${STATE_PATH}`);
        console.log('\nYou can close the browser now.');
        saved = true;
        break;
      }
    } catch {}

    await new Promise(r => setTimeout(r, 1000));
  }

  if (!saved) {
    console.warn('Browser closed before login was detected.');
  }

  await browser.close().catch(() => {});
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
