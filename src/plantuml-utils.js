/**
 * PlantUML encoding/decoding utility.
 *
 * PlantUML encodes diagram source using:
 *   1. UTF-8 encode
 *   2. Raw Deflate compress (no zlib/gzip headers)
 *   3. Custom Base64 with alphabet: 0-9 A-Z a-z - _
 *
 * Uses browser-native CompressionStream / DecompressionStream (Chrome 110+)
 * so no external dependencies are needed.
 *
 * Exposes globalThis.StriffsPlantUmlUtils for content scripts.
 */

(() => {
  if (typeof globalThis !== 'undefined' && globalThis.StriffsPlantUmlUtils) return;

  // ── Custom Base64 ──────────────────────────────────────────────────────

  const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';

  function encode6bit(b) {
    if (b < 10) return String.fromCharCode(48 + b);
    if (b < 36) return String.fromCharCode(55 + b);
    if (b < 62) return String.fromCharCode(61 + b);
    return b === 62 ? '-' : '_';
  }

  function decode6bit(c) {
    const code = c.charCodeAt(0);
    if (c === '_') return 63;
    if (c === '-') return 62;
    if (code >= 97) return code - 61;
    if (code >= 65) return code - 55;
    if (code >= 48) return code - 48;
    return 0;
  }

  function plantumlEncode64(bytes) {
    let r = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const b1 = bytes[i];
      const b2 = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const b3 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      r += encode6bit(b1 >> 2);
      r += encode6bit(((b1 & 0x3) << 4) | (b2 >> 4));
      r += encode6bit(((b2 & 0xF) << 2) | (b3 >> 6));
      r += encode6bit(b3 & 0x3F);
    }
    return r;
  }

  function plantumlDecode64(encoded) {
    const bytes = [];
    for (let i = 0; i + 3 < encoded.length; i += 4) {
      const c1 = decode6bit(encoded[i]);
      const c2 = decode6bit(encoded[i + 1]);
      const c3 = decode6bit(encoded[i + 2]);
      const c4 = decode6bit(encoded[i + 3]);
      bytes.push((c1 << 2) | ((c2 >> 4) & 0x3));
      bytes.push(((c2 << 4) & 0xF0) | ((c3 >> 2) & 0xF));
      bytes.push(((c3 << 6) & 0xC0) | (c4 & 0x3F));
    }
    return new Uint8Array(bytes);
  }

  // ── Raw Deflate / Inflate ──────────────────────────────────────────────

  async function rawDeflate(bytes) {
    const ds = new CompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    writer.write(bytes);
    writer.close();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const result = new Uint8Array(total);
    let off = 0;
    for (const chunk of chunks) { result.set(chunk, off); off += chunk.length; }
    return result;
  }

  async function rawInflate(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    writer.write(bytes);
    writer.close();
    const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } catch (_) {
      // Trailing zero bytes from base64 padding can cause
      // "Junk after end of compressed data" — all valid
      // decompressed data has already been collected.
    }
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const result = new Uint8Array(total);
    let off = 0;
    for (const chunk of chunks) { result.set(chunk, off); off += chunk.length; }
    return result;
  }

  // ── Public API ─────────────────────────────────────────────────────────

  function decode(encoded) {
    let text = (encoded || '').trim();
    if (text.startsWith('~1')) text = text.slice(2);
    const compressed = plantumlDecode64(text);
    return rawInflate(compressed).then(buf => new TextDecoder().decode(buf));
  }

  function encode(source) {
    const utf8 = new TextEncoder().encode(source);
    return rawDeflate(utf8).then(plantumlEncode64);
  }

  function extractEncodedPuml(svgText) {
    const str = svgText || '';
    const startMarker = 'plantuml-src';
    const startIdx = str.lastIndexOf(startMarker);
    if (startIdx < 0) return null;
    // Skip marker + whitespace to reach the encoded payload
    let i = startIdx + startMarker.length;
    while (i < str.length && (str[i] === ' ' || str[i] === '\t' || str[i] === '\n' || str[i] === '\r')) i++;
    // Find end delimiter: ?> covers both <?plantuml-src ... ?> and <!--?plantuml-src ... ?-->
    let endIdx = str.indexOf('?>', i);
    if (endIdx < 0) return null;
    const encoded = str.slice(i, endIdx).trim();
    // Validate: only allowed chars
    if (!/^[0-9A-Za-z_-]+$/.test(encoded)) return null;
    return encoded || null;
  }

  function extractPuml(svgText) {
    const encoded = extractEncodedPuml(svgText);
    if (!encoded) return Promise.resolve(null);
    return decode(encoded);
  }

  function getRenderURL(source, format) {
    return encode(source).then(enc => `https://www.plantuml.com/plantuml/${format || 'svg'}/${enc}`);
  }

  const api = { decode, encode, extractEncodedPuml, extractPuml, getRenderURL };

  if (typeof globalThis !== 'undefined') {
    globalThis.StriffsPlantUmlUtils = api;
  }
})();
