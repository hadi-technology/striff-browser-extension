// Quick check of saved GitHub storage state.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const STATE_PATH = path.resolve(__dirname, '.github-storage-state.json');

(async () => {
  console.log('Checking storage state:', STATE_PATH);
  if (!fs.existsSync(STATE_PATH)) {
    console.log('No saved storage state file found.');
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: [
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-features=CalculateNativeWinOcclusion,Vulkan',
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });
  const context = await browser.newContext({
    storageState: STATE_PATH,
    viewport: { width: 1400, height: 900 }
  });
  const page = await context.newPage();
  await page.goto('https://github.com', { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(() => {
    const meta = document.querySelector('meta[name="user-login"]');
    return {
      loggedIn: !!(meta && meta.content),
      user: meta ? meta.content : null,
      href: location.href
    };
  });

  console.log('\n=== LOGIN STATUS ===');
  console.log('Logged in:', result.loggedIn);
  console.log('User:', result.user);
  console.log('URL:', result.href);
  console.log('\nClose the browser when done.');

  await new Promise((resolve) => {
    browser.on('disconnected', resolve);
  });
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
