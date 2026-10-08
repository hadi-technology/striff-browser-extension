/**
 * A document's sentence as HTML a reader should see: its inline Markdown read, never shown as marks,
 * and every character of it escaped.
 *
 * The server sends a document's own words, Markdown and all, and the words a rule checks as UTF-16
 * offsets into that raw string (checkedFrom/checkedTo). The raw text is read once into visible
 * characters, each remembering its raw offset and the styles covering it, so the checked span is
 * applied per character: a span starting inside "**A b**", or straddling it, splits the bold run
 * into styled pieces and never cuts a pair of marks.
 *
 * Read: backslash escapes, code spans, links and images inline or by reference (their text, never
 * their target), strong and emphasis with `*` and `_` (`_` not inside a word). Anything unmatched is
 * shown as the character it is.
 */
(function (root) {
  const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
  const isWord = c => c !== undefined && /[\p{L}\p{N}]/u.test(c);
  const isSpace = c => c === undefined || /\s/.test(c);

  function parseInline(raw) {
    const text = raw || "";
    const out = [];
    read(text, 0, text.length, { strong: false, em: false }, out);
    return out;
  }

  function read(raw, from, to, style, out) {
    let i = from;
    while (i < to) {
      const c = raw[i];
      if (c === "\\" && i + 1 < to && PUNCTUATION.test(raw[i + 1])) {
        out.push(char(raw[i + 1], i + 1, style, false));
        i += 2;
        continue;
      }
      if (c === "`") {
        const code = codeSpan(raw, i, to);
        if (code) {
          for (let k = code.contentFrom; k < code.contentTo; k++) out.push(char(raw[k], k, style, true));
          i = code.next;
          continue;
        }
        while (i < to && raw[i] === "`") out.push(char("`", i++, style, false));
        continue;
      }
      if (c === "[" || (c === "!" && raw[i + 1] === "[")) {
        const link = linkAt(raw, c === "!" ? i + 1 : i, to);
        if (link) {
          read(raw, link.textFrom, link.textTo, style, out);
          i = link.next;
          continue;
        }
      }
      if (c === "*" || c === "_") {
        const span = emphasisAt(raw, i, from, to);
        if (span) {
          read(raw, span.contentFrom, span.contentTo,
            { strong: style.strong || span.strong, em: style.em || span.em }, out);
          i = span.next;
          continue;
        }
      }
      out.push(char(c, i, style, false));
      i += 1;
    }
  }

  function char(ch, at, style, code) {
    return { ch, at, strong: style.strong, em: style.em, code };
  }

  function codeSpan(raw, at, to) {
    let n = 0;
    while (at + n < to && raw[at + n] === "`") n++;
    let j = at + n;
    while (j < to) {
      if (raw[j] !== "`") { j++; continue; }
      let m = 0;
      while (j + m < to && raw[j + m] === "`") m++;
      if (m === n) {
        let contentFrom = at + n;
        let contentTo = j;
        if (contentTo - contentFrom >= 2 && raw[contentFrom] === " " && raw[contentTo - 1] === " "
            && raw.slice(contentFrom, contentTo).trim()) {
          contentFrom++;
          contentTo--;
        }
        return { contentFrom, contentTo, next: j + m };
      }
      j += m;
    }
    return null;
  }

  function linkAt(raw, at, to) {
    let depth = 0;
    let close = -1;
    for (let j = at; j < to; j++) {
      if (raw[j] === "\\") { j++; continue; }
      if (raw[j] === "`") {
        const code = codeSpan(raw, j, to);
        if (code) { j = code.next - 1; continue; }
      }
      if (raw[j] === "[") depth++;
      if (raw[j] === "]" && --depth === 0) { close = j; break; }
      if (raw[j] === "\n") return null;
    }
    if (close < 0 || close + 1 >= to) return null;
    const closer = raw[close + 1] === "(" ? ")" : raw[close + 1] === "[" ? "]" : null;
    if (!closer) return null;
    for (let j = close + 2; j < to; j++) {
      if (raw[j] === "\n") return null;
      if (raw[j] === closer) return { textFrom: at + 1, textTo: close, next: j + 1 };
    }
    return null;
  }

  function emphasisAt(raw, at, from, to) {
    const d = raw[at];
    let n = 0;
    while (at + n < to && raw[at + n] === d) n++;
    if (isSpace(raw[at + n])) return null;
    if (d === "_" && isWord(at > from ? raw[at - 1] : undefined)) return null;
    for (const size of n >= 3 ? [3, 2, 1] : n === 2 ? [2, 1] : [1]) {
      const close = closerOf(raw, d, size, at + size, to);
      if (close >= 0) {
        return { contentFrom: at + size, contentTo: close, next: close + size,
          strong: size >= 2, em: size !== 2 };
      }
    }
    return null;
  }

  function closerOf(raw, d, size, from, to) {
    for (let j = from; j < to; j++) {
      const c = raw[j];
      if (c === "\\") { j++; continue; }
      if (c === "`") {
        const code = codeSpan(raw, j, to);
        if (code) { j = code.next - 1; continue; }
      }
      if (c !== d) continue;
      let m = 0;
      while (j + m < to && raw[j + m] === d) m++;
      if (m >= size && !isSpace(raw[j - 1]) && j > from && !(d === "_" && isWord(raw[j + m]))) {
        return j + m - size;
      }
      j += m - 1;
    }
    return -1;
  }

  function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /**
   * The sentence as escaped HTML: code in <code>, bold in <strong>, emphasis in <em>, and the words
   * the rule checks in <strong class="…__checked">, where the span fits the sentence.
   *
   * @param {string} raw the sentence as the server sent it
   * @param {{checkedFrom?: number|null, checkedTo?: number|null, codeClass?: string,
   *     checkedClass?: string}} options
   */
  function inlineMarkdownHtml(raw, options = {}) {
    const chars = parseInline(raw);
    const { checkedFrom, checkedTo } = options;
    const fits = Number.isInteger(checkedFrom) && Number.isInteger(checkedTo) && checkedFrom >= 0
      && checkedTo > checkedFrom && checkedTo <= (raw || "").length;
    const runs = [];
    for (const c of chars) {
      const checked = fits && c.at >= checkedFrom && c.at < checkedTo;
      const last = runs[runs.length - 1];
      if (last && last.strong === c.strong && last.em === c.em && last.code === c.code
          && last.checked === checked) {
        last.text += c.ch;
      } else {
        runs.push({ text: c.ch, strong: c.strong, em: c.em, code: c.code, checked });
      }
    }
    const codeClass = options.codeClass ? ` class="${escHtml(options.codeClass)}"` : "";
    const checkedClass = options.checkedClass ? ` class="${escHtml(options.checkedClass)}"` : "";
    return runs.map(run => {
      let html = escHtml(run.text);
      if (run.code) html = `<code${codeClass}>${html}</code>`;
      if (run.em) html = `<em>${html}</em>`;
      if (run.strong) html = `<strong>${html}</strong>`;
      if (run.checked) html = `<strong${checkedClass}>${html}</strong>`;
      return html;
    }).join("");
  }

  const api = { parseInline, inlineMarkdownHtml };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.StriffsInlineMarkdown = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : null);
