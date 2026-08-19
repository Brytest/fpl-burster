'use strict';

require('dotenv').config();
const fpl = require('../lib/fplClient');
const { postBoth } = require('../lib/posters');
const { openStore, wasWeeklyPostSent, markWeeklyPostSent } = require('../lib/fplStorage');
const {
  getTeamsById,
  computeFixtureDifficulty,
  topByField,
} = require('../lib/fplAnalytics');
const { withCaption } = require('../lib/branding');

const JOB = 'fixtureFocus';
const LOOKAHEAD_GWS = 5;

async function run() {
  const store = openStore();
  await store.init();

  try {
    const bootstrap = await fpl.getBootstrap();
    const { next } = fpl.getCurrentAndNextEvent(bootstrap);
    if (!next) {
      console.log('[fixtureFocus] no upcoming gameweek, nothing to do');
      return;
    }

    if (await wasWeeklyPostSent(store, JOB, next.id)) {
      console.log(`[fixtureFocus] GW${next.id} fixture focus already posted`);
      return;
    }

    const teamsById = getTeamsById(bootstrap);
    const allFixtures = await fpl.getFixtures();
    const difficulty = computeFixtureDifficulty(allFixtures, next.id, LOOKAHEAD_GWS);

    if (!difficulty.size) {
      console.log('[fixtureFocus] no fixture data in window, skipping');
      return;
    }

    const ranked = [...difficulty.entries()].sort(
      (a, b) => a[1].avgDifficulty - b[1].avgDifficulty
    );
    const easiest = ranked.slice(0, 3);
    const hardest = ranked.slice(-3).reverse();

    // Captaincy: in-form players whose very next fixture (this upcoming
    // gameweek specifically) is favourable.
    const players = bootstrap.elements;
    const inForm = topByField(players, 'form', 15); // wide net, then filter by fixture
    const captainCandidates = inForm
      .map((p) => {
        const teamDiff = difficulty.get(p.team);
        const nextFixture = teamDiff?.fixtures.find((f) => f.eventId === next.id);
        return nextFixture ? { player: p, fixture: nextFixture } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.fixture.difficulty - b.fixture.difficulty)
      .slice(0, 3);

    const lines = ['📅 FIXTURE ANALYSIS 📅', '', `Best fixtures next ${LOOKAHEAD_GWS} GWs:`];
    easiest.forEach(([teamId]) => lines.push(`🟢 ${teamsById.get(teamId).name}`));
    lines.push('', `Toughest fixtures next ${LOOKAHEAD_GWS} GWs:`);
    hardest.forEach(([teamId]) => lines.push(`🔴 ${teamsById.get(teamId).name}`));

    if (captainCandidates.length) {
      lines.push('', 'Captaincy options for next GW:');
      captainCandidates.forEach((c, i) => {
        const opponent = teamsById.get(c.fixture.opponentId);
        const venue = c.fixture.isHome ? 'H' : 'A';
        lines.push(`${i + 1}️⃣ ${c.player.web_name} - vs ${opponent.short_name} (${venue})`);
      });
    }

    lines.push('', 'Who gets the armband? 👇');

    await postBoth(withCaption(lines.join('\n'), 'fixtureFocus'));
    await markWeeklyPostSent(store, JOB, next.id);
    console.log(`[fixtureFocus] posted GW${next.id} fixture focus`);
  } finally {
    await store.close();
  }
}

run().catch((err) => {
  console.error('[fixtureFocus] fatal error:', err);
  process.exitCode = 1;
});
