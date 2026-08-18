'use strict';

/** Most recently completed gameweek (highest id where finished === true). */
function getMostRecentFinishedEvent(bootstrap) {
  const finished = bootstrap.events.filter((e) => e.finished);
  if (!finished.length) return null;
  return finished.reduce((a, b) => (a.id > b.id ? a : b));
}

function getTeamsById(bootstrap) {
  return new Map(bootstrap.teams.map((t) => [t.id, t]));
}

function getPlayersById(bootstrap) {
  return new Map(bootstrap.elements.map((p) => [p.id, p]));
}

function formatMoney(nowCost) {
  return `£${(nowCost / 10).toFixed(1)}m`;
}

/**
 * Average fixture difficulty per team over the next `count` gameweeks
 * starting at `fromEventId` (inclusive). Lower = easier. Returns a Map
 * teamId -> { avgDifficulty, fixtures: [{ eventId, opponentId, isHome, difficulty }] }.
 * Teams with a blank gameweek in the window get fewer fixtures counted,
 * not penalized or boosted for it.
 */
function computeFixtureDifficulty(allFixtures, fromEventId, count = 5) {
  const toEventId = fromEventId + count - 1;
  const inWindow = allFixtures.filter(
    (f) => f.event != null && f.event >= fromEventId && f.event <= toEventId
  );

  const byTeam = new Map();
  const record = (teamId, entry) => {
    if (!byTeam.has(teamId)) byTeam.set(teamId, []);
    byTeam.get(teamId).push(entry);
  };

  for (const f of inWindow) {
    record(f.team_h, {
      eventId: f.event,
      opponentId: f.team_a,
      isHome: true,
      difficulty: f.team_h_difficulty,
    });
    record(f.team_a, {
      eventId: f.event,
      opponentId: f.team_h,
      isHome: false,
      difficulty: f.team_a_difficulty,
    });
  }

  const result = new Map();
  for (const [teamId, fixtures] of byTeam) {
    const avg =
      fixtures.reduce((sum, x) => sum + x.difficulty, 0) / fixtures.length;
    fixtures.sort((a, b) => a.eventId - b.eventId);
    result.set(teamId, { avgDifficulty: avg, fixtures });
  }
  return result;
}

/** Highest-` field` N players, excluding those with 0 minutes played. */
function topByField(elements, field, count, filterFn = () => true) {
  return [...elements]
    .filter((p) => p.minutes > 0 && filterFn(p))
    .sort((a, b) => Number(b[field]) - Number(a[field]))
    .slice(0, count);
}

module.exports = {
  getMostRecentFinishedEvent,
  getTeamsById,
  getPlayersById,
  formatMoney,
  computeFixtureDifficulty,
  topByField,
};
