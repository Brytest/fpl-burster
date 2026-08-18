# fpl-burster

Standalone Fantasy Premier League bot. Posts to Telegram and Facebook via
four independent GitHub Actions workflows:

| Job | Schedule | Does |
|---|---|---|
| `deadline-alerts.yml` | every 30 min | Posts at T-24h and T-1h to the next GW deadline |
| `price-changes.yml` | daily, 02:00 UTC | Diffs player prices vs last snapshot, posts risers/fallers |
| `live-points.yml` | every 15 min, 11:00-23:00 UTC | Posts notable in-game point jumps; posts a top-5 summary once a GW finishes |
| `league-standings.yml` | every 4 hours | Posts mini-league standings once a GW is fully finished |

## Storage

Uses the same `storage.js` hybrid module as GoalBurster, Redis-only here
(no local JSON persistence needed since GitHub Actions runners are
ephemeral — `init()` reconciles from Redis fresh on every run).

## Setup

1. `npm install`
2. Set these as **repo secrets** (Settings → Secrets and variables → Actions):

   | Secret | Required for |
   |---|---|
   | `REDIS_URL` | all jobs |
   | `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Telegram posts |
   | `FB_PAGE_ID` / `FB_ACCESS_TOKEN` | Facebook posts |
   | `FPL_LEAGUE_IDS` | league-standings only — comma-separated classic league IDs |

3. Push to GitHub. Workflows run on their schedules automatically, or trigger
   manually via Actions tab → workflow → "Run workflow" (`workflow_dispatch`
   is enabled on all four).

## Notes

- **Live points polling window** is restricted to 11:00-23:00 UTC to avoid
  burning Action minutes 24/7 — realistic PL kickoffs all fall in that
  range. The job also self-gates on fixtures having actually started, so
  even within that window it's a fast no-op most of the time.
- If this repo is **private**, GitHub Free gives 2,000 Action minutes/month;
  at ~15-20s per run across ~4 workflows this comfortably fits, but keep an
  eye on usage if you add more frequent jobs. Public repos have unlimited
  minutes.
- `lib/posters.js` is a standalone Telegram/Facebook implementation (retry +
  backoff on 429/5xx), not a copy of GoalBurster's actual poster module —
  swap it out if you want the exact same idempotency-key/edit-retry logic.
