'use strict';
require('dotenv').config();
const fpl = require('../lib/fplClient');
const { postBoth } = require('../lib/posters');
const {
  openStore,
  getLastPostedStandingsEvent,
  setLastPostedStandingsEvent,
} = require('../lib/fplStorage');
const { withCaption } = require('../lib/branding');

// Comma-separated list of classic mini-league IDs, e.g. "12345,67890"
const LEAGUE_IDS = (process.env.FPL_LEAGUE_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

async function run() {
  if (!LEAGUE_IDS.length) {
    console.log('[leagueStandings] FPL_LEAGUE_IDS not set, nothing to do');
    return;
  }

  const store = openStore();
  await store.init();

  try {
    const bootstrap = await fpl.getBootstrap();
    const { current } = fpl.getCurrentAndNextEvent(bootstrap);
    if (!current) {
      console.log('[leagueStandings] no current gameweek, nothing to do');
      return;
    }

    const fixtures = await fpl.getFixtures(current.id);
    const allFinished = fixtures.length > 0 && fixtures.every((f) => f.finished);
    if (!allFinished) {
      console.log(`[leagueStandings] GW${current.id} not finished yet, skipping`);
      return; // gate: standings for the GW only settle once every match is done
    }

    for (const leagueId of LEAGUE_IDS) {
      const lastPosted = getLastPostedStandingsEvent(store, leagueId);
      if (lastPosted === current.id) {
        console.log(`[leagueStandings] league ${leagueId} GW${current.id} already posted`);
        continue;
      }

      const data = await fpl.getLeagueStandings(leagueId);
      const top = data.standings.results.slice(0, 10);
      const leagueName = data.league?.name || `League ${leagueId}`;

      const lines = [
        `🏆 ${leagueName} — GW${current.id} standings`,
        '',
        ...top.map(
          (r) =>
            `${r.rank}. ${r.entry_name} (${r.player_name}) — ${r.total} pts`
        ),
      ];

      await postBoth(withCaption(lines.join('\n'), 'leagueStandings'));
      await setLastPostedStandingsEvent(store, leagueId, current.id);
      console.log(`[leagueStandings] posted league ${leagueId} standings`);
    }
  } finally {
    await store.close();
  }
}

run().catch((err) => {
  console.error('[leagueStandings] fatal error:', err);
  process.exitCode = 1;
});
