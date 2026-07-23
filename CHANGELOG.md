# Changelog

## Unreleased

- Architecture Review panel no longer falls back to rendering raw detector findings when no review
  items surface. The API now treats deterministic facts as the sole origin of user-visible items
  (striff-api ADR-022), so an empty list is a real "nothing to flag" result; the findings array
  carries every detector regardless of surfacing tier, and rendering it made the panel disagree
  with the GitHub check run on the same PR.
- Doc conflicts are now shown as such in the panel: their own badge and colour instead of a
  severity tint, the contradicted document names listed, and sorted ahead of other items.

## 1.0.3

- Hardened production packaging checks so dev-only overrides fail the build if they are not stripped.
- Added a `chrome.storage.session` shim path for non-Chromium environments.
- Consolidated cache-clearing behavior across popup, options, background, and content-script flows.
- Added usage-data opt-out in the popup and documented the telemetry surface more explicitly.
- Tightened old-review comment submission behavior and review-draft formatting for embedded subdiagrams.
