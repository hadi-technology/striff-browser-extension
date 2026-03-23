# Striffs GitHub Extension

A cross-browser GitHub extension that adds a **"Striffs"** tab to pull request pages. This tab displays architectural diffs as interactive SVG diagrams, making code review more transparent and insightful.

---

## ✨ Features
- Detects GitHub PR pages automatically
- Adds a new `Striffs` tab next to "Conversation", "Commits", and "Files changed"
- Displays zoomable, pannable SVG diagrams
- Supports GitHub tokens for private repo access

---

## 🧰 Setup

1. **Install the extension in development mode:**
   - Chrome: `chrome://extensions` → Enable dev mode → "Load unpacked"
   - Firefox: `about:debugging` → "Load Temporary Add-on"
   - Edge: `edge://extensions` → Enable dev mode → "Load unpacked"
   - Safari: Use Xcode with `safari-web-extension-converter`

2. **Configure GitHub Token:**
   - Go to extension options (`chrome://extensions > Striffs > Details > Options`)
   - Paste your GitHub token to allow access to private repos
---

## 📦 Folder Structure

```
StriffsExtension/
├── manifest.json
├── background.js
├── content-script.js
├── options.html
├── popup.html
├── panzoom.min.js
└── README.md
```

---

## 🔒 Permissions
| Permission        | Reason                                       |
|------------------|----------------------------------------------|
| `storage`        | Store GitHub token                           |
| `host_permissions` | GitHub domains + `codeload.github.com`     |

---

## 🛠 Future Improvements
- Diagram grouping by language
- SVG download/export button
- Retry/backoff logic for failed requests

---

## ✅ Test Commands

- `npm test`
  - Runs the stable local suite: unit tests, background telemetry tests, result-contract tests, and a deterministic Playwright UI harness against a local PR fixture.
- `npm run test:live`
  - Runs the live GitHub smoke (`test/manual-smoke-live.js`). This is intentionally separate because it depends on GitHub UI, remote config, and a running backend.

---

## ✅ Manual Smoke Test Coverage

The manual Playwright smoke test (`test/manual-smoke-live.js`) validates observable behavior only:

1. **Remote config behavior**
   - Bad/unreachable config does **not** disable the Striffs button
   - Test config disables Striffs (button disabled, greyed out, tooltip matches)
   - Production config re-enables Striffs

2. **Buttons & mounting**
   - Striffs/Diffs buttons render on PR Files tab
   - Toolbar slot is present

3. **Failure phase**
   - With a bad API base, Striffs shows an error state

4. **Normal flow**
   - Striffs view renders and is visible
   - File tree availability reflects Striffs mapping
   - Clicking a known component navigates to the expected diff hash
   - Clicking any diagram entity switches to diffs view
   - Resize keeps diagram visible
   - Diffs view toggles and content is visible

5. **Mapping integrity**
   - Path→component map size > 0
   - Component→file map size > 0
   - DiffId→component map size > 0

6. **Reload & cache behavior**
   - Buttons persist after reload
   - Striffs renders after reload
   - If a cached diagram exists, the test validates it reports a cache hit

7. **Navigation**
   - Striffs/Diffs buttons are hidden on the conversation tab

### Optional override for component hash test
You can override the specific component/hash assertions with:

```
CLICK_COMPONENT=... CLICK_DIFF_ID=... node test/manual-smoke-live.js
```

---

## 📬 Feedback
Submit suggestions or bugs at [striff.io](https://striff.io)

---

© 2026 Hadii Technologies — All rights reserved.
