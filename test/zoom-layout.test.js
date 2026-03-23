const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const prMetadataPath = path.join(__dirname, '..', 'src', 'pr-metadata-utils.js');
const striffsPath = path.join(__dirname, '..', 'src', 'striffs.js');
const prMetadataSource = fs.readFileSync(prMetadataPath, 'utf8');
const striffsSource = fs.readFileSync(striffsPath, 'utf8');

function createStorageArea(initial = {}) {
  const data = { ...initial };
  return {
    get(keys, cb) {
      const result = keys == null ? { ...data } : {};
      if (typeof cb === 'function') cb(result);
      return Promise.resolve(result);
    },
    set(items, cb) {
      Object.assign(data, items || {});
      if (typeof cb === 'function') cb();
      return Promise.resolve();
    },
    remove(keys, cb) {
      const toRemove = Array.isArray(keys) ? keys : [keys];
      for (const key of toRemove) delete data[key];
      if (typeof cb === 'function') cb();
      return Promise.resolve();
    }
  };
}

function createElement() {
  return {
    style: {},
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

function loadStriffs() {
  const localStorage = createStorage();
  const sessionStorage = createStorage();
  const head = createElement();
  const body = createElement();
  const documentElement = createElement();
  body.parentNode = documentElement;

  const document = {
    head,
    body,
    documentElement,
    createElement() { return createElement(); },
    createElementNS() { return createElement(); },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {}
  };

  const chrome = {
    storage: {
      local: createStorageArea(),
      sync: createStorageArea(),
      onChanged: { addListener() {} }
    },
    runtime: {
      sendMessage() {},
      onMessage: { addListener() {} }
    }
  };

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
    localStorage,
    sessionStorage,
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
    chrome,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; }
  };

  sandbox.window = sandbox;
  vm.runInNewContext(prMetadataSource, sandbox, { filename: prMetadataPath });
  vm.runInNewContext(striffsSource, sandbox, { filename: striffsPath });
  return sandbox.window.Striffs;
}

function createSvg(width, height) {
  const wrap = { style: {} };
  const attrs = { width: String(width), height: String(height) };
  const svg = {
    style: {},
    parentElement: wrap,
    viewBox: {
      baseVal: { width, height }
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    getBBox() {
      return { x: 0, y: 0, width, height };
    }
  };
  return { svg, wrap };
}

function testSyncZoomedSvgLayoutExpandsScrollableSurface() {
  const S = loadStriffs();
  const view = { clientWidth: 300, clientHeight: 200 };
  const { svg, wrap } = createSvg(400, 250);
  S.__striffsZoom = 2;

  const didSync = S.syncZoomedSvgLayout(view, svg);

  assert.strictEqual(didSync, true);
  assert.strictEqual(svg.style.transform, 'scale(2)');
  assert.strictEqual(wrap.style.width, '800px');
  assert.strictEqual(wrap.style.height, '500px');
  assert.strictEqual(wrap.style.minWidth, '800px');
  assert.strictEqual(wrap.style.minHeight, '500px');
  assert.strictEqual(svg.style.width, '400px');
  assert.strictEqual(svg.style.height, '250px');
}

function testApplyZoomAtPointRepositionsScrollAgainstScaledSurface() {
  const S = loadStriffs();
  const view = {
    clientWidth: 300,
    clientHeight: 200,
    scrollLeft: 0,
    scrollTop: 0,
    getBoundingClientRect() {
      return { left: 10, top: 20, width: 300, height: 200 };
    }
  };
  const { svg, wrap } = createSvg(400, 250);
  S.__striffsZoom = 1;

  const didApply = S.applyZoomAtPoint(view, svg, 2, 110, 120);

  assert.strictEqual(didApply, true);
  assert.strictEqual(S.__striffsZoom, 2);
  assert.strictEqual(view.scrollLeft, 100);
  assert.strictEqual(view.scrollTop, 100);
  assert.strictEqual(wrap.style.width, '800px');
  assert.strictEqual(wrap.style.height, '500px');
}

testSyncZoomedSvgLayoutExpandsScrollableSurface();
testApplyZoomAtPointRepositionsScrollAgainstScaledSurface();
console.log('zoom layout test passed');
