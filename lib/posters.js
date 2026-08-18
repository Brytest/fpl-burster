'use strict';

/**
 * Standalone Telegram + Facebook posters. Built fresh rather than assuming
 * GoalBurster's exact poster internals (didn't have that file) — if you'd
 * rather share fb24.js's actual poster module, this is a thin enough layer
 * to swap out without touching the jobs that call it.
 *
 * Both functions retry transient failures (429/5xx) with backoff, matching
 * the multi-provider failover pattern used elsewhere in GoalBurster.
 */

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FB_PAGE_ID = process.env.FB_PAGE_ID;
const FB_ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN;

async function withRetry(fn, { retries = 3, baseDelayMs = 1000, label } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.status || err.response?.status;
      const retryable = !status || status === 429 || status >= 500;
      if (!retryable || attempt === retries) break;
      const delay = baseDelayMs * 2 ** attempt;
      console.warn(
        `[posters] ${label} attempt ${attempt + 1} failed (${err.message}), retrying in ${delay}ms`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function sendTelegram(text, { parseMode = 'HTML', disablePreview = true } = {}) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[posters] Telegram not configured, skipping post');
    return null;
  }
  return withRetry(
    async () => {
      const res = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            text,
            parse_mode: parseMode,
            disable_web_page_preview: disablePreview,
          }),
        }
      );
      const body = await res.json();
      if (!res.ok || !body.ok) {
        const err = new Error(body.description || `Telegram HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return body.result;
    },
    { label: 'telegram sendMessage' }
  );
}

async function postFacebook(message) {
  if (!FB_PAGE_ID || !FB_ACCESS_TOKEN) {
    console.warn('[posters] Facebook not configured, skipping post');
    return null;
  }
  return withRetry(
    async () => {
      const res = await fetch(
        `https://graph.facebook.com/v19.0/${FB_PAGE_ID}/feed`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, access_token: FB_ACCESS_TOKEN }),
        }
      );
      const body = await res.json();
      if (!res.ok || body.error) {
        const err = new Error(body.error?.message || `Facebook HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return body;
    },
    { label: 'facebook feed post' }
  );
}

/** Post the same message to both platforms; failures on one don't block the other. */
async function postBoth(text) {
  const results = await Promise.allSettled([
    sendTelegram(text),
    postFacebook(text),
  ]);
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const platform = i === 0 ? 'Telegram' : 'Facebook';
      console.error(`[posters] ${platform} post failed:`, r.reason.message);
    }
  });
  return results;
}

module.exports = { sendTelegram, postFacebook, postBoth };
