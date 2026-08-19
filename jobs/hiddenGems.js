'use strict';
require('dotenv').config();
const fpl = require('../lib/fplClient');
const { postBoth } = require('../lib/posters');
const { openStore, wasWeeklyPostSent, markWeeklyPostSent } = require('../lib/fplStorage');
const { formatMoney, topByField } = require('../lib/fplAnalytics');
const { withCaption } = require('../lib/branding');

const JOB = 'hiddenGems';
const LOW_OWNERSHIP_PCT = 10;

async function run() {
  const store = openStore();
  await store.init();

  try {
    const bootstrap = await fpl.getBootstrap();
    const { next } = fpl.getCurrentAndNextEvent(bootstrap);
    if (!next) {
      console.log('[hiddenGems] no upcoming gameweek, nothing to do');
      return;
    }

    if (await wasWeeklyPostSent(store, JOB, next.id)) {
      console.log(`[hiddenGems] GW${next.id} hidden gems already posted`);
      return;
    }

    const players = bootstrap.elements;

    // "form" is FPL's own rolling average over recent gameweeks — using it
    // instead of a hand-summed "last 5 GWs" total, since that would need a
    // per-player history call (600+ requests) just to build one post.
    const gems = topByField(
      players,
      'form',
      3,
      (p) => parseFloat(p.selected_by_percent) < LOW_OWNERSHIP_PCT
    );

    const valuePicks = [...players]
      .filter((p) => p.minutes > 180)
      .map((p) => ({ player: p, ppm: p.total_points / (p.now_cost / 10) }))
      .sort((a, b) => b.ppm - a.ppm)
      .slice(0, 3);

    if (!gems.length && !valuePicks.length) {
      console.log('[hiddenGems] not enough season data yet, skipping');
      return;
    }

    const lines = ['💎 HIDDEN GEMS 💎', ''];

    if (gems.length) {
      lines.push('Low ownership, in form:');
      gems.forEach((p) =>
        lines.push(`🎯 ${p.web_name} - ${p.selected_by_percent}% owned, ${p.form} form`)
      );
      lines.push('');
    }

    if (valuePicks.length) {
      lines.push('💰 Best value picks (points per million):');
      valuePicks.forEach((v, i) =>
        lines.push(
          `${i + 1}. ${v.player.web_name} - ${v.ppm.toFixed(1)} PPM (${formatMoney(v.player.now_cost)})`
        )
      );
      lines.push('');
    }

    lines.push("Who's your differential? 👇");

    await postBoth(withCaption(lines.join('\n'), 'hiddenGems'));
    await markWeeklyPostSent(store, JOB, next.id);
    console.log(`[hiddenGems] posted GW${next.id} hidden gems`);
  } finally {
    await store.close();
  }
}

run().catch((err) => {
  console.error('[hiddenGems] fatal error:', err);
  process.exitCode = 1;
});
