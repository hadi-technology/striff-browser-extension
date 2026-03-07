// options.js — secure token management + cache clearing + overwrite confirm

const local = chrome.storage.local;
const sync  = chrome.storage.sync;

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

async function tokenExists() {
  const l = await local.get(["ghToken"]);
  if (l?.ghToken) return true;
  const s = await sync.get(["ghToken"]);
  return !!s?.ghToken;
}

async function saveTokenToBoth(token) {
  await Promise.allSettled([ local.set({ ghToken: token }), sync.set({ ghToken: token }) ]);
}
async function clearTokenEverywhere() {
  await Promise.allSettled([
    local.remove("ghToken"),
    sync.remove("ghToken"),
    chrome.runtime.sendMessage({ type: "forgetToken" }).catch(() => {})
  ]);
}

async function proxyJson(url, token, { timeoutMs = 10000, returnHeaders = false } = {}) {
  return chrome.runtime.sendMessage({
    type: "proxyFetch",
    url,
    method: "GET",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Striffs-Extension"
    },
    bodyType: "json",
    timeoutMs,
    returnHeaders
  });
}

function parseClassicScopes(headers) {
  const raw = headers?.["x-oauth-scopes"] || "";
  return new Set(raw.split(",").map(s => s.trim()).filter(Boolean).map(s => s.toLowerCase()));
}

// Validate token permissions
async function validateToken(token) {
  if (!token) return { ok: false, reason: "Empty token" };

  const user = await proxyJson("https://api.github.com/user", token, { returnHeaders: true });
  if (!user || user.ok !== true) {
    if (user && user.status === 401) return { ok: false, reason: "Unauthorized: invalid token" };
    return { ok: false, reason: `GitHub /user error${user?.status ? ` ${user.status}` : ""}` };
  }

  const login = user.json?.login || "user";
  const hasClassicHeader = !!(user.headers && "x-oauth-scopes" in user.headers);

  if (hasClassicHeader) {
    const scopes = parseClassicScopes(user.headers);
    const hasRepo = scopes.has("repo");
    if (!hasRepo) {
      const scopeList = Array.from(scopes).join(", ") || "none";
      return { ok: false, reason: `Token missing 'repo' scope (scopes: ${scopeList}). Add 'repo'.` };
    }
    return { ok: true, type: "classic", login };
  }

  // Fine-grained: token is valid (200); scopes are repo-scoped on GitHub side.
  return { ok: true, type: "fine-grained", login };
}

// ---- Cache clearing (keeps token) ----
async function clearExtensionCaches() {
  const all = await local.get(null);
  const prefixes = ["striffs:", "StriffsCache:", "striffsCache:", "striffsCacheMeta:", "StriffsCacheMeta:"];
  const keys = [
    "striffsActiveTab",
    "striffsRemoteConfig",
    "striffsRemoteConfigFetchedAt",
    "striffsRemoteConfigUrl",
    "striffsSupportedLangs",
    "striffsSupportedLangsFetchedAt",
    "striffsSupportedLangsBase",
    "striffsConfigUrl",
    "striffsApiBase"
  ];
  const toRemove = Object.keys(all).filter(k =>
    (k !== "striffsCacheClearAt") &&
    (String(k).toLowerCase() !== "striffsdebug") &&
    (keys.includes(k) || prefixes.some(p => k.startsWith(p)))
  );
  if (toRemove.length) await local.remove(toRemove);
}

async function clearGithubTabsCaches() {
  const tabs = await chrome.tabs.query({ url: ["*://github.com/*", "*://*.github.com/*"] });
  let touched = 0;

  await Promise.allSettled(tabs.map(async (tab) => {
    const target = { tabId: tab.id, allFrames: true };

    const tryMessage = async () => {
      try {
        const resp = await chrome.tabs.sendMessage(tab.id, { type: "clearStriffsCaches" });
        if (resp && resp.ok) return true;
      } catch (_) {}
      return false;
    };

    const tryScript = async () => {
      try {
        await chrome.scripting.executeScript({
          target,
          func: () => {
            try {
              const prefixes = ["striffs:", "StriffsCache:"];
              const clearFrom = (store) => {
                const keys = [];
                for (let i = 0; i < store.length; i++) {
                  keys.push(store.key(i));
                }
                for (const k of keys) {
                  if (k && prefixes.some(p => k.startsWith(p))) {
                    try { store.removeItem(k); } catch {}
                  }
                }
              };
              try { clearFrom(window.localStorage); } catch {}
              try { clearFrom(window.sessionStorage); } catch {}

              try {
                if (window.StriffsForceReload) {
                  window.StriffsForceReload();
                } else {
                  window.dispatchEvent(new Event("striffs:caches-cleared"));
                }
              } catch {}
            } catch {}
          }
        });
        return true;
      } catch (_) {
        return false;
      }
    };

    const ok = (await tryMessage()) || (await tryScript());
    if (ok) touched++;
  }));

  return touched;
}

async function clearAllCaches() {
  await clearExtensionCaches();
  const tabsTouched = await clearGithubTabsCaches();
  return { tabsTouched };
}

async function refreshBadgeFromStorage() {
  setTokenBadge(await tokenExists());
}

async function init() {
  const input      = document.getElementById("ghToken");
  const saveBtn    = document.getElementById("save");
  const clearBtn   = document.getElementById("clear");
  const clearCache = document.getElementById("clearCache");

  await refreshBadgeFromStorage();
  setStatus(""); // start clean

  // Save (with overwrite confirmation)
  saveBtn.addEventListener("click", async () => {
    const token = (input.value || "").trim();
    if (!token) {
      setStatus("Please paste a token.", "error");
      return;
    }

    // If a token already exists, confirm overwrite
    if (await tokenExists()) {
      const ok = confirm("A token is already saved. Do you want to overwrite it?");
      if (!ok) return;
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
      await saveTokenToBoth(token);
      input.value = ""; // never persist in the field
      setStatus(`Token saved securely for @${v.login} (${v.type}).`, "ok");
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
      await clearTokenEverywhere();
      input.value = "";
      setStatus("Token cleared from storage and memory.", "ok");
      await refreshBadgeFromStorage();
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
      const { tabsTouched } = await clearAllCaches();
      setStatus(`Cleared caches. Updated ${tabsTouched} GitHub tab${tabsTouched === 1 ? "" : "s"}.`, "ok");
    } catch (e) {
      console.error("Cache clear error:", e);
      setStatus("Failed to clear caches.", "error");
    } finally {
      setBusy(false);
    }
  });
}

document.addEventListener("DOMContentLoaded", init);
