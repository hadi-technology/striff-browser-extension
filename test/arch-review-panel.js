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
 * when nothing was checked, or when findings were held below the surfacing gate. The GitHub check
 * run draws those distinctions too, and the two surfaces contradicting each other on the same PR
 * is the credibility this protects.
 *
 * The analysis no longer runs structural detector checks, but a published extension can meet an
 * older API that still sends them. Several fixtures here are old-style responses: the panel must
 * render the same documented rules and review items for them, and nothing from the detectors.
 *
 * The second half covers the load itself: the review arrives with the diagram, so a load waits for
 * a running review and renders once, and the findings button opens the panel only on a click. It
 * drives the render the load paths share, with the review's status endpoint stubbed, and asserts
 * the order of status reads and renders, and what the button says in every review state.
 *
 * Needs a browser but no network and no GitHub login, unlike test:visual and test:live.
 *
 * Run: npm run test:panel
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'striffs.js'), 'utf8');
// Loaded ahead of the content script, as the manifest does.
const REVIEW_STATE_SRC = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'review-state-utils.js'), 'utf8');

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

const DOC_VERDICTS = [
  { factId: 'd1', subject: 'com.app.domain', statement: 'domain must not depend on infrastructure', sourceDocPath: 'docs/architecture/adr-001-layering.md', quote: 'The domain layer must not depend on infrastructure.', status: 'MAINTAINED', evidence: [] },
  { factId: 'd2', subject: 'com.app.web', statement: 'web must not reach the persistence layer directly', sourceDocPath: 'docs/architecture.md', quote: 'Controllers talk to services, never to repositories.', status: 'VIOLATED', evidence: ['com.app.web.OrderController -> com.app.persistence.OrderRepository'] },
  { factId: 'd3', subject: 'com.app.billing', statement: 'billing owns all money arithmetic', sourceDocPath: 'docs/invariants.md', quote: 'All money arithmetic lives in billing.', status: 'UNCLEAR', evidence: [] },
  { factId: 'd4', subject: 'com.app.audit', statement: 'every mutation writes an audit record', sourceDocPath: 'docs/invariants.md', quote: 'Every mutation writes an audit record.', status: 'PRE_EXISTING', evidence: ['already broken before this change; this change did not add to it', 'com.app.audit.Writer -> com.app.web.Session'] },
  { factId: 'd5', subject: 'com.app.report', statement: 'reporting reads through the query service', sourceDocPath: 'docs/invariants.md', quote: 'Reporting reads through the query service.', status: 'RESTORED', evidence: ['broken at base, satisfied at head', 'com.app.report.Builder -> com.app.query.QueryService'] }
];

// What the current API sends: documented-rule findings only, and none of the retired fields.
const CURRENT = {
  reviewSummary: { headline: 'h', overview: 'Overview.', totalComponents: 14, changedComponents: 5 },
  surfacedItems: [{ itemId: 'f1', priority: 'STRUCTURAL_REGRESSION', title: 'Controller reaches the repository directly', whyShown: 'why', reviewAction: 'verify', docConflict: true, conflictingDocs: ['architecture.md'] }],
  findings: [{ findingId: 'f1', detectorId: 'DOCUMENTED_RULE', title: 'Documented rule broken', summary: 's', affectedComponents: ['com.app.web.OrderController'] }],
  docFactVerdicts: DOC_VERDICTS
};

// The same review from an older API: structural-detector findings in the same array, plus the
// fields that went with them.
const LEGACY = {
  ...CURRENT,
  findings: [
    ...CURRENT.findings,
    { findingId: 'f7', detectorId: 'NEW_PACKAGE_CYCLE', title: 'Package cycle introduced', summary: 's', affectedComponents: ['com.app.a.A'] },
    { findingId: 'f8', detectorId: 'HUB_FORMATION', title: 'Hub forming', summary: 's3', affectedComponents: ['com.app.core.Registry'] },
    { findingId: 'f9', detectorId: 'WMC_GROWTH', title: 'Complexity rose', summary: 'WMC 12 -> 18', affectedComponents: ['com.app.svc.OrderService'] }
  ],
  detectorsNotCompleted: ['LAYER_SKIP'],
  anomalousEdges: [{ source: 'com.app.a.A', target: 'com.app.b.B', score: 0.2 }],
  advisoryEdges: [{ source: 'com.app.b.B', target: 'com.app.a.A', score: 0.5 }],
  componentProfiles: [{ component: 'com.app.core.Registry' }],
  structuralChanges: [{ component: 'com.app.svc.OrderService', metric: 'WMC', before: 12, after: 18 }]
};

// An older API's quiet review: detector findings held below the surfacing gate and nothing else.
// These used to become observation rows and an "evidence-only findings" count.
const LEGACY_HELD_BACK = {
  reviewSummary: { headline: 'h', overview: 'Overview.', totalComponents: 9, changedComponents: 2 },
  surfacedItems: [],
  findings: [
    { findingId: 'f1', detectorId: 'INSTABILITY_SPIKE', title: 'Efferent coupling rose', summary: 'EC 4 -> 7', affectedComponents: ['com.app.svc.OrderService'] },
    { findingId: 'f2', detectorId: 'WMC_GROWTH', title: 'Complexity rose', summary: 'WMC 12 -> 18', affectedComponents: ['com.app.svc.OrderService'] },
    { findingId: 'f3', detectorId: 'INSTABILITY_SPIKE', title: 'Efferent coupling rose', summary: 'EC 2 -> 5', affectedComponents: ['com.app.web.Ctrl'] }
  ],
  detectorsNotCompleted: [],
  docFactVerdicts: []
};

// A documented-rule finding held below the surfacing gate.
const DOC_HELD_BACK = {
  reviewSummary: { headline: 'h', overview: 'Overview.', totalComponents: 9, changedComponents: 2 },
  surfacedItems: [],
  findings: [{ findingId: 'a1', detectorId: 'DOC_ARCHITECTURE_ADVISORY', title: 'Intention not followed', summary: 's', affectedComponents: ['com.app.x.X'] }],
  docFactVerdicts: [{ factId: 'a1v', subject: 'com.app.x', statement: 'x goes through the gateway', sourceDocPath: 'docs/intent.md', quote: 'X goes through the gateway.', status: 'UNCLEAR', evidence: [] }]
};

// The review ran, nothing was raised, and no documented rule applied.
const QUIET = {
  reviewSummary: { headline: 'h', overview: 'Adds two components inside the existing billing module.', totalComponents: 9, changedComponents: 2 },
  surfacedItems: [], findings: [], docFactVerdicts: []
};

// Only a summary: every list field absent, as a response that omits empty or retired fields sends.
const MINIMAL = {
  reviewSummary: { headline: 'h', overview: 'Only an overview.', totalComponents: 3, changedComponents: 1 }
};

const NO_REVIEW = { reviewSummary: null, surfacedItems: [], findings: [], docFactVerdicts: [] };

const XSS = {
  reviewSummary: { headline: 'h', overview: '<img src=x onerror=alert(1)>', totalComponents: 1, changedComponents: 1 },
  surfacedItems: [{ itemId: 'x1', priority: 'REVIEW_HOTSPOT', title: '<script>alert(5)</script>', whyShown: '<img src=x onerror=alert(6)>', reviewAction: '<iframe src=x></iframe>', docConflict: true, conflictingDocs: ['<script>alert(7)</script>.md'] }],
  findings: [{ findingId: 'x1', detectorId: 'DOCUMENTED_RULE', title: '<script>alert(1)</script>', summary: 's', affectedComponents: ['<b>Evil</b>'] }],
  docFactVerdicts: [{ factId: 'x2', subject: 's', statement: '<script>alert(2)</script>', sourceDocPath: '<img src=x onerror=alert(3)>.md', quote: 'q', status: 'VIOLATED', evidence: ['<script>alert(4)</script>'] }]
};

// Text that only the retired section, or a detector finding, could have put in the panel.
const DETECTOR_TRACES = ['STRUCTURAL CHECKS', '✅ clean', '👀', '❗', 'observation', 'evidence-only',
  'Package cycles', 'Hub formation', 'Coupling stability', 'Complexity growth'];

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
  await page.addScriptTag({ content: REVIEW_STATE_SRC });
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

  const detectorTracesIn = (text) => DETECTOR_TRACES.filter(t => text.includes(t));

  console.log('\ncurrent API — review items plus documented rules');
  {
    const { text } = await render(CURRENT);
    check('renders the review item', text.includes('Controller reaches the repository directly'));
    check('marks it as a doc conflict', /doc conflict/i.test(text) && text.includes('architecture.md'));
    check('review items render above documented rules',
      text.indexOf('REVIEW ITEMS') >= 0 && text.indexOf('REVIEW ITEMS') < text.indexOf('DOCUMENTED RULES'));
    check('renders a documented-rule violation', text.includes('❌ broken by this change'));
    check('renders a rule the change did not break', text.includes('✅ holds'));
    check('violations sort above the rules that held',
      text.indexOf('❌ broken by this change') < text.indexOf('✅ holds'));
    // The two rows that are cheapest to fold into the pass state and most expensive to get wrong.
    // An abstention or a live violation shown as a clean bill of health is the failure this
    // section can least afford -- and a previous revision made exactly that trade, on the false
    // premise that the server filters these out before they arrive. It does not.
    // A rule the review could not check is not shown at all -- and so never as holding.
    check('a rule the review could not check is not shown', !text.includes('billing owns all money arithmetic')
      && !text.includes("couldn't check") && !text.includes('💭'), text);
    check('a pre-existing violation is not rendered as held',
      text.includes('⚠️ already broken, not by this PR'));
    check('a pre-existing violation names the edge that breaks it',
      text.includes('com.app.audit.Writer -> com.app.web.Session'));
    check('already-broken sorts above the rules that held',
      text.indexOf('⚠️ already broken') < text.indexOf('✅ holds'));
    // RESTORED: the docs and the code disagreed and this change closed the gap.
    check('a restored rule is shown as restored',
      text.includes('✨ restored by this change'));
    check('a restored rule names the edge that now satisfies it',
      text.includes('com.app.report.Builder -> com.app.query.QueryService'));
    check('restored sorts below violations and above what merely holds',
      text.indexOf('❌ broken by this change') < text.indexOf('✨ restored by this change')
        && text.indexOf('✨ restored by this change') < text.indexOf('✅ holds'));
    // "Holds" is a claim about this pull request only, never about the rest of the codebase.
    check('the section defines holding as not broken by this PR',
      text.includes('A rule shown as holding is not broken by this PR, which says nothing about the rest of the codebase')
        && text.includes('one shown as already broken is broken in the code checked, but not by this PR')
        && !/anywhere/i.test(text), text);
    check('the section says it checked the dependency graph',
      text.includes('dependency graph this PR produces'));
    check('source doc shown as basename only', text.includes('adr-001-layering.md') && !text.includes('docs/architecture/adr-001'));
    check('no structural checks section', detectorTracesIn(text).length === 0, detectorTracesIn(text).join(', '));
  }

  console.log('\nolder API — the same review with detector findings and retired fields');
  {
    const current = await render(CURRENT);
    const legacy = await render(LEGACY);
    check('renders no structural checks section', !legacy.text.includes('STRUCTURAL CHECKS'));
    check('renders nothing from the detectors', detectorTracesIn(legacy.text).length === 0,
      detectorTracesIn(legacy.text).join(', '));
    check('no detector finding reaches the panel',
      !['Package cycle introduced', 'Hub forming', 'Complexity rose', 'Registry'].some(t => legacy.text.includes(t)));
    check('still renders the review item and documented rules',
      legacy.text.includes('Controller reaches the repository directly') && legacy.text.includes('❌ broken by this change'));
    // The only difference between the two payloads is what the panel no longer shows, so the
    // rendered panel must be identical.
    check('renders exactly what the current API response renders', legacy.text === current.text);
  }

  console.log('\nolder API — only detector findings, all held below the gate');
  {
    const { text } = await render(LEGACY_HELD_BACK);
    check('renders nothing from the detectors', detectorTracesIn(text).length === 0, detectorTracesIn(text).join(', '));
    check('does not name a detector finding', !text.includes('OrderService') && !text.includes('Efferent coupling'));
    check('does NOT claim a clean pass',
      !text.includes('Everything looks good') && !text.includes('No architectural concerns were found'));
    check('says no documented rules were checked', text.includes('no documented rules were checked'));
  }

  console.log('\ndocumented-rule finding held below the surfacing gate');
  {
    const { text } = await render(DOC_HELD_BACK);
    check('reports nothing surfaced', text.includes('Nothing surfaced for review'));
    check('states the held-back count', text.includes('1 documented-rule finding was recorded'));
    check('does not list the rule it could not check', !text.includes('x goes through the gateway'));
  }

  console.log('\nreview ran, nothing raised, no documented rules');
  {
    const { text } = await render(QUIET);
    // With the structural checks gone, the only thing that could have been found is a documented
    // rule. "No concerns were found" would claim a check that never happened.
    check('does NOT claim a clean pass',
      !text.includes('Everything looks good') && !text.includes('No architectural concerns were found'));
    check('says nothing was raised', text.includes('No review items'));
    check('says no documented rules were checked', text.includes('no documented rules were checked'));
    check('shows the overview', text.includes('billing module'));
    check('renders no structural checks section', !text.includes('STRUCTURAL CHECKS'));
  }

  console.log('\nretired and list fields absent entirely');
  {
    const { text } = await render(MINIMAL);
    check('renders the overview', text.includes('Only an overview.'));
    check('says nothing was raised', text.includes('No review items'));
    check('renders no documented rules section', !text.includes('DOCUMENTED RULES'));
    check('renders no structural checks section', !text.includes('STRUCTURAL CHECKS'));
    check('leaks no undefined/null/NaN', !/\bundefined\b|\bnull\b|\bNaN\b/.test(text), text);
    check('footer still counts components', text.includes('1 changed / 3 total'));
  }

  console.log('\nno review recorded');
  {
    const { text } = await render(NO_REVIEW);
    check('does NOT claim a clean pass', !text.includes('Everything looks good') && !text.includes('No review items'));
    check('says nothing was recorded', text.includes('No review recorded'));
    check('renders no structural checks section', !text.includes('STRUCTURAL CHECKS'));
  }

  console.log('\nuntrusted content is escaped');
  {
    const { html, injectedNodes } = await render(XSS);
    check('no element built from injected markup', injectedNodes === 0);
    check('markup is entity-escaped', html.includes('&lt;script&gt;') && html.includes('&lt;img src=x'));
    check('no raw tag reaches the DOM string',
      !html.includes('<script') && !html.includes('<img') && !html.includes('<iframe'));
  }

  // -----------------------------------------------------------------------------------------------
  // One load. renderStriffsResult is where every load path lands -- a cached 200, a queued job, the
  // token GET, the private-repo fallback, a diagram read back from storage -- so these drive it
  // directly, with the review's status endpoint stubbed, and record every status read and render.
  // -----------------------------------------------------------------------------------------------
  const svg = (which) => `<svg xmlns="http://www.w3.org/2000/svg" data-diagram="${which}" width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100"/></svg>`;
  const analysis = (status, extra = {}) => ({
    operationId: 'op-1', operationAccessToken: 'tok-1', aiReviewStatus: status,
    striffs: [{ svgCode: svg('base') }], ...extra
  });
  const reply = (status, extra = {}) => ({
    ok: true, status: 200,
    json: { operationId: 'op-1', operationAccessToken: 'tok-1', aiReviewStatus: status, aiReviewPollAfterMs: 1000, ...extra }
  });
  const readyReply = (review = CURRENT) => reply('READY', { striffs: [{ svgCode: svg('reviewed') }], ...review });

  await page.evaluate(() => {
    const S = window.Striffs;
    // replies answer status reads until the diagram renders; afterRender, if given, answers the
    // ones after it -- the background collection of the fallback.
    S.fetchAiReviewStatus = async () => {
      const f = S.__flow;
      const rendered = f.events.includes('render');
      const list = rendered && f.afterRender ? f.afterRender : f.replies;
      const index = rendered && f.afterRender ? f.readsAfterRender++ : f.reads++;
      const r = list[Math.min(index, list.length - 1)];
      f.events.push(`read:${r?.json?.aiReviewStatus || r?.status || 'error'}`);
      return r;
    };
    const renderInto = S.renderStriffsInto;
    S.renderStriffsInto = (target, data) => {
      S.__flow.events.push('render');
      return renderInto(target, data);
    };
    const updateStriffButton = S.updateStriffButton;
    S.updateStriffButton = (state) => {
      if (state?.loading) S.__flow?.events.push(`loading:${state.phase}`);
      return updateStriffButton(state);
    };
    S.__resetFlow = ({ replies = [], afterRender = null, budgetMs = 10000, timeoutMs = 20000 } = {}) => {
      S.cancelReviewCollection('test');
      S.closeArchReviewPanel();
      S.__striffsReady = false;
      S.__striffsSvg = null;
      S.setReviewState(null, null);
      const view = document.getElementById('striff-diagram-view');
      view.innerHTML = S.getStriffsContainerMarkup('');
      view.style.display = 'block';
      S.setCurrentView('striffs');
      S.REVIEW_WAIT_BUDGET_MS = budgetMs;
      S.REVIEW_COLLECTION_TIMEOUT_MS = timeoutMs;
      S.__flow = { events: [], replies, afterRender, reads: 0, readsAfterRender: 0 };
    };
    S.__startLoad = (scenario) => {
      S.__resetFlow(scenario);
      return S.renderStriffsResult(scenario.result, null);
    };
    S.__flowSnapshot = () => {
      const btn = document.getElementById('striffs-arch-review-btn');
      return {
        events: S.__flow.events.slice(),
        diagram: document.querySelector('#striffs-content svg')?.getAttribute('data-diagram') || '',
        text: String(btn?.textContent || '').trim(),
        title: String(btn?.title || ''),
        disabled: Boolean(btn?.disabled),
        hidden: !btn || btn.style.display === 'none',
        panelOpen: Boolean(document.querySelector('#striffs-arch-review-panel.striffs-arch-review-panel--open')),
        panelText: String(document.getElementById('striffs-arch-review-panel')?.innerText || '')
      };
    };
  });

  const buttonTexts = [];
  const seen = (s) => { buttonTexts.push(s.text); return s; };
  const load = async (scenario) => seen(await page.evaluate(async (s) => {
    await window.Striffs.__startLoad(s);
    return window.Striffs.__flowSnapshot();
  }, scenario));
  const snapshot = async () => seen(await page.evaluate(() => window.Striffs.__flowSnapshot()));
  const clickFindings = () => page.evaluate(() => {
    document.getElementById('striffs-arch-review-btn').click();
    return window.Striffs.__flowSnapshot();
  });
  const waitForButton = (prefix, ms) => page.waitForFunction(
    (t) => String(document.getElementById('striffs-arch-review-btn')?.textContent || '').trim().startsWith(t),
    prefix, { timeout: ms }).then(() => true, () => false);
  const renders = (s) => s.events.filter(e => e === 'render').length;
  // Status reads and renders, in order.
  const flow = (s) => s.events.filter(e => e === 'render' || e.startsWith('read:')).join(' ');

  console.log('\none load — the first response already carries the finished review');
  {
    const s = await load({ result: analysis('READY', { ...CURRENT, striffs: [{ svgCode: svg('reviewed') }] }) });
    check('renders once, reading no review status', flow(s) === 'render', flow(s));
    check('the button shows the documented-rule count', s.text === 'Findings (4 rules)', s.text);
    check('the button is enabled', !s.disabled);
    check('the panel does not open by itself', !s.panelOpen);
    const opened = await clickFindings();
    check('a click opens the panel on the review', opened.panelOpen
      && opened.panelText.includes('Controller reaches the repository directly'));
    const closed = await clickFindings();
    check('a second click closes it', !closed.panelOpen);
  }

  console.log('\none load — review running, finishes inside the wait');
  {
    const s = await load({ result: analysis('PENDING'), replies: [reply('PENDING'), readyReply()] });
    check('reads the review until it is ready, then renders once', flow(s) === 'read:PENDING read:READY render', flow(s));
    const waiting = s.events.indexOf('loading:Reviewing');
    check('the loading state covers the wait', waiting >= 0 && waiting < s.events.indexOf('render'), s.events.join(' '));
    check('renders the review-complete diagram', s.diagram === 'reviewed', s.diagram);
    check('the button shows the documented-rule count', s.text === 'Findings (4 rules)' && !s.disabled, s.text);
    check('the panel does not open by itself', !s.panelOpen);
  }

  console.log('\none load — review outlasts the wait, finishes in the background');
  {
    const s = await load({
      result: analysis('PENDING', { aiReviewWarmupRequired: true }),
      replies: [reply('PENDING')],
      afterRender: [reply('PENDING'), readyReply()],
      budgetMs: 1500
    });
    check('renders the analysis diagram when the wait runs out', renders(s) === 1 && s.diagram === 'base', `${flow(s)} ${s.diagram}`);
    check('the loading state says the documents are read for the first time', s.events.includes('loading:Reading Docs'), s.events.join(' '));
    check('the button says the review is still running', s.text === 'Reading docs…', s.text);
    check('the button cannot be opened yet', s.disabled);
    check('the button uses the first-read wording', /for the first time/.test(s.title), s.title);
    const arrived = await waitForButton('Findings (', 8000);
    const after = await snapshot();
    check('the button enables itself when the review lands, with no click', arrived && !after.disabled
      && after.text === 'Findings (4 rules)', after.text);
    // The diagram does not carry the review, so a late review changes the button and the panel's
    // data and nothing else -- even when the status reply carries a diagram of its own.
    check('the diagram is not rendered again', renders(after) === 1 && after.diagram === 'base',
      `${flow(after)} ${after.diagram}`);
    check('the panel still does not open by itself', !after.panelOpen);
    const opened = await clickFindings();
    check('a click opens the panel on the review that arrived late', opened.panelOpen
      && opened.panelText.includes('Controller reaches the repository directly'));
    await clickFindings();
  }

  console.log('\none load — review never finishes');
  {
    const s = await load({ result: analysis('PENDING'), replies: [reply('RUNNING')], budgetMs: 500, timeoutMs: 1500 });
    check('renders the diagram when the wait runs out', renders(s) === 1, flow(s));
    check('the button says the review is still running', s.text === 'Reading docs…' && s.disabled, s.text);
    const gaveUp = await waitForButton("Review didn't finish", 6000);
    const after = await snapshot();
    check("the button says the review didn't finish", gaveUp && after.disabled, after.text);
    check('no second render without a review', renders(after) === 1, flow(after));
  }

  console.log('\none load — review failed');
  {
    const first = await load({ result: analysis('FAILED', { aiReviewErrorMessage: 'The review model timed out.' }) });
    check('renders once, reading no review status', flow(first) === 'render', flow(first));
    check('the button says the review failed', first.text === 'Review failed' && first.disabled, first.text);
    check('the button gives the reason', first.title === 'The review model timed out.', first.title);
    const during = await load({
      result: analysis('PENDING'),
      replies: [reply('PENDING'), reply('FAILED', { aiReviewErrorMessage: 'The review model timed out.' })]
    });
    check('a review that fails during the wait renders once', flow(during) === 'read:PENDING read:FAILED render', flow(during));
    check('it keeps the analysis diagram', during.diagram === 'base', during.diagram);
    check('the button says the review failed', during.text === 'Review failed' && during.disabled, during.text);
  }

  console.log('\none load — no review ran');
  {
    const skipped = await load({ result: analysis('SKIPPED', { aiReviewErrorMessage: 'Too few components to review.' }) });
    check('renders once, reading no review status', flow(skipped) === 'render', flow(skipped));
    check('the button says no review ran', skipped.text === 'No review' && skipped.disabled, skipped.text);
    check('the button gives the reason', skipped.title === 'Too few components to review.', skipped.title);
    const none = await load({ result: analysis(undefined) });
    check('with no review status at all, says no review ran', none.text === 'No review' && none.disabled, none.text);
    const during = await load({ result: analysis('PENDING'), replies: [reply('SKIPPED')] });
    check('a review skipped during the wait says no review ran', during.text === 'No review' && renders(during) === 1, during.text);
  }

  console.log('\none load — review finished, but checked no documented rules');
  {
    const s = await load({ result: analysis('PENDING'), replies: [readyReply(QUIET)] });
    check('the button carries no count', s.text === 'Findings' && !s.disabled, s.text);
    const opened = await clickFindings();
    check('the panel says no documented rules were checked', opened.panelText.includes('no documented rules were checked'));
    await clickFindings();
  }

  console.log('\none load — review status refused');
  {
    const s = await load({ result: analysis('PENDING'), replies: [{ ok: false, status: 403, error: 'HTTP 403' }] });
    check('renders once', renders(s) === 1, flow(s));
    check('the button says the review is unavailable', s.text === 'Review unavailable' && s.disabled, s.text);
  }

  console.log('\none load — the page moves on during the wait');
  {
    const moveOn = (how) => page.evaluate(async ({ scenario, how }) => {
      const S = window.Striffs;
      const done = S.__startLoad(scenario);
      await new Promise(r => setTimeout(r, 300));
      if (how === 'pr-change') S.resetPrScopedState('test');
      else S.__disabledByRemote = true;
      await done;
      await new Promise(r => setTimeout(r, 1200));
      const snap = S.__flowSnapshot();
      S.__disabledByRemote = false;
      return snap;
    }, { scenario: { result: analysis('PENDING'), replies: [reply('PENDING')] }, how });
    const prChange = await moveOn('pr-change');
    check('a move to another PR stops the wait and renders nothing', renders(prChange) === 0
      && prChange.events.filter(e => e.startsWith('read:')).length === 1, prChange.events.join(' '));
    const killed = await moveOn('kill-switch');
    check('the remote kill switch stops the wait and renders nothing', renders(killed) === 0
      && killed.events.filter(e => e.startsWith('read:')).length === 1, killed.events.join(' '));
    const hidden = await page.evaluate(async (result) => {
      const S = window.Striffs;
      await S.__startLoad({ result });
      S.__disabledByRemote = true;
      S.updateArchReviewButton();
      const snap = S.__flowSnapshot();
      S.__disabledByRemote = false;
      return snap;
    }, analysis('READY', { ...CURRENT }));
    check('the kill switch hides the findings button', hidden.hidden);
  }

  console.log('\na diagram read back from storage');
  {
    const r = await page.evaluate(async ({ pending, ready }) => {
      const S = window.Striffs;
      const saved = {
        extractPRMetadata: S.extractPRMetadata, cacheKey: S.cacheKey, getCacheClearAt: S.getCacheClearAt,
        readCacheFromChromeStorage: S.readCacheFromChromeStorage,
        readCacheFromLocalStorage: S.readCacheFromLocalStorage,
        readCacheFromIndexedDb: S.readCacheFromIndexedDb
      };
      S.extractPRMetadata = () => ({ owner: 'o', repo: 'r', pull_number: '1', updated_at: 'u', commit_count: 1 });
      S.cacheKey = () => 'striffs:o/r#1';
      S.getCacheClearAt = async () => 0;
      S.readCacheFromLocalStorage = () => null;
      S.readCacheFromIndexedDb = async () => null;
      const prime = async (result, status) => {
        S.readCacheFromChromeStorage = async () => ({ result, cachedAiReviewStatus: status, commit_count: 1, savedAt: Date.now() });
        S.__resetFlow();
        const outcome = await S.primeDiagramFromCache();
        return { outcome, ...S.__flowSnapshot() };
      };
      try {
        return { pending: await prime(pending, 'PENDING'), ready: await prime(ready, 'READY') };
      } finally {
        Object.assign(S, saved);
      }
    }, { pending: analysis('PENDING'), ready: analysis('READY', { ...CURRENT, striffs: [{ svgCode: svg('reviewed') }] }) });
    // 'stale' is what sends the boot into a load, and a load waits for the review.
    check('a diagram cached before its review finished is left to the load that waits for it',
      r.pending.outcome === 'stale' && renders(r.pending) === 0, `${r.pending.outcome} ${flow(r.pending)}`);
    check('a cached finished review renders once, with its findings', r.ready.outcome === 'fresh'
      && renders(r.ready) === 1 && r.ready.text === 'Findings (4 rules)', `${r.ready.outcome} ${flow(r.ready)} ${r.ready.text}`);
  }

  console.log('\nwhat the review could not check is not shown');
  {
    // Only unchecked rules: nothing to show, and nothing claimed about them.
    const onlyUnchecked = await render({ ...QUIET, docFactVerdicts: [DOC_VERDICTS[2],
      { ...DOC_VERDICTS[2], factId: 'd9', statement: 'a sixth outcome', status: 'SOMETHING_NEW' }] });
    check('rules the review could not check are not shown', !onlyUnchecked.text.includes('billing owns all money arithmetic')
      && !onlyUnchecked.text.includes('a sixth outcome') && !onlyUnchecked.text.includes('DOCUMENTED RULES'), onlyUnchecked.text);
    check('and never as holding', !onlyUnchecked.text.includes('✅') && !onlyUnchecked.text.includes('✓'), onlyUnchecked.text);

    // Docs that could not be read and rules that could not be re-checked are not reported, and do not
    // stand in the way of a clean result: the tick is decided by the rules shown.
    const gaps = { docsUnread: ['docs/a.md'], docsNotRechecked: [{ docPath: 'docs/rules.md', ruleCount: 2 }] };
    const allHeld = await render({ ...CURRENT, surfacedItems: [], findings: [], docFactVerdicts: [DOC_VERDICTS[0]], ...gaps });
    check('no warning about unread docs or rules not re-checked',
      !/could not be read|re-checked|unread/i.test(allHeld.text), allHeld.text);
    check('rules that all held earn their tick', allHeld.text.includes('✓'), allHeld.text);
    const broken = await render({ ...CURRENT, surfacedItems: [], findings: [], ...gaps });
    check('a broken rule still withholds it', !broken.text.includes('✓'), broken.text);

    const loaded = await load({ result: analysis('PENDING', gaps), replies: [readyReply(CURRENT)] });
    check('the findings button counts only the rules shown', loaded.text === 'Findings (4 rules)' && !loaded.disabled, loaded.text);
    check('and its tooltip says nothing of what was not checked',
      !/could not be read|re-checked|unread/i.test(loaded.title), loaded.title);
  }

  console.log('\ndocumented rules a doc edit retired or restored');
  {
    const CHANGES = [
      { docPath: 'docs/architecture/caching.md', statement: 'OrderCache is in `com.app.core`', change: 'retired', evidence: 'its sentence was removed' },
      { docPath: 'docs/architecture/caching.md', statement: 'Cache keys include the request fingerprint', change: 'retired', evidence: 'contradicted by "keys are random"' },
      { docPath: 'docs/rules.md', statement: 'web never reaches persistence', change: 'restored', evidence: 'stated again' }
    ];
    const withVerdicts = await render({ ...CURRENT, docRuleChanges: CHANGES });
    check('names the doc and how many rules it no longer states',
      withVerdicts.text.includes('📝 caching.md changed and no longer states 2 documented rules, which are retired and no longer checked:'),
      withVerdicts.text);
    check('lists each retired rule with its evidence',
      withVerdicts.text.includes('OrderCache is in com.app.core — its sentence was removed')
        && withVerdicts.text.includes('Cache keys include the request fingerprint — contradicted by "keys are random"'),
      withVerdicts.text);
    check('restored rules get a line of their own',
      withVerdicts.text.includes('📝 rules.md states 1 documented rule again: web never reaches persistence (stated again)'),
      withVerdicts.text);
    check('does not show full doc paths', !withVerdicts.text.includes('docs/architecture/caching.md'));
    check('still renders the rules that were checked', withVerdicts.text.includes('❌ broken by this change'));

    const allHeld = await render({ ...CURRENT, surfacedItems: [], findings: [],
      docFactVerdicts: [DOC_VERDICTS[0]], docRuleChanges: CHANGES });
    check('it is a note, not a failure: a clean result keeps its tick', allHeld.text.includes('✓'), allHeld.text);

    const none = await render({ ...QUIET, docRuleChanges: CHANGES.slice(0, 1) });
    check('shows the note even when no rule was evaluated', none.text.includes('DOCUMENTED RULES')
      && none.text.includes('📝 caching.md changed and no longer states 1 documented rule, which is retired and no longer checked:'),
      none.text);

    const many = await render({ ...QUIET, docRuleChanges: Array.from({ length: 13 }, (_, i) =>
      ({ docPath: 'docs/big.md', statement: `rule number ${i + 1}`, change: 'retired', evidence: 'its sentence was removed' })) });
    const shownRules = (many.text.match(/rule number \d+/g) || []).length;
    check('caps the list at ten a doc, with a count of the rest', shownRules === 10 && many.text.includes('+3 more'),
      `${shownRules} shown`);

    const absent = await render(QUIET);
    const emptyList = await render({ ...QUIET, docRuleChanges: [] });
    check('an empty list renders as if the field were absent', emptyList.text === absent.text);
    const malformed = await render({ ...QUIET, docRuleChanges: [
      { docPath: '', statement: 's', change: 'retired' }, { docPath: 'a.md', statement: '', change: 'retired' },
      { docPath: 'a.md', statement: 's', change: 'renamed' }, null, 'x.md'] });
    check('entries without a doc, a statement or a known change say nothing', malformed.text === absent.text, malformed.text);

    const hostile = await render({ ...QUIET, docRuleChanges: [{ docPath: 'docs/<img src=x onerror=alert(10)>.md',
      statement: '<script>alert(11)</script>', change: 'retired', evidence: '<iframe src=x></iframe>' }] });
    check('doc names, statements and evidence are escaped', hostile.injectedNodes === 0
      && hostile.html.includes('&lt;script&gt;') && hostile.html.includes('&lt;iframe') && hostile.html.includes('&lt;img'));

    // The label and the clean/unclean state are untouched; the tooltip mentions the edit.
    const kept = await load({ result: analysis('PENDING', { docRuleChanges: CHANGES }), replies: [readyReply(CURRENT)] });
    check('the findings button reads as it would without the note', kept.text === 'Findings (4 rules)' && !kept.disabled, kept.text);
    check('its tooltip mentions the doc edit', /A doc edit retired 2 documented rules and restored 1\./.test(kept.title), kept.title);
    const opened = await clickFindings();
    check('a status reply without the field keeps the analysis value', opened.panelText.includes('📝 caching.md changed'));
    await clickFindings();
    const replaced = await load({ result: analysis('PENDING', { docRuleChanges: CHANGES }),
      replies: [readyReply({ ...CURRENT, docRuleChanges: [] })] });
    check("a status reply's own value wins, even when empty", !/doc edit/.test(replaced.title), replaced.title);
  }

  console.log('\npanning with the review panel open');
  {
    // A diagram far wider and taller than the view, with a component in each corner. The panel
    // overlays the right of the view, so "reachable" means the component can be scrolled into the
    // part of the scroll area the panel does not cover, and a click at its centre lands on it.
    const W = 3000, H = 2000;
    const corner = (id, x, y) =>
      `<g class="entity" data-qualified-name="${id}"><rect data-corner="${id}" x="${x}" y="${y}" width="120" height="80" fill="#cde"/></g>`;
    const wide = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
      + corner('TopLeft', 0, 0) + corner('TopRight', W - 120, 0)
      + corner('BottomLeft', 0, H - 80) + corner('BottomRight', W - 120, H - 80) + '</svg>';
    const small = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">'
      + corner('Only', 10, 10) + '</svg>';

    await page.evaluate(() => {
      const S = window.Striffs;
      S.__panTest = {
        scroll: () => document.getElementById('striffs-scroll'),
        show(svgCode) {
          // The diagram's layout CSS is injected at boot, which only runs on a pull request page.
          // Without it there is no scroll area or overlay to test.
          S.addSpinAnimation();
          S.cancelReviewCollection('test');
          S.closeArchReviewPanel();
          const view = document.getElementById('striff-diagram-view');
          view.innerHTML = S.getStriffsContainerMarkup('');
          view.style.display = 'block';
          view.style.height = '600px';
          S.setCurrentView('striffs');
          S.renderStriffsInto(view, { striffs: [{ svgCode }] });
          // A render leaves a "Diagram ready." line above the diagram for a moment; measured without it.
          document.getElementById('striffs-status')?.remove();
          // Only components that map to a diff take clicks; these stand in for ones that do.
          S.__striffsSvg.querySelectorAll('g.entity').forEach((g) => { g.style.pointerEvents = ''; });
        },
        zoom(z) {
          S.__striffsZoom = z;
          S.syncZoomedSvgLayout(this.scroll(), S.__striffsSvg);
        },
        scrollTo(left, top) {
          const s = this.scroll();
          s.scrollLeft = left === 'max' ? s.scrollWidth : left;
          s.scrollTop = top === 'max' ? s.scrollHeight : top;
        },
        // Whether a corner is in the uncovered part of the scroll area, and whether a click at its
        // centre would land on it rather than on the panel.
        probe(id) {
          const s = this.scroll();
          const box = s.getBoundingClientRect();
          const panel = document.querySelector('#striffs-arch-review-panel.striffs-arch-review-panel--open');
          const right = Math.min(box.left + s.clientWidth, panel ? panel.getBoundingClientRect().left : Infinity);
          const r = document.querySelector(`[data-corner="${id}"]`).getBoundingClientRect();
          const x = r.left + r.width / 2, y = r.top + r.height / 2;
          return {
            inView: x > box.left && x < right && y > box.top && y < box.top + s.clientHeight,
            clickable: document.elementFromPoint(x, y)?.getAttribute?.('data-corner') === id
          };
        },
        bounds() {
          const s = this.scroll();
          return { clientWidth: s.clientWidth, maxLeft: s.scrollWidth - s.clientWidth, maxTop: s.scrollHeight - s.clientHeight };
        },
        state() {
          const s = this.scroll();
          return { zoom: S.__striffsZoom, left: s.scrollLeft, top: s.scrollTop };
        }
      };
    });
    const pan = (fn, ...args) => page.evaluate(({ fn, args }) => window.Striffs.__panTest[fn](...args), { fn, args });
    const openPanel = async () => { await page.evaluate((r) => window.Striffs.openArchReviewPanel(r), CURRENT); await page.waitForTimeout(450); };
    const closePanel = async () => { await page.evaluate(() => window.Striffs.closeArchReviewPanel()); await page.waitForTimeout(450); };
    const reachable = async (label) => {
      const results = {};
      for (const [id, left, top] of [['TopRight', 'max', 0], ['BottomRight', 'max', 'max'], ['BottomLeft', 0, 'max'], ['TopLeft', 0, 0]]) {
        await pan('scrollTo', left, top);
        results[id] = await pan('probe', id);
      }
      for (const [id, r] of Object.entries(results)) {
        check(`${label}: ${id} can be scrolled clear of the panel and clicked`, r.inView && r.clickable, JSON.stringify(r));
      }
    };

    await pan('show', wide);
    await pan('zoom', 1);
    const closedBounds = await pan('bounds');
    await pan('scrollTo', 150, 90);
    const before = await pan('state');
    await openPanel();
    const afterOpen = await pan('state');
    check('opening the panel keeps the zoom and the scroll position',
      afterOpen.zoom === before.zoom && afterOpen.left === before.left && afterOpen.top === before.top,
      `${JSON.stringify(before)} -> ${JSON.stringify(afterOpen)}`);
    const openBounds = await pan('bounds');
    check('the scroll area ends where the panel begins', closedBounds.clientWidth - openBounds.clientWidth >= 390,
      `${closedBounds.clientWidth} -> ${openBounds.clientWidth}`);
    await reachable('zoom 1');

    await pan('zoom', 2.5);
    await reachable('zoomed in');

    await pan('zoom', 1);
    await pan('scrollTo', 150, 90);
    await closePanel();
    const afterClose = await pan('state');
    check('closing the panel keeps the zoom and the scroll position',
      afterClose.zoom === 1 && afterClose.left === 150 && afterClose.top === 90, JSON.stringify(afterClose));
    const reclosedBounds = await pan('bounds');
    check('closing the panel restores the bounds', JSON.stringify(reclosedBounds) === JSON.stringify(closedBounds),
      `${JSON.stringify(closedBounds)} vs ${JSON.stringify(reclosedBounds)}`);

    // Fitted to the whole view, then the panel opens over its right side: the fitted diagram is now
    // wider than what is left, and has to scroll.
    await pan('show', wide);
    await openPanel();
    await reachable('fitted to the view, then the panel opened');
    await closePanel();

    // A diagram smaller than the view has nothing to scroll to, with the panel or without it, and
    // after the window is resized.
    await pan('show', small);
    await openPanel();
    let b = await pan('bounds');
    check('a small diagram gets no scroll range when the panel opens', b.maxLeft <= 1 && b.maxTop <= 1, JSON.stringify(b));
    await page.setViewportSize({ width: 1000, height: 1000 });
    await page.waitForTimeout(150);
    b = await pan('bounds');
    check('nor when the window narrows with the panel open', b.maxLeft <= 1 && b.maxTop <= 1, JSON.stringify(b));
    await closePanel();
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.waitForTimeout(150);
    b = await pan('bounds');
    check('nor when the panel closes and the window widens again', b.maxLeft <= 1 && b.maxTop <= 1, JSON.stringify(b));
  }

  console.log('\nprivate repositories');
  {
    // Drives the real load, autoFetchStriffs, with the background stubbed at the message boundary.
    // In every case the page carries no sign the repository is private -- after GitHub navigates in
    // place it often does not -- so only GitHub's own answer can tell.
    await page.evaluate(() => {
      const S = window.Striffs;
      const payload = () => ({ operationId: 'op-p', operationAccessToken: 'tok-p',
        striffs: [{ svgCode: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100"/></svg>' }] });
      S.__loadTest = async ({ repo, token = null, github, zipOk = false }) => {
        const calls = [];
        const toasts = [];
        S.getStoredToken = async () => token;
        S.extractPRMetadata = () => ({ owner: 'acme', repo, pull_number: '1', updated_at: 'u', commit_count: 1 });
        S.extractHeadBaseRefs = () => ({ baseOwner: 'acme', baseRepo: repo, baseBranch: 'main', headOwner: 'acme', headRepo: repo, headBranch: 'feature' });
        S.getFilterFilesFromNav = () => [];
        S.isPrivateRepo = () => false;
        S.sendMessageWithTimeout = async (msg) => {
          if (msg.type === 'proxyFetch' && /api\.github\.com\/repos\/[^/]+\/[^/?]+$/.test(msg.url)) { calls.push('github:repo'); return github; }
          if (msg.type === 'proxyFetch') return { ok: true, status: 200, json: [] };
          if (msg.type === 'generateStriffs') {
            calls.push('upload');
            return zipOk
              ? { ok: true, status: 200, json: payload() }
              : { ok: false, errorCode: 'BASE_ZIP_NOT_FOUND', error: 'Failed downloading base zip: Failed to download zip: 404' };
          }
          if (msg.type === 'fetchStriffsWithToken') { calls.push('token'); return { ok: true, status: 200, json: payload() }; }
          if (msg.type === 'getStriffsDebugContext') return { ok: true, apiBase: 'http://localhost' };
          return { ok: true };
        };
        const realToast = S.toast;
        const realLocal = chrome.storage.local;
        S.toast = (message) => { toasts.push(String(message)); return () => {}; };
        // A load reads the cache and the cache-clear flag through storage callbacks, which the page's
        // stub never calls. An empty store that answers stands in for a first visit.
        chrome.storage.local = {
          get: (keys, cb) => { cb?.({}); return Promise.resolve({}); },
          set: (items, cb) => { cb?.(); return Promise.resolve(); },
          remove: (keys, cb) => { cb?.(); return Promise.resolve(); }
        };
        let finished = false;
        try {
          // Bounded, so a load that stalls fails a check instead of hanging the suite.
          await Promise.race([
            S.autoFetchStriffs().then(() => { finished = true; }),
            new Promise((resolve) => setTimeout(resolve, 20000))
          ]);
        } finally {
          S.toast = realToast;
          chrome.storage.local = realLocal;
        }
        return { calls, toasts, finished };
      };
    });
    const RAW = /Failed (downloading base zip|to download zip)/;
    const LOOKS_PRIVATE = /looks private/i;
    const shown = (r) => `finished=${r.finished} calls=${r.calls.join(',')} toasts=${r.toasts.join(' | ')}`;
    const loadPr = async (opts) => {
      const r = await page.evaluate((o) => window.Striffs.__loadTest(o), opts);
      if (!r.finished) check(`the load for ${opts.repo} finishes`, false, shown(r));
      return r;
    };

    // The case that shipped: GitHub cannot be asked, and codeload answers 404.
    const cannotAsk = { ok: false, status: 403, json: { message: 'API rate limit exceeded' } };
    let r = await loadPr({ repo: 'misread-no-token', github: cannotAsk });
    check('a codeload 404 never reaches the user as its raw message', !r.toasts.some(t => RAW.test(t)), shown(r));
    check('without a token, it asks for one', r.toasts.some(t => LOOKS_PRIVATE.test(t)), shown(r));
    r = await loadPr({ repo: 'misread-token', token: 'ghp_test', github: cannotAsk });
    check('with a token, it falls back to the token route', r.calls.filter(c => c !== 'github:repo').join(',') === 'upload,token', shown(r));
    check('and says nothing', r.toasts.length === 0, shown(r));

    // GitHub says the repository is private: codeload is never asked.
    r = await loadPr({ repo: 'private-token', token: 'ghp_test', github: { ok: true, status: 200, json: { private: true } } });
    check('a private repository with a token goes straight to the token route', !r.calls.includes('upload') && r.calls.includes('token'), shown(r));
    check('and shows no error', r.toasts.length === 0, shown(r));
    r = await loadPr({ repo: 'private-no-token', github: { ok: false, status: 404, json: { message: 'Not Found' } } });
    check('a private repository without a token is not sent to codeload', !r.calls.includes('upload') && !r.calls.includes('token'), shown(r));
    check('and is asked for a token, not shown a download error', r.toasts.some(t => LOOKS_PRIVATE.test(t)) && !r.toasts.some(t => RAW.test(t)), shown(r));

    // Public repositories are unchanged.
    r = await loadPr({ repo: 'public', token: 'ghp_test', github: { ok: true, status: 200, json: { private: false } }, zipOk: true });
    check('a public repository takes the upload route', r.calls.includes('upload') && !r.calls.includes('token') && r.toasts.length === 0, shown(r));
    r = await loadPr({ repo: 'public', token: 'ghp_test', github: { ok: true, status: 200, json: { private: false } }, zipOk: true });
    check("the repository's visibility is asked once and remembered", !r.calls.includes('github:repo'), shown(r));
  }

  console.log('\nno manual review trigger');
  {
    const remaining = await page.evaluate(() => ['triggerArchitectureReview', 'startEnrichmentPolling',
      'maybeAutoStartReviewPolling', 'refreshDiagramWithEnrichment', 'updateDocRuleHeadline']
      .filter(n => typeof window.Striffs[n] === 'function'));
    check('nothing left to start or trigger a review, or to lay the rule count over the diagram',
      remaining.length === 0, remaining.join(', '));
    const headline = await page.evaluate(() => Boolean(document.getElementById('striffs-coverage-headline')));
    check('no documented-rule headline over the diagram', !headline);
    for (const phrase of ['>AI Review<', '"AI Review"', 'Executing architecture review', 'Obtaining operation context',
      'Architecture review complete', 'striffs-coverage-headline']) {
      check(`the content script no longer says ${phrase}`, !SRC.includes(phrase));
    }
    check('no button state above read "AI Review"', buttonTexts.length > 0 && !buttonTexts.includes('AI Review'),
      buttonTexts.join(' | '));
  }

  console.log('\ndiagram source decoding');
  {
    // With debug logging on, every render decodes the PlantUML source embedded in the diagram. The
    // base64 padding leaves bytes after the compressed data, which used to raise two uncaught errors
    // in the page per render. Node's decompressor ignores those bytes, so only a browser shows it.
    await page.addScriptTag({ content: fs.readFileSync(path.resolve(__dirname, '..', 'src', 'plantuml-utils.js'), 'utf8') });
    const before = pageErrors.length;
    const decoded = await page.evaluate(async () => {
      const U = window.StriffsPlantUmlUtils;
      const source = '@startuml\nclass A\nA --> B\n@enduml';
      const ok = (await U.decode(await U.encode(source))) === source;
      await new Promise(r => setTimeout(r, 200));
      return ok;
    });
    check('decodes the embedded diagram source', decoded);
    check('raises no uncaught error doing it', pageErrors.length === before, pageErrors.slice(before).join('; '));
  }

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '));

  await browser.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
