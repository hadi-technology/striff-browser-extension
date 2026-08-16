/**
 * Architecture Review panel render tests
 * ======================================
 *
 * The panel is built by buildArchReviewPanelHtml inside the content script's IIFE, so it is not
 * importable and had no coverage at all. This loads the real content script into a real browser
 * DOM and drives openArchReviewPanel with representative API payloads, which is the only way to
 * exercise that function without a live GitHub session.
 *
 * The assertions are deliberately about *claims*, not markup. The panel's failure mode is not a
 * broken layout, it is stating something the analysis did not establish — asserting a clean pass
 * when detectors fired and were held below the surfacing gate, or when no review ran at all. The
 * GitHub check run draws those distinctions (striff-api CheckRunFormatter / AIReviewResultMapper)
 * and the two surfaces contradicting each other on the same PR is the credibility this protects.
 *
 * Needs a browser but no network and no GitHub login, unlike test:visual and test:live.
 *
 * Run: npm run test:panel
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'striffs.js'), 'utf8');

let failures = 0;
let passes = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passes++;
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const CLEAN = {
  reviewSummary: { headline: 'h', overview: 'Adds two components inside the existing billing module.', totalComponents: 9, changedComponents: 2 },
  surfacedItems: [], findings: [], docFactVerdicts: []
};

const HELD_BACK = {
  reviewSummary: { headline: 'h', overview: 'Overview.', totalComponents: 9, changedComponents: 2 },
  surfacedItems: [],
  findings: [
    { findingId: 'f1', detectorId: 'INSTABILITY_SPIKE', title: 'Efferent coupling rose', summary: 'EC 4 -> 7', affectedComponents: ['com.app.svc.OrderService'] },
    { findingId: 'f2', detectorId: 'WMC_GROWTH', title: 'Complexity rose', summary: 'WMC 12 -> 18', affectedComponents: ['com.app.svc.OrderService'] },
    { findingId: 'f3', detectorId: 'INSTABILITY_SPIKE', title: 'Efferent coupling rose', summary: 'EC 2 -> 5', affectedComponents: ['com.app.web.Ctrl'] }
  ],
  docFactVerdicts: []
};

const FLAGGED_WITH_DOCS = {
  reviewSummary: { headline: 'h', overview: 'Overview.', totalComponents: 14, changedComponents: 5 },
  surfacedItems: [{ itemId: 'f1', priority: 'STRUCTURAL_REGRESSION', title: 'New package cycle', whyShown: 'why', reviewAction: 'verify', docConflict: false }],
  findings: [
    { findingId: 'f1', detectorId: 'NEW_PACKAGE_CYCLE', title: 'Cycle', summary: 's', affectedComponents: ['com.app.a.A'] },
    { findingId: 'f9', detectorId: 'NEW_PACKAGE_CYCLE', title: 'Another cycle', summary: 's2', affectedComponents: ['com.app.b.B'] },
    { findingId: 'f4', detectorId: 'HUB_FORMATION', title: 'Hub forming', summary: 's3', affectedComponents: ['com.app.core.Registry'] }
  ],
  docFactVerdicts: [
    { factId: 'd1', subject: 'com.app.domain', statement: 'domain must not depend on infrastructure', sourceDocPath: 'docs/architecture/adr-001-layering.md', quote: 'The domain layer must not depend on infrastructure.', status: 'MAINTAINED', evidence: [] },
    { factId: 'd2', subject: 'com.app.web', statement: 'web must not reach the persistence layer directly', sourceDocPath: 'docs/architecture.md', quote: 'Controllers talk to services, never to repositories.', status: 'VIOLATED', evidence: ['com.app.web.OrderController -> com.app.persistence.OrderRepository'] },
    { factId: 'd3', subject: 'com.app.billing', statement: 'billing owns all money arithmetic', sourceDocPath: 'docs/invariants.md', quote: 'All money arithmetic lives in billing.', status: 'UNCLEAR', evidence: [] },
    { factId: 'd4', subject: 'com.app.audit', statement: 'every mutation writes an audit record', sourceDocPath: 'docs/invariants.md', quote: 'Every mutation writes an audit record.', status: 'PRE_EXISTING', evidence: ['already broken before this change; this change did not add to it', 'com.app.audit.Writer -> com.app.web.Session'] },
    { factId: 'd5', subject: 'com.app.report', statement: 'reporting reads through the query service', sourceDocPath: 'docs/invariants.md', quote: 'Reporting reads through the query service.', status: 'RESTORED', evidence: ['broken at base, satisfied at head', 'com.app.report.Builder -> com.app.query.QueryService'] }
  ]
};

const NO_REVIEW = { reviewSummary: null, surfacedItems: [], findings: [], docFactVerdicts: [] };

const XSS = {
  reviewSummary: { headline: 'h', overview: '<img src=x onerror=alert(1)>', totalComponents: 1, changedComponents: 1 },
  surfacedItems: [],
  findings: [{ findingId: 'x1', detectorId: 'HUB_FORMATION', title: '<script>alert(1)</script>', summary: 's', affectedComponents: ['<b>Evil</b>'] }],
  docFactVerdicts: [{ factId: 'x2', subject: 's', statement: '<script>alert(2)</script>', sourceDocPath: '<img src=x onerror=alert(3)>.md', quote: 'q', status: 'VIOLATED', evidence: ['<script>alert(4)</script>'] }]
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  await page.setContent('<!doctype html><html><body><div id="striff-diagram-view"></div></body></html>');
  // The content script expects extension APIs at load; a stub is enough to reach its namespace.
  await page.evaluate(() => {
    window.chrome = {
      runtime: { sendMessage: () => {}, onMessage: { addListener: () => {} }, id: 'test' },
      storage: { local: { get: () => {}, set: () => {} } }
    };
  });
  await page.addScriptTag({ content: SRC });

  const ready = await page.evaluate(() => typeof window.Striffs?.openArchReviewPanel === 'function');
  if (!ready) {
    console.log('FAIL: content script did not define openArchReviewPanel');
    await browser.close();
    process.exit(1);
  }

  const render = async (payload) => page.evaluate((p) => {
    window.Striffs.closeArchReviewPanel?.();
    window.Striffs.openArchReviewPanel(p);
    const el = document.getElementById('striffs-arch-review-panel');
    return {
      text: el.innerText,
      html: el.innerHTML,
      // Live nodes, not substrings: an escaped "<img src=x onerror=...>" still contains the
      // literal text "onerror=", so grepping the HTML reports an injection that isn't there.
      // What matters is whether the browser built an element out of it.
      injectedNodes: el.querySelectorAll('img, script, iframe, object, embed').length
    };
  }, payload);

  console.log('\nclean pass — detectors ran and found nothing');
  {
    const { text } = await render(CLEAN);
    check('claims a clean result', text.includes('Everything looks good'));
    check('renders the full check roster', (text.match(/✅ clean/g) || []).length === 12);
    check('shows the overview', text.includes('billing module'));
    // Doc-tier rows are violation-only, so a clean doc row can never be derived from absence.
    check('no clean row for documented rules', !text.includes('Documented dependency rules'));
  }

  console.log('\nfindings held below the surfacing gate');
  {
    const { text } = await render(HELD_BACK);
    check('does NOT claim a clean pass', !text.includes('No architectural concerns were found'));
    check('reports nothing surfaced', text.includes('Nothing surfaced for review'));
    check('states the evidence count', text.includes('3 evidence-only findings'));
    check('shows observations per check', text.includes('👀 2 observations') && text.includes('👀 1 observation'));
    check('names the strongest example', text.includes('OrderService'));
  }

  console.log('\nsurfaced item plus documented rules');
  {
    const { text } = await render(FLAGGED_WITH_DOCS);
    check('renders the surfaced item', text.includes('New package cycle'));
    check('renders a documented-rule violation', text.includes('❌ broken by this change'));
    check('renders a rule the change did not break', text.includes('✅ holds'));
    check('violations sort above the rules that held',
      text.indexOf('❌ broken by this change') < text.indexOf('✅ holds'));
    // The two rows that are cheapest to fold into the pass state and most expensive to get wrong.
    // An abstention or a live violation shown as a clean bill of health is the failure this
    // section can least afford -- and a previous revision made exactly that trade, on the false
    // premise that the server filters these out before they arrive. It does not: a scrapy review
    // sends 15 UNCLEAR rows out of 20.
    check("an unclear verdict is not rendered as held", text.includes("💭 couldn't check"));
    check('a pre-existing violation is not rendered as held',
      text.includes('⚠️ already broken, not by this PR'));
    check('a pre-existing violation names the edge that breaks it',
      text.includes('com.app.audit.Writer -> com.app.web.Session'));
    check('already-broken sorts above the rules that held',
      text.indexOf('⚠️ already broken') < text.indexOf('✅ holds'));
    // The fifth status. It used to fall through the unrecognised-status guard and render as
    // "couldn't check", which is the opposite of what it means: the docs and the code disagreed
    // and this change closed the gap. Safe, since the guard refuses to call an unknown status a
    // pass, but wrong -- and wrong in the one place a reader would have been pleased.
    check('a restored rule is not rendered as unchecked',
      text.includes('✨ restored by this change'));
    check('a restored rule names the edge that now satisfies it',
      text.includes('com.app.report.Builder -> com.app.query.QueryService'));
    check('restored sorts below violations and above what merely holds',
      text.indexOf('❌ broken by this change') < text.indexOf('✨ restored by this change')
        && text.indexOf('✨ restored by this change') < text.indexOf('✅ holds'));
    check('the section says it checked the dependency graph',
      text.includes('dependency graph this PR produces'));
    check('flagged check counts both buckets', text.includes('❗ 1 flagged · 👀 1 observation'));
    check('doc rules render above structural checks', text.indexOf('DOCUMENTED RULES') < text.indexOf('STRUCTURAL CHECKS'));
    check('source doc shown as basename only', text.includes('adr-001-layering.md') && !text.includes('docs/architecture/adr-001'));
  }

  console.log('\nno review recorded');
  {
    const { text } = await render(NO_REVIEW);
    check('does NOT claim a clean pass', !text.includes('Everything looks good'));
    check('says nothing was recorded', text.includes('No review recorded'));
    // Rendering the roster here would present "didn't check" as "checked, clean".
    check('suppresses the check roster', !text.includes('STRUCTURAL CHECKS'));
  }

  console.log('\nuntrusted content is escaped');
  {
    const { html, injectedNodes } = await render(XSS);
    check('no element built from injected markup', injectedNodes === 0);
    check('markup is entity-escaped', html.includes('&lt;script&gt;') && html.includes('&lt;img src=x'));
    check('no raw tag reaches the DOM string', !html.includes('<script') && !html.includes('<img'));
  }

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '));

  await browser.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
