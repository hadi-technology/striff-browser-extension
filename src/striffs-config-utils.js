const LANG_TO_EXT = {
  java: "java",
  golang: "go",
  go: "go",
  javascript: "js",
  typescript: "ts",
  python: "py",
  csharp: "cs",
  cpp: "cpp",
  cplusplus: "cpp",
  ruby: "rb",
  rust: "rs",
  php: "php",
  kotlin: "kt"
};

function parseLangsToExts(text) {
  const langs = String(text || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return langs.map((lang) => LANG_TO_EXT[lang]).filter(Boolean);
}

function normalizeExtensions(exts) {
  if (!Array.isArray(exts)) return [];
  return exts
    .map((ext) => String(ext || '').trim().toLowerCase())
    .map((ext) => (ext.startsWith('.') ? ext.slice(1) : ext))
    .filter(Boolean);
}

function extractSupportedExtensionsFromConfig(cfg) {
  if (!cfg) return [];
  const byExt = normalizeExtensions(cfg.supportedExtensions);
  if (byExt.length) return byExt;
  const byLang = typeof cfg.supportedLanguages === 'string' ? parseLangsToExts(cfg.supportedLanguages) : [];
  return normalizeExtensions(byLang);
}

if (typeof globalThis !== 'undefined' && globalThis.StriffsConfigUtils) {
  // Already loaded — skip re-declaration on SPA re-injection
} else {
  const api = {
    extractSupportedExtensionsFromConfig,
    normalizeExtensions,
    parseLangsToExts
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  if (typeof globalThis !== 'undefined') {
    globalThis.StriffsConfigUtils = api;
  }
}
