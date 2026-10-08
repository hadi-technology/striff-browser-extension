const test = require('node:test');
const assert = require('node:assert/strict');

const { inlineMarkdownHtml } = require('../src/inline-markdown-utils.js');

const html = (raw, options) => inlineMarkdownHtml(raw, { checkedClass: 'k', ...options });

test('no Markdown mark reaches the HTML, and the text is escaped', () => {
  assert.equal(html('**Bold** and _em_ and `<code>` and [a link](https://x.io/a_b) and [ref][r]'),
    '<strong>Bold</strong> and <em>em</em> and <code>&lt;code&gt;</code> and a link and ref');
});

test('escaped characters are shown as themselves', () => {
  assert.equal(html('a \\*star\\* and snake_case_name'), 'a *star* and snake_case_name');
});

test('a null span renders plain', () => {
  assert.equal(html('**A b** c', { checkedFrom: null, checkedTo: null }), '<strong>A b</strong> c');
});

test('a span starting inside a bold run splits it without breaking the pair', () => {
  const raw = '**A b** c';
  assert.equal(html(raw, { checkedFrom: raw.indexOf('b'), checkedTo: raw.length }),
    '<strong>A </strong><strong class="k"><strong>b</strong></strong><strong class="k"> c</strong>');
});

test('a span beside code and a link takes them whole', () => {
  const raw = 'Use [the `Gateway`](docs/gw.md) for calls, and log.';
  assert.equal(html(raw, { checkedFrom: raw.indexOf('['), checkedTo: raw.indexOf(',') }),
    'Use <strong class="k">the </strong><strong class="k"><code>Gateway</code></strong>'
      + '<strong class="k"> for calls</strong>, and log.');
});

test('a span that does not fit the text emphasises nothing', () => {
  assert.equal(html('abc', { checkedFrom: 1, checkedTo: 9 }), 'abc');
});
