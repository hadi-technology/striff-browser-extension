// zip-filter-utils.js — decide which files of a repository archive are worth uploading.
//
// The extension downloads a whole repository ZIP from codeload and posts it to the API, but only a
// fraction of it is ever read: source files clarpse can parse, documentation the rule catalog is
// built from, and a handful of build manifests TypeScript needs to resolve imports. Everything else
// -- screenshots, binaries, vendored trees -- is uploaded, spooled, scanned and discarded. On one
// measured repository that was 937MiB of archive to deliver 12MiB of content.
//
// The rules are NOT authored here. They are served by GET /api/v1/zip-filter so the client and the
// server cannot drift: a client filtering by its own private copy would omit a file the analysis
// needed, the analysis would still complete, and a degraded result is indistinguishable from a good
// one. DEFAULT_MANIFEST below is a fallback for when that call fails, not a second source of truth.
(function (root) {
  'use strict';

  // Mirrors the server's manifest at version 1. Used only when the endpoint cannot be reached --
  // a network failure must not mean uploading a 937MiB archive that will be refused anyway.
  const DEFAULT_MANIFEST = {
    version: 1,
    sourceExtensions: ['cs', 'java', 'py', 'ts', 'tsx'],
    docExtensions: ['adoc', 'md', 'mdx', 'rst'],
    supportFileGlobs: [
      '**/package.json',
      '**/jsconfig.json',
      '**/tsconfig.json',
      '**/tsconfig.*.json',
      '**/__init__.py'
    ],
    excludedPathSegments: ['/node_modules/', '/vendor/', '/target/', '/dist/'],
    maxUploadBytes: 15728640
  };

  const MANIFEST_TTL_MS = 60 * 60 * 1000;

  function normalizePath(path) {
    const lower = String(path || '').replace(/\\/g, '/').toLowerCase();
    return lower.startsWith('/') ? lower : '/' + lower;
  }

  function extensionOf(path) {
    const base = normalizePath(path).split('/').pop();
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(dot + 1) : '';
  }

  // Only the two glob shapes the manifest actually uses -- `**/name` and `**/pre.*.suf`. A general
  // glob engine would be more code and more ways to disagree with the server's regex.
  function globToRegExp(glob) {
    // `**/` becomes a placeholder BEFORE single `*` is expanded. Substituting `(?:.*/)?` first
    // put a `*` into the output that the next replace then rewrote to `[^/]*`, collapsing
    // "any number of directories" into "exactly one" -- so `**/tsconfig.json` matched a
    // root-level file and missed every nested one. Caught by the nested-path test.
    const DIRS = '\u0000';
    const escaped = String(glob)
      .replace(/\*\*\//g, DIRS)
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .split(DIRS).join('(?:.*/)?');
    return new RegExp('^/?' + escaped + '$', 'i');
  }

  function compile(manifest) {
    const m = manifest && typeof manifest === 'object' ? manifest : DEFAULT_MANIFEST;
    const source = new Set((m.sourceExtensions || []).map((e) => String(e).toLowerCase()));
    const docs = new Set((m.docExtensions || []).map((e) => String(e).toLowerCase()));
    const globs = (m.supportFileGlobs || []).map(globToRegExp);
    const excluded = (m.excludedPathSegments || []).map((s) => String(s).toLowerCase());

    return function keep(path) {
      if (!path || path.endsWith('/')) return false;
      const p = normalizePath(path);
      for (const segment of excluded) {
        if (p.indexOf(segment) !== -1) return false;
      }
      const ext = extensionOf(p);
      if (source.has(ext) || docs.has(ext)) return true;
      return globs.some((re) => re.test(p));
    };
  }

  // Fetched once per TTL rather than per upload. Cached in storage rather than in a module variable
  // because an MV3 service worker is evicted between requests, so a memory cache would never hit.
  async function loadManifest(apiBase, { fetchImpl, storage, now } = {}) {
    const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    const store = storage || (typeof chrome !== 'undefined' ? chrome.storage?.local : null);
    const clock = now || Date.now;

    try {
      const cached = store ? await store.get(['striffsZipFilterManifest']) : null;
      const entry = cached && cached.striffsZipFilterManifest;
      if (entry && entry.manifest && clock() - entry.fetchedAt < MANIFEST_TTL_MS) {
        return { manifest: entry.manifest, source: 'cache' };
      }
    } catch (_) { /* fall through to the network */ }

    try {
      const res = await doFetch(String(apiBase).replace(/\/+$/, '') + '/api/v1/zip-filter');
      if (res && res.ok) {
        const manifest = await res.json();
        if (manifest && Array.isArray(manifest.sourceExtensions) && manifest.sourceExtensions.length) {
          try {
            if (store) {
              await store.set({
                striffsZipFilterManifest: { manifest, fetchedAt: clock() }
              });
            }
          } catch (_) { /* caching is an optimisation, not a requirement */ }
          return { manifest, source: 'network' };
        }
      }
    } catch (_) { /* fall through to the default */ }

    // Deliberately NOT "upload everything". An unfiltered archive is refused by the server's
    // ceiling anyway, so failing open would turn a manifest outage into a total outage; failing
    // onto a known-good copy of the rules degrades to "possibly slightly stale" instead.
    return { manifest: DEFAULT_MANIFEST, source: 'default' };
  }

  /**
   * Repack `arrayBuffer` keeping only the files the manifest says are read.
   *
   * Returns { ok, buffer, keptCount, totalCount, bytesBefore, bytesAfter } — or
   * { ok: false, reason } when fflate is unavailable or the archive cannot be read, in which case
   * the caller should send the original rather than nothing.
   */
  function filterZip(arrayBuffer, manifest, { fflateImpl } = {}) {
    const lib = fflateImpl || (typeof root !== 'undefined' ? root.fflate : null);
    if (!lib || typeof lib.unzipSync !== 'function' || typeof lib.zipSync !== 'function') {
      return { ok: false, reason: 'fflate-unavailable' };
    }
    const keep = compile(manifest);
    const input = new Uint8Array(arrayBuffer);
    let total = 0;
    try {
      // fflate's filter runs before inflation, so a 478MiB tree of screenshots is never
      // decompressed -- which is what keeps this affordable inside a service worker.
      const kept = lib.unzipSync(input, {
        filter: (file) => {
          total += 1;
          return keep(file.name);
        }
      });
      const out = lib.zipSync(kept, { level: 6 });
      return {
        ok: true,
        buffer: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength),
        keptCount: Object.keys(kept).length,
        totalCount: total,
        bytesBefore: input.byteLength,
        bytesAfter: out.byteLength
      };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  }

  const api = {
    DEFAULT_MANIFEST,
    MANIFEST_TTL_MS,
    compile,
    loadManifest,
    filterZip,
    globToRegExp,
    normalizePath,
    extensionOf
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.StriffsZipFilterUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
