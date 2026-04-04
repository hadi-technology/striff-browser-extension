/**
 * Captures console output from a page to a file for debugging
 *
 * Usage:
 *   node test/capture-console.js https://github.com/owner/repo/pull/123/files
 *   AUTO_CLOSE=1 node test/capture-console.js https://github.com/owner/repo/pull/123/files
 *
 * Console output will be saved to:
 *   /tmp/striffs-console-<timestamp>.json
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..');
const OUTPUT_DIR = '/tmp';
const AUTO_CLOSE = process.env.AUTO_CLOSE === '1';
const WAIT_MS = Number(process.env.WAIT_MS || '8000');

async function captureConsole(url) {
  const browser = await chromium.launchPersistentContext('', {
    headless: false,
    viewport: { width: 1920, height: 1080 },
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--enable-logging=stderr',
    ],
  });

  const page = await browser.newPage();
  const consoleMessages = [];

  // Capture all console messages
  page.on('console', msg => {
    const type = msg.type();
    const text = msg.text();
    const location = msg.location();
    consoleMessages.push({
      type,
      text,
      location: location ? { url: location.url, lineNumber: location.lineNumber } : null,
      timestamp: Date.now()
    });
    // Also print to terminal for visibility
    console.log(`[Page ${type}]`, text);
  });

  // Catch errors
  page.on('pageerror', error => {
    consoleMessages.push({
      type: 'error',
      text: error.toString(),
      stack: error.stack,
      timestamp: Date.now()
    });
    console.error('[Page Error]', error.toString());
  });

  // Enable debug mode in storage before navigating
  await page.addInitScript(() => {
    localStorage.setItem('striffsDebug', '1');
  });

  console.log('Navigating to:', url);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

  // Wait for extension to fully load and run checks
  console.log(`Waiting ${WAIT_MS}ms for extension to initialize...`);
  await page.waitForTimeout(WAIT_MS);

  // Save console output to file
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputFile = path.join(OUTPUT_DIR, `striffs-console-${timestamp}.json`);
  fs.writeFileSync(outputFile, JSON.stringify(consoleMessages, null, 2));

  console.log(`\n=== Console output saved to: ${outputFile} ===`);
  console.log(`Total messages: ${consoleMessages.length}`);

  // Print summary
  const summary = {
    total: consoleMessages.length,
    byType: consoleMessages.reduce((acc, msg) => {
      acc[msg.type] = (acc[msg.type] || 0) + 1;
      return acc;
    }, {}),
    striffsDebug: consoleMessages.filter(m =>
      m.text.includes('[Striffs]') || m.text.includes('striffs')
    ).length
  };
  console.log('Summary:', JSON.stringify(summary, null, 2));

  if (AUTO_CLOSE) {
    await browser.close();
    console.log('\nBrowser closed automatically.');
    console.log(`Output file: ${outputFile}`);
  } else {
    console.log('\nBrowser staying open for manual inspection. Press Ctrl+C to exit.');
    await new Promise(() => {}); // Keep running
  }
}

const url = process.argv[2] || 'https://github.com/yamadashy/repomix/pull/1378/changes';
captureConsole(url).catch(console.error);
