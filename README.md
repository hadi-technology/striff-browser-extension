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
| `tabs`           | Interact with GitHub PR tabs                 |
| `webRequest`     | (Required by some extensions for zip fetch)  |
| `webNavigation`  | Detect tab and history changes               |
| `host_permissions` | GitHub domains + `codeload.github.com`     |

---

## 🛠 Future Improvements
- Diagram grouping by language
- SVG download/export button
- Retry/backoff logic for failed requests

---

## 📬 Feedback
Submit suggestions or bugs at [striff.io](https://striff.io)

---

© 2025 Hadii Technologies — All rights reserved.