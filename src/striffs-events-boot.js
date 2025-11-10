// Striffs — events & boot
(async () => {
  const S = (window.Striffs = window.Striffs || {});
  const { cwarn, cerr } = S;

  // ---------- Toast (legacy view-local) ----------
  S.showToast = (msg) => {
    const view = S.ensureStriffContainer();
    if (!view) return;
    const toast = view.querySelector("#striffs-toast");
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 7500);
  };

  // ---------- Auto fetch (background-powered) ----------
  S.autoFetchStriffs = async () => {
    const token = await S.getStoredToken();
    const { owner, repo, pull_number, updated_at } = S.extractPRMetadata();

    S.buildFilePathToDiffIdMapAsync(); // parallel

    try {
      let result;
      const key = S.cacheKey();
      const cached = localStorage.getItem(key);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (parsed.updated_at === updated_at && (Date.now() - parsed.savedAt) < S.CACHE_TTL_MS) {
            result = parsed.result;
            S.cinfo('Using cached Striffs result');
          }
        } catch (e) {
          S.cwarn('Cache parse failed', e);
        }
      }

      if (!result) {
        if (token) {
          S.updateStriffButton({ loading: true, phase: "Fetching source...", tooltip: "Fetching from API..." });
          const resp = await S.bgRequest({
            type: 'fetchStriffsWithToken',
            owner, repo, pull_number, updated_at, token
          }, 30000);
          const ok = resp?.ok === true || resp?.success === true;
          if (!ok) {
            cerr('fetchStriffsWithToken failed', resp?.error);
            throw new Error(resp?.error || "Internal error fetching diagram (API is down)");
          }
          result = resp.json;
        } else {
          S.updateStriffButton({ loading: true, phase: "Generating diagram...", tooltip: "Preparing zips..." });
          const filterFiles = S.getFilterFilesFromNav();
          const { baseOwner, baseRepo, baseBranch, headOwner, headRepo, headBranch } = S.extractHeadBaseRefs();

          const resp = await S.bgRequest({
            type: 'generateStriffs',
            baseOwner, baseRepo, baseBranch,
            headOwner, headRepo, headBranch,
            filterFiles
          }, 60000);

          const ok = resp?.ok === true || resp?.success === true;
          if (!ok) {
            cerr('generateStriffs failed', resp?.error);
            throw new Error(resp?.error || "Internal error fetching diagram (API is down)");
          }
          result = resp.json;
        }
      }

      // Validate — empty array means “no changes” (not an error)
      const valid = S.isValidStriffsResult(result);
      if (!valid) {
        throw new Error(result?.error || result?.message || "Invalid response.");
      }

      const striffContainer = S.ensureStriffContainer();

      // NO CHANGES: disable + neutral icon, do not switch view, do not mark ready
      if (Array.isArray(result.striffs) && result.striffs.length === 0) {
        if (striffContainer) {
          striffContainer.innerHTML = `<div id="striffs-toast" role="status" aria-live="polite"></div>`;
        }
        S.updateStriffButton({ neutral: true, tooltip: "No changes were found", disabled: true });
        S.__striffsReady = false;
        S.__lastFetchedUpdatedAt = updated_at;
        if (typeof S.toast === 'function') S.toast("No changes were found.", "neutral", { timeoutMs: 5000 });
        return true; // treat as successful request
      }

      // HAS DIAGRAM: render + cache + mark ready
      if (striffContainer) {
        const rendered = S.renderStriffsInto(striffContainer, result);
        if (!rendered) {
          cerr('Render returned false');
          throw new Error("Failed to render diagram.");
        }
        S.storeDiagramInCache(result);
      }

      // mark ready & success state
      S.__striffsReady = true;
      S.__lastFetchedUpdatedAt = updated_at;
      S.updateStriffButton({ success: true, tooltip: "Striffs loaded. Click to view." });
      return true;

    } catch (err) {
      const message = err?.message || String(err);
      cerr('autoFetchStriffs error:', message, err);

      // disable + error styling + tooltip
      S.updateStriffButton({ failure: true, tooltip: message });
      S.__striffsReady = false;

      // prominent error toast for 5s
      if (typeof S.toast === 'function') S.toast(message, "error", { timeoutMs: 5000 });
      return false;
    }
  };

  // ---------- UI Events ----------
  // File tree -> center the corresponding node
  document.addEventListener("click", (e) => {
    const link = e.target.closest("a.ActionList-content, a.ActionListContent, [data-testid='file-tree'] a[href^='#diff-'], [data-testid='file-tree'] a[href*='#diff-']");
    if (!link) return;
    const li = link.closest("li[id^='file-tree-item-diff-'], [data-testid='file-tree'] li");
    const hiddenSpan = li?.querySelector("span[data-filterable-item-text], [data-testid='file-tree-item-text']");
    const fullPath = '/' + (hiddenSpan?.textContent.trim() || '');
    if (S.__striffsSvg && S.__striffsPanzoom) {
      const textEl = S.findSvgTextForFile(fullPath);
      const pane = S.ensureStriffContainer();
      if (pane) pane.scrollIntoView({ block: "center", behavior: "smooth" });
      if (textEl) {
        S.centerOnElement(S.__striffsSvg, textEl, S.__striffsPanzoom, 0.85, 0.5);
        S.flashFocus(textEl);
      } else {
        S.toast?.("No corresponding component exists in the diagram for this file.", "info", { timeoutMs: 5000 });
      }
    }
  });

  // Diagram text -> jump to diff
  document.addEventListener("click", (e) => {
    if (!S.__striffsSvg) return;
    const target = e.target.closest("text[id]");
    if (!target) return;
    const ownerSvg = target.ownerSVGElement || target.closest("svg");
    if (ownerSvg !== S.__striffsSvg) return;
    const id = target.getAttribute("id");
    const file = S.__striffsComponentIdToFile.get(id);
    if (file) {
      S.showDiffView();
      S.setActiveButtons("diffs");
      S.saveActiveTab("diffs");

      const diffId = S.__filePathToDiffId.get(file) || S.__filePathToDiffId.get(S.normalizePath(file));
      if (diffId) {
        if (location.hash !== `#${diffId}`) history.replaceState(null, "", `#${diffId}`);
        const diffEl = document.getElementById(diffId);
        if (diffEl) diffEl.scrollIntoView({ block: "start", behavior: "smooth" });
      } else {
        S.toast?.("No corresponding file exists in this Pull Request’s changeset.", "info", { timeoutMs: 5000 });
      }
    } else {
      S.toast?.("No corresponding file exists in this Pull Request’s changeset.", "info", { timeoutMs: 5000 });
    }
  });

  // Focus flash
  S.flashFocus = (elem) => {
    try {
      elem.classList.add("striffs-focused");
      setTimeout(() => elem.classList.remove("striffs-focused"), 900);
    } catch {}
  };

  // Center helper
  S.centerOnElement = (svg, elem, pan, paddingFactor = 0.8, scaleAdjust = 1.0) => {
    try {
      const striffView = document.getElementById("striff-diagram-view") || svg.parentElement;
      const container = striffView.getBoundingClientRect();
      const bbox = elem.getBBox();
      let scale = Math.min(container.width / (bbox.width || 1), container.height / (bbox.height || 1)) * paddingFactor;
      scale = Math.max(scale * scaleAdjust, 0.1);
      pan.zoomAbs(0, 0, scale);
      const cx = bbox.x + bbox.width / 2;
      const cy = bbox.y + bbox.height / 2;
      const tx = container.width / 2 - cx * scale;
      const ty = container.height / 2 - cy * scale;
      pan.moveTo(tx, ty);
    } catch (e) { cwarn('centerOnElement skipped', e); }
  };

  // Refit on resize
  window.addEventListener("resize", () => {
    if (S.__striffsSvg && S.__striffsPanzoom) S.fitSvgToContainer(S.__striffsSvg, S.__striffsPanzoom);
  });

  // Force reload
  window.StriffsForceReload = async function () {
    const btn = document.getElementById("striffs-btn");
    if (!btn) return S.cwarn("Striffs button not found");

    S.__striffsReady = false;
    S.__lastFetchedUpdatedAt = null;
    S.__striffsSvg = null;
    S.__striffsPanzoom = null;
    S.__striffsPathToComponentId.clear();
    S.__striffsComponentIdToFile.clear();

    try { localStorage.removeItem(S.cacheKey()); } catch {}

    const view = document.getElementById("striff-diagram-view");
    if (view) view.innerHTML = `<div id="striffs-toast" role="status" aria-live="polite"></div><p>Reloading…</p>`;

    S.updateStriffButton({ loading: true, tooltip: "Force reloading…", phase: "Bypassing cache..." });
    const ok = await S.autoFetchStriffs();
    if (ok && S.__striffsReady) {
      S.updateStriffButton({ success: true, tooltip: "Reloaded fresh." });
      S.showStriffView();
      document.getElementById("striff-diagram-view")?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  };

  // ---------- BOOT ----------
  console.log('[Striffs] content script boot', location.href);
  S.addSpinAnimation();

  // Mount toolbar buttons once (wait until toolbar exists)
  S.getMainToolbar() || await new Promise(resolve => {
    const tryFind = () => {
      const el = S.getMainToolbar();
      if (el) resolve(el); else requestAnimationFrame(tryFind);
    };
    tryFind();
  });
  S.mountMainBarButtons();

  // Default tooltip and non-blocking languages check
  S.updateStriffButton({ tooltip: "Click to generate Striffs" });
  S.fetchSupportedExtensions()
    .then(exts => {
      const files = S.getFilesInPR();
      const found = S.checkIfRelevantFilesExist(files, exts);
      if (!found) S.updateStriffButton({ disabled: true, neutral: true, tooltip: "No supported files in PR" });
    })
    .catch(err => S.cwarn('languages check error', err));

  // Files root + cache prime
  await S.waitForFilesRoot();
  S.buildFilePathToDiffIdMapAsync();
  S.primeDiagramFromCache();

  // Start in "Diffs"
  S.setActiveButtons("diffs");
  S.showDiffView();
  S.saveActiveTab("diffs");
})();
