// Striffs — PR helpers & mapping
(() => {
  const S = (window.Striffs = window.Striffs || {});

  // ---------- PR metadata ----------
  S.extractPRMetadata = () => {
    const [, owner, repo, , pull_number] = window.location.pathname.split("/");
    const updated_at =
      document.querySelector("relative-time")?.getAttribute("datetime") ||
      document.querySelector('time-ago, time')?.getAttribute('datetime') ||
      new Date().toISOString();
    return { owner, repo, pull_number, updated_at };
  };

  // ---------- Files in PR ----------
  S.getFilesInPR = () => {
    const els = S.$$all([
      ".file-info a.Link--primary",
      '[data-testid="file-header"] a.Link--primary',
      'a[data-testid="file-name"], a[data-hovercard-type="file"]'
    ]);
    const titles = els.map(el => el.getAttribute("title") || el.textContent || "").map(t => t.trim()).filter(Boolean);
    return titles.map(t => t.toLowerCase());
  };

  S.checkIfRelevantFilesExist = (filenames, supportedExts) =>
    filenames.some(filename => {
      const parts = filename.toLowerCase().split(".");
      const ext = parts.length > 1 ? parts.pop() : "";
      return supportedExts.includes(ext);
    });

  // ---------- Mapping ----------
  S.normalizePath = (p) => String(p || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
  S.cssEscape = (id) => String(id).replace(/(["\\\]])/g, "\\$1");

  S.buildPathIdMapping = (apiData) => {
    S.__striffsPathToComponentId.clear();
    S.__striffsComponentIdToFile.clear();
    if (!S.__striffsSvg) return;

    const existsInSvg = (id) =>
      !!id && (S.__striffsSvg.querySelector(`[id="${S.cssEscape(id)}"]`) ||
        (typeof S.__striffsSvg.getElementById === "function" && S.__striffsSvg.getElementById(id)));

    const items = Array.isArray(apiData?.striffs) ? apiData.striffs : [];
    for (const item of items) {
      let comps = [];
      try {
        if (item.diagramCmpsJSON) comps = JSON.parse(item.diagramCmpsJSON);
      } catch (e) { /* ignore */ }
      for (const comp of comps) {
        const file = comp.sourceFile;
        const id = comp.uniqueName;
        if (!file || !id) continue;
        const norm = S.normalizePath(file);
        if (existsInSvg(id)) {
          S.__striffsPathToComponentId.set("/" + norm, id);
          S.__striffsPathToComponentId.set(norm, id);
          S.__striffsComponentIdToFile.set(id, "/" + norm);
        }
      }
    }
  };

  S.findSvgTextForFile = (fullPath) => {
    if (!S.__striffsSvg) return null;
    const norm = S.normalizePath(fullPath);
    const mappedId = S.__striffsPathToComponentId.get("/" + norm) || S.__striffsPathToComponentId.get(norm);
    if (!mappedId) return null;
    return S.__striffsSvg.querySelector(`text[id="${S.cssEscape(mappedId)}"]`);
  };

  S.getFilterFilesFromNav = () => {
    const items = S.$$all([
      "li[id^='file-tree-item-diff-'] span[data-filterable-item-text]",
      "[data-testid='file-tree'] li [data-testid='file-tree-item-text']",
      "[data-testid='file-tree'] li a.ActionListContent",
    ]);
    const paths = items.map(span => "/" + S.normalizePath(span.textContent.trim())).filter(Boolean);
    return paths;
  };

  S.buildFilePathToDiffIdMapAsync = () => {
    Promise.resolve().then(() => {
      const map = new Map();
      const items = S.$$all([
        "li[id^='file-tree-item-diff-']",
        "[data-testid='file-tree'] li",
      ]);
      for (const li of items) {
        const span = li.querySelector("span[data-filterable-item-text]") ||
                     li.querySelector("[data-testid='file-tree-item-text']");
        const a = li.querySelector("a.ActionList-content, a.ActionListContent, a[href^='#diff-'], a[href*='#diff-']");
        const href = a?.getAttribute("href") || "";
        const diffId = (href.startsWith("#") ? href.slice(1) : (href.match(/#(.+)$/)?.[1] || null));
        if (!span || !diffId) continue;
        const fullPath = "/" + S.normalizePath(span.textContent.trim());
        map.set(fullPath, diffId);
        map.set(S.normalizePath(span.textContent.trim()), diffId);
      }
      S.__filePathToDiffId = map;
    });
  };

  // --- PR refs parsing (robust) ---
  S.extractHeadBaseRefs = () => {
    let anchors = Array.from(document.querySelectorAll(".commit-ref > a"));
    if (anchors.length < 2) {
      anchors = Array.from(document.querySelectorAll('a[data-hovercard-type="repository"].Link--primary, a[data-hovercard-type="repository"].Link--muted'));
    }
    if (anchors.length < 2) {
      anchors = Array.from(document.querySelectorAll('a[href*="/tree/"]'));
    }

    const parseRef = (anchor) => {
      if (!anchor) return { owner: "", repo: "", branch: "" };
      const href = anchor.getAttribute("href") || "";
      const parts = href.split("/").filter(Boolean);
      const owner = parts[0] || "";
      const repo = parts[1] || "";
      const branch = decodeURIComponent(parts.slice(3).join("/")) || "";
      return { owner, repo, branch };
    };

    const base = parseRef(anchors[0]), head = parseRef(anchors[1]);
    return { baseOwner: base.owner, baseRepo: base.repo, baseBranch: base.branch, headOwner: head.owner, headRepo: head.repo, headBranch: head.branch };
  };
})();
