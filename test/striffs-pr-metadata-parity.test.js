const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const prMetadataPath = path.join(__dirname, '..', 'src', 'pr-metadata-utils.js');
const striffsPath = path.join(__dirname, '..', 'src', 'striffs.js');
const prMetadataSource = fs.readFileSync(prMetadataPath, 'utf8');
const striffsSource = fs.readFileSync(striffsPath, 'utf8');
const prMetadataUtils = require('../src/pr-metadata-utils');

function createElement() {
  return {
    style: { setProperty() {} },
    dataset: {},
    classList: {
      add() {},
      remove() {},
      contains() { return false; },
      toggle() { return false; }
    },
    appendChild() {},
    insertBefore() {},
    prepend() {},
    remove() {},
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    addEventListener() {},
    removeEventListener() {},
    scrollIntoView() {},
    focus() {},
    click() {},
    dispatchEvent() { return true; },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    },
    getBBox() {
      return { x: 0, y: 0, width: 0, height: 0 };
    },
    matches() { return false; },
    contains() { return false; },
    ownerSVGElement: null,
    parentElement: null,
    parentNode: null,
    innerHTML: '',
    textContent: '',
    value: '',
    clientWidth: 0,
    clientHeight: 0,
    scrollLeft: 0,
    scrollTop: 0
  };
}

function createStorageArea() {
  return {
    get(_keys, cb) {
      const result = {};
      if (typeof cb === 'function') cb(result);
      return Promise.resolve(result);
    },
    set(_items, cb) {
      if (typeof cb === 'function') cb();
      return Promise.resolve();
    },
    remove(_keys, cb) {
      if (typeof cb === 'function') cb();
      return Promise.resolve();
    }
  };
}

function createStorage() {
  const data = new Map();
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    }
  };
}

function makeNode({ text = '', attrs = {} } = {}) {
  return {
    textContent: text,
    innerText: text,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    }
  };
}

function makeDocument({ selectors = {}, selectorLists = {} } = {}) {
  const head = createElement();
  const body = createElement();
  const documentElement = createElement();
  body.parentNode = documentElement;
  return {
    head,
    body,
    documentElement,
    createElement,
    createElementNS: createElement,
    getElementById() { return null; },
    querySelector(selector) {
      return Object.prototype.hasOwnProperty.call(selectors, selector) ? selectors[selector] : null;
    },
    querySelectorAll(selector) {
      return Object.prototype.hasOwnProperty.call(selectorLists, selector) ? selectorLists[selector] : [];
    },
    addEventListener() {},
    removeEventListener() {}
  };
}

function loadStriffsWithDocument(document) {
  const sandbox = {
    console: {
      log() {},
      info() {},
      warn() {},
      error() {}
    },
    setTimeout() { return 0; },
    clearTimeout() {},
    setInterval() { return 0; },
    clearInterval() {},
    MutationObserver: function MutationObserver() {
      this.observe = () => {};
      this.disconnect = () => {};
    },
    Event: function Event(type) { this.type = type; },
    URL: {
      createObjectURL() { return 'blob:test'; },
      revokeObjectURL() {}
    },
    Blob,
    FormData,
    localStorage: createStorage(),
    sessionStorage: createStorage(),
    location: {
      href: 'https://github.com/',
      pathname: '/',
      hash: ''
    },
    history: {
      pushState() {},
      replaceState() {}
    },
    navigator: {},
    performance: { now: () => 0 },
    crypto: { randomUUID: () => 'sess-test' },
    document,
    chrome: {
      storage: {
        local: createStorageArea(),
        sync: createStorageArea(),
        onChanged: { addListener() {} }
      },
      runtime: {
        sendMessage() {},
        onMessage: { addListener() {} }
      }
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; }
  };

  sandbox.window = sandbox;
  vm.runInNewContext(prMetadataSource, sandbox, { filename: prMetadataPath });
  vm.runInNewContext(striffsSource, sandbox, { filename: striffsPath });
  sandbox.location.pathname = '/acme/widgets/pull/42/files';
  return sandbox.window.Striffs;
}

const cases = [
  {
    name: 'clipboard sha and legacy counter',
    document: makeDocument({
      selectors: {
        "clipboard-copy[value][aria-label*='SHA'], clipboard-copy[value][aria-label*='commit']": makeNode({
          attrs: { value: '0123456789abcdef0123456789abcdef01234567' }
        }),
        '#commits_tab_counter': makeNode({ text: '11', attrs: { title: '11' } })
      }
    }),
    expectedSha: '0123456789abcdef0123456789abcdef01234567',
    expectedCount: 11
  },
  {
    name: 'commit link and aria label fallback',
    document: makeDocument({
      selectors: {
        'a[data-hovercard-type="commit"], a[href*="/commit/"]': makeNode({
          text: 'ignored',
          attrs: { href: '/acme/widgets/commit/89abcdef0123456789abcdef0123456789abcdef01' }
        }),
        'a#commits_tab': makeNode({ attrs: { 'aria-label': '2,031 commits' } })
      }
    }),
    expectedSha: '89abcdef0123456789abcdef0123456789abcdef',
    expectedCount: 2031
  },
  {
    name: 'embedded data and commits tab text fallback',
    document: makeDocument({
      selectors: {
        'a#commits_tab': makeNode({ text: '314 commits' })
      },
      selectorLists: {
        'script[data-target="react-app.embeddedData"]': [
          makeNode({
            text: JSON.stringify({
              payload: {
                pullRequest: {
                  headRefOid: 'fedcba9876543210fedcba9876543210fedcba98'
                }
              }
            })
          })
        ]
      }
    }),
    expectedSha: 'fedcba9876543210fedcba9876543210fedcba98',
    expectedCount: 314
  }
];

for (const testCase of cases) {
  const S = loadStriffsWithDocument(testCase.document);
  const moduleSha = prMetadataUtils.resolveLatestCommitShaFromDocument(testCase.document);
  const moduleCount = prMetadataUtils.resolveCommitCountFromDocument(testCase.document);
  const extracted = S.extractPRMetadata();

  assert.strictEqual(moduleSha, testCase.expectedSha, `${testCase.name} module sha`);
  assert.strictEqual(moduleCount, testCase.expectedCount, `${testCase.name} module count`);
  assert.strictEqual(extracted.commit_sha, moduleSha, `${testCase.name} striffs sha parity`);
  assert.strictEqual(extracted.commit_count, moduleCount, `${testCase.name} striffs count parity`);
  assert.strictEqual(extracted.owner, 'acme');
  assert.strictEqual(extracted.repo, 'widgets');
  assert.strictEqual(extracted.pull_number, '42');
}

console.log('striffs pr metadata parity test passed');
