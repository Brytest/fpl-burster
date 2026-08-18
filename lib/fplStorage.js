'use strict';

const path = require('path');
const { getStorage } = require('./storage');

/**
 * All FPL jobs share one logical store ("fpl-burster"), namespaced by key
 * prefix per concern. Backend is Redis, resolved from REDIS_URL /
 * UPSTASH_REDIS_URL — same env convention as GoalBurster. Local JSON path
 * still gets set (storage.js requires one) but on a GH Actions runner it's
 * just a throwaway mirror; it never persists between runs, which is fine
 * because init() reconciles from Redis every time.
 */
function openStore() {
  return getStorage('fpl-burster', path.join('data', 'fpl-burster.json'), {
    backend: 'redis',
    timezone: 'Europe/London', // FPL deadlines are UK time
  });
}

// ---- Deadline alerts -------------------------------------------------

/** Has the 24h or 1h alert already gone out for this event? */
function deadlineAlertKey(eventId, stage) {
  return `deadline:${eventId}:${stage}`; // stage: '24h' | '1h'
}

async function wasDeadlineAlertSent(store, eventId, stage) {
  return !!store.get(deadlineAlertKey(eventId, stage), false);
}

async function markDeadlineAlertSent(store, eventId, stage) {
  // TTL: alerts are only ever relevant for a few days: let them expire
  // instead of growing this hash forever across a 38-gameweek season.
  await store.set(deadlineAlertKey(eventId, stage), true, { ttl: '7 days' });
}

// ---- Price changes -----------------------------------------------------

const PRICES_KEY = 'prices:last-known';

function getLastKnownPrices(store) {
  // { [playerId]: now_cost }
  return store.get(PRICES_KEY, null);
}

async function setLastKnownPrices(store, pricesMap) {
  await store.set(PRICES_KEY, pricesMap);
}

// ---- Live points ---------------------------------------------------------

function livePointsKey(eventId) {
  return `livepoints:${eventId}`;
}

function getLastLiveSnapshot(store, eventId) {
  // { [playerId]: total_points }
  return store.get(livePointsKey(eventId), null);
}

async function setLiveSnapshot(store, eventId, snapshot) {
  // Keep for 3 days after write — long enough to cover a postponed/replayed
  // fixture, short enough not to accumulate across a season.
  await store.set(livePointsKey(eventId), snapshot, { ttl: '3 days' });
}

function liveEventFinishedKey(eventId) {
  return `livepoints:${eventId}:finished-posted`;
}

async function wasFinishedSummaryPosted(store, eventId) {
  return !!store.get(liveEventFinishedKey(eventId), false);
}

async function markFinishedSummaryPosted(store, eventId) {
  await store.set(liveEventFinishedKey(eventId), true, { ttl: '7 days' });
}

// ---- League standings ------------------------------------------------

function standingsKey(leagueId) {
  return `standings:${leagueId}:last-posted-event`;
}

function getLastPostedStandingsEvent(store, leagueId) {
  return store.get(standingsKey(leagueId), null);
}

async function setLastPostedStandingsEvent(store, leagueId, eventId) {
  await store.set(standingsKey(leagueId), eventId);
}

// ---- Generic weekly content posts (recap, transfers, gems, fixtures, tips) ----

function weeklyPostKey(jobName, eventId) {
  return `weekly:${jobName}:${eventId}`;
}

async function wasWeeklyPostSent(store, jobName, eventId) {
  return !!store.get(weeklyPostKey(jobName, eventId), false);
}

async function markWeeklyPostSent(store, jobName, eventId) {
  // A week is plenty — by the time this would matter again the eventId
  // has moved on to the next gameweek.
  await store.set(weeklyPostKey(jobName, eventId), true, { ttl: '9 days' });
}

module.exports = {
  openStore,
  wasDeadlineAlertSent,
  markDeadlineAlertSent,
  wasWeeklyPostSent,
  markWeeklyPostSent,
  getLastKnownPrices,
  setLastKnownPrices,
  getLastLiveSnapshot,
  setLiveSnapshot,
  wasFinishedSummaryPosted,
  markFinishedSummaryPosted,
  getLastPostedStandingsEvent,
  setLastPostedStandingsEvent,
};
