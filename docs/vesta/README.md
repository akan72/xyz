# Vesta prices on /projects

A private scheduled Cloudflare Worker samples market data every 30 minutes.
A singleton SQLite Durable Object prevents duplicate deliveries and persists
cooldowns. The producer publishes one complete six-instrument display to private
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
npx wrangler@4.143.1 kv key get vesta:runs:alpaca:v2 --binding VESTA_PRICES --config workers/vesta/wrangler.toml --env staging --remote
```

Production pushes deploy both Workers through the existing deployment job.
GitHub Actions deploys code; it does not schedule market-data requests.
The Cloudflare trigger runs at minute 17 and 47. The bounded private history
records actual deliveries, batch status codes and publication timestamps, separately
from the preserved Yahoo and earlier Alpaca histories. It contains no quote tables or board copies. To stop refreshes, remove the staging Cron
Trigger; closing the site's PR preview does not remove the separate producer.
The earlier Codex observation automation remains paused.

API availability is separate from public-display permission. Alpaca's published
terms require notice/permission for making data available to other people;
public display rights must be arranged separately with Alpaca.

## Small display contract

`shared/vesta.ts` defines the six instruments and the private `vesta:display:v2`
cache key. The cached value is either `{version: 2, mode: "market", fetchedAt,
board}` or `{version: 2, mode: "demo", fetchedAt}`. Prices, previous closes,
provider identifiers and market-session metadata never enter the website cache.
The producer validates prices and freshness before formatting; Rust validates
only the version, timestamp, 6×22 dimensions and allowed tile codes before
rendering. Other failures continue to retain the current display.

The code follows one flow:

- `workers/vesta/alpaca.ts`: fetch two authenticated batches and validate six quotes.
- `shared/board.ts`: format those quotes to the same tiles as the CLI.
- `workers/vesta/prices.ts`: enforce cooldown and publish a board or demo marker.
- `workers/vesta/worker.ts`: Cloudflare entrypoints and compact private run records.
- `src/vesta.rs`: read the display and render safe tile HTML into the page.

The v2 key coexists with the previously deployed `vesta:latest:v1`; old data and
historical evidence remain untouched. The coordinator name and persisted cooldown
key stay unchanged, so deployment cannot reset the provider backoff. Deploy the
producer first, let an eligible refresh publish v2, then deploy the site consumer.
If v2 is absent or invalid, the site retains its CLI-generated sample.

## Validation and experiment record

`node --test scripts/vesta-prices.test.ts` covers batching, normalization,
freshness, duplicate prevention, failure retention and demo fallback. The checked-in
`scripts/fixtures/vesta-board.json` was generated directly with the Vesta 0.2.0
Python formatter's `format_for_board`: it includes sample prices and rounding
boundaries. Both TypeScript formatter checks and Rust renderer checks consume it.
`cargo test --lib` verifies safe rendering and malformed-cache fallback.

The refactor passed 12 focused TypeScript checks, 14 Rust checks, type checking
and a Worker build dry-run. Its isolated staging deployment then completed 14
scheduled publications, each with both Alpaca batches returning HTTP 200. The
live preview matched all 132 cached cells. Production still runs the previous
version; the staging result does not claim a v2 production deployment. See [deployment evidence](ALPACA.md)
and the [historical Yahoo experiment](YAHOO-EXPERIMENT.md).
