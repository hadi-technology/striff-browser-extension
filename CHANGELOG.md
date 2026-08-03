# Changelog

## Unreleased

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
