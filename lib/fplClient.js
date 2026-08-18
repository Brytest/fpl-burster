'use strict';

/**
 * Thin wrapper around the public Fantasy Premier League API.
 * No auth required for these endpoints. No storage dependency —
 * callers own caching/diffing.
 */

const BASE = 'https://fantasy.premierleague.com/api';

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      // FPL's API is picky about a UA being present on some edge nodes.
      'User-Agent': 'Mozilla/5.0 (compatible; GoalBurster-FPL/1.0)',
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`FPL API ${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
}

/**
 * Master data dump: players, teams, gameweeks (events), settings.
 * Cache this per-run; it's the source of truth for prices, deadlines,
 * player names/teams, and current/next event.
 */
async function getBootstrap() {
  return fetchJson(`${BASE}/bootstrap-static/`);
}

/**
 * All fixtures for the season, or a single gameweek if eventId given.
 */
async function getFixtures(eventId) {
  const url = eventId
    ? `${BASE}/fixtures/?event=${eventId}`
    : `${BASE}/fixtures/`;
  return fetchJson(url);
}

/**
 * Live points/stats for every player in a given gameweek.
 * Updates during matches (subject to FPL's own lag, not just ours).
 */
async function getLiveEvent(eventId) {
  return fetchJson(`${BASE}/event/${eventId}/live/`);
}

/**
 * Classic mini-league standings, paginated. page defaults to 1
 * (top 50). Most private mini-leagues never need page 2+.
 */
async function getLeagueStandings(leagueId, page = 1) {
  return fetchJson(
    `${BASE}/leagues-classic/${leagueId}/standings/?page_standings=${page}`
  );
}

/**
 * A single manager's picks for a given gameweek (needed if you ever
 * want per-manager live score breakdowns, not just league totals).
 */
async function getManagerPicks(managerId, eventId) {
  return fetchJson(`${BASE}/entry/${managerId}/event/${eventId}/picks/`);
}

/** Convenience: pull current + next event objects out of bootstrap. */
function getCurrentAndNextEvent(bootstrap) {
  const events = bootstrap.events || [];
  const current = events.find((e) => e.is_current) || null;
  const next = events.find((e) => e.is_next) || null;
  return { current, next };
}

/**
 * True if any fixture in the event has kicked off but not finished.
 * Use this to gate the live-points job so it no-ops outside match windows.
 */
function eventHasLiveFixtures(fixtures) {
  return fixtures.some((f) => f.started && !f.finished);
}

module.exports = {
  getBootstrap,
  getFixtures,
  getLiveEvent,
  getLeagueStandings,
  getManagerPicks,
  getCurrentAndNextEvent,
  eventHasLiveFixtures,
};
