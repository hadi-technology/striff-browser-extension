const test = require('node:test');
const assert = require('node:assert/strict');

const { stripInvalidXmlChars } = require('../src/plantuml-utils.js');

// Regression: the subdiagram render for a component whose doc text contained a
// control byte came back with `&#8;` (backspace) in an SVG <text> element.
// That reference is illegal in XML, so the preview panel's strict SVG parse
// aborted mid-document and the component rendered as a bare class rectangle
// with no members.
test('stripInvalidXmlChars removes control-character references, decimal and hex', () => {
  assert.equal(
    stripInvalidXmlChars('Authentication&#8; decorator'),
    'Authentication decorator'
  );
  assert.equal(stripInvalidXmlChars('a&#x8;b&#x1F;c&#0;d'), 'abcd');
});

test('stripInvalidXmlChars keeps legal character references', () => {
  const s = 'nbsp:&#160; copy:&#xA9; lf:&#10; tab:&#9; cr:&#13;';
  assert.equal(stripInvalidXmlChars(s), s);
});

test('stripInvalidXmlChars removes raw control bytes but keeps tab/LF/CR', () => {
  assert.equal(stripInvalidXmlChars('a\bbcd'), 'abcd');
  assert.equal(stripInvalidXmlChars('a\tb\nc\rd'), 'a\tb\nc\rd');
});

test('stripInvalidXmlChars removes DEL, C1 controls, and XML noncharacters', () => {
  assert.equal(stripInvalidXmlChars('a\u007Fb\u0085c\u009Fd'), 'abcd');
  assert.equal(stripInvalidXmlChars('a\uFFFEb\uFFFFc'), 'abc');
  assert.equal(stripInvalidXmlChars('a&#x7F;b&#x9F;c&#xFFFE;d&#xFFFF;e'), 'abcde');
});

test('stripInvalidXmlChars removes lone surrogates but keeps valid pairs', () => {
  assert.equal(stripInvalidXmlChars('a\uD800b\uDC00c'), 'abc');
  assert.equal(stripInvalidXmlChars('a&#xD800;b&#xDFFF;c'), 'abc');
  const emoji = 'doc 😀 text';
  assert.equal(stripInvalidXmlChars(emoji), emoji);
});

test('stripInvalidXmlChars leaves ordinary SVG markup untouched', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text x="1" y="2">getName() : String</text></svg>';
  assert.equal(stripInvalidXmlChars(svg), svg);
  assert.equal(stripInvalidXmlChars(''), '');
  assert.equal(stripInvalidXmlChars(null), '');
});
