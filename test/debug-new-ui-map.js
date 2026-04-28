const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..');
const PROFILE = path.resolve(__dirname, '.pw-profile');
const PROFILE_COPY = path.resolve(__dirname, '.pw-profile-debug');
const PR_URL = process.env.PR_URL || 'https://github.com/Zir0-93/striff-lib/pull/1/changes';
const HEADLESS = (process.env.HEADLESS || '1') === '1';
const KEEP_OPEN = (process.env.KEEP_OPEN || '') === '1';
const SKIP_GENERATE = (process.env.SKIP_GENERATE || '') === '1';
const STORAGE_STATE_PATH = (process.env.GITHUB_STORAGE_STATE_PATH || '').trim() || undefined;

const log = (...args) => console.log(new Date().toISOString(), ...args);

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
    storageState: STORAGE_STATE_PATH,
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
  page.on('console', (msg) => log('[page]', msg.type(), msg.text()));
  page.on('pageerror', (err) => log('[pageerror]', err?.message || err));

  const getServiceWorker = async () => {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => null);
    return sw;
  };

  const sw = await getServiceWorker();
  if (sw) {
    sw.on('console', (msg) => log('[bg]', msg.type(), msg.text()));
    await sw.evaluate(async () => {
      try {
        await chrome.storage.local.set({
          striffsTest: true,
          striffsDebug: true,
          striffsApiBase: 'http://localhost:8080'
        });
      } catch {}
    }).catch(() => {});
  }

  await page.goto(PR_URL.replace(/\/files(?=[/?#]|$)/, '/changes'), {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  await page.waitForTimeout(3000);

  const pre = await page.evaluate(() => {
    const summarizeNodes = (nodes, limit = 12) => nodes.slice(0, limit).map((node) => ({
      tag: node.tagName,
      id: node.id || '',
      className: typeof node.className === 'string' ? node.className : '',
      role: node.getAttribute?.('role') || '',
      href: node.getAttribute?.('href') || '',
      title: node.getAttribute?.('title') || '',
      ariaLabel: node.getAttribute?.('aria-label') || '',
      dataPath: node.getAttribute?.('data-path') || '',
      dataFilePath: node.getAttribute?.('data-file-path') || '',
      dataTestId: node.getAttribute?.('data-testid') || '',
      text: (node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 180),
      controls: Array.from(node.querySelectorAll?.('a,button,[role="button"]') || []).slice(0, 6).map((el) => ({
        tag: el.tagName,
        id: el.id || '',
        href: el.getAttribute?.('href') || '',
        title: el.getAttribute?.('title') || '',
        ariaLabel: el.getAttribute?.('aria-label') || '',
        dataPath: el.getAttribute?.('data-path') || '',
        dataFilePath: el.getAttribute?.('data-file-path') || '',
        dataTestId: el.getAttribute?.('data-testid') || '',
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120)
      }))
    }));
    const treeItems = Array.from(document.querySelectorAll("li[data-tree-entry-type='file'], li[id^='file-tree-item-diff-'], li[role='treeitem']"));
    const headerLinks = Array.from(document.querySelectorAll(".file-info a.Link--primary, [data-testid='file-header'] a.Link--primary, a[data-testid='file-name'], a[data-hovercard-type='file'], a.ActionList-content[href^='#diff-']"));
    const fileNodes = Array.from(document.querySelectorAll(".js-file[data-path], [data-testid='file-diff-unified'][data-path], [data-testid='file-diff-split'][data-path], .file-header[data-path], .js-file-header[data-path], .file-header--expandable[data-path], [id^='diff-'][data-path]"));
    return {
      href: location.href,
      path: location.pathname,
      title: document.title,
      treeCount: treeItems.length,
      headerCount: headerLinks.length,
      fileNodeCount: fileNodes.length,
      tree: summarizeNodes(treeItems),
      headers: summarizeNodes(headerLinks),
      fileNodes: summarizeNodes(fileNodes)
    };
  }).catch(() => null);

  log('PRE', JSON.stringify(pre, null, 2));

  if (SKIP_GENERATE) {
    await context.close().catch(() => {});
    fs.rmSync(PROFILE_COPY, { recursive: true, force: true });
    return;
  }

  const striffsBtn = page.locator('#striffs-btn');
  await striffsBtn.waitFor({ state: 'visible', timeout: 30000 });
  await striffsBtn.click();

  await page.waitForFunction(() => {
    const d = document.documentElement?.dataset || {};
    const S = window.Striffs;
    return Boolean(
      (S?.__striffsReady && document.querySelector('#striff-diagram-view svg')) ||
      Number(d.striffsPathToComponentSize || 0) > 0
    );
  }, { timeout: 180000 }).catch(() => null);
  await page.waitForTimeout(3000);

  const post = await page.evaluate(() => {
    const d = document.documentElement?.dataset || {};
    const S = window.Striffs;
    const treeItems = Array.from(document.querySelectorAll("li[data-tree-entry-type='file'], li[id^='file-tree-item-diff-'], li[role='treeitem']"));
    const mappedItems = Array.from(document.querySelectorAll("li[data-striffs-mapped='1']"));
    return {
      href: location.href,
      path: location.pathname,
      dataset: { ...d },
      striffsReady: !!S?.__striffsReady,
      hasSvg: !!document.querySelector('#striff-diagram-view svg'),
      filesInPr: Array.isArray(S?.getFilesInPR?.()) ? S.getFilesInPR() : [],
      filterFiles: Array.isArray(S?.getFilterFilesFromNav?.()) ? S.getFilterFilesFromNav() : [],
      pathToComponent: Array.from(S?.__striffsPathToComponentId?.entries?.() || []).slice(0, 50),
      componentToFile: Array.from(S?.__striffsComponentIdToFile?.entries?.() || []).slice(0, 50),
      filePathToDiffId: Array.from(S?.__filePathToDiffId?.entries?.() || []).slice(0, 50),
      debugFilePathToDiffHash: S?.__debugFilePathToDiffHash || null,
      debugPathToComponent: S?.__debugPathToComponent || null,
      debugApiComponents: S?.__debugApiComponents || null,
      mappedItems: mappedItems.slice(0, 20).map((node) => ({
        id: node.id || '',
        className: typeof node.className === 'string' ? node.className : '',
        dataPath: node.getAttribute('data-path') || '',
        mapped: node.getAttribute('data-striffs-mapped') || '',
        diffLink: node.querySelector("a[href*='#diff-']")?.getAttribute('href') || '',
        text: (node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 180)
      })),
      tree: treeItems.slice(0, 20).map((node) => ({
        id: node.id || '',
        role: node.getAttribute('role') || '',
        type: node.getAttribute('data-tree-entry-type') || '',
        dataPath: node.getAttribute('data-path') || '',
        dataFilePath: node.getAttribute('data-file-path') || '',
        ariaLabel: node.getAttribute('aria-label') || '',
        title: node.getAttribute('title') || '',
        mapped: node.getAttribute('data-striffs-mapped') || '',
        disabled: node.classList.contains('striffs-file-disabled'),
        diffLink: node.querySelector("a[href*='#diff-']")?.getAttribute('href') || '',
        text: (node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 180)
      }))
    };
  }).catch((e) => ({ error: String(e?.message || e) }));

  log('POST', JSON.stringify(post, null, 2));

  if (!KEEP_OPEN) {
    await context.close().catch(() => {});
    fs.rmSync(PROFILE_COPY, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
