const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractSupportedExtensionsFromConfig,
  normalizeExtensions,
  parseLangsToExts
} = require('../src/striffs-config-utils.js');

test('parseLangsToExts maps supported languages to extensions', () => {
  assert.deepEqual(parseLangsToExts('Java, TypeScript, Rust, Unknown'), ['java', 'ts', 'rs']);
});

test('normalizeExtensions lowercases and strips leading dots', () => {
  assert.deepEqual(normalizeExtensions(['.TS', ' py ', '', null]), ['ts', 'py']);
});

test('extractSupportedExtensionsFromConfig prefers explicit supportedExtensions', () => {
  assert.deepEqual(
    extractSupportedExtensionsFromConfig({ supportedExtensions: ['.MD', 'ts'] }),
    ['md', 'ts']
  );
});

test('extractSupportedExtensionsFromConfig falls back to supportedLanguages', () => {
  assert.deepEqual(
    extractSupportedExtensionsFromConfig({ supportedLanguages: 'Java, Python' }),
    ['java', 'py']
  );
});
