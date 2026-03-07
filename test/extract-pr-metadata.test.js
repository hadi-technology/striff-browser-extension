const assert = require('node:assert');
const { resolveLatestCommitShaFromDocument, resolveCommitCountFromDocument } = require('../src/pr-metadata-utils');

const EXPECTED_SHA = '0123456789abcdef0123456789abcdef01234567';

const scriptElement = {
  get textContent() {
    return JSON.stringify({
      payload: {
        pullRequest: {
          headRefOid: EXPECTED_SHA
        }
      }
    });
  }
};

const documentStub = {
  querySelector(selector) {
    return null;
  },
  querySelectorAll(selector) {
    if (selector === 'script[data-target="react-app.embeddedData"]') {
      return [scriptElement];
    }
    return [];
  }
};

const sha = resolveLatestCommitShaFromDocument(documentStub);
assert.strictEqual(sha, EXPECTED_SHA, 'expected the embedded payload commit to be returned');

const EXPECTED_COMMITS = 11;
const commitsDoc = {
  querySelector(selector) {
    if (selector === '#commits_tab_counter') {
      return {
        textContent: String(EXPECTED_COMMITS),
        getAttribute(name) {
          if (name === 'title') return String(EXPECTED_COMMITS);
          return null;
        }
      };
    }
    return null;
  },
  querySelectorAll(selector) {
    return [];
  }
};

const count = resolveCommitCountFromDocument(commitsDoc);
assert.strictEqual(count, EXPECTED_COMMITS, 'expected the commits counter value to be returned');
console.log('extract-pr-metadata test passed');
