'use strict';

const fpl = require('../lib/fplClient');
const { postBoth } = require('../lib/posters');
const { openStore, wasWeeklyPostSent, markWeeklyPostSent } = require('../lib/fplStorage');
const {
  getTeamsById,
  computeFixtureDifficulty,
  topByField,
} = require('../lib/fplAnalytics');

const JOB = 'deadlineTips';
const LOOKAHEAD_GWS = 5;

function truncate(str, max = 90) {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

async function run() {
  const store = openStore();
  await store.init();

  try {
    const bootstrap = await fpl.getBootstrap();
    const { next } = fpl.getCurrentAndNextEvent(bootstrap);
    if (!next) {
      console.log('[deadlineTips] no upcoming gameweek, nothing to do');
      return;
    }

    if (await wasWeeklyPostSent(store, JOB, next.id)) {
      console.log(`[deadlineTips] GW${next.id} deadline tips already posted`);
      return;
    }

    const players = bootstrap.elements;
    const teamsById = getTeamsById(bootstrap);
    const allFixtures = await fpl.getFixtures();
    const difficulty = computeFixtureDifficulty(allFixtures, next.id, LOOKAHEAD_GWS);

    // Injury/rotation news on widely-owned players — the ones people
    // actually need to act on.
    const flagged = players
      .filter((p) => p.news && p.chance_of_playing_next_round !== 100)
      .sort((a, b) => parseFloat(b.selected_by_percent) - parseFloat(a.selected_by_percent))
      .slice(0, 4);

    // Captain pick: same "in-form + favourable next fixture" heuristic as
    // fixtureFocus, but we just want the single best one here.
    const inForm = topByField(players, 'form', 15);
    const captainPick = inForm
      .map((p) => {
        const teamDiff = difficulty.get(p.team);
        const nextFixture = teamDiff?.fixtures.find((f) => f.eventId === next.id);
        return nextFixture ? { player: p, fixture: nextFixture } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.fixture.difficulty - b.fixture.difficulty)[0];

    // Transfer suggestion: best in-form player not already the captain pick,
    // ownership under 30% so it's an actual suggestion rather than "buy Salah".
    const transferSuggestion = inForm.find(
      (p) =>
        p.id !== captainPick?.player.id && parseFloat(p.selected_by_percent) < 30
    );

    const lines = [`⏰ DEADLINE TOMORROW — GW${next.id} ⏰`, ''];

    if (flagged.length) {
      lines.push('⚠️ Injury news:');
      flagged.forEach((p) => {
        const pct =
          p.chance_of_playing_next_round === null
            ? ''
            : ` (${p.chance_of_playing_next_round}% chance)`;
        lines.push(`- ${p.web_name}${pct}: ${truncate(p.news)}`);
      });
      lines.push('');
    }

    lines.push('💡 Final tips:');
    if (captainPick) {
      const opp = teamsById.get(captainPick.fixture.opponentId);
      const venue = captainPick.fixture.isHome ? 'H' : 'A';
      lines.push(
        `✅ Captain: ${captainPick.player.web_name} (form ${captainPick.player.form}, vs ${opp.short_name} ${venue})`
      );
    }
    if (transferSuggestion) {
      lines.push(
        `✅ Consider: ${transferSuggestion.web_name} (form ${transferSuggestion.form}, ${transferSuggestion.selected_by_percent}% owned)`
      );
    }

    lines.push('', 'Last-minute changes? Drop your team below! 👇');

    await postBoth(lines.join('\n'));
    await markWeeklyPostSent(store, JOB, next.id);
    console.log(`[deadlineTips] posted GW${next.id} deadline tips`);
  } finally {
    await store.close();
  }
}

run().catch((err) => {
  console.error('[deadlineTips] fatal error:', err);
  process.exitCode = 1;
});
