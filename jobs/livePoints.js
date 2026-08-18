'use strict';

const fpl = require('../lib/fplClient');
const { postBoth } = require('../lib/posters');
const {
  openStore,
  getLastLiveSnapshot,
  setLiveSnapshot,
  wasFinishedSummaryPosted,
  markFinishedSummaryPosted,
} = require('../lib/fplStorage');

// A player's live total_points jumping by this much in one poll almost
// always means a goal, assist, or bonus reveal — worth a post. Smaller
// jumps (e.g. clean sheet ticks accruing per minute) are noise.
const NOTABLE_POINT_JUMP = 3;

async function run() {
  const store = openStore();
  await store.init();

  try {
    const bootstrap = await fpl.getBootstrap();
    const { current } = fpl.getCurrentAndNextEvent(bootstrap);
    if (!current) {
      console.log('[livePoints] no current gameweek, nothing to do');
      return;
    }

    const fixtures = await fpl.getFixtures(current.id);
    const anyStarted = fixtures.some((f) => f.started);
    if (!anyStarted) {
      console.log(`[livePoints] GW${current.id} hasn't kicked off yet, skipping`);
      return; // gate: avoid burning Action minutes outside match windows
    }

    const allFinished = fixtures.every((f) => f.finished);
    const playersById = new Map(bootstrap.elements.map((p) => [p.id, p]));

    const live = await fpl.getLiveEvent(current.id);
    const currentSnapshot = {};
    for (const el of live.elements) {
      currentSnapshot[el.id] = el.stats.total_points;
    }

    if (!allFinished) {
      const previousSnapshot = getLastLiveSnapshot(store, current.id) || {};
      const notable = [];

      for (const [idStr, points] of Object.entries(currentSnapshot)) {
        const id = Number(idStr);
        const prevPoints = previousSnapshot[idStr] ?? 0;
        const jump = points - prevPoints;
        if (jump >= NOTABLE_POINT_JUMP) {
          const player = playersById.get(id);
          if (player) notable.push(`⚡ ${player.web_name}: ${prevPoints} → ${points} pts`);
        }
      }

      if (notable.length) {
        await postBoth(`🔴 Live GW${current.id} updates\n\n${notable.join('\n')}`);
        console.log(`[livePoints] posted ${notable.length} notable jumps`);
      } else {
        console.log('[livePoints] no notable point jumps this poll');
      }

      await setLiveSnapshot(store, current.id, currentSnapshot);
      return;
    }

    // All fixtures finished — post a one-time top-scorers summary.
    const alreadyPosted = await wasFinishedSummaryPosted(store, current.id);
    if (alreadyPosted) {
      console.log(`[livePoints] GW${current.id} finished summary already posted`);
      return;
    }

    const top = Object.entries(currentSnapshot)
      .map(([id, points]) => ({ player: playersById.get(Number(id)), points }))
      .filter((e) => e.player)
      .sort((a, b) => b.points - a.points)
      .slice(0, 5);

    const lines = [
      `✅ GW${current.id} complete — top performers:`,
      '',
      ...top.map((e, i) => `${i + 1}. ${e.player.web_name} — ${e.points} pts`),
    ];

    await postBoth(lines.join('\n'));
    await markFinishedSummaryPosted(store, current.id);
    await setLiveSnapshot(store, current.id, currentSnapshot);
    console.log(`[livePoints] posted GW${current.id} finished summary`);
  } finally {
    await store.close();
  }
}

run().catch((err) => {
  console.error('[livePoints] fatal error:', err);
  process.exitCode = 1;
});
