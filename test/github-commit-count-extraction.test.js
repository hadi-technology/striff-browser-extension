const assert = require('node:assert');
const { resolveCommitCountFromDocument } = require('../src/pr-metadata-utils');

function makeNode({ text = '', attrs = {} } = {}) {
  return {
    textContent: text,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    }
  };
}

function makeDocument(selectorMap = {}) {
  return {
    querySelector(selector) {
      return selectorMap[selector] || null;
    },
    querySelectorAll() {
      return [];
    }
  };
}

const cases = [
  {
    name: 'legacy commits counter id',
    doc: makeDocument({
      '#commits_tab_counter': makeNode({ text: '11', attrs: { title: '11' } })
    }),
    expected: 11
  },
  {
    name: 'modern commits tab counter',
    doc: makeDocument({
      'a#commits_tab .Counter': makeNode({ text: '27' })
    }),
    expected: 27
  },
  {
    name: 'commits tab text fallback',
    doc: makeDocument({
      'a#commits_tab': makeNode({ text: '314 commits' })
    }),
    expected: 314
  },
  {
    name: 'commits tab aria-label fallback',
    doc: makeDocument({
      'a#commits_tab': makeNode({ attrs: { 'aria-label': '2,031 commits' } })
    }),
    expected: 2031
  },
  {
    name: 'counter supports thousands separators',
    doc: makeDocument({
      '#commits_tab_counter': makeNode({ text: '1,234' })
    }),
    expected: 1234
  }
];

for (const testCase of cases) {
  const actual = resolveCommitCountFromDocument(testCase.doc);
  assert.strictEqual(
    actual,
    testCase.expected,
    `expected ${testCase.name} to resolve commit count ${testCase.expected}, got ${actual}`
  );
}

const missing = resolveCommitCountFromDocument(makeDocument({}));
assert.strictEqual(missing, null, 'expected null when no commit count markers exist');

console.log('github commit count extraction test passed');
