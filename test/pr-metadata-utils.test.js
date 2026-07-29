const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getCommitFromEmbeddedData,
  isPrStatePrefetchEligible,
  normalizeCommit,
  normalizePrState,
  resolveCommitCountFromDocument,
  resolveLatestCommitShaFromDocument,
  resolvePrStateFromDocument
} = require('../src/pr-metadata-utils.js');

// Minimal fake document: selector -> node (or nodes for querySelectorAll).
const fakeDocument = (bySelector = {}, allBySelector = {}) => ({
  querySelector(selector) {
    return bySelector[selector] || null;
  },
  querySelectorAll(selector) {
    return allBySelector[selector] || [];
  }
});

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

test('normalizePrState maps badge text to canonical states', () => {
  assert.equal(normalizePrState('Open'), 'open');
  assert.equal(normalizePrState('  Draft '), 'draft');
  assert.equal(normalizePrState('Merged'), 'merged');
  assert.equal(normalizePrState('Closed'), 'closed');
  assert.equal(normalizePrState('OPEN', { isDraft: true }), 'draft');
  assert.equal(normalizePrState('something else'), null);
  assert.equal(normalizePrState(''), null);
});

test('resolvePrStateFromDocument reads the classic reviewable_state attribute', () => {
  const doc = fakeDocument({
    '[reviewable_state]': { getAttribute: () => 'draft' }
  });
  assert.equal(resolvePrStateFromDocument(doc), 'draft');
});

test('resolvePrStateFromDocument reads the header State badge by class', () => {
  const doc = fakeDocument({
    '.gh-header-meta .State': { className: 'State State--merged', textContent: 'Merged' }
  });
  assert.equal(resolvePrStateFromDocument(doc), 'merged');
});

test('resolvePrStateFromDocument reads the header State badge by text', () => {
  const doc = fakeDocument({
    '#partial-discussion-header .State': { className: 'State', textContent: ' Open ' }
  });
  assert.equal(resolvePrStateFromDocument(doc), 'open');
});

// Regression: an open PR's conversation timeline contains .State--merged /
// .State--closed badges from cross-referenced PRs and issues. Reading badges
// outside the PR header misclassified the open PR as merged and skipped
// prefetch. Timeline badges must be ignored entirely.
test('resolvePrStateFromDocument ignores merged badges outside the PR header', () => {
  const timelineMergedBadge = { className: 'State State--merged', textContent: 'Merged' };
  // Embedded payload present: it wins over any badge.
  const withEmbedded = fakeDocument(
    { '.State--merged, .State.Color--merged': timelineMergedBadge },
    {
      'script[data-target="react-app.embeddedData"]': [{
        textContent: JSON.stringify({ payload: { pullRequest: { state: 'OPEN', isDraft: false } } })
      }],
      '.State': [timelineMergedBadge]
    }
  );
  assert.equal(resolvePrStateFromDocument(withEmbedded), 'open');

  // No embedded payload and no header badge: unknown, never a timeline guess.
  const timelineOnly = fakeDocument(
    { '.State--merged, .State.Color--merged': timelineMergedBadge },
    { '.State': [timelineMergedBadge] }
  );
  assert.equal(resolvePrStateFromDocument(timelineOnly), null);
});

test('resolvePrStateFromDocument reads React embedded payload state and draft flag', () => {
  const embedded = [{
    textContent: JSON.stringify({ payload: { pullRequest: { state: 'OPEN', isDraft: true } } })
  }];
  const doc = fakeDocument({}, {
    'script[data-target="react-app.embeddedData"]': embedded
  });
  assert.equal(resolvePrStateFromDocument(doc), 'draft');
});

test('resolvePrStateFromDocument reads React data-status values', () => {
  const doc = fakeDocument({
    '[data-status]': { getAttribute: () => 'pullOpened' }
  });
  assert.equal(resolvePrStateFromDocument(doc), 'open');
});

test('resolvePrStateFromDocument returns null when no state signal exists', () => {
  assert.equal(resolvePrStateFromDocument(fakeDocument()), null);
  assert.equal(resolvePrStateFromDocument(null), null);
});

// Regression: prefetch was silently disabled on pages where no state markup
// matched, because unknown state was treated as "not open". Unknown must be
// eligible; only a definitive merged/closed state may skip prefetch.
test('isPrStatePrefetchEligible allows open, draft, and unknown; blocks merged and closed', () => {
  assert.equal(isPrStatePrefetchEligible('open'), true);
  assert.equal(isPrStatePrefetchEligible('draft'), true);
  assert.equal(isPrStatePrefetchEligible(null), true);
  assert.equal(isPrStatePrefetchEligible('merged'), false);
  assert.equal(isPrStatePrefetchEligible('closed'), false);
});
