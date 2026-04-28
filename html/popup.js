// popup.js — token management, cache clearing, debug mode

const DEBUG_KEY = "striffsDebug";
const shared = window.StriffsUiShared;

// Status display
function setStatus(text, kind = "") {
  const el = document.getElementById("status");
  if (!el) return;
  if (!text) {
    el.style.display = "none";
    return;
  }
  el.textContent = text;
  el.className = kind === "ok" ? "status-ok" : kind === "error" ? "status-error" : "";
  el.style.display = "";
}

function setBusy(busy) {
  for (const id of ["saveBtn", "clearBtn", "resetCacheBtn"]) {
    const el = document.getElementById(id);
    if (el) el.disabled = busy;
  }
}

function setTokenBadge(has) {
  const badge = document.getElementById("tokenBadge");
  if (!badge) return;
  if (has) {
    badge.textContent = "Token saved";
    badge.classList.add("ok");
    badge.title = "A GitHub token is saved.";
  } else {
    badge.textContent = "No token set";
    badge.classList.remove("ok");
    badge.title = "No GitHub token is saved.";
  }
}

// Validate token permissions
async function validateToken(token) {
  return shared.validateToken(token, {
    invalidTokenMessage: "Invalid token",
    genericErrorPrefix: "GitHub error",
    missingRepoScopeMessage: (scopeList) => `Missing 'repo' scope (has: ${scopeList})`
  });
}

// ---- Debug mode ----
function readDebugOnce() {
  shared.readFlagOnce(DEBUG_KEY, (enabled) => {
    const toggle = document.getElementById("debugToggle");
    if (toggle) toggle.checked = enabled;
  });
}

function setDebug(enabled) {
  shared.writeFlag(DEBUG_KEY, enabled);
}

// ---- Initialization ----
async function refreshBadgeFromStorage() {
  const hasToken = await shared.tokenExists();
  setTokenBadge(hasToken);
  updateSaveButtonText(hasToken);
}

function updateSaveButtonText(hasToken) {
  const saveBtn = document.getElementById("saveBtn");
  if (saveBtn) {
    saveBtn.textContent = hasToken ? "Overwrite" : "Save";
  }
}

async function init() {
  const input = document.getElementById("ghToken");
  const saveBtn = document.getElementById("saveBtn");
  const clearBtn = document.getElementById("clearBtn");
  const resetCacheBtn = document.getElementById("resetCacheBtn");
  const debugToggle = document.getElementById("debugToggle");

  await refreshBadgeFromStorage();
  readDebugOnce();
  setStatus(""); // start clean

  // First-run onboarding
  const ONBOARDED_KEY = "striffsOnboarded";
  const onboarding = document.getElementById("onboarding");
  const dismissOnboarding = document.getElementById("dismissOnboarding");

  if (onboarding && dismissOnboarding) {
    // Check if user has been onboarded
    chrome.storage.local.get([ONBOARDED_KEY], (result) => {
      if (!result[ONBOARDED_KEY]) {
        onboarding.style.display = "block";
      }
    });

    dismissOnboarding.addEventListener("click", () => {
      chrome.storage.local.set({ [ONBOARDED_KEY]: true });
      onboarding.style.display = "none";
    });
  }

  // Save token
  saveBtn.addEventListener("click", async () => {
    const token = (input.value || "").trim();
    if (!token) {
      setStatus("Please paste a token.", "error");
      return;
    }

    setBusy(true);
    setStatus("Validating token…");

    const v = await validateToken(token);
    if (!v.ok) {
      setStatus(`${v.reason}`, "error");
      setBusy(false);
      return;
    }

    try {
      await shared.saveToken(token);
      input.value = ""; // never persist in the field
      setStatus(`Saved for @${v.login} (${v.type}).`, "ok");
      await refreshBadgeFromStorage();
    } catch (e) {
      console.error("Save error:", e);
      setStatus("Failed to save token.", "error");
    } finally {
      setBusy(false);
    }
  });

  // Clear token
  clearBtn.addEventListener("click", async () => {
    setBusy(true);
    try {
      await shared.clearTokenEverywhere();
      input.value = "";
      setStatus("Token cleared.", "ok");
      await refreshBadgeFromStorage();
    } catch (e) {
      console.error("Clear error:", e);
      setStatus("Failed to clear token.", "error");
    } finally {
      setBusy(false);
    }
  });

  // Clear cache
  resetCacheBtn.addEventListener("click", async () => {
    setBusy(true);
    setStatus("Clearing caches…");
    try {
      const { tabsTouched } = await shared.clearAllCaches();
      setStatus(`Cleared. Updated ${tabsTouched} tab${tabsTouched === 1 ? "" : "s"}.`, "ok");
    } catch (e) {
      console.error("Cache clear error:", e);
      setStatus("Failed to clear caches.", "error");
    } finally {
      setBusy(false);
    }
  });

  // Debug toggle
  if (debugToggle) {
    debugToggle.addEventListener("change", () => {
      setDebug(debugToggle.checked);
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "tokenStateChanged") {
      const hasToken = msg?.hasToken === true;
      setTokenBadge(hasToken);
      updateSaveButtonText(hasToken);
      if (hasToken) {
        setStatus("Token set.", "ok");
      } else {
        setStatus(""); // Clear status, don't show "No token set"
      }
      return;
    }
  });

  // Live update if storage changes while popup is open
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (DEBUG_KEY in changes) {
      const enabled = changes[DEBUG_KEY]?.newValue === true;
      const toggle = document.getElementById("debugToggle");
      if (toggle) toggle.checked = enabled;
    }
  });

  // Show initial status
  const hasToken = await shared.tokenExists();
  setStatus(hasToken ? "Token set." : "", hasToken ? "ok" : "");
}

document.addEventListener("DOMContentLoaded", init);
