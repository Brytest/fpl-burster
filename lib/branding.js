'use strict';

/**
 * Appends hashtags to every FPL post so they're visually distinct from
 * other content in the same Telegram/Facebook channels (e.g. GoalBurster's
 * live match posts). Global tags apply everywhere; job tags identify the
 * specific post type.
 */

const GLOBAL_HASHTAGS = ['#FPL', '#FantasyPremierLeague'];

const JOB_HASHTAGS = {
  deadlineAlerts: ['#FPLDeadline'],
  priceChanges: ['#FPLPrices'],
  livePoints: ['#FPLLive'],
  leagueStandings: ['#FPLStandings'],
  weeklyRecap: ['#FPLRecap'],
  transferTrends: ['#FPLTransfers'],
  hiddenGems: ['#FPLDifferentials'],
  fixtureFocus: ['#FPLFixtures'],
  deadlineTips: ['#FPLTips'],
};

/**
 * Optional signature line (e.g. bot/page name), set via env so it's easy
 * to change without touching code. Leave FPL_POST_SIGNATURE unset to omit.
 */
function getSignature() {
  return process.env.FPL_POST_SIGNATURE || null;
}

/**
 * @param {string} text   the post body, already fully composed
 * @param {string} jobKey one of the keys in JOB_HASHTAGS above
 */
function withCaption(text, jobKey) {
  const tags = [...GLOBAL_HASHTAGS, ...(JOB_HASHTAGS[jobKey] || [])];
  const signature = getSignature();

  const parts = [text];
  if (signature) parts.push(signature);
  parts.push(tags.join(' '));

  return parts.join('\n\n');
}

module.exports = { withCaption };
