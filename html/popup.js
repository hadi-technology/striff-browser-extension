// Use local storage for reliability in MV3 popups
const storageArea = chrome.storage?.local;

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

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab?.id) {
      setMsg("⚠️ No active tab to reset.");
      return;
    }
    try {
      chrome.tabs.sendMessage(tab.id, { type: "clearStriffsCaches" }, (resp) => {
        if (chrome.runtime.lastError) {
          setMsg("⚠️ Could not reset cache on this page.");
          return;
        }
        if (resp?.ok) {
          setMsg("✅ Striffs cache cleared on this page.");
        } else {
          setMsg("⚠️ Could not reset cache on this page.");
        }
      });
    } catch (e) {
      setMsg("⚠️ Could not reset cache.");
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  // Initial read
  readTokenOnce();

  // Live update if Options changes the token while popup is open
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if ("ghToken" in changes) {
      renderStatus(!!changes.ghToken.newValue);
    }
  });

  // Wire the button
  const btn = document.getElementById("openOptionsBtn");
  if (btn) btn.addEventListener("click", openOptions);

  const resetBtn = document.getElementById("resetCacheBtn");
  if (resetBtn) resetBtn.addEventListener("click", resetCache);

  // Fallback retry in rare cases
  setTimeout(() => {
    const stillChecking = (document.getElementById("status")?.textContent || "")
      .includes("Checking token");
    if (stillChecking) readTokenOnce();
  }, 250);
});
