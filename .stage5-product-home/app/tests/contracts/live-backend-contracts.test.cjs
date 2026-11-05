const test = require('node:test');

test('live backend contract validation is run by scripts/validate-live-contracts.mjs', { skip: !process.env.HOME23_LIVE_CONTRACTS }, async () => {
  const { validateLiveContracts } = await import('../../scripts/validate-live-contracts.mjs');
  await validateLiveContracts({ rootDir: process.cwd(), strict: true });
});
