# Changelog

## 1.3.0

- Cursor project rules (`.cursor/rules/*.mdc`) count as documentation in the file list the extension
  falls back to when the API's own list cannot be fetched, so a repository's rules for its coding agent
  still reach the analysis. The API's list is used whenever it is available.

## 1.2.0

- The "first analysis takes a few minutes" notice is gone. The Striffs button's loading state shows
  a load in progress, so the only notices a load shows are errors.
- The review panel no longer has a Structural Checks section. The analysis no longer runs
  structural detector checks; the panel shows the review summary, the review items and the
  documented rules. A response from an older API that still carries detector findings renders the
  same panel, with the findings ignored. When nothing is raised, the panel no longer says
  "Everything looks good": if no documented rule was checked, it says so.
- The architecture review no longer has a button of its own to start it. Opening Striffs loads the
  diagram and its review together, and the diagram shows once, when the review is in. The button
  beside it then reads "Findings (N rules)" and opens the review panel, which is where the findings
  are: the documented-rule count no longer sits over the diagram. The first review of a repository
  reads its documents and can take several minutes, so after two and a half minutes the diagram
  shows anyway, the button reads "Reading docs…", and it enables itself when the review arrives. A
  review that failed, did not finish, or did not run says so on the button rather than showing an
  empty result.
- Documented rules the review could not check are no longer shown, in the panel or on the Findings
  button. The panel lists the rules this pull request breaks, restores, leaves holding, or finds
  already broken, and the button counts only those. A rule that could not be checked is never shown
  as holding.
- When a doc edit retires documented rules, or states them again, the review panel lists them under
  the doc that changed. It is a note, not a finding: the Findings button's count and result do not
  change, and its tooltip mentions the edit.
- A private repository no longer fails its first load with "Failed downloading base zip: Failed to
  download zip: 404". Whether a repository is private is now asked of GitHub rather than read off
  the page, whose signals can be missing after GitHub navigates in place: with a token the load goes
  straight to token-based generation, and without one it says a token is needed. A failed analysis
  request is always shown as a readable message, never as its raw error text.
- With the review panel open, the whole diagram can be scrolled into view. The panel covered the
  diagram's right edge, which could not be scrolled out from under it. The bottom row can also be
  scrolled clear of the zoom and download controls.
- The helpful/unhelpful buttons under review notes on the diagram are gone, along with the feedback
  they sent. The review's findings are in the Findings panel rather than drawn on the diagram.

## 1.1.0

- The wait for a first analysis is explained when it starts. The only notice appeared 30 seconds
  in and left 15 seconds later, so most of a wait measured in minutes had no explanation; it now
  shows as soon as the request goes to the server. The documented-rule review, which reads the
  repository's documents and is the slowest part, says it can take a few minutes -- and says
  plainly when striff-api reports it is reading a repository's documents for the first time.
- Clicking a top-level file such as README.md in the new /changes view no longer selects an
  unrelated component. That view gives each diff no path attribute, so the extension guessed the
  path from the longest path-like text in the diff; README.md's prose named
  `tradingagents/default_config.py`, its diff was filed under that path, and the click resolved to
  that file's component. The guess now comes last, and every file-to-diff pairing is checked
  against GitHub's own scheme -- the diff id is the SHA-256 of the path -- so a wrong one is dropped.
- A gateway error reads as one. While a deploy restarts the API, nginx answers 503 with an HTML
  page, and the extension printed that page, markup and all, into a toast. It now says Striffs is
  briefly unavailable and to try again in a minute.
- A GitHub token that stops working is reported. GitHub's 401 for an expired or revoked token was
  absorbed by the fallbacks behind every GitHub call, so the popup kept saying "Token saved" while
  nothing used it; the page now says the token was rejected and to update it. The token is also held
  closer: the background proxy forwards it only to `api.github.com` and `raw.githubusercontent.com`
  rather than to every host it is allowed to reach, and the github.com fallback that reads a file
  through the user's session no longer sends the token alongside the cookies.
- A slow first analysis is no longer sent twice. The page gave up on the background after 6
  minutes while the background kept polling for up to 15, and a timeout counts as retryable, so a
  long analysis re-downloaded and re-uploaded the repository and polled a second time beside the
  first. The page now waits as long as the background can (20 minutes). The 30-second notice no
  longer suggests a GitHub token -- public pull requests take the upload route either way, so a
  token does not speed them up -- and says instead that a first analysis takes a few minutes.
- The extension no longer prefetches. Every pull request page load, and every in-app navigation to
  another pull request, fired a background analysis request before anyone asked for a diagram -- a
  server-side fetch when a token was stored, otherwise a base-branch archive upload -- and its
  de-duplication key was built on an update time the page often could not supply, so the current
  time stood in and a single view could fire it more than once. With a token stored, a public pull
  request was prefetched on the token route while the real request went through the upload route,
  whose results are keyed separately, so that work was never read. Requests now go out only when
  the extension needs a diagram to show. striff-api drops the matching prefetch endpoints; 1.0.x
  clients that still call them catch the error and log a console warning.
- "Create one here" opens a fine-grained token already filled in: named Striffs, read-only
  Contents and Pull requests, 364 days. The link used to open a blank form and leave the
  permissions to the user; the only choice left is "All repositories". Not a classic token, whose
  `repo` scope grants write access to every private repository.
- Clearing the token also clears cached diagrams, in storage and in open pull request tabs. A
  private repository's diagram can only have been produced with the token, and it stayed on screen
  for up to a day after the user had taken the extension's access away.
- Uploads send `Prefer: respond-async` and poll the job the API answers with. The API now holds a
  request that does not ask for it until the analysis finishes, which is how 1.0.x -- which cannot
  poll, and since 2026-08-23 had read the 202 job as a result and shown "missing striffs array" on
  every first analysis -- works again without an update.
- Connecting a GitHub token no longer puts a cold analysis on the slower path. Public pull
  requests now go through the queued, polled upload route regardless of whether a token is stored;
  the token GET held a socket open for the whole analysis, measured at 177-483 seconds against a
  180-second budget, so it could expire before the server finished. The token still carries private
  repositories, changed-file metadata read from the API rather than scraped from the page, and the
  fallback when an upload is refused for size.
- A pull request too large for the upload path now offers to connect a GitHub token. The refusal
  the API actually returns was matched by neither arm of the check, so the one case a token fixes
  reported a bare "API request failed 413" and offered nothing.
- An architecture review that ends without being authorised now says so and stops, instead of
  retrying the same rejected request every five seconds until it times out.
- `[Striffs]` warnings for conditions the extension already handled - a remote config that did not
  answer, a cache read that fell back - no longer appear in the console unless debug logging is on.

- Documented rules render from the status the server actually sends. The panel had been splitting
  rows on a `tier` the API stopped sending and checking for a `RAISED` status it stopped producing,
  so every row — violations included — displayed as "nothing stood out". One list now, matching the
  server's single vocabulary: violated, maintained, unclear. Unclear keeps its own rendering rather
  than folding into maintained, because an abstention shown as a clean bill of health is the failure
  this section can least afford.

- The enrichment poll waits 5 minutes instead of 2 before giving up. striff-api raised its review
  budgets (`augmentation-timeout-seconds` 300 → 900, agent timeout 120 → 300) and now runs the
  review call at high reasoning effort, so the old ceiling fired on reviews that were merely slow
  rather than broken. Giving up is also no longer reported as a failure: the server keeps working
  past the point we stop watching, so the message now says the review is still running and to
  reload to pick it up. The duration is derived from the constant instead of written into the
  message, which is how it drifted out of sync in the first place.
- The review panel shows the deterministic check roster it was previously only summarising. All 12
  structural checks render with their outcome — flagged, observed, or clean — so "nothing surfaced"
  is legible as the result of twelve checks rather than an unexplained verdict. Findings held below
  the surfacing gate appear as observation rows, matching what the GitHub check run says about the
  same finding, and are still never promoted into review items.
- The panel renders the Documented Rules section: statements extracted from the repository's own
  docs, with pass/fail on the deterministically checked ones and deliberately no pass/fail on the
  advisory ones. An advisory row is the model's reading of something nothing verified, so a green
  tick against one would tell a reviewer their invariant was checked when nothing checked it. The
  section is absent entirely when no statements were checked. Requires the striff-api change that
  puts `docFactVerdicts` on the review-status response.
- The review panel no longer claims a clean pass it cannot support. Detectors that fired but were
  held below the surfacing gate are still evidence, and "No architectural concerns were found"
  asserts the detectors found nothing — a different claim from "nothing met the bar to show you".
  When findings exist but none surfaced, the panel now says so and gives the count. Those findings
  are still not rendered as items; counting them is what keeps the panel from contradicting the
  GitHub check run, which draws the same distinction (striff-api `AIReviewResultMapper`). A result
  where no review ran at all now says so instead of reporting a clean pass.
- The Architecture Review panel has automated coverage for the first time (`npm run test:panel`).
  It loads the real content script into a browser DOM and asserts what the panel *claims* for each
  payload shape, since the failure mode that matters is stating something the analysis did not
  establish, not a broken layout. Needs a browser but no network and no GitHub login. The live
  smoke test additionally asserts the overview and both tables against a real API response,
  including that the overview is a model-written account rather than the old counts placeholder.

## 1.0.6

- The packaged manifest no longer includes the dev-only `http://localhost:*/*` host permission —
  it existed only for local API development, and the Chrome Web Store rejects manifests that
  contain it.
- Attaching a subdiagram to a review that already contained one no longer duplicates the
  `**Context:**` line. The attach-confirmation checks matched *any* image markdown, asset URL, or
  upload node in the draft/form — all left behind by the first attach (and the classic UI's
  dropzone carries `.js-upload-markdown-image` permanently) — so the second attach was "confirmed"
  instantly, before its upload landed, and the layout pass appended a context line with no diagram
  above it. All signals are now deltas against the pre-attach state. A retry after a genuinely
  failed attach also reuses the orphaned context line instead of stacking a twin.

## 1.0.5

- The comment panel's "Start review" button is guarded for the whole submit flow — spam-clicking
  while GitHub's review dialog was being opened appended a duplicate context block and diagram to
  the draft for every extra click. The button now disables and shows "Opening review…" until the
  flow finishes or fails.
- Soft-navigating between PRs no longer carries the previous PR's state along: the in-memory
  diagram, component maps, and the toolbar button's green success check are all cleared on a PR
  change, so a newly opened PR primes from its own cache instead of flashing the old PR's diagram.
- Prefetch no longer skips silently when GitHub's PR-state markup isn't recognized. State
  detection moved to the shared metadata module, reads the embedded React payload first, scopes
  badge lookups to the PR header (timeline badges from cross-referenced merged PRs previously
  misclassified an open PR as merged), and an unknown state now allows prefetch — only a
  definitive merged/closed skips.
- Subdiagram previews survive XML-illegal characters in the rendered SVG (control bytes leaking
  from doc text became `&#8;`-style references that truncated the strict parse to a bare green
  class box). SVGs are sanitized at receipt, and the preview renders through the same
  parse-fallback and XSS sanitizer as the main diagram. Server-side companion fix in
  striff-api#64.
- "View Striff" no longer resurfaces inside unrelated menus (e.g. the reviewers list on the
  conversation tab): GitHub reuses dropdown portals across SPA navigation, so injected buttons
  are now swept on route changes and re-injected only into verified file menus.
- Generation status words no longer reference code internals ("Parsing AST" → "Analyzing
  Changes", etc.), and the diagram guide button links to the coupling-metrics explainer.

## 1.0.4

- Architecture Review panel no longer falls back to rendering raw detector findings when no review
  items surface. The API now treats deterministic facts as the sole origin of user-visible items
  (striff-api ADR-022), so an empty list is a real "nothing to flag" result; the findings array
  carries every detector regardless of surfacing tier, and rendering it made the panel disagree
  with the GitHub check run on the same PR.
- Doc conflicts are now shown as such in the panel: their own badge and colour instead of a
  severity tint, the contradicted document names listed, and sorted ahead of other items.
- Attaching several subdiagrams to one unsubmitted review now stacks clean `image` →
  `**Context:**` pairs. Previously each attach rebuilt the whole draft around the first image it
  found, so the second attach detached context #1 from its image and clumped the images together;
  the layout pass is now local to the image that was just uploaded.
- The review composer is found on GitHub's new `/changes` UI (Primer `MarkdownEditor`), and the
  subdiagram uploads there via a full drag-and-drop handshake — that composer has no file input,
  so the previous single synthetic `drop` never attached anything.
- "Start review" no longer matches Striffs' own panel button, and reports "Sign in to GitHub to
  start a review" when the viewer is signed out instead of a misleading "couldn't open the review
  text box".

## 1.0.3

- Hardened production packaging checks so dev-only overrides fail the build if they are not stripped.
- Added a `chrome.storage.session` shim path for non-Chromium environments.
- Consolidated cache-clearing behavior across popup, options, background, and content-script flows.
- Added usage-data opt-out in the popup and documented the telemetry surface more explicitly.
- Tightened old-review comment submission behavior and review-draft formatting for embedded subdiagrams.
