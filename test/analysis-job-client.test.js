const test = require('node:test');
const assert = require('node:assert/strict');

const client = require('../src/analysis-job-client.js');

// A clock and a sleep that do not actually wait, so a test can cover a fifteen-minute budget in
// microseconds. Real timers here would make the suite either slow or flaky.
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    advance: (ms) => { t += ms; }
  };
}

function respondingWith(...responses) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url) => {
    calls.push(url);
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (typeof next === 'function') return next();
    return next;
  };
  return { fetchImpl, calls };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const ACCEPTED = { jobId: 'job-1', status: 'QUEUED', statusUrl: '/api/v1/github/striffs/jobs/job-1', pollAfterMs: 3000 };

test('a queued analysis is waited out and its result returned', async () => {
  const clock = fakeClock();
  const { fetchImpl, calls } = respondingWith(
    jsonResponse({ status: 'QUEUED', pollAfterMs: 3000 }),
    jsonResponse({ status: 'RUNNING', pollAfterMs: 3000 }),
    jsonResponse({ status: 'READY', result: { operationId: 'op-1', striffs: [] } })
  );

  const result = await client.awaitAnalysisJob(ACCEPTED, 'https://api.striff.io', {
    fetchImpl, sleepImpl: clock.sleep, nowImpl: clock.now
  });

  assert.equal(result.ok, true);
  assert.equal(result.json.operationId, 'op-1');
  assert.equal(calls[0], 'https://api.striff.io/api/v1/github/striffs/jobs/job-1');
});

test('a failed analysis surfaces the reason rather than a generic error', async () => {
  const clock = fakeClock();
  const { fetchImpl } = respondingWith(
    jsonResponse({ status: 'FAILED', errorCode: 'TOO_MANY_CHANGES', errorMessage: '80 changed files, above the 50 this endpoint analyses.' })
  );

  const result = await client.awaitAnalysisJob(ACCEPTED, 'https://api.striff.io', {
    fetchImpl, sleepImpl: clock.sleep, nowImpl: clock.now
  });

  // Told only "failed", the extension can neither retry intelligently nor tell the user anything.
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'TOO_MANY_CHANGES');
  assert.match(result.error, /50/);
});

test('READY with no result is a failure, not an empty analysis', async () => {
  const clock = fakeClock();
  const { fetchImpl } = respondingWith(jsonResponse({ status: 'READY' }));

  const result = await client.awaitAnalysisJob(ACCEPTED, 'https://api.striff.io', {
    fetchImpl, sleepImpl: clock.sleep, nowImpl: clock.now
  });

  // An empty diagram reads to a user exactly like a change with no structure in it.
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'RESULT_UNAVAILABLE');
});

test('a dropped poll does not abandon an analysis that is still running', async () => {
  const clock = fakeClock();
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call <= 2) throw new Error('network hiccup');
    return jsonResponse({ status: 'READY', result: { operationId: 'op-2' } });
  };

  const result = await client.awaitAnalysisJob(ACCEPTED, 'https://api.striff.io', {
    fetchImpl, sleepImpl: clock.sleep, nowImpl: clock.now
  });

  // The work continues on the server; giving up on the first dropped packet would throw it away.
  assert.equal(result.ok, true);
  assert.equal(result.json.operationId, 'op-2');
});

test('persistent transport failure gives up rather than spinning to the deadline', async () => {
  const clock = fakeClock();
  const fetchImpl = async () => { throw new Error('offline'); };

  const result = await client.awaitAnalysisJob(ACCEPTED, 'https://api.striff.io', {
    fetchImpl, sleepImpl: clock.sleep, nowImpl: clock.now
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /Lost contact/);
});

test('a rate-limited poll backs off instead of failing', async () => {
  const clock = fakeClock();
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call === 1) return { ok: false, status: 429, json: async () => ({}) };
    return jsonResponse({ status: 'READY', result: { operationId: 'op-3' } });
  };

  const result = await client.awaitAnalysisJob(ACCEPTED, 'https://api.striff.io', {
    fetchImpl, sleepImpl: clock.sleep, nowImpl: clock.now
  });

  // The analysis is still running; a 429 while collecting it must not throw the work away.
  assert.equal(result.ok, true);
  assert.equal(result.json.operationId, 'op-3');
});

test('a job the server no longer has is reported as gone rather than retried', async () => {
  const clock = fakeClock();
  const { fetchImpl } = respondingWith({ ok: false, status: 404, json: async () => ({}) });

  const result = await client.awaitAnalysisJob(ACCEPTED, 'https://api.striff.io', {
    fetchImpl, sleepImpl: clock.sleep, nowImpl: clock.now
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});

test('running out of patience says the analysis is still running', async () => {
  const clock = fakeClock();
  const { fetchImpl } = respondingWith(jsonResponse({ status: 'RUNNING', pollAfterMs: 3000 }));

  const result = await client.awaitAnalysisJob(ACCEPTED, 'https://api.striff.io', {
    fetchImpl, sleepImpl: clock.sleep, nowImpl: clock.now, totalWaitMs: 30000
  });

  // The next attempt is deduplicated onto the same analysis server-side, so "try again" is cheap
  // and correct advice -- which it would not be if this read as a hard failure.
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'ANALYSIS_STILL_RUNNING');
});

test('the server decides the poll interval, within floors the client keeps', () => {
  assert.equal(client.clampInterval(5000), 5000);
  // A missing or nonsense value must not become a hot loop against a rate limiter.
  assert.equal(client.clampInterval(0), client.DEFAULT_POLL_INTERVAL_MS);
  assert.equal(client.clampInterval(undefined), client.DEFAULT_POLL_INTERVAL_MS);
  assert.equal(client.clampInterval(-1), client.DEFAULT_POLL_INTERVAL_MS);
  assert.equal(client.clampInterval(5), client.MIN_POLL_INTERVAL_MS);
  assert.equal(client.clampInterval(10 ** 9), client.MAX_POLL_INTERVAL_MS);
});

test('a relative statusUrl resolves against the API base, an absolute one is left alone', () => {
  assert.equal(
    client.absoluteStatusUrl('https://api.striff.io/', '/api/v1/github/striffs/jobs/x'),
    'https://api.striff.io/api/v1/github/striffs/jobs/x');
  assert.equal(
    client.absoluteStatusUrl('https://api.striff.io', 'https://elsewhere/jobs/x'),
    'https://elsewhere/jobs/x');
});

test('an acceptance with nowhere to poll fails immediately', async () => {
  const result = await client.awaitAnalysisJob({ jobId: 'j' }, 'https://api.striff.io', {
    fetchImpl: async () => { throw new Error('should not be called'); }
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /where to collect/);
});

test('the default budget outlasts the slowest measured analysis', () => {
  // 483s was the slowest that completed, and the wait is now a queue wait as well. Giving up early
  // leaves the analysis running and pays for it again next time.
  assert.ok(client.DEFAULT_TOTAL_WAIT_MS > 483000);
});
