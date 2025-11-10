// Striffs — DOM & UI
(() => {
    const S = (window.Striffs = window.Striffs || {});
    const { cwarn } = S;

    // ---------- DOM utils ----------
    S.$$first = (selectors) => {
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) return el;
        }
        return null;
    };

    S.$$all = (selectors) => {
        const set = new Set();
        const out = [];
        for (const sel of selectors) {
            document.querySelectorAll(sel).forEach(el => {
                if (!set.has(el)) {
                    set.add(el);
                    out.push(el);
                }
            });
        }
        return out;
    };

    S.waitForFilesRoot = async (maxMs = 15000) => {
        const start = Date.now();
        const candidates = [
            '#files',
            'div[data-testid="files-changed"]',
            'div[data-view-component="true"][data-testid="pull-requests-files"]',
            'turbo-frame[id^="repo-content-"] div#files',
            'main[aria-label="Content"] #files',
            'div[data-hpc] #files',
        ];
        while (Date.now() - start < maxMs) {
            const el = S.$$first(candidates);
            if (el) return el;
            await S.sleep(250);
        }
        return S.$$first(candidates);
    };

    // ---------- Toolbar discovery ----------
    S.getMainToolbar = () =>
        S.$$first([
            '.pr-toolbar[data-target="diff-layout.diffToolbar"]',
            '.js-pr-toolbar',
            '[data-testid="pr-toolbar"]',
            'div[role="toolbar"][data-view-component="true"]',
            'div[aria-label="Pull request toolbar"]',
        ]);

    S.getToolbarControlsRow = (toolbarEl) => {
        if (!toolbarEl) return null;
        return (
            toolbarEl.querySelector('.flex-auto.min-width-0 > .d-flex.flex-items-center.flex-wrap') ||
            toolbarEl.querySelector('.diffbar .d-flex.flex-items-center.flex-wrap') ||
            toolbarEl.querySelector('[data-view-component="true"].d-flex.flex-items-center.flex-wrap') ||
            toolbarEl.querySelector('.d-flex.flex-items-center.flex-wrap') ||
            toolbarEl
        );
    };

    // ---------- Octicons & Buttons ----------
    S.octicon = function octicon(name) {
        const pathMap = {
            file: 'M3 2.75A.75.75 0 0 1 3.75 2h5.5a.75.75 0 0 1 .53.22l3 3a.75.75 0 0 1 .22.53v7.5A1.75 1.75 0 0 1 11.25 15H4.75A1.75 1.75 0 0 1 3 13.25Zm1 .75v9.75c0 .138.112.25.25.25h6.5c.138 0 .25-.112.25-.25V6.5H9.5a1 1 0 0 1-1-1V3.5H4.25a.25.25 0 0 0-.25.25Zm6 .25V5.5h1.5Z',
            graph: 'M1.75 2.5a.75.75 0 0 0 0 1.5h.443l2.168 5.42a.75.75 0 0 0 1.388 0l1.07-2.675 1.094 3.283a.75.75 0 0 0 1.4.12L12.1 5h2.15a.75.75 0 0 0 0-1.5h-2.6a.75.75 0 0 0-.659.393L9.5 7.4 8.37 4.06a.75.75 0 0 0-1.4-.06L5.7 6.953 3.93 2.9A.75.75 0 0 0 3.2 2.5Z',

            // NEW: specific Octicons you requested
            // check-circle (success)
            'check-circle': 'M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14Zm3.78-8.72a.75.75 0 0 1 0 1.06l-4 4a.75.75 0 0 1-1.06 0l-2-2a.75.75 0 1 1 1.06-1.06L7 9.94l3.22-3.22a.75.75 0 0 1 1.06 0Z',

            // alert (failure)
            alert: 'M7.53 1.21a1 1 0 0 1 1.94 0l6.17 11.94A1 1 0 0 1 14.76 15H1.24a1 1 0 0 1-.88-1.85L7.53 1.21zM8 5a.75.75 0 0 0-.75.82l.25 3a.5.5 0 0 0 1 0l.25-3A.75.75 0 0 0 8 5zm0 6a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',

            // circle-slash (neutral/no changes)
            'circle-slash': 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm3.182 2.318a5 5 0 0 1 .768 6.14L4.042 2.05A5 5 0 0 1 11.182 3.818ZM2.05 4.042l7.296 7.296A5 5 0 0 1 2.05 4.042Z'
        };
        const d = pathMap[name] || pathMap.file;
        return `<svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16" style="vertical-align: text-bottom; fill: currentColor;"><path d="${d}"></path></svg>`;
    };

    S.ensureBtn = function ensureBtn(parent, id, labelHtml, onClick, extraClass = '') {
        if (!parent) return null;
        let btn = parent.querySelector(`#${id}`);
        if (btn) return btn;
        btn = document.createElement('button');
        btn.id = id;
        btn.type = 'button';
        btn.className = `btn btn-sm striffs-local-btn ${extraClass}`.trim();
        btn.style.margin = '0';
        btn.innerHTML = labelHtml;
        btn.addEventListener('click', (e) => { e.preventDefault(); onClick?.(e); });
        parent.appendChild(btn);
        return btn;
    };

    // Simple mount: add 2 buttons at the right end of the main toolbar
    S.mountMainBarButtons = function mountMainBarButtons() {
        const toolbar = S.getMainToolbar();
        if (!toolbar) return;

        const row = S.getToolbarControlsRow(toolbar) || toolbar;

        // Slot container appended at the end
        let slot = row.querySelector('#striffs-toolbar-slot');
        if (!slot) {
            slot = document.createElement('span');
            slot.id = 'striffs-toolbar-slot';
            slot.style.display = 'inline-flex';
            slot.style.gap = '6px';
            slot.style.alignItems = 'center';
            slot.style.marginLeft = '8px';
            row.appendChild(slot);
        }

        const onDiffClick = () => {
            S.showDiffView();
            S.setActiveButtons('diffs');
            S.saveActiveTab('diffs');
        };

        const onStriffClick = async () => {
            const { updated_at } = S.extractPRMetadata();
            const needsRefetch = !S.__striffsReady || (S.__lastFetchedUpdatedAt && S.__lastFetchedUpdatedAt !== updated_at);

            if (needsRefetch) {
                S.updateStriffButton({ loading: true, tooltip: "Generating Striffs…", phase: "Analyzing files..." });
                const ok = await S.autoFetchStriffs();

                // autoFetchStriffs now sets the correct button state and S.__striffsReady
                if (!ok) return;

                // Only switch to Striffs if a diagram actually exists
                if (S.__striffsReady) {
                    S.showStriffView();
                    S.setActiveButtons('striffs');
                    S.saveActiveTab('striffs');
                }
            } else {
                // Already ready with a diagram, show it
                S.showStriffView();
                S.setActiveButtons('striffs');
                S.saveActiveTab('striffs');
            }
        };

        S.ensureBtn(
            slot,
            'diffs-btn',
            `${S.octicon('file')}<span class="striffs-local-btn-label"> Diffs</span>`,
            onDiffClick
        );
        S.ensureBtn(
            slot,
            'striffs-btn',
            `${S.octicon('graph')}<span class="striffs-local-btn-label"> Striffs</span>`,
            onStriffClick
        );
    };

    // Button state / label updater (now with explicit Octicons + colors)
    S.updateStriffButton = function updateStriffButton({
        loading = false,
        success = false,
        failure = false,
        disabled = false,
        neutral = false, // “valid but no diagram”
        tooltip = "",
        phase = ""
    }) {
        const btn = document.querySelector("#striffs-btn");
        if (!btn) return;

        // cleanup state classes
        btn.classList.remove('is-error');

        // Compute final disabled
        const isDisabled = disabled || loading || failure || neutral;
        btn.disabled = isDisabled;
        btn.title = tooltip || "";

        const iconWrap = (svg, colorVar) =>
            `<span class="striffs-status" style="display:inline-flex;align-items:center;justify-content:center;color: var(${colorVar});">${svg}</span>`;

        if (loading) {
            const phaseText = phase ? ` ${phase}` : " Loading...";
            btn.innerHTML =
                `<span class="loader" style="display:inline-block;width:16px;height:16px;border:2px solid var(--borderColor-muted, var(--color-border-default, #ccc));border-top:2px solid var(--accent-fg, #0969da);border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;"></span>${phaseText}`;
            return;
        }

        if (failure) {
            btn.classList.add('is-error');
            const icon = iconWrap(S.octicon('alert'), '--color-danger-fg, #d1242f');
            btn.innerHTML = `${icon}<span class="striffs-local-btn-label">Striffs</span>`;
            return;
        }

        if (neutral) {
            // Gray/neutral state: “no changes found”
            const icon = iconWrap(S.octicon('circle-slash'), '--fgColor-muted, #6e7781');
            btn.innerHTML = `${icon}<span class="striffs-local-btn-label">Striffs</span>`;
            return;
        }

        if (success) {
            const icon = iconWrap(S.octicon('check-circle'), '--success-fg, var(--color-success-fg, #1a7f37)');
            btn.innerHTML = `${icon}<span class="striffs-local-btn-label">Striffs</span>`;
            return;
        }

        if (disabled) {
            const icon = iconWrap(S.octicon('circle-slash'), '--fgColor-muted, #6e7781');
            btn.innerHTML = `${icon}<span class="striffs-local-btn-label">Striffs</span>`;
            return;
        }

        // Default state
        btn.innerHTML = `${S.octicon('graph')}<span class="striffs-local-btn-label"> Striffs</span>`;
    };

    // --- Global toast helpers (theme-aware) ---
    S.ensureGlobalToast = function ensureGlobalToast() {
        let t = document.getElementById('striffs-global-toast');
        if (t) return t;
        t = document.createElement('div');
        t.id = 'striffs-global-toast';
        t.setAttribute('aria-live', 'polite');
        t.setAttribute('role', 'status');
        t.style.pointerEvents = 'none';
        document.body.appendChild(t);
        return t;
    };

    S.toast = function toast(message, type = 'info', { timeoutMs = 7500 } = {}) { // default 7.5s
        S.ensureGlobalToast();

        const el = document.createElement('div');
        el.className = `striffs-toast-item striffs-toast-${type}`;
        el.innerHTML = `
    <span class="striffs-toast-dot" aria-hidden="true"></span>
    <div class="striffs-toast-msg">${message}</div>
  `;

        const host = document.getElementById('striffs-global-toast');
        host.appendChild(el);

        requestAnimationFrame(() => el.classList.add('show'));

        const remove = () => {
            el.classList.remove('show');
            setTimeout(() => el.remove(), 240);
        };
        const t = setTimeout(remove, Math.max(7500, timeoutMs)); // enforce ≥7.5s
        el.addEventListener('click', () => { clearTimeout(t); remove(); }, { passive: true });
    };

    // Compute and set #striff-diagram-view height to fill remaining viewport
    S.resizeStriffView = function resizeStriffView(marginPx = 16) {
        const el = document.getElementById('striff-diagram-view');
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const avail = Math.max(200, window.innerHeight - rect.top - marginPx);
        el.style.height = `${avail}px`;
    };

    S.addSpinAnimation = function addSpinAnimation() {
        if (S.__styleInjected) return;
        const style = document.createElement("style");
        style.id = "striffs-style";
        style.textContent = `
  @keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}

  .striffs-local-btn {
    color: var(--fgColor-default, var(--color-fg-default, #24292f));
    background: var(--button-default-bgColor-rest, var(--color-btn-bg, #f6f8fa));
    border: 1px solid var(--borderColor-muted, var(--color-border-default, #d0d7de));
    line-height: 20px;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 2px 5px;
    border-radius: 6px;
    transition: background-color .12s ease, border-color .12s ease, color .12s ease;
  }
  .striffs-local-btn:hover {
    background: var(--button-default-bgColor-hover, var(--color-btn-hover-bg, #eef1f4));
    text-decoration: none;
  }
  .striffs-local-btn:disabled {
    opacity: .75;
    cursor: not-allowed;
    filter: grayscale(0.2);
  }

  /* Toast container + larger, more prominent items */
  #striffs-global-toast {
    position: fixed;
    top: 14px;
    right: 14px;
    z-index: 999999;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .striffs-toast-item {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: min(640px, 92vw);
    padding: 12px 14px;
    border-radius: 10px;
    box-shadow: 0 4px 16px rgba(0,0,0,.22);
    border: 1px solid var(--borderColor-muted, var(--color-border-default, #d0d7de));
    background: var(--bgColor-default, var(--color-canvas-default, #fff));
    color: var(--fgColor-default, var(--color-fg-default, #24292f));
    transform: translateY(-8px);
    opacity: 0;
    transition: opacity .2s ease, transform .2s ease, background-color .18s ease, border-color .18s ease;
    font-size: 14px;
    font-weight: 500;
  }
  .striffs-toast-item.show {
    transform: translateY(0);
    opacity: 1;
  }

  .striffs-toast-dot {
    width: 10px; height: 10px; border-radius: 50%;
    flex: 0 0 10px;
  }
  .striffs-toast-info     { border-color: var(--accent-fg, var(--color-accent-fg, #0969da)); }
  .striffs-toast-info .striffs-toast-dot { background: var(--accent-fg, var(--color-accent-fg, #0969da)); }

  .striffs-toast-success  { border-color: var(--success-fg, var(--color-success-fg, #1a7f37)); }
  .striffs-toast-success .striffs-toast-dot { background: var(--success-fg, var(--color-success-fg, #1a7f37)); }

  .striffs-toast-error    { border-color: var(--borderColor-danger, var(--color-danger-fg, #d1242f)); }
  .striffs-toast-error .striffs-toast-dot { background: var(--borderColor-danger, var(--color-danger-fg, #d1242f)); }

  /* neutral (gray) variant for “no changes” etc. */
  .striffs-toast-neutral  { border-color: var(--borderColor-muted, var(--color-border-default, #8b949e)); }
  .striffs-toast-neutral .striffs-toast-dot { background: var(--borderColor-muted, var(--color-border-default, #8b949e)); }

  /* Pressed/active look */
  .striffs-local-btn.is-active {
    color: var(--accent-fg, var(--color-accent-fg, #0969da));
    border-color: var(--accent-fg, var(--color-accent-fg, #0969da));
    background: color-mix(in srgb, var(--accent-fg, #0969da) 12%, transparent);
  }

  /* Error state */
  .striffs-local-btn.is-error {
    color: var(--fgColor-default, var(--color-fg-default, #24292f));
    border-color: var(--borderColor-danger, var(--color-danger-fg, #d1242f));
    background: color-mix(in srgb, var(--borderColor-danger, #d1242f) 12%, transparent);
  }

  /* View + SVG styles — container fills remaining viewport via JS */
  #striff-diagram-view{
    min-height: 50vh;
    overflow: hidden;
    position: relative;
    width: 100%;
    border: 1px solid #444; /* solid dark gray border */
  }
  #striff-diagram-view .striff-svg-wrap{
    position: relative;
    width: 100%;
    height: 100%;
  }
  #striff-diagram-view svg{
    width: 100%;
    height: 100%;
    display: block;
    cursor: move;
  }
  .striffs-hoverable{outline:none}
  .striffs-hoverable:hover{filter:drop-shadow(0 0 2px #1a73e8)}
  .striffs-focused{outline:2px solid #1a73e8;outline-offset:2px}
  #striffs-toast{position:absolute;top:6px;left:8px;background:var(--bgColor-default, #fff);border:1px solid #f0a3a3;color:#b00020;padding:6px 10px;border-radius:6px;font-size:12px;box-shadow:0 1px 4px rgba(0,0,0,.08);opacity:0;transition:opacity .2s}
  #striffs-toast.show{opacity:1}
  `;
        document.head.appendChild(style);
        S.__styleInjected = true;
    };

    S.setActiveButtons = function setActiveButtons(which /* 'diffs' | 'striffs' */) {
        const diffs = document.querySelector('#diffs-btn');
        const striffs = document.querySelector('#striffs-btn');
        diffs?.classList.remove('is-active');
        striffs?.classList.remove('is-active');

        const id = which === 'diffs' ? '#diffs-btn' : '#striffs-btn';
        const btn = document.querySelector(id);
        if (btn) btn.classList.add('is-active');
    };

    // ---------- Containers / Show-Hide ----------
    S.getFilesWrapper = () =>
        S.$$first([
            '#files',
            'div[data-testid="files-changed"]',
            'div[data-view-component="true"][data-testid="pull-requests-files"]',
            'main[aria-label="Content"] #files',
        ]);

    S.ensureStriffContainer = () => {
        let striffView = document.getElementById("striff-diagram-view");
        if (!striffView) {
            const filesWrapper = S.getFilesWrapper();
            if (!filesWrapper) return null;
            striffView = document.createElement("div");
            striffView.id = "striff-diagram-view";
            striffView.style.marginTop = "20px";
            striffView.style.display = "none";
            striffView.innerHTML = `<div id="striffs-toast" role="status" aria-live="polite"></div><p>Loading Striffs...</p>`;
            filesWrapper.appendChild(striffView);
        } else if (!striffView.querySelector("#striffs-toast")) {
            striffView.insertAdjacentHTML("afterbegin", `<div id="striffs-toast" role="status" aria-live="polite"></div>`);
        }
        return striffView;
    };

    const DIFF_CONTAINERS_SELECTORS = [
        ".js-diff-progressive-container",
        '[data-testid="file-diff-split"]',
        '[data-testid="file-diff-unified"]',
        'div.js-file[data-file-type="file"]',
    ];

    S.hideAllDiffs = () => S.$$all(DIFF_CONTAINERS_SELECTORS).forEach(el => { el.style.display = "none"; });
    S.showAllDiffs = () => S.$$all(DIFF_CONTAINERS_SELECTORS).forEach(el => { el.style.display = "block"; });

    S.showDiffView = () => {
        S.showAllDiffs();
        const striffView = document.getElementById("striff-diagram-view");
        if (striffView) striffView.style.display = "none";
        S.setActiveButtons('diffs');
    };

    S.showStriffView = () => {
        S.hideAllDiffs();
        const striffView = S.ensureStriffContainer();
        if (striffView) {
            striffView.style.display = "block";
            S.resizeStriffView();
            requestAnimationFrame(() => {
                if (S.__striffsSvg && S.__striffsPanzoom) S.fitSvgToContainer(S.__striffsSvg, S.__striffsPanzoom);
            });
        }
        S.setActiveButtons('striffs');
    };

    S.saveActiveTab = (tabName) => {
        try { chrome.storage.local.set({ striffsActiveTab: tabName }); } catch (e) { cwarn('saveActiveTab failed', e); }
    };

    S.getSavedActiveTab = async () =>
        new Promise((resolve) => {
            try {
                chrome.storage.local.get(["striffsActiveTab"], (result) => resolve(result?.striffsActiveTab || "diffs"));
            } catch {
                resolve("diffs");
            }
        });
})();
