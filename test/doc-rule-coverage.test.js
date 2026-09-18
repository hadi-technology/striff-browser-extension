const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// computeDocRuleCoverage is a pure function -- the findings button counts documented rules with it
// -- but it lives inside striffs.js, a content-script IIFE that touches window/document at load and
// so cannot be require()d in node. Extract just that function declaration from the source and
// evaluate it in a sandbox, so the test exercises the real shipped code rather than a copy.
function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `could not find ${name} in striffs.js`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'striffs.js'), 'utf8');
const sandbox = {};
vm.runInNewContext(
  `${extractFunction(src, 'computeDocRuleCoverage')}\nthis.computeDocRuleCoverage = computeDocRuleCoverage;`,
  sandbox
);
const { computeDocRuleCoverage: rawCoverage } = sandbox;
// rawCoverage returns an object from the vm realm, whose prototype is not this realm's
// Object.prototype -- strict deepEqual would reject it on that alone. Re-shape into a plain
// local object so the comparison is about the values, which is what these tests are for.
const computeDocRuleCoverage = (result) => {
  const c = rawCoverage(result);
  return { total: c.total, atRisk: c.atRisk, upheld: c.upheld };
};

test('computeDocRuleCoverage counts only the rules the panel shows', () => {
  const result = {
    docFactVerdicts: [
      { status: 'VIOLATED' },
      { status: 'PRE_EXISTING' },
      { status: 'maintained' }, // case-insensitive
      { status: 'RESTORED' },
      { status: 'UNCLEAR' }, // could not be checked: not shown, not counted
      { status: 'SOMETHING_NEW' }, // unknown: not shown, not counted
      null, // filtered out
    ],
  };
  assert.deepEqual(computeDocRuleCoverage(result), {
    total: 4,
    atRisk: 2, // VIOLATED + PRE_EXISTING
    upheld: 2, // MAINTAINED + RESTORED
  });
});

test('computeDocRuleCoverage returns zeros when there are no verdicts', () => {
  assert.deepEqual(computeDocRuleCoverage({}), { total: 0, atRisk: 0, upheld: 0 });
  assert.deepEqual(computeDocRuleCoverage(null), { total: 0, atRisk: 0, upheld: 0 });
  assert.deepEqual(computeDocRuleCoverage({ docFactVerdicts: 'nope' }), { total: 0, atRisk: 0, upheld: 0 });
});

test('computeDocRuleCoverage never counts an unchecked rule as upheld', () => {
  const c = computeDocRuleCoverage({ docFactVerdicts: [{ status: 'MAINTAINED' }, { status: 'UNCLEAR' }] });
  assert.deepEqual(c, { total: 1, atRisk: 0, upheld: 1 });
});
