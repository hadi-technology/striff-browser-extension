# Changelog

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
