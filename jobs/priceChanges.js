'use strict';

const fpl = require('../lib/fplClient');
const { postBoth } = require('../lib/posters');
const {
  openStore,
  getLastKnownPrices,
  setLastKnownPrices,
} = require('../lib/fplStorage');

async function run() {
  const store = openStore();
  await store.init();

  try {
    const bootstrap = await fpl.getBootstrap();
    const players = bootstrap.elements; // now_cost is tenths of £m, e.g. 125 = £12.5m

    const currentPrices = {};
    for (const p of players) currentPrices[p.id] = p.now_cost;

    const lastKnown = getLastKnownPrices(store);

    if (!lastKnown) {
      // First ever run: nothing to diff against yet.
      await setLastKnownPrices(store, currentPrices);
      console.log('[priceChanges] no prior snapshot, seeded baseline prices');
      return;
    }

    const risers = [];
    const fallers = [];

    for (const p of players) {
      const prev = lastKnown[p.id];
      if (prev === undefined) continue; // new player, no baseline
      const diff = p.now_cost - prev;
      if (diff === 0) continue;
      const entry = `${p.web_name} £${(p.now_cost / 10).toFixed(1)}m`;
      if (diff > 0) risers.push(entry);
      else fallers.push(entry);
    }

    if (!risers.length && !fallers.length) {
      console.log('[priceChanges] no price changes since last run');
      await setLastKnownPrices(store, currentPrices);
      return;
    }

    const lines = ['💰 FPL Price Changes'];
    if (risers.length) lines.push('', '📈 Risers:', ...risers.map((r) => `↑ ${r}`));
    if (fallers.length) lines.push('', '📉 Fallers:', ...fallers.map((f) => `↓ ${f}`));

    await postBoth(lines.join('\n'));
    await setLastKnownPrices(store, currentPrices);
    console.log(
      `[priceChanges] posted ${risers.length} risers, ${fallers.length} fallers`
    );
  } finally {
    await store.close();
  }
}

run().catch((err) => {
  console.error('[priceChanges] fatal error:', err);
  process.exitCode = 1;
});
