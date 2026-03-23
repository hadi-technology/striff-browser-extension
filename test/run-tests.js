async function runUiCoreSmokeTest() {
  try {
    const result = await require('./ui-core-smoke.test');
    if (result?.skipped) {
      console.warn(`ui core smoke test skipped: ${result.reason || 'Playwright is unavailable'}`);
    }
  } catch (error) {
    const message = String(error?.message || error);
    if ((error?.code === 'MODULE_NOT_FOUND' && /playwright/i.test(message)) || error?.code === 'UI_SMOKE_SKIPPED') {
      console.warn(`ui core smoke test skipped: ${message}`);
      return;
    }
    throw error;
  }
}

(async () => {
  require('./manifest-permissions.test');
  require('./extract-pr-metadata.test');
  require('./striffs-pr-metadata-parity.test');
  require('./github-commit-count-extraction.test');
  await require('./background-engagement.test');
  await require('./striffs-result-contract.test');
  require('./zoom-layout.test');
  await runUiCoreSmokeTest();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
