// shared.js — shared popup/options helpers

(() => {
  async function tokenExists() {
    const resp = await chrome.runtime.sendMessage({ type: "getTokenStatus" }).catch(() => null);
    return resp?.ok === true && resp?.hasToken === true;
  }

  async function saveToken(token) {
    const resp = await chrome.runtime.sendMessage({ type: "storeToken", token });
    if (!resp?.ok) throw new Error(resp?.error || "Failed to store token");
  }

  async function clearTokenEverywhere() {
    await chrome.runtime.sendMessage({ type: "forgetToken" });
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
    return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean).map((s) => s.toLowerCase()));
  }

  async function validateToken(token, messages = {}) {
    if (!token) return { ok: false, reason: "Empty token" };

    const user = await proxyJson("https://api.github.com/user", token, { returnHeaders: true });
    if (!user || user.ok !== true) {
      if (user?.status === 401) {
        return { ok: false, reason: messages.invalidTokenMessage || "Invalid token" };
      }
      return {
        ok: false,
        reason: `${messages.genericErrorPrefix || "GitHub error"}${user?.status ? ` ${user.status}` : ""}`
      };
    }

    const login = user.json?.login || "user";
    const hasClassicHeader = !!(user.headers && "x-oauth-scopes" in user.headers);
    if (!hasClassicHeader) {
      return { ok: true, type: "fine-grained", login };
    }

    const scopes = parseClassicScopes(user.headers);
    if (!scopes.has("repo")) {
      const scopeList = Array.from(scopes).join(", ") || "none";
      return {
        ok: false,
        reason: typeof messages.missingRepoScopeMessage === "function"
          ? messages.missingRepoScopeMessage(scopeList)
          : `Missing 'repo' scope (has: ${scopeList})`
      };
    }

    return { ok: true, type: "classic", login };
  }

  async function clearAllCaches({ notifyBackground = false } = {}) {
    const resp = await chrome.runtime.sendMessage({ type: "clearStriffsCaches" });
    if (!resp?.ok) {
      throw new Error(resp?.error || "Failed to clear caches");
    }
    return { tabsTouched: Number(resp?.tabsTouched || 0), cacheClearAt: resp?.cacheClearAt || null };
  }

  function readFlagOnce(key, callback) {
    const local = chrome.storage.local;
    try {
      local.get([key], (items) => callback(items?.[key] === true));
    } catch {
      callback(false);
    }
  }

  function writeFlag(key, enabled) {
    const local = chrome.storage.local;
    local.set({ [key]: !!enabled });
  }

  window.StriffsUiShared = {
    tokenExists,
    saveToken,
    clearTokenEverywhere,
    validateToken,
    clearAllCaches,
    readFlagOnce,
    writeFlag
  };
})();
