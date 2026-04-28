// Debug script to dump DOM structure for new GitHub UI
const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..');
const PR_URL = 'https://github.com/Zir0-93/striff-lib/pull/1/changes';
const HEADED = (process.env.HEADED || '') === '1';
const HEADLESS = HEADED ? false : (process.env.HEADLESS || '1') !== '0';

(async () => {
  const context = await chromium.launchPersistentContext('', {
    headless: HEADLESS,
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
    ],
  });

  const page = await context.newPage();

  // Enable debug mode
  await page.addInitScript(() => {
    window.__STRIFFS_DEBUG = true;
  });

  // Listen to console logs
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[Striffs]') || text.includes('[debug]') || text.includes('filter')) {
      console.log('[page]', msg.type(), text);
    }
  });

  console.log('Navigating to PR:', PR_URL);
  await page.goto(PR_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait for file tree to load
  await page.waitForTimeout(3000);

  // Dump what S.$$all finds for fileTreeItems
  const selectorResults = await page.evaluate(() => {
    const S = window.Striffs;
    if (!S) return { error: 'Striffs not loaded' };

    const treeItems = S.$$all(S.SELECTORS?.fileTreeItems || []);
    const fileLinks = S.$$all(S.SELECTORS?.fileLinks || []);

    return {
      striffsLoaded: true,
      treeItemsCount: treeItems.length,
      fileLinksCount: fileLinks.length,
      treeItemsSample: treeItems.slice(0, 5).map(el => ({
        tagName: el.tagName,
        textContent: el.textContent?.slice(0, 50),
        className: el.className,
        outerHTML: el.outerHTML?.slice(0, 200)
      })),
      fileLinksSample: fileLinks.slice(0, 5).map(el => ({
        tagName: el.tagName,
        href: el.getAttribute('href'),
        textContent: el.textContent?.slice(0, 50),
        title: el.getAttribute('title'),
        outerHTML: el.outerHTML?.slice(0, 200)
      })),
      getFilterFilesFromNavResult: S.getFilterFilesFromNav?.() || [],
      selectors: S.SELECTORS
    };
  });

  console.log('\n=== DOM DUMP RESULTS ===');
  console.log(JSON.stringify(selectorResults, null, 2));

  // Also dump actual file tree structure
  const fileTreeStructure = await page.evaluate(() => {
    // Check filesRoot selectors
    const filesRootSelectors = [
      '#files',
      'div[data-view-component="true"][data-testid="pull-requests-files"]',
      'div[data-testid="files-changed"]',
      'div[data-target="diff-layout.sidebarContainer"]',
      'div.diff-sidebar[data-view-component="true"]',
    ];
    const foundFilesRoot = filesRootSelectors.map(sel => ({
      selector: sel,
      found: !!document.querySelector(sel)
    }));

    // Look for any file tree container
    const containers = [
      document.querySelector('[data-testid="file-tree"]'),
      document.querySelector('ul[role="list"]'),
      document.querySelector('.js-file-tree'),
      document.querySelector('li[data-tree-entry-type]')
    ].filter(Boolean);

    const treeLis = Array.from(document.querySelectorAll('li[data-tree-entry-type="file"], li[id^="file-tree-item-"]'));

    return {
      foundFilesRoot,
      containersCount: containers.length,
      containerTypes: containers.map(c => ({
        tagName: c.tagName,
        className: c.className,
        id: c.id,
        childrenCount: c.children.length
      })),
      fileLisCount: treeLis.length,
      fileLisSample: treeLis.slice(0, 5).map(li => ({
        tagName: li.tagName,
        id: li.id,
        dataTreeEntryType: li.getAttribute('data-tree-entry-type'),
        hasDataFilterableItemText: !!li.querySelector('[data-filterable-item-text]'),
        dataFilterableItemText: li.querySelector('[data-filterable-item-text]')?.textContent?.slice(0, 50),
        hasActionListContent: !!li.querySelector('a.ActionList-content, a.ActionListContent'),
        actionListContentHref: li.querySelector('a.ActionList-content, a.ActionListContent')?.getAttribute('href'),
        outerHTML: li.outerHTML?.slice(0, 300)
      }))
    };
  });

  console.log('\n=== FILE TREE STRUCTURE ===');
  console.log(JSON.stringify(fileTreeStructure, null, 2));

  console.log('\nPress Ctrl+C to exit...');
  await new Promise(() => {});
})();
