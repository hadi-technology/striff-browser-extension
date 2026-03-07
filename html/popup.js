// Use local storage for reliability in MV3 popups
const storageArea = chrome.storage?.local;
const DEBUG_KEY = "striffsDebug";

// Minimal safe render
function renderStatus(hasToken, fallbackText) {
  const el = document.getElementById("status");
  if (!el) return;
  if (typeof hasToken === "boolean") {
    el.textContent = hasToken ? "✅ Token set" : "⚠️ No token set";
  } else {
    el.textContent = fallbackText || "⚠️ Could not load token";
  }
}

function readTokenOnce() {
  if (!storageArea) {
    renderStatus(null, "⚠️ Storage unavailable");
    return;
  }
  try {
    storageArea.get(["ghToken"], (items) => {
      // Callback always fires; items may be {} if key missing
      const hasToken = !!items.ghToken;
      renderStatus(hasToken);
    });
  } catch (e) {
    console.error("Storage read error:", e);
    renderStatus(null, "⚠️ Could not load token");
  }
}

function openOptions() {
  // You have "options_page": "html/options.html" in manifest
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open(chrome.runtime.getURL("html/options.html"));
  }
}

function resetCache() {
  const statusEl = document.getElementById("status");
  const setMsg = (msg) => { if (statusEl) statusEl.textContent = msg; };

  setMsg("Clearing caches…");
  try {
    chrome.runtime.sendMessage({ type: "clearStriffsCaches" }, (resp) => {
      if (chrome.runtime.lastError) {
        setMsg("⚠️ Could not reset cache.");
        return;
      }
      if (resp?.ok) {
        setMsg("✅ Striffs cache cleared.");
      } else {
        setMsg("⚠️ Could not reset cache.");
      }
    });
  } catch (e) {
    setMsg("⚠️ Could not reset cache.");
  }
}

function readDebugOnce() {
  if (!storageArea) {
    return;
  }
  try {
    storageArea.get([DEBUG_KEY], (items) => {
      const enabled = items?.[DEBUG_KEY] === true;
      const toggle = document.getElementById("debugToggle");
      if (toggle) toggle.checked = enabled;
    });
  } catch (e) {
    console.error("Debug storage read error:", e);
  }
}

function setDebug(enabled) {
  if (!storageArea) return;
  storageArea.set({ [DEBUG_KEY]: !!enabled });
}

document.addEventListener("DOMContentLoaded", () => {
  // Initial read
  readTokenOnce();
  readDebugOnce();

  // Live update if Options changes the token while popup is open
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if ("ghToken" in changes) {
      renderStatus(!!changes.ghToken.newValue);
    }
    if (DEBUG_KEY in changes) {
      const enabled = changes[DEBUG_KEY]?.newValue === true;
      const toggle = document.getElementById("debugToggle");
      if (toggle) toggle.checked = enabled;
    }
  });

  // Wire the button
  const btn = document.getElementById("openOptionsBtn");
  if (btn) btn.addEventListener("click", openOptions);

  const resetBtn = document.getElementById("resetCacheBtn");
  if (resetBtn) resetBtn.addEventListener("click", resetCache);

  const debugToggle = document.getElementById("debugToggle");
  if (debugToggle) {
    debugToggle.addEventListener("change", () => {
      setDebug(debugToggle.checked);
    });
  }

  // Fallback retry in rare cases
  setTimeout(() => {
    const stillChecking = (document.getElementById("status")?.textContent || "")
      .includes("Checking token");
    if (stillChecking) readTokenOnce();
  }, 250);
});
