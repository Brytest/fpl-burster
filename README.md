# fpl-burster

Standalone Fantasy Premier League bot. Posts to Telegram and Facebook via
four independent GitHub Actions workflows:

| Job | Schedule | Does |
|---|---|---|
| `deadline-alerts.yml` | every 30 min | Posts at T-24h and T-1h to the next GW deadline |
| `price-changes.yml` | daily, 02:00 UTC | Diffs player prices vs last snapshot, posts risers/fallers |
| `live-points.yml` | every 15 min, 11:00-23:00 UTC | Posts notable in-game point jumps; posts a top-5 summary once a GW finishes |
| `league-standings.yml` | every 4 hours | Posts mini-league standings once a GW is fully finished |
| `weekly-recap.yml` | Monday ~8am UTC | Top scorers + a differential shoutout from the just-finished GW |
| `transfer-trends.yml` | Tuesday ~12pm UTC | Biggest transfers in/out and net-gain leader for the upcoming GW |
| `hidden-gems.yml` | Wednesday ~6pm UTC | Low-ownership in-form players + best points-per-million picks |
| `fixture-focus.yml` | Thursday ~7pm UTC | Best/worst fixture runs over the next 5 GWs + captaincy suggestions |
| `deadline-tips.yml` | Friday ~6pm UTC | Injury news on widely-owned players, a captain pick, one transfer suggestion |

The five weekly content jobs are all keyed to UTC times as a rough stand-in
for the UK-time schedule you described — off by up to an hour depending on
BST/GMT. That's harmless: every job dedupes on gameweek id via
`wasWeeklyPostSent`/`markWeeklyPostSent` in `fplStorage.js`, so a run either
posts once for that GW or is a no-op — exact minute doesn't matter, only
"once per week, roughly the right day."

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

## Not automated (needs a human)

- Memes
- "Team reveal" / best-squad-gets-pinned community contests — someone has to read comments and pick a winner
- Native Facebook polls — the Graph API doesn't support post-attached polls anymore; the "🗳️ POLL" posts are just regular feed posts

## Data caveats

- **Hidden gems "form"**: uses FPL's own rolling `form` field rather than a
  hand-summed "points over last 5 GWs" — computing that properly would mean
  a per-player history call across 600+ players just to build one post.
- **Deadline tips injury news**: `news` is free-text FPL enters themselves
  (e.g. "Ankle injury - 75% chance of playing"), truncated to ~90 chars for
  the post. It's their own factual status line, not reworded commentary.

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
# fpl-burster
