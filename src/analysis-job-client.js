// analysis-job-client.js — submit an analysis and wait for it, without holding a request open.
//
// The API used to analyse on the request thread. That took 177-483s against a server that runs one
// analysis per pod, so a second caller queued behind an admission gate that waited four minutes and
// then refused: a guaranteed failure, delivered as slowly as possible, with a socket held open the
// whole time.
//
// It now answers 200 when the analysis already exists and 202 with a job to poll when it does not.
// Both are success; this module hides the difference from callers, which care about the analysis
// rather than about which way it arrived.
(function (root) {
  'use strict';

  // Floors only. The server sends pollAfterMs and it is authoritative -- it knows what an analysis
  // costs and can change it without shipping a new extension. These stop a bad or missing value
  // turning the loop into a hot spin against a rate limiter.
  const MIN_POLL_INTERVAL_MS = 1000;
  const DEFAULT_POLL_INTERVAL_MS = 3000;
  const MAX_POLL_INTERVAL_MS = 15000;

  // Longer than the slowest analysis measured (483s) with room for queue time, because the wait is
  // now a queue wait as well as an analysis. A client that gives up early leaves the analysis
  // running and pays for it again on the next attempt.
  const DEFAULT_TOTAL_WAIT_MS = 900000;

  function clampInterval(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_POLL_INTERVAL_MS;
    return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, n));
  }

  function absoluteStatusUrl(apiBase, statusUrl) {
    const path = String(statusUrl || '');
    if (/^https?:\/\//i.test(path)) return path;
    return String(apiBase || '').replace(/\/+$/, '') + (path.startsWith('/') ? path : '/' + path);
  }

  /**
   * Poll a submitted job until it resolves.
   *
   * Returns { ok: true, json } with the analysis, or { ok: false, error, errorCode, status }.
   */
  async function awaitAnalysisJob(accepted, apiBase, {
    fetchImpl,
    sleepImpl,
    nowImpl,
    totalWaitMs = DEFAULT_TOTAL_WAIT_MS,
    pollTimeoutMs = 20000,
    abortableTimeout
  } = {}) {
    const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    const sleep = sleepImpl || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const now = nowImpl || Date.now;

    // Checked BEFORE resolving, not after. absoluteStatusUrl turns a missing path into the API
    // base itself, which is a perfectly non-empty string -- so a guard on the resolved value passes
    // and the loop then polls the API root every few seconds for the whole budget. Found by the
    // test below rather than by reading it.
    if (!accepted || !accepted.jobId || !accepted.statusUrl) {
      return { ok: false, error: 'The server accepted the analysis but did not say where to collect it.' };
    }
    const statusUrl = absoluteStatusUrl(apiBase, accepted.statusUrl);

    let interval = clampInterval(accepted.pollAfterMs);
    const deadline = now() + totalWaitMs;
    let consecutiveTransportErrors = 0;

    while (now() < deadline) {
      await sleep(interval);

      let res;
      try {
        const t = abortableTimeout ? abortableTimeout(pollTimeoutMs) : null;
        try {
          res = await doFetch(statusUrl, t ? { signal: t.signal } : undefined);
        } finally {
          if (t) t.cancel();
        }
      } catch (e) {
        // A dropped poll is not a failed analysis -- the work continues on the server. Back off
        // and keep asking; only give up when the whole budget is gone.
        consecutiveTransportErrors += 1;
        if (consecutiveTransportErrors >= 5) {
          return { ok: false, error: `Lost contact while waiting for the analysis: ${String(e?.message || e)}` };
        }
        interval = clampInterval(interval * 2);
        continue;
      }
      consecutiveTransportErrors = 0;

      if (res.status === 429) {
        // Backing off rather than failing: the analysis is still running, and giving up here
        // would abandon work that is nearly done.
        interval = clampInterval(interval * 2);
        continue;
      }
      if (!res.ok) {
        // 404 means the job is gone -- expired, or never existed. Retrying cannot bring it back.
        return {
          ok: false,
          status: res.status,
          error: res.status === 404
            ? 'The analysis is no longer available on the server. Try again.'
            : `The server could not report on the analysis (HTTP ${res.status}).`
        };
      }

      let body;
      try {
        body = await res.json();
      } catch (e) {
        return { ok: false, error: 'The server sent an unreadable status for the analysis.' };
      }

      if (body.status === 'READY') {
        if (!body.result) {
          // "Finished, and here is nothing" is the one answer that must not be treated as an empty
          // analysis: an empty diagram reads to a user exactly like a change with no structure.
          return { ok: false, errorCode: 'RESULT_UNAVAILABLE', error: 'The analysis finished but returned no result.' };
        }
        return { ok: true, json: body.result };
      }
      if (body.status === 'FAILED') {
        return {
          ok: false,
          errorCode: body.errorCode || 'ANALYSIS_FAILED',
          error: body.errorMessage || 'The analysis could not be completed.'
        };
      }

      // QUEUED or RUNNING. The server restates how long to wait each time, so it can slow clients
      // down under load without shipping anything.
      interval = clampInterval(body.pollAfterMs || interval);
    }

    // The job is still running server-side. Saying so matters: the next attempt is deduplicated
    // onto the same analysis rather than starting another, so retrying is cheap and correct.
    return {
      ok: false,
      errorCode: 'ANALYSIS_STILL_RUNNING',
      error: 'The analysis is taking longer than expected. It is still running -- try again shortly.'
    };
  }

  const api = {
    MIN_POLL_INTERVAL_MS,
    DEFAULT_POLL_INTERVAL_MS,
    MAX_POLL_INTERVAL_MS,
    DEFAULT_TOTAL_WAIT_MS,
    clampInterval,
    absoluteStatusUrl,
    awaitAnalysisJob
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.StriffsAnalysisJobClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
