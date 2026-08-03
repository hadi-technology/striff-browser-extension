# Changelog

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
