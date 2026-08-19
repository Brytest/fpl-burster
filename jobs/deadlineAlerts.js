'use strict';

require('dotenv').config();
const fpl = require('../lib/fplClient');
const { postBoth } = require('../lib/posters');
const {
  openStore,
  wasDeadlineAlertSent,
  markDeadlineAlertSent,
} = require('../lib/fplStorage');
const { withCaption } = require('../lib/branding');

const HOUR_MS = 60 * 60 * 1000;

// Windows are checked against a cron that runs every 30-60 min, so give
// each stage a tolerance band rather than an exact instant — otherwise a
// slightly-off cron tick means the alert never fires at all.
const STAGES = [
  { key: '24h', minHours: 23, maxHours: 25 },
  { key: '1h', minHours: 0.5, maxHours: 1.5 },
];

async function run() {
  const store = openStore();
  await store.init();

  try {
    const bootstrap = await fpl.getBootstrap();
    const { next, current } = fpl.getCurrentAndNextEvent(bootstrap);
    const upcoming = next || current; // fallback: mid-GW re-run scenarios
    if (!upcoming || !upcoming.deadline_time) {
      console.log('[deadlineAlerts] no upcoming deadline found, nothing to do');
      return;
    }

    const deadline = new Date(upcoming.deadline_time);
    const hoursUntil = (deadline.getTime() - Date.now()) / HOUR_MS;

    if (hoursUntil < 0) {
      console.log('[deadlineAlerts] deadline already passed, nothing to do');
      return;
    }

    for (const stage of STAGES) {
      const inWindow = hoursUntil <= stage.maxHours && hoursUntil >= stage.minHours;
      if (!inWindow) continue;

      const alreadySent = await wasDeadlineAlertSent(store, upcoming.id, stage.key);
      if (alreadySent) {
        console.log(`[deadlineAlerts] GW${upcoming.id} ${stage.key} alert already sent`);
        continue;
      }

      const label = stage.key === '24h' ? '24 hours' : '1 hour';
      const deadlineStr = deadline.toLocaleString('en-GB', {
        timeZone: 'Europe/London',
        dateStyle: 'medium',
        timeStyle: 'short',
      });

      const text =
        stage.key === '1h'
          ? `⏰ FINAL CALL — GW${upcoming.id} deadline is in ${label}! (${deadlineStr} UK). Lock in your transfers now.`
          : `📅 Reminder: GW${upcoming.id} deadline is in ${label} — ${deadlineStr} UK. Get your team sorted.`;

      await postBoth(withCaption(text, 'deadlineAlerts'));
      await markDeadlineAlertSent(store, upcoming.id, stage.key);
      console.log(`[deadlineAlerts] posted GW${upcoming.id} ${stage.key} alert`);
    }
  } finally {
    // Critical on a one-shot runner: flushes the batched Redis write queue
    // and closes the connection before the process exits.
    await store.close();
  }
}

run().catch((err) => {
  console.error('[deadlineAlerts] fatal error:', err);
  process.exitCode = 1;
});
