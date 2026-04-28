const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const repo = path.resolve(__dirname, '..');
const profile = path.join(__dirname, '.pw-profile');
const copy = path.join(__dirname, '.pw-profile-toolbar');
const HEADED = (process.env.HEADED || '') === '1';
const HEADLESS = HEADED ? false : (process.env.HEADLESS || '1') !== '0';

const summarize = (el) => {
  if (!el) return null;
  return {
    tag: el.tagName,
    id: el.id || '',
    cls: typeof el.className === 'string' ? el.className : '',
    style: el.getAttribute('style') || '',
    text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200)
  };
};

(async () => {
  fs.rmSync(copy, { recursive: true, force: true });
  fs.cpSync(profile, copy, { recursive: true });
  for (const name of ['SingletonCookie', 'SingletonLock', 'SingletonSocket']) {
    try { fs.rmSync(path.join(copy, name), { force: true }); } catch {}
  }

  const context = await chromium.launchPersistentContext(copy, {
    channel: 'chromium',
    headless: HEADLESS,
    viewport: { width: 1440, height: 900 },
    args: [
      `--disable-extensions-except=${repo}`,
      `--load-extension=${repo}`,
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion,Vulkan',
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });

  const page = await context.newPage();
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => null);
  if (sw) {
    await sw.evaluate(async () => {
      try { await chrome.storage.local.set({ striffsTest: true }); } catch {}
    }).catch(() => {});
  }
  await page.goto('https://github.com/Zir0-93/striff-lib/pull/1/changes', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  await page.waitForTimeout(5000);

  const out = await page.evaluate(() => {
    const toolbar = document.querySelector(
      '.pr-toolbar[data-target="diff-layout.diffToolbar"], .js-pr-toolbar, [data-testid="pr-toolbar"], div[role="toolbar"][data-view-component="true"], div[aria-label="Pull request toolbar"]'
    );
    const viewed = document.querySelector('span[class*="ViewedFileProgress-module__FilesCountText"]');
    const chain = [];
    let current = viewed;
    while (current && chain.length < 8) {
      chain.push({
        tag: current.tagName,
        id: current.id || '',
        cls: typeof current.className === 'string' ? current.className : '',
        style: current.getAttribute?.('style') || '',
        text: (current.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200)
      });
      current = current.parentElement;
    }
    if (!toolbar) {
      const section = viewed?.closest('section');
      return {
        href: location.href,
        path: location.pathname,
        title: document.title,
        viewedFound: !!viewed,
        viewedChain: chain,
        sectionChildren: section ? Array.from(section.children).map((el) => ({
          tag: el.tagName,
          cls: typeof el.className === 'string' ? el.className : '',
          text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200)
        })) : [],
        sections: Array.from(document.querySelectorAll('section')).slice(0, 10).map((sec) => ({
          cls: sec.className,
          aria: sec.getAttribute('aria-label') || '',
          text: (sec.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200)
        }))
      };
    }
    const summarize = (el) => {
      if (!el) return null;
      return {
        tag: el.tagName,
        id: el.id || '',
        cls: typeof el.className === 'string' ? el.className : '',
        style: el.getAttribute('style') || '',
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200)
      };
    };
    return {
      toolbar: summarize(toolbar),
      children: Array.from(toolbar.children).map(summarize),
      descendants: Array.from(toolbar.querySelectorAll(':scope > *, :scope > * > *')).slice(0, 20).map(summarize),
      html: toolbar.innerHTML.slice(0, 6000)
    };
  });

  console.log(JSON.stringify(out, null, 2));
  await context.close();
  fs.rmSync(copy, { recursive: true, force: true });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
