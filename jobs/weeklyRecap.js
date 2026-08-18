'use strict';

const fpl = require('../lib/fplClient');
const { postBoth } = require('../lib/posters');
const { openStore, wasWeeklyPostSent, markWeeklyPostSent } = require('../lib/fplStorage');
const { getMostRecentFinishedEvent, getPlayersById } = require('../lib/fplAnalytics');

const JOB = 'weeklyRecap';

async function run() {
  const store = openStore();
  await store.init();

  try {
    const bootstrap = await fpl.getBootstrap();
    const finished = getMostRecentFinishedEvent(bootstrap);
    if (!finished) {
      console.log('[weeklyRecap] no finished gameweek yet, nothing to do');
      return;
    }

    if (await wasWeeklyPostSent(store, JOB, finished.id)) {
      console.log(`[weeklyRecap] GW${finished.id} recap already posted`);
      return;
    }

    const playersById = getPlayersById(bootstrap);
    const live = await fpl.getLiveEvent(finished.id);

    const scored = live.elements
      .map((el) => ({
        player: playersById.get(el.id),
        points: el.stats.total_points,
      }))
      .filter((e) => e.player && e.points > 0)
      .sort((a, b) => b.points - a.points);

    if (!scored.length) {
      console.log('[weeklyRecap] no scorers found, skipping');
      return;
    }

    const podium = scored.slice(0, 3);
    const medals = ['🥇', '🥈', '🥉'];

    // Differential: best score among players owned by under 10%.
    const differential = scored.find(
      (e) => parseFloat(e.player.selected_by_percent) < 10
    );

    const lines = [`🚨 GAMEWEEK ${finished.id} RECAP 🚨`, '', 'Top scorers:'];
    podium.forEach((e, i) => {
      lines.push(
        `${medals[i]} ${e.player.web_name} - ${e.points}pts (owned by ${e.player.selected_by_percent}%)`
      );
    });

    if (differential) {
      lines.push(
        '',
        `💎 Differential alert: ${differential.player.web_name} scored ${differential.points}pts with just ${differential.player.selected_by_percent}% ownership!`
      );
    }

    lines.push('', 'Who was your hero this week? 👇');

    await postBoth(lines.join('\n'));
    await markWeeklyPostSent(store, JOB, finished.id);
    console.log(`[weeklyRecap] posted GW${finished.id} recap`);
  } finally {
    await store.close();
  }
}

run().catch((err) => {
  console.error('[weeklyRecap] fatal error:', err);
  process.exitCode = 1;
});
