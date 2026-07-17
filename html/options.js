// options.js — secure token management + cache clearing + overwrite confirm

const shared = window.StriffsUiShared;

function setStatus(text, kind = "ok") {
  const el = document.getElementById("status");
  el.textContent = text;
  el.style.color = kind === "ok" ? "green" : "crimson";
}
function setBusy(b) {
  for (const id of ["save","clear","clearCache"]) {
    const el = document.getElementById(id);
    if (el) el.disabled = !!b;
  }
}

function setTokenBadge(has) {
  const badge = document.getElementById("tokenBadge");
  if (!badge) return;
  if (has) {
    badge.textContent = "Token saved";
    badge.classList.remove("none");
    badge.classList.add("ok");
    badge.title = "A GitHub token is saved.";
  } else {
    badge.textContent = "No token saved";
    badge.classList.remove("ok");
    badge.classList.add("none");
    badge.title = "No GitHub token is saved.";
  }
}

// Validate token permissions
async function validateToken(token) {
  return shared.validateToken(token, {
    invalidTokenMessage: "Unauthorized: invalid token",
    genericErrorPrefix: "GitHub /user error",
    missingRepoScopeMessage: (scopeList) => `Token missing 'repo' scope (scopes: ${scopeList}). Add 'repo'.`
  });
}

async function refreshBadgeFromStorage() {
  setTokenBadge(await shared.tokenExists());
}

async function init() {
  const input      = document.getElementById("ghToken");
  const saveBtn    = document.getElementById("save");
  const clearBtn   = document.getElementById("clear");
  const clearCache = document.getElementById("clearCache");
  const overwritePrompt = document.getElementById("overwritePrompt");

  const hasToken = await shared.tokenExists();
  setTokenBadge(hasToken);
  if (overwritePrompt) overwritePrompt.style.display = hasToken ? "block" : "none";
  setStatus(""); // start clean

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
      setStatus(`Token NOT saved: ${v.reason}`, "error");
      setBusy(false);
      return;
    }

    try {
      await shared.saveToken(token);
      input.value = ""; // never persist in the field
      setStatus(`Token saved for @${v.login} (${v.type}).`, "ok");
      await refreshBadgeFromStorage();
      if (overwritePrompt) overwritePrompt.style.display = "block";
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
      if (overwritePrompt) overwritePrompt.style.display = "none";
    } catch (e) {
      console.error("Clear error:", e);
      setStatus("Failed to clear token.", "error");
    } finally {
      setBusy(false);
    }
  });

  // Clear cache (diagrams/state), does not touch token
  clearCache.addEventListener("click", async () => {
    setBusy(true);
    setStatus("Clearing Striffs caches…");
    try {
      await shared.clearAllCaches({ notifyBackground: true });
      setStatus("Cleared caches. Changes will apply when you refresh GitHub pages.", "ok");
    } catch (e) {
      console.error("Cache clear error:", e);
      setStatus("Failed to clear caches.", "error");
    } finally {
      setBusy(false);
    }
  });
}

document.addEventListener("DOMContentLoaded", init);
