# Agents

## Playwright UI Tests — How They Work

### Setup (one-time): `npm run test:login`

The manual Playwright tests need two things in a Chrome profile at `test/.pw-profile-login`:
1. **Striffs extension loaded** (via Chrome's `--load-extension` flag)
2. **GitHub session** (user logs in manually)

`npm run test:login` (or `node test/login-github.js`) launches real Chrome with:
- `--load-extension` pointing at the project root (loads the extension automatically)
- `chrome://extensions` tab so the user can verify the extension is loaded
- `https://github.com/login` tab for the user to authenticate

The user closes Chrome when done, and the profile is saved.

**Important:** Playwright's bundled Chromium and `channel: 'chrome'` with `launchPersistentContext` do NOT load extensions due to Playwright's `--enable-automation` flag. Tests must use `connectOverCDP` to a real Chrome launched separately, OR use a pre-built profile via `launchPersistentContext` with `channel: 'chrome'` where the extension was already installed manually. The test files use `channel: 'chrome'` with `launchPersistentContext` and a pre-saved profile.

### Running Tests

```bash
# One-time: create login profile
npm run test:login

# Run UI tests (headed)
HEADED=1 npm run test:ui

# Run visual regression tests
npm run test:visual

# Run full smoke test
npm run test:live
```

### Profile Detection

Tests auto-detect the login profile at `test/.pw-profile-login`. If it exists and has cookies, they use it (preserving GitHub auth and extension). Otherwise they fall back to a fresh profile (no auth, no extension).

### Key Files

- `test/login-github.js` — Opens Chrome for manual login + extension setup
- `test/playwright-skill-test.js` — UI tests (`npm run test:ui`)
- `test/striffs-visual-tests.js` — Visual regression tests (`npm run test:visual`)
- `test/manual-smoke-live.js` — Full smoke test (`npm run test:live`)
- `test/.pw-profile-login/` — Saved Chrome profile (gitignored)

### For LLMs / Automated Agents

When running Playwright tests for this project:
1. First check if `test/.pw-profile-login/Default/Cookies` exists
2. If not, run `node test/login-github.js` and ask the user to log in
3. Tests require `channel: 'chrome'` in Playwright — do NOT use Playwright's bundled Chromium
4. The extension loads via the saved Chrome profile, not via `--load-extension` in Playwright args
