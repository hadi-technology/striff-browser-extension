(async function () {
  const isPR = window.location.pathname.includes("/pull/");
  if (!isPR) return;

  const waitForTabs = async () => {
    const el = document.querySelector(".js-pull-request-tabnav");
    if (el) return el;
    await new Promise(r => setTimeout(r, 500));
    return waitForTabs();
  };

  const loadPanzoomScript = () => {
    return new Promise((resolve) => {
      if (window.panzoom) return resolve();
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("panzoom.min.js");
      script.onload = resolve;
      document.head.appendChild(script);
    });
  };

  const observeURLChanges = () => {
    let lastURL = location.href;
    new MutationObserver(() => {
      const currentURL = location.href;
      if (currentURL !== lastURL) {
        lastURL = currentURL;
        if (currentURL.includes("/pull/")) {
          waitForTabs().then(() => createStriffsTab());
        }
      }
    }).observe(document, { subtree: true, childList: true });
  };

  const createStriffsTab = () => {
    const nav = document.querySelector(".js-pull-request-tabnav");
    if (!nav || document.querySelector("#striffs-tab")) return;

    const templateTab = nav.querySelector(".tabnav-tab");
    if (!templateTab) return;

    const striffsTab = templateTab.cloneNode(true);
    striffsTab.id = "striffs-tab";
    striffsTab.href = "#striffs";
    striffsTab.textContent = "Striffs";
    striffsTab.addEventListener("click", async (e) => {
      e.preventDefault();
      const container = document.querySelector(".js-discussion") || document.body;
      container.innerHTML = "<div class='striffs-loading'>Loading Striffs...</div>";

      const token = await getStoredToken();
      const { owner, repo, pull_number, updated_at } = extractPRMetadata();

      const headers = token ? { Authorization: `token ${token}` } : {};
      const url = token
        ? `https://your-server/github/striffs/owners/${owner}/repos/${repo}/pulls/${pull_number}?updated_at=${updated_at}`
        : null;

      try {
        const result = token
          ? await fetch(url, { headers }).then(r => r.json())
          : await uploadZipsAndGetStriffs(owner, repo);

        await loadPanzoomScript();
        renderStriffs(result);
        showSuccessBtnIcon();
      } catch (err) {
        container.innerHTML = `<div class='striffs-error'>Error loading Striffs: ${err.message}</div>`;
        showFailureBtnIcon();
      }
    });

    nav.appendChild(striffsTab);
  };

  const getStoredToken = async () => {
    return new Promise((resolve) => {
      chrome.storage.sync.get(["ghToken"], (result) => {
        resolve(result.ghToken || null);
      });
    });
  };

  const extractPRMetadata = () => {
    const [, owner, repo,, pull,, pull_number] = window.location.pathname.split("/");
    const updated_at = document.querySelector("relative-time")?.getAttribute("datetime") || new Date().toISOString();
    return { owner, repo, pull_number, updated_at };
  };

  const uploadZipsAndGetStriffs = async (owner, repo) => {
    const [baseRef, headRef] = Array.from(document.querySelectorAll(".commit-ref span"))
      .map(e => e.getAttribute("title"));

    const supported = await fetch("https://your-server/github/languages")
      .then(r => r.text())
      .then(t => t.split(","));

    const [beforeZip, afterZip] = await Promise.all([
      downloadAndFilterZip(owner, repo, baseRef, supported),
      downloadAndFilterZip(owner, repo, headRef, supported)
    ]);

    if (!beforeZip || !afterZip) {
      throw new Error("Unable to fetch valid zip archives.");
    }

    if (beforeZip.size === 0 && afterZip.size === 0) {
      throw new Error("No supported languages found in this PR.");
    }

    const formData = new FormData();
    formData.append("before", beforeZip, "before.zip");
    formData.append("after", afterZip, "after.zip");

    return fetch("https://your-server/github/striffs", {
      method: "POST",
      body: formData
    }).then(r => r.json());
  };

  const downloadAndFilterZip = async (owner, repo, ref, supportedExts) => {
    const zipUrl = `https://codeload.github.com/${owner}/${repo}/zip/${ref}`;
    const res = await fetch(zipUrl);
    if (!res.ok) throw new Error(`Failed to download zip for ${ref}`);
    const blob = await res.blob();
    const zip = await JSZip.loadAsync(blob);
    const newZip = new JSZip();

    await Promise.all(Object.keys(zip.files).map(async (path) => {
      const file = zip.files[path];
      if (file.dir) return;
      const ext = path.split(".").pop().toLowerCase();
      if (!supportedExts.includes(ext)) return;
      const content = await file.async("blob");
      newZip.file(path.replace(/^.*?\//, ""), content);
    }));

    return await newZip.generateAsync({ type: "blob" });
  };

  const renderStriffs = (data) => {
    const container = document.querySelector(".js-discussion") || document.body;
    if (!data.striffs || data.striffs.length === 0) {
      container.innerHTML = "<p>No supported files were found.</p>";
      showNoChangesBtnIcon();
    } else {
      container.innerHTML = "";
      data.striffs.forEach((svg, index) => {
        const div = document.createElement("div");
        div.innerHTML = svg;
        div.style.marginBottom = "20px";
        container.appendChild(div);
      });

      setTimeout(() => {
        document.querySelectorAll("svg").forEach(svg => {
          svg.style.border = "1px solid #aaa";
          svg.style.width = "100%";
          svg.style.minHeight = "800px";
          svg.style.cursor = "move";
          window.panzoom(svg.querySelector("g") || svg);
        });
      }, 100);
    }
  };

  const showSuccessBtnIcon = () => updateStriffTabIcon("✅");
  const showFailureBtnIcon = () => updateStriffTabIcon("❌");
  const showNoChangesBtnIcon = () => updateStriffTabIcon("⚠️");
  const updateStriffTabIcon = (symbol) => {
    const tab = document.querySelector("#striffs-tab");
    if (tab) tab.textContent = `${symbol} Striffs`;
  };

  await waitForTabs();
  createStriffsTab();
  observeURLChanges();
})();
