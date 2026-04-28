const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getCommitFromEmbeddedData,
  normalizeCommit,
  resolveCommitCountFromDocument,
  resolveLatestCommitShaFromDocument
} = require('../src/pr-metadata-utils.js');

test('normalizeCommit accepts valid shas and rejects noise', () => {
  assert.equal(normalizeCommit('abcdef1'), 'abcdef1');
  assert.equal(normalizeCommit('not-a-sha'), null);
});

test('getCommitFromEmbeddedData reads pull request head sha from embedded data', () => {
  const document = {
    querySelectorAll() {
      return [{
        textContent: JSON.stringify({ payload: { pullRequest: { headRefOid: 'abcdef1234567890abcdef1234567890abcdef12' } } })
      }];
    }
  };
  assert.equal(
    getCommitFromEmbeddedData(document),
    'abcdef1234567890abcdef1234567890abcdef12'
  );
});

test('resolveLatestCommitShaFromDocument prefers clipboard sha', () => {
  const document = {
    querySelector(selector) {
      if (selector.includes('clipboard-copy')) {
        return {
          getAttribute(name) {
            return name === 'value' ? '1234567890abcdef1234567890abcdef12345678' : '';
          }
        };
      }
      return null;
    }
  };
  assert.equal(resolveLatestCommitShaFromDocument(document), '1234567890abcdef1234567890abcdef12345678');
});

test('resolveCommitCountFromDocument parses count from counters and labels', () => {
  const node = {
    getAttribute(name) {
      return name === 'aria-label' ? '12 commits' : null;
    },
    textContent: '12'
  };
  const document = {
    querySelector() {
      return node;
    }
  };
  assert.equal(resolveCommitCountFromDocument(document), 12);
});
