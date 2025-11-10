// Striffs — rendering & cache
(() => {
    const S = (window.Striffs = window.Striffs || {});
    const { cwarn, cerr } = S;

    // ---------- Validation ----------
    // Treat an empty 'striffs' array as a valid (no changes) response.
    S.isValidStriffsResult = (result) => {
        if (!result || typeof result !== "object") return false;
        if (result.error || result.message === "error") return false;
        if (!Array.isArray(result.striffs)) return false;
        return true;
    };

    // Ensure we have cssEscape on S (used by applyHoverability & other lookups)
    S.cssEscape = S.cssEscape || function cssEscape(id) {
        return String(id).replace(/(["\\\]])/g, "\\$1");
    };

    // Hoverability: make mapped <text id="..."> nodes pointer/keyboard-focusable
    S.applyHoverability = function applyHoverability() {
        if (!S.__striffsSvg) return;

        // clear old state
        S.__striffsSvg.querySelectorAll(".striffs-hoverable").forEach(n => {
            n.classList.remove("striffs-hoverable");
            n.removeAttribute("tabindex");
            n.removeAttribute("title");
            n.style.cursor = "";
        });

        const added = new Set();
        for (const [, id] of (S.__striffsPathToComponentId || new Map()).entries()) {
            if (added.has(id)) continue;
            const el = S.__striffsSvg.querySelector(`text[id="${S.cssEscape(id)}"]`);
            if (el) {
                el.classList.add("striffs-hoverable");
                el.style.cursor = "pointer";
                el.setAttribute("tabindex", "0");
                el.setAttribute("title", "View diffs");
                added.add(id);
            }
        }
    };

    // ---------- Cache ----------
    S.cacheKey = () => {
        const { owner, repo, pull_number } = S.extractPRMetadata();
        return `striffs:${owner}/${repo}#${pull_number}`;
    };

    S.primeDiagramFromCache = () => {
        try {
            const key = S.cacheKey();
            const raw = localStorage.getItem(key);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            const { updated_at } = S.extractPRMetadata();
            const freshUpdatedAt = parsed.updated_at === updated_at;
            const freshTime = (Date.now() - (parsed.savedAt || 0)) < S.CACHE_TTL_MS;
            if (freshUpdatedAt && freshTime && parsed.result && Array.isArray(parsed.result.striffs)) {
                const container = S.ensureStriffContainer();
                if (container) {
                    const rendered = S.renderStriffsInto(container, parsed.result);
                    if (rendered) {
                        S.__striffsReady = true;
                        S.__lastFetchedUpdatedAt = updated_at;
                        S.updateStriffButton({ success: true, tooltip: "Striffs loaded from cache. Click to view." });
                    }
                }
            }
        } catch (e) {
            cwarn('primeDiagramFromCache failed', e);
        }
    };

    S.storeDiagramInCache = (result) => {
        try {
            const key = S.cacheKey();
            const { updated_at } = S.extractPRMetadata();
            const payload = { updated_at, savedAt: Date.now(), result };
            localStorage.setItem(key, JSON.stringify(payload));
        } catch (e) {
            cwarn('storeDiagramInCache failed (quota?)', e);
        }
    };

    // ---------- SVG dimension sanitizer ----------
    S.sanitizeSvgDimensions = function sanitizeSvgDimensions(svg) {
        try {
            if (!svg) return;

            svg.removeAttribute('width');
            svg.removeAttribute('height');

            const style = svg.getAttribute('style') || '';
            if (style) {
                const cleaned = style
                    .replace(/(?:^|;)\s*width\s*:[^;]+;?/gi, ';')
                    .replace(/(?:^|;)\s*height\s*:[^;]+;?/gi, ';')
                    .replace(/^\s*;|;\s*$/g, '')
                    .replace(/\s*;;\s*/g, ';')
                    .trim();
                if (cleaned) svg.setAttribute('style', cleaned);
                else svg.removeAttribute('style');
            }

            if (!svg.hasAttribute('viewBox')) {
                const root = svg.querySelector('g') || svg;
                try {
                    const bbox = root.getBBox();
                    if (bbox && isFinite(bbox.width) && isFinite(bbox.height) && bbox.width > 0 && bbox.height > 0) {
                        svg.setAttribute('viewBox', `${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height}`);
                    }
                } catch (e) {
                    S.cwarn('sanitizeSvgDimensions: getBBox failed; leaving viewBox as-is', e);
                }
            }
        } catch (e) {
            S.cwarn('sanitizeSvgDimensions failed', e);
        }
    };

    // ---------- Rendering ----------
    const b64ToBytes = (b64) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

    S.renderStriffsInto = (target, data) => {
        if (!target) return false;
        target.innerHTML = `<div id="striffs-toast" role="status" aria-live="polite"></div><div id="striffs-status">Rendering diagram…</div>`;

        const items = Array.isArray(data?.striffs) ? data.striffs : [];

        // "No changes" case – valid, but nothing to render
        if (items.length === 0) {
            target.innerHTML = `<div id="striffs-toast" role="status" aria-live="polite"></div>`;
            S.updateStriffButton({ neutral: true, disabled: true, tooltip: "No changes were found" });
            S.toast?.("No changes were found.", "neutral", { timeoutMs: 5000 });
            return true;
        }

        for (const item of items) {
            try {
                let svgText = "";
                if (item.svgCode) {
                    svgText = item.svgCode;
                } else if (item.base64encodedSVGCode) {
                    svgText = atob(item.base64encodedSVGCode);
                } else if (item.gzippedBase64Svg) {
                    const raw = b64ToBytes(item.gzippedBase64Svg);
                    if (!window.fflate) throw new Error("fflate not loaded");
                    const u8 = window.fflate.gunzipSync(raw);
                    svgText = new TextDecoder("utf-8").decode(u8);
                } else {
                    continue;
                }
                target.innerHTML = `<div id="striffs-toast" role="status" aria-live="polite"></div><div id="striffs-status">Rendering diagram…</div>`;
                const wrap = document.createElement("div");
                wrap.className = "striff-svg-wrap";
                wrap.innerHTML = svgText;
                target.appendChild(wrap);

                const svg = wrap.querySelector("svg");
                if (svg) {
                    S.sanitizeSvgDimensions(svg);
                }

                if (svg && window.panzoom) {
                    const node = svg.querySelector("g") || svg;
                    S.__striffsPanzoom = window.panzoom(node, { contain: "inside", maxScale: 3, minScale: 0.5 });
                    S.__striffsSvg = svg;
                    S.fitSvgToContainer(svg, S.__striffsPanzoom);
                    S.buildPathIdMapping(data);
                    S.applyHoverability();
                }

                const s = document.getElementById("striffs-status");
                if (s) s.textContent = "Diagram ready.";
                setTimeout(() => s?.remove(), 800);
                return true;
            } catch (e) {
                cerr("Failed to decode/render SVG", e);
            }
        }

        target.innerHTML = `<div id="striffs-toast" role="status" aria-live="polite"></div><div style="color:#d1242f;">❌ Failed to render Striffs diagram.</div>`;
        return false;
    };

    S.fitSvgToContainer = (svg, pan) => {
        try {
            const striffView = document.getElementById("striff-diagram-view") || svg.parentElement;
            if (typeof S.resizeStriffView === 'function') S.resizeStriffView();
            const rect = striffView.getBoundingClientRect();
            const width  = rect.width  || striffView.clientWidth  || window.innerWidth  || 1200;
            const height = rect.height || striffView.clientHeight || window.innerHeight || 800;

            const root = svg.querySelector("g") || svg;
            const bbox = root.getBBox();
            const scale = Math.min(width / (bbox.width || 1), height / (bbox.height || 1)) * 0.95;
            pan.zoomAbs(0, 0, scale);
            const tx = width / 2 - (bbox.x + bbox.width / 2) * scale;
            const ty = height / 2 - (bbox.y + bbox.height / 2) * scale;
            pan.moveTo(tx, ty);
        } catch (e) {
            cwarn('fitSvgToContainer skipped', e);
        }
    };
})();
