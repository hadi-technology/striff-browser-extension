const test = require('node:test');
const assert = require('node:assert/strict');

const {
  collectReview,
  mergeReviewResult,
  reviewButtonState,
  isReviewPending,
  reviewProgressText
} = require('../src/review-state-utils.js');

// Sleeping advances the clock instantly, so a budget of minutes runs in microseconds.
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; }, elapsed: () => t };
}

// Serves the responses in order, then keeps repeating the last one.
function server(...responses) {
  const calls = [];
  return {
    calls,
    fetchStatus: async () => {
      const resp = responses[Math.min(calls.length, responses.length - 1)];
      calls.push(resp);
      return resp;
    }
  };
}

const reply = (aiReviewStatus, extra = {}) =>
  ({ ok: true, status: 200, json: { aiReviewStatus, aiReviewPollAfterMs: 5000, ...extra } });

const BUDGET = 150000;

test('READY on the first read resolves at once', async () => {
  const clock = fakeClock();
  const api = server(reply('READY', { docFactVerdicts: [{ status: 'MAINTAINED' }] }));
  const r = await collectReview({ fetchStatus: api.fetchStatus, now: clock.now, sleep: clock.sleep, deadline: BUDGET });
  assert.equal(r.status, 'READY');
  assert.equal(r.result.docFactVerdicts.length, 1);
  assert.equal(api.calls.length, 1);
  assert.equal(clock.elapsed(), 0);
});

test('PENDING then READY inside the budget resolves READY', async () => {
  const clock = fakeClock();
  const api = server(reply('PENDING'), reply('RUNNING'), reply('READY'));
  const r = await collectReview({ fetchStatus: api.fetchStatus, now: clock.now, sleep: clock.sleep, deadline: BUDGET });
  assert.equal(r.status, 'READY');
  assert.equal(api.calls.length, 3);
  assert.equal(clock.elapsed(), 10000);
});

test('a review still running at the deadline resolves PENDING, having read right up to it', async () => {
  const clock = fakeClock();
  const api = server(reply('RUNNING', { aiReviewId: 'r1' }));
  const r = await collectReview({ fetchStatus: api.fetchStatus, now: clock.now, sleep: clock.sleep, deadline: BUDGET });
  assert.equal(r.status, 'PENDING');
  assert.equal(r.result.aiReviewId, 'r1');
  // The last read happens at the deadline, never after it.
  assert.equal(clock.elapsed(), BUDGET);
  assert.equal(api.calls.length, BUDGET / 5000 + 1);
});

test("follows the server's poll interval, but never reads more than once a second", async () => {
  const clock = fakeClock();
  const api = server(reply('PENDING', { aiReviewPollAfterMs: 10 }), reply('READY'));
  await collectReview({ fetchStatus: api.fetchStatus, now: clock.now, sleep: clock.sleep, deadline: BUDGET });
  assert.equal(clock.elapsed(), 1000);
});

test("FAILED resolves FAILED with the server's reason", async () => {
  const clock = fakeClock();
  const api = server(reply('PENDING'), reply('FAILED', { aiReviewErrorMessage: 'model timed out' }));
  const r = await collectReview({ fetchStatus: api.fetchStatus, now: clock.now, sleep: clock.sleep, deadline: BUDGET });
  assert.equal(r.status, 'FAILED');
  assert.equal(r.result.aiReviewErrorMessage, 'model timed out');
});

test('SKIPPED and NOT_REQUESTED both resolve SKIPPED', async () => {
  for (const s of ['SKIPPED', 'NOT_REQUESTED']) {
    const clock = fakeClock();
    const api = server(reply(s, { aiReviewErrorMessage: 'too small to review' }));
    const r = await collectReview({ fetchStatus: api.fetchStatus, now: clock.now, sleep: clock.sleep, deadline: BUDGET });
    assert.equal(r.status, 'SKIPPED', s);
    assert.equal(r.result.aiReviewErrorMessage, 'too small to review');
  }
});

test('an unrecognised status resolves FAILED, never as something to wait on', async () => {
  const clock = fakeClock();
  const api = server(reply('HALF_DONE'));
  const r = await collectReview({ fetchStatus: api.fetchStatus, now: clock.now, sleep: clock.sleep, deadline: BUDGET });
  assert.equal(r.status, 'FAILED');
  assert.match(r.result.aiReviewErrorMessage, /HALF_DONE/);
  assert.equal(api.calls.length, 1);
});

test('a refused token stops at once as UNAVAILABLE', async () => {
  const clock = fakeClock();
  const api = server({ ok: false, status: 403, error: 'HTTP 403' });
  const r = await collectReview({ fetchStatus: api.fetchStatus, now: clock.now, sleep: clock.sleep, deadline: BUDGET });
  assert.equal(r.status, 'UNAVAILABLE');
  assert.equal(api.calls.length, 1);
});

test('a request that fails for any other reason is tried again', async () => {
  const clock = fakeClock();
  const api = server({ ok: false, error: 'Failed to fetch' }, { ok: false, status: 503 }, reply('READY'));
  const r = await collectReview({ fetchStatus: api.fetchStatus, now: clock.now, sleep: clock.sleep, deadline: BUDGET });
  assert.equal(r.status, 'READY');
  assert.equal(api.calls.length, 3);
});

test('cancellation stops the collection without another read', async () => {
  const clock = fakeClock();
  let current = true;
  const api = server(reply('PENDING'));
  const fetchStatus = async () => { const r = await api.fetchStatus(); current = false; return r; };
  const r = await collectReview({ fetchStatus, now: clock.now, sleep: clock.sleep, deadline: BUDGET, isCurrent: () => current });
  assert.equal(r.status, 'CANCELLED');
  assert.equal(api.calls.length, 1);
});

test('a collection cancelled before it starts makes no request', async () => {
  const clock = fakeClock();
  const api = server(reply('READY'));
  const r = await collectReview({ fetchStatus: api.fetchStatus, now: clock.now, sleep: clock.sleep, deadline: BUDGET, isCurrent: () => false });
  assert.equal(r.status, 'CANCELLED');
  assert.equal(api.calls.length, 0);
});

test('merging keeps what only the analysis carries and lets the review win elsewhere', () => {
  const analysis = {
    operationId: 'op1',
    aiReviewStatus: 'PENDING',
    aiReviewWarmupRequired: true,
    striffs: [{ svgCode: '<svg id="base"/>' }]
  };
  const review = {
    operationId: 'op1',
    aiReviewStatus: 'READY',
    aiReviewErrorMessage: null,
    striffs: [{ svgCode: '<svg id="reviewed"/>' }],
    reviewSummary: { overview: 'o' },
    docFactVerdicts: []
  };
  const merged = mergeReviewResult(analysis, review);
  assert.equal(merged.aiReviewStatus, 'READY');
  assert.equal(merged.aiReviewWarmupRequired, true);
  assert.equal(merged.striffs[0].svgCode, '<svg id="reviewed"/>');
  assert.deepEqual(merged.reviewSummary, { overview: 'o' });
  assert.deepEqual(merged.docFactVerdicts, []);
  assert.equal('aiReviewErrorMessage' in merged, false);
  // The analysis payload is not modified.
  assert.equal(analysis.aiReviewStatus, 'PENDING');
});

test('a status reply without diagrams leaves the analysis diagrams in place', () => {
  const analysis = { striffs: [{ svgCode: '<svg id="base"/>' }] };
  assert.equal(mergeReviewResult(analysis, { aiReviewStatus: 'FAILED', striffs: null }).striffs[0].svgCode, '<svg id="base"/>');
  assert.equal(mergeReviewResult(analysis, { aiReviewStatus: 'PENDING', striffs: [] }).striffs[0].svgCode, '<svg id="base"/>');
  assert.deepEqual(mergeReviewResult(analysis, null), analysis);
});

test('a finished review opens the findings, with the documented-rule count', () => {
  assert.deepEqual(
    { text: reviewButtonState({ status: 'READY', ruleCount: 3 }).text, enabled: reviewButtonState({ status: 'READY', ruleCount: 3 }).enabled },
    { text: 'Findings (3 rules)', enabled: true });
  assert.equal(reviewButtonState({ status: 'READY', ruleCount: 1 }).text, 'Findings (1 rule)');
});

test('a finished review that checked no documented rules shows no count', () => {
  const s = reviewButtonState({ status: 'READY', ruleCount: 0 });
  assert.equal(s.text, 'Findings');
  assert.equal(s.enabled, true);
  assert.match(s.title, /No documented rules were checked/);
});

test('only the rules shown are counted, and nothing is said of what could not be checked', () => {
  const s = reviewButtonState({ status: 'READY', ruleCount: 3, unreadCount: 2, notRecheckedCount: 4 });
  assert.equal(s.text, 'Findings (3 rules)');
  assert.equal(s.title, 'Open the architecture review');
});

test('a doc edit that retired or restored rules is mentioned, and changes nothing else', () => {
  const { docRuleChangesText } = require('../src/review-state-utils.js');
  const plain = reviewButtonState({ status: 'READY', ruleCount: 3 });
  const changed = reviewButtonState({ status: 'READY', ruleCount: 3, retiredCount: 2 });
  assert.equal(changed.text, plain.text);
  assert.equal(changed.enabled, plain.enabled);
  assert.equal(changed.title, 'Open the architecture review. A doc edit retired 2 documented rules.');
  const noRules = reviewButtonState({ status: 'READY', ruleCount: 0, restoredCount: 1 });
  assert.equal(noRules.text, 'Findings');
  assert.equal(noRules.title,
    'Open the architecture review. No documented rules were checked against this change. A doc edit restored 1 documented rule.');
  const both = reviewButtonState({ status: 'READY', ruleCount: 3, retiredCount: 1, restoredCount: 2 });
  assert.equal(both.text, 'Findings (3 rules)');
  assert.equal(both.title, 'Open the architecture review. A doc edit retired 1 documented rule and restored 2.');
  assert.equal(docRuleChangesText(0, 0), '');
  // Only a finished review has anything to open.
  assert.doesNotMatch(reviewButtonState({ status: 'PENDING', retiredCount: 2 }).title, /doc edit/);
});

test('a running review says so and cannot be opened', () => {
  const plain = reviewButtonState({ status: 'PENDING' });
  assert.equal(plain.text, 'Reading docs…');
  assert.equal(plain.enabled, false);
  assert.equal(plain.title, reviewProgressText(false));
  const firstRead = reviewButtonState({ status: 'RUNNING', warmup: true });
  assert.equal(firstRead.enabled, false);
  assert.match(firstRead.title, /for the first time/);
});

test('only a review still being read is busy, so only it spins', () => {
  // The spinner says "work is happening". Every state below is an outcome, including the two that
  // are disabled for other reasons -- a button that kept spinning on a failed or timed-out review
  // would promise a result that is never coming.
  for (const status of ['PENDING', 'RUNNING', 'pending']) {
    assert.equal(reviewButtonState({ status }).busy, true, status);
  }
  for (const status of ['READY', 'FAILED', 'TIMED_OUT', 'UNAVAILABLE', 'SKIPPED', null, '']) {
    assert.equal(reviewButtonState({ status, ruleCount: 2 }).busy, false, String(status));
  }
});

test('a failed review says it failed', () => {
  const s = reviewButtonState({ status: 'FAILED', reason: 'model timed out' });
  assert.equal(s.text, 'Review failed');
  assert.equal(s.enabled, false);
  assert.equal(s.title, 'model timed out');
});

test("a review that outlasted the wait says it didn't finish", () => {
  const s = reviewButtonState({ status: 'TIMED_OUT' });
  assert.equal(s.text, "Review didn't finish");
  assert.equal(s.enabled, false);
});

test('an unreadable review says it is unavailable', () => {
  const s = reviewButtonState({ status: 'UNAVAILABLE' });
  assert.equal(s.text, 'Review unavailable');
  assert.equal(s.enabled, false);
});

test('a skipped review, or none, says no review ran', () => {
  for (const status of ['SKIPPED', null, undefined, '']) {
    const s = reviewButtonState({ status, ruleCount: 4 });
    assert.equal(s.text, 'No review', String(status));
    assert.equal(s.enabled, false);
  }
  assert.equal(reviewButtonState({ status: 'SKIPPED', reason: 'too small to review' }).title, 'too small to review');
});

test('no state asks the user to start a review or claims a result that was not earned', () => {
  for (const status of ['READY', 'PENDING', 'RUNNING', 'FAILED', 'SKIPPED', 'TIMED_OUT', 'UNAVAILABLE', null]) {
    for (const ruleCount of [0, 2]) {
      const { text, title } = reviewButtonState({ status, ruleCount });
      assert.notEqual(text, 'AI Review', String(status));
      assert.doesNotMatch(`${text} ${title}`, /\b0\b|✓|✅|no issues|looks good|run .*review/i, `${status}/${ruleCount}`);
    }
  }
});

test('the wording for a running review says what is happening, and the first read takes minutes', () => {
  assert.match(reviewProgressText(false), /still running/);
  assert.match(reviewProgressText(true), /for the first time/);
  assert.match(reviewProgressText(true), /few minutes/);
  // Without the first-read hint, it does not promise a wait of minutes it has no basis for.
  assert.doesNotMatch(reviewProgressText(false), /minute/);
});

test('only PENDING and RUNNING count as a review in progress', () => {
  assert.equal(isReviewPending('pending'), true);
  assert.equal(isReviewPending('RUNNING'), true);
  for (const s of ['READY', 'FAILED', 'SKIPPED', null, '']) assert.equal(isReviewPending(s), false);
});
