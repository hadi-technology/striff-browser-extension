# Changelog

## 1.0.3

- Hardened production packaging checks so dev-only overrides fail the build if they are not stripped.
- Added a `chrome.storage.session` shim path for non-Chromium environments.
- Consolidated cache-clearing behavior across popup, options, background, and content-script flows.
- Added usage-data opt-out in the popup and documented the telemetry surface more explicitly.
- Tightened old-review comment submission behavior and review-draft formatting for embedded subdiagrams.
