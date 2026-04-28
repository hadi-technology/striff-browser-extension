const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..');
const PROFILE = path.resolve(__dirname, '.pw-profile');
const PROFILE_COPY = path.resolve(__dirname, '.pw-profile-click');
const PR_URL = 'https://github.com/Zir0-93/striff-lib/pull/1/changes';
const HEADED = (process.env.HEADED || '') === '1';
const HEADLESS = HEADED ? false : (process.env.HEADLESS || '1') !== '0';

const ensureProfileCopy = () => {
  fs.rmSync(PROFILE_COPY, { recursive: true, force: true });
  fs.cpSync(PROFILE, PROFILE_COPY, { recursive: true });
  for (const name of ['SingletonCookie', 'SingletonLock', 'SingletonSocket']) {
    try { fs.rmSync(path.join(PROFILE_COPY, name), { force: true }); } catch {}
  }
  return PROFILE_COPY;
};

(async () => {
  const runProfile = ensureProfileCopy();
  const context = await chromium.launchPersistentContext(runProfile, {
    channel: 'chromium',
    headless: HEADLESS,
    viewport: { width: 1440, height: 1100 },
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
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
  // Wait for service worker and set debug mode
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => null);
  if (sw) {
    await sw.evaluate(async () => {
      try {
        await chrome.storage.local.set({ striffsDebug: true, striffsTest: true });
      } catch {}
    }).catch(() => {});
  }

  await page.goto(PR_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  // Find DiagramComponent.java and analyze its DOM structure
  const result = await page.evaluate(() => {
    // Find the file treeitem for DiagramComponent.java
    const allItems = Array.from(document.querySelectorAll('li[role="treeitem"], li[id^="file-tree-item-diff-"], li[data-tree-entry-type="file"]'));
    const diagramComponent = allItems.find(el => {
      const text = el.textContent || '';
      return text.includes('DiagramComponent.java');
    });

    if (!diagramComponent) {
      return { error: 'DiagramComponent.java not found in tree' };
    }

    // Walk up the DOM from the text node to understand structure
    const walkUp = (startEl) => {
      const chain = [];
      let current = startEl;
      while (current && chain.length < 10) {
        chain.push({
          tag: current.tagName,
          id: current.id || '',
          role: current.getAttribute?.('role') || '',
          type: current.getAttribute?.('data-tree-entry-type') || '',
          class: typeof current.className === 'string' ? current.className.slice(0, 100) : '',
          hasIdAttr: current.id && current.id.startsWith('file-tree-item-diff-'),
          dataPath: current.getAttribute?.('data-path') || '',
          dataFilePath: current.getAttribute?.('data-file-path') || ''
        });
        current = current.parentElement;
      }
      return chain;
    };

    // Find the actual link/text for DiagramComponent.java
    const link = diagramComponent.querySelector('a[href*="#diff-"]');
    const textNode = Array.from(diagramComponent.childNodes).find(n => 
      n.textContent?.includes('DiagramComponent.java')
    );

    return {
      found: true,
      itemSummary: {
        id: diagramComponent.id,
        role: diagramComponent.getAttribute('role'),
        type: diagramComponent.getAttribute('data-tree-entry-type'),
        dataPath: diagramComponent.getAttribute('data-path'),
        dataFilePath: diagramComponent.getAttribute('data-file-path'),
        class: diagramComponent.className?.slice(0, 200)
      },
      linkFromItem: link ? {
        href: link.getAttribute('href'),
        closestLiId: link.closest('li')?.id,
        closestLiRole: link.closest('li')?.getAttribute('role'),
        closestLiType: link.closest('li')?.getAttribute('data-tree-entry-type')
      } : null,
      chainFromLink: link ? walkUp(link) : null,
      closestResults: link ? {
        byId: link.closest('li[id^="file-tree-item-diff-"]')?.id || null,
        byTree: link.closest('[data-testid="file-tree"] li')?.id || null,
        byType: link.closest('li[data-tree-entry-type="file"]')?.id || null,
        byRole: link.closest('li[role="treeitem"]')?.id || null,
        byLi: link.closest('li')?.id || null
      } : null
    };
  });

  console.log(JSON.stringify(result, null, 2));

  await context.close().catch(() => {});
  fs.rmSync(PROFILE_COPY, { recursive: true, force: true });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
