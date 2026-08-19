'use strict';
require('dotenv').config();
const fpl = require('../lib/fplClient');
const { postBoth } = require('../lib/posters');
const { openStore, wasWeeklyPostSent, markWeeklyPostSent } = require('../lib/fplStorage');
const { withCaption } = require('../lib/branding');

const JOB = 'transferTrends';

async function run() {
  const store = openStore();
  await store.init();

  try {
    const bootstrap = await fpl.getBootstrap();
    const { next } = fpl.getCurrentAndNextEvent(bootstrap);
    if (!next) {
      console.log('[transferTrends] no upcoming gameweek, nothing to do');
      return;
    }

    if (await wasWeeklyPostSent(store, JOB, next.id)) {
      console.log(`[transferTrends] GW${next.id} transfer trends already posted`);
      return;
    }

    const players = bootstrap.elements;
    const in5 = [...players]
      .sort((a, b) => b.transfers_in_event - a.transfers_in_event)
      .slice(0, 3);
    const out5 = [...players]
      .sort((a, b) => b.transfers_out_event - a.transfers_out_event)
      .slice(0, 2);

    if (!in5[0]?.transfers_in_event) {
      console.log('[transferTrends] no transfer activity recorded yet, skipping');
      return;
    }

    const netLeader = [...players].sort(
      (a, b) =>
        b.transfers_in_event -
        b.transfers_out_event -
        (a.transfers_in_event - a.transfers_out_event)
    )[0];
    const netGain = netLeader.transfers_in_event - netLeader.transfers_out_event;

    const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n));

    const lines = [
      '🔄 TRANSFER TRENDS 🔄',
      '',
      'Players being bought ⬆️:',
      ...in5.map((p, i) => `${i + 1}. ${p.web_name} - ${fmt(p.transfers_in_event)} transfers in`),
      '',
      'Players being sold ⬇️:',
      ...out5.map((p, i) => `${i + 1}. ${p.web_name} - ${fmt(p.transfers_out_event)} transfers out`),
      '',
      `📈 Net gain: ${netLeader.web_name} +${fmt(netGain)}`,
      '',
      'Are you making moves this week? 🤔',
    ];

    await postBoth(withCaption(lines.join('\n'), 'transferTrends'));
    await markWeeklyPostSent(store, JOB, next.id);
    console.log(`[transferTrends] posted GW${next.id} transfer trends`);
  } finally {
    await store.close();
  }
}

run().catch((err) => {
  console.error('[transferTrends] fatal error:', err);
  process.exitCode = 1;
});
