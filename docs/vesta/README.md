# Vesta prices on /projects

A private scheduled Cloudflare Worker samples market data every 30 minutes.
A singleton SQLite Durable Object prevents duplicate deliveries and persists
cooldowns. The producer publishes one complete six-instrument snapshot to private
KV. The existing Rust xyz Worker reads it when serving `/projects` and renders
all 132 cells into the HTML. Visitors never trigger provider requests.

The provider is now Alpaca; see [adapter and deployment details](ALPACA.md).
The Vesta CLI supports Yahoo/yfinance and Alpaca (`--provider yahoo|alpaca`)
and continues to send through the Vestaboard SDK. The website
never sends to a physical board.

## Security and display

- The producer has no routes, workers.dev URL or preview URL; HTTP returns 404.
- Both `/api/vesta` and its subpaths return 404 for every method.
- Alpaca credentials are Cloudflare secrets on the producer only. Authorization
  headers are sent only to Alpaca, redirects are refused, and logs contain fixed
  result codes rather than headers or upstream error bodies.
- Production uses KV `1434bc71e28a4c5b90e15f6a57a1078c`, bound only to `xyz`
  and the private producer `xyz-vesta-refresh`. PR previews and the staging
  producer use separate KV `f47f1c49d816470ca5947468c050442c`.
- The main site serves safe allowlisted tile HTML, not price JSON. Market data
  removes the Sample Prices caption. There is no text-view option on the page.
- `/projects` uses a 60-second cache TTL. Static HTML conditional validators are
  removed before live rendering. Markdown/static `.html` copies remain samples.

On a rate limit the producer writes a demo-mode marker, even after a prior
market publication, and persists a 1/2/4/8-hour cooldown. The site selects its
actual CLI-generated sample HTML; neither Worker duplicates demo prices.
Other failures preserve the current published display. The next successful
publication restores market mode. KV propagation may delay a newly published
board reaching another location.

## Demo artifact

The sample board is checked-in output from the actual CLI's `--demo --preview-file`
command. Regenerate it with:

```bash
npm run vesta:demo -- /path/to/vesta-checkout
```

Failed generation preserves the artifact. Ordinary site builds require no Python
runtime or provider access. The sample keeps BTC $83,436 and three green, two red
and one black chips.

## Production and staging deployment

The production producer is `xyz-vesta-refresh`; staging is
`xyz-vesta-refresh-staging`. Both have independently provisioned secrets. The two secret
names are `APCA-API-KEY-ID` and `APCA-API-SECRET-KEY`; values never belong in Git.

```bash
npx wrangler@4.143.1 deploy --config workers/vesta/wrangler.toml --env ""
npx wrangler@4.143.1 deploy

# Optional: update the isolated staging producer
npx wrangler@4.143.1 deploy --config workers/vesta/wrangler.toml --env staging
npx wrangler@4.143.1 kv key get vesta:runs:alpaca:v1 --binding VESTA_PRICES --config workers/vesta/wrangler.toml --env staging --remote
```

Production pushes deploy both Workers through the existing deployment job.
GitHub Actions deploys code; it does not schedule market-data requests.
The Cloudflare trigger runs at minute 17 and 47. The bounded private history
records actual deliveries, request status codes and exact publications, separately
from the preserved Yahoo history. To stop refreshes, remove the staging Cron
Trigger; closing the site's PR preview does not remove the separate producer.
The earlier Codex observation automation remains paused.

API availability is separate from public-display permission. Alpaca's published
terms require notice/permission for making data available to other people;
public display rights must be arranged separately with Alpaca.

## Validation and experiment record

TypeScript and Rust compile, the 19 existing preview checks pass, and offline
adapter checks verify two-request batching, complete 6×22 boards, missing-symbol
rejection, duplicate prevention and CLI fallback after HTTP 429. The live
Cloudflare result must be reported separately from fixture checks.

The earlier Yahoo experiment had zero successful market publications; see
[its historical implementation and evidence](YAHOO-EXPERIMENT.md). Switching
providers preserves that evidence and uses separate coordinator state.
