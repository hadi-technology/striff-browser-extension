# Striffs for GitHub

> **Install from the Chrome Web Store**: [Striffs for GitHub](https://chromewebstore.google.com/detail/striffs-for-github/gcbcjajnjbplgkhnbemlkadgnjnfjoen)

Browser extension that adds a `Striffs` view to GitHub pull request pages and renders architecture-aware SVG diffs from the Striff API.

https://youtu.be/gte1iFYRN88

## Features

- **Architecture-aware diffs**: Visualize code changes as interactive diagrams
- **Multi-phase loading**: Animated progress indicator with status updates
- **AI review notes**: Inline AI-generated code review feedback with helpful/unhelpful voting
- **Smart caching**: Response caching for faster repeat PR loads
- **Custom icons**: GitHub logo for diffs, Striffs node-graph icon for striffs

## Loading States

The Striffs button shows animated states during processing:

| Phase | Behavior |
|-------|----------|
| **Analyzing** | Scanning PR files and changes |
| **Fetching** | Downloading file content from GitHub |
| **Generating** | Rotating Striffs-specific progress copy while the diagram is prepared |
| **Enriching** | Adding metadata and relationships |

A horizontal shine effect animates across the loading text, and a progress bar appears under the button during generation.

## Development

Load the repo root as an unpacked MV3 extension in Chromium-based browsers.

- Chrome: `chrome://extensions`
- Edge: `edge://extensions`
- Chromium: `chrome://extensions`

The packaged extension targets `https://api.striff.io`.
For local development, the unpacked extension defaults to `http://localhost:8080`.

### Configuration

Open the extension options to configure:

- **GitHub Token**: Optional, used for private repository access and token-backed API requests
- **Clear Cache**: Removes cached diagrams and local Striffs state
- **Send Usage Data**: Popup toggle for engagement and review interaction events

## Runtime Layout

```text
manifest.json
html/
  options.html      # Extension settings page
  options.js
  popup.html        # Browser action popup
  popup.js
  shared.js
icons/
  striff.svg        # Colored node-graph icon
  striff-16.png
  striff-32.png
  striff-48.png
  striff-128.png
lib/
  VERSIONS.md
  fflate.min.js     # ZIP decompression
  panzoom.min.js    # SVG pan/zoom
src/
  background.js     # Service worker
  pr-metadata-utils.js
  striffs.js        # Main content script
  webext-shim.js
test/
  manual-smoke-live.js    # Playwright smoke tests
  login-github.js
  check-login.js
scripts/
  package-extension.mjs
```

## Packaging

Build a store-ready zip with:

```bash
npm run package:extension
```

This stages only runtime files and excludes dev/test artifacts.

## Manual Playwright Testing

### Persist a GitHub login profile:

```bash
node test/login-github.js
```

This prepares the saved Chrome login profile used by the manual smoke harness.

### Run the live smoke tests:

```bash
# Old GitHub UI
GITHUB_STORAGE_STATE_PATH=test/.github-storage-state.json HEADLESS=1 node test/manual-smoke-live.js

# New GitHub UI
GITHUB_STORAGE_STATE_PATH=test/.github-storage-state.json HEADLESS=1 NEW_UI=1 node test/manual-smoke-live.js
```

The smoke harness now defaults to headless unless you explicitly set `HEADED=1`.

### Run the automated CI-safe tests:

```bash
npm test
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `PR_URL` | Target PR URL for testing |
| `GH_TOKEN` | Token stored into extension storage for the run |
| `HEADLESS=1` | Run browser in headless mode (default) |
| `HEADED=1` | Force a visible browser window for debugging |
| `GITHUB_STORAGE_STATE_PATH` | Path to a saved GitHub Playwright storage state file |
| `RUN_API_DOWN_TEST=1` | Include cache-clear plus API-down validation |
| `PRIVATE_PR_URL` | Private repo PR URL for auth testing |

## Privacy & Security

- GitHub tokens are stored in extension storage until cleared from the popup or options page
- Live/manual test hooks exist in source but are stripped from the packaged production artifact
- Usage-data collection can be disabled from the popup without disabling base diagram generation
- Engagement, review interaction, and AI review feedback events may be sent to the configured Striffs backend when usage data is enabled
- All API calls go to the packaged production base URL or the unpacked local-development base URL

## Icons

The Striffs icon depicts a three-node graph representing connected code entities:

- Green node (top): Represents primary/healthy code
- Red node (bottom-left): Represents modified/deleted code
- Blue node (bottom-right): Represents new/added code

The golden connecting lines symbolize the relationships and dependencies between code entities.
