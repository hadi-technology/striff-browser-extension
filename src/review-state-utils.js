// The architecture review that arrives with a diagram: reading its status, and what the page says
// about it. Pure -- no DOM, no extension APIs -- so it is unit-tested directly
// (test/review-state-utils.test.js). The content script passes in what touches the outside world (the
// status fetch, the clock, the sleep) and owns everything that touches the page.
//
// Wrapped because content scripts share one global scope: a top-level const here would collide with
// the same name in another script.
(function (root) {
  const PENDING_STATUSES = new Set(['PENDING', 'RUNNING']);
  const DEFAULT_POLL_DELAY_MS = 5000;
  const MIN_POLL_DELAY_MS = 1000;

  const WARMUP_TEXT = "Reading this repository's documents for the first time. This review takes a few minutes.";

  const normalizeStatus = (value) => String(value || '').trim().toUpperCase();

  const isReviewPending = (status) => PENDING_STATUSES.has(normalizeStatus(status));

  const pollDelay = (pollAfterMs) => {
    const n = Number(pollAfterMs);
    return Number.isFinite(n) && n > 0 ? Math.max(MIN_POLL_DELAY_MS, n) : DEFAULT_POLL_DELAY_MS;
  };

  // What the findings button says while a review is running. A load never waits for the review, so
  // this is the only place a running review is reported. The server says when it has not read this
  // repository's documents yet, which is the case that takes minutes rather than seconds; only some
  // responses carry that hint, so without it the wording promises no particular length of wait.
  const reviewProgressText = (warmup) => (warmup === true
    ? WARMUP_TEXT
    : 'The architecture review is still running. Its findings will appear here when it finishes.');

  // Documented rules a doc edit retired or restored: news for the tooltip, not a verdict. Empty when
  // nothing changed.
  const docRuleChangesText = (retired = 0, restored = 0) => {
    const r = Math.max(0, Math.floor(Number(retired) || 0));
    const s = Math.max(0, Math.floor(Number(restored) || 0));
    const rules = (n) => `${n} documented rule${n === 1 ? '' : 's'}`;
    if (r > 0 && s > 0) return `A doc edit retired ${rules(r)} and restored ${s}`;
    if (r > 0) return `A doc edit retired ${rules(r)}`;
    return s > 0 ? `A doc edit restored ${rules(s)}` : '';
  };

  /**
   * Reads the review the server started with an analysis until it finishes, the deadline passes, or
   * the caller stops caring. It only ever reads the review's status: the server starts the review
   * with every analysis, so there is nothing to request.
   *
   * Resolves to { status, result }:
   *   READY / FAILED / SKIPPED  the review ended; result is the payload that says so.
   *   PENDING      still running at the deadline; result is the last status payload, if any.
   *   UNAVAILABLE  the status cannot be read for this operation (the server refused the token), and
   *                asking again will not change that.
   *   CANCELLED    isCurrent() turned false: the page moved on, so nobody wants the answer.
   * A status this code does not know resolves as FAILED, never as something to wait on or as a pass.
   * A request that fails for any other reason is tried again at the same pace until the deadline.
   */
  async function collectReview({ fetchStatus, sleep, now, deadline, isCurrent = () => true }) {
    let last = null;
    let delayMs = DEFAULT_POLL_DELAY_MS;
    for (;;) {
      if (!isCurrent()) return { status: 'CANCELLED', result: last };
      const resp = await fetchStatus();
      if (!isCurrent()) return { status: 'CANCELLED', result: last };
      if (resp?.ok) {
        const result = resp.json || {};
        const status = normalizeStatus(result.aiReviewStatus);
        if (status === 'READY' || status === 'FAILED') return { status, result };
        if (status === 'SKIPPED' || status === 'NOT_REQUESTED') return { status: 'SKIPPED', result };
        if (!PENDING_STATUSES.has(status)) {
          return {
            status: 'FAILED',
            result: {
              ...result,
              aiReviewErrorMessage: result.aiReviewErrorMessage
                || `The review returned a status this extension does not recognise (${status || 'none'}).`
            }
          };
        }
        last = result;
        delayMs = pollDelay(result.aiReviewPollAfterMs);
      } else if (Number(resp?.status) === 403) {
        return { status: 'UNAVAILABLE', result: last };
      }
      const remaining = deadline - now();
      if (remaining <= 0) return { status: 'PENDING', result: last };
      await sleep(Math.min(delayMs, remaining));
    }
  }

  /**
   * The payload to render once the review has been read: the analysis payload with the review's
   * fields laid over it. The status response carries the review-complete diagram and the review, but
   * not everything the analysis response does (the warm-up hint, for one), and it sends absent fields
   * as null -- so only values it actually carries replace the analysis's, and its diagrams only when
   * it has some.
   */
  function mergeReviewResult(analysis, review) {
    const merged = { ...(analysis || {}) };
    for (const [key, value] of Object.entries(review || {})) {
      if (value === null || value === undefined) continue;
      if (key === 'striffs' && !(Array.isArray(value) && value.length > 0)) continue;
      merged[key] = value;
    }
    return merged;
  }

  /**
   * What the findings button says for a review state. It opens only onto a review that finished;
   * every other state says in the label itself why there is nothing to open. None of them may read as
   * a clean result: a count appears only beside a finished review that checked documented rules, it
   * counts rules rather than problems, and it is never zero.
   *
   * status is the server's review status, or one of the two this extension records itself:
   * TIMED_OUT (it stopped waiting) and UNAVAILABLE (it could not read the review).
   *
   * `busy` marks the one state that is still going somewhere -- a review being read right now --
   * which the button shows as a spinner. It is decided here rather than in the DOM so that "still
   * running" has one definition, the same one `isReviewPending` uses. Every other state is an
   * outcome: disabled and busy are not the same thing, and a failed review must not keep spinning.
   */
  function reviewButtonState({ status, ruleCount = 0, retiredCount = 0, restoredCount = 0, warmup = false, reason = null } = {}) {
    const s = normalizeStatus(status);
    const why = String(reason || '').trim();
    if (s === 'READY') {
      // Counts the rules the panel shows. What the review could not check is neither shown nor counted.
      const n = Math.max(0, Math.floor(Number(ruleCount) || 0));
      const base = n > 0
        ? 'Open the architecture review'
        : 'Open the architecture review. No documented rules were checked against this change.';
      // A doc edit that retired or restored rules is mentioned, and changes nothing else: not the
      // label, and not whether the result reads as clean.
      const changes = docRuleChangesText(retiredCount, restoredCount);
      const title = changes ? `${base.replace(/\.?$/, '.')} ${changes}.` : base;
      return { text: n > 0 ? `Findings (${n} rule${n === 1 ? '' : 's'})` : 'Findings', enabled: true, busy: false, title };
    }
    if (PENDING_STATUSES.has(s)) {
      return { text: 'Reading docs…', enabled: false, busy: true, title: reviewProgressText(warmup) };
    }
    if (s === 'FAILED') {
      return { text: 'Review failed', enabled: false, busy: false, title: why || 'The architecture review failed. The diagram is still available.' };
    }
    if (s === 'TIMED_OUT') {
      return { text: "Review didn't finish", enabled: false, busy: false, title: 'The review is still running on the server. Reload the page to pick it up once it finishes.' };
    }
    if (s === 'UNAVAILABLE') {
      return { text: 'Review unavailable', enabled: false, busy: false, title: why || 'The architecture review for this analysis could not be read. Reload the page to try again.' };
    }
    // SKIPPED, or no review at all.
    return { text: 'No review', enabled: false, busy: false, title: why || 'No architecture review ran for this pull request.' };
  }

  const api = {
    isReviewPending,
    collectReview,
    mergeReviewResult,
    reviewButtonState,
    reviewProgressText,
    docRuleChangesText
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.StriffsReviewStateUtils = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : null);
