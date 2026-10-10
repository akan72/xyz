# Alpaca production and staging deployment

The website producer calls Alpaca. The Vesta CLI supports both Yahoo/yfinance
and Alpaca while retaining the Vestaboard SDK for physical-board sends.

The private production producer is `xyz-vesta-refresh`; staging is
`xyz-vesta-refresh-staging`. It reads the Cloudflare
secrets `APCA-API-KEY-ID` and `APCA-API-SECRET-KEY` at runtime and sends them only
to `https://data.alpaca.markets`, with redirects refused. Neither the site
Worker nor browser receives those secrets. The Worker has no public route,
workers.dev URL, preview URL, or HTTP refresh endpoint.

Each scheduled refresh makes two concurrent HTTP requests, without retries:

- One `/v2/stocks/snapshots` request for SPCX, GLD, GOOG, META and VTI,
  explicitly using the free `iex` feed and USD currency. Prices are sampled
  minute-bar closes; percentage changes compare against `prevDailyBar.c`.
  IEX represents one exchange rather than consolidated all-exchange pricing.
- One `/v1beta3/crypto/us/bars` request for `BTC/USD`, using five-minute bars
  and an explicit 20-minute delay. The bounded range includes two prior UTC days, so a delayed bar just
  after midnight still has its correct previous-close comparison. Pagination, missing prior-close bars,
  future timestamps and stale quotes reject the complete snapshot.

Missing symbols or minute bars reject the six-row publication; values are never
fabricated to fill an unsupported ticker. All rows use the existing formatter.
The producer formats the validated quotes into a 6×22 board. The private v2
cache contains only the board and publication timestamp, or a demo marker.
Rust checks tile codes and dimensions instead of repeating provider validation.

The existing singleton Durable Object, duplicate prevention, atomic snapshot
publication, 1/2/4/8-hour cooldown and CLI-generated demo fallback remain. Alpaca
uses a different named coordinator and `refresh-state:alpaca:v1`; Yahoo's saved
cooldown and history are preserved, not reset. Alpaca's bounded private history
is stored under `vesta:runs:alpaca:v2`. Compact records contain trigger, result,
batch HTTP statuses and publication timestamp/mode, never quote tables, board
copies, authorization headers or provider error bodies. The original v1 history
is preserved as evidence of the previous deployment.

The 30-minute Cloudflare trigger is restored at minute 17 and 47. The previous
Codex monitoring automation remains paused. Production uses private KV
`1434bc71e28a4c5b90e15f6a57a1078c`; staging uses
`f47f1c49d816470ca5947468c050442c`. Deployments from master update both
the main site and production producer. Cloudflare Cron handles normal refreshes. The private `VestaOperations` RPC
entrypoint permits an authenticated administrative service binding to request
a manual refresh through the same coordinator and cooldown. HTTP remains 404.

API access does not establish public-display rights. Alpaca's published terms
require notice/permission for making data available to other people. Written
confirmation is recommended for the public personal-site use case.

References:
- https://docs.alpaca.markets/us/reference/stocksnapshots-1
- https://docs.alpaca.markets/us/reference/cryptobars-1
- https://files.alpaca.markets/disclosures/library/TermsAndConditions.pdf

The initial Yahoo Cloudflare experiment completed six scheduled deliveries:
two rate-limited attempts (all four requests HTTP 429) and four cooldown skips,
with zero market snapshots. The CLI-generated Sample Prices board remained
available. Its original `vesta:runs:v1` history and local observations are kept.

## Historical verification before the v2 simplification

The following results and screenshots describe the previously deployed v1 code.
The v2 refactor is verified locally and on isolated staging; production still
runs the previous version.

### First live verification

Deployed the private producer as version
`fed15d07-337e-44f8-a6aa-018cffc311bc` and updated only the PR 40 site preview
as deployment `f9d9c777-6d62-45cf-8957-63204a18ac7a`.
The first real scheduled refresh was 2026-10-08 18:47:29 UTC (2:47 PM Eastern):
both provider requests returned HTTP 200, all six instruments validated, and
one complete Alpaca market snapshot was published. Bitcoin's sampled price
was $81,373.2545; the board correctly rounded it to $81,373.

The live browser rendered 132 cells in 22 columns, with no Sample Prices
caption or text-view option, and made no provider/API requests. This verifies
one real scheduled publication, not long-term provider reliability.

### Production rollout

Production site version `a150c24e-107c-425b-87fa-f360edc78841` and private
producer version `3d94e28f-ccb3-414b-89a5-fdcaea496074` were deployed October 8.
The production producer has both secret names, its scheduled handler, the
30-minute trigger, and its dedicated KV binding. Its public URL returns 404.
The same production site version is available at
https://a150c24e-xyz.akan72.workers.dev/projects.

The local ISP security filter blocks the custom domain; the deployed production
version was therefore verified through its Cloudflare URL. Writing and Contact
pages still return 200. All 14 method/path checks on the retired price API return
404, and reloading the page makes no provider requests.

The empty production cache was warmed once with the actual staging publication
from 19:17:29 UTC. Both of that scheduled run's batch requests returned 200.
The production HTML matches all 132 cells of this publication, with no Sample
Prices caption or text view. This warm-up made no provider request and did not
modify or fabricate production run history. A production Cron success has not
yet been observed; it is a separate verification from the two successful staging
runs at 18:47 and 19:17 UTC.

![Production rendering of the scheduled staging publication](production-live-board.png)


### Immediate production verification

At the user's request, one manual refresh ran at 2026-10-08 19:44:22 UTC
through an authenticated remote service binding to `VestaOperations`, using the
production Worker's own secrets. Producer version
`caf1c3d2-5e0e-4f44-931f-261b6946b610` returned `updated`. Both batch requests
returned HTTP 200, and all six quotes were published at 19:44:23 UTC.
The production HTML matched all 132 cells of that exact publication, including
BTC $81,597. This replaced the initial staging cache warm-up.

Private history marks this run `trigger: manual`; it is not counted as a Cron
success. Normal refreshes retain the 30-minute interval and persisted cooldown;
a Cron delivery soon after this manual refresh may therefore skip fetching.
At verification time, production had one successful manual publication and zero
observed successful scheduled publications. Staging had two scheduled successes.

![Production rendering after the manual production refresh](production-manual-live-board.png)


## Verified v2 staging refactor

Staging producer `cbafd00a-bb89-47da-8a78-5d1b69fb6509` and PR 40 preview
`b7a22141-1d2e-4717-9174-df4c07b5aa18` were deployed October 8 at 20:48 UTC.
A manual invocation returned cooldown because the previous version had published
at 20:47 UTC. The new reader was initially checked using the existing real
publication converted to the smaller v2 display contract; that warm-up is not
counted as a fresh producer run.

The first actual v2 scheduled success was October 8 at 21:17:29 UTC
(5:17:29 PM Eastern). By observation at October 9, 04:25 UTC, compact history
showed 14 successful scheduled publications through 04:17:17 UTC. Every run had
both stock and crypto batches return HTTP 200: 28 successful requests, no rate
limits and no other failures recorded. All 132 live HTML cells matched the latest
v2 cache, with no Sample Prices caption or text view. Browser reloads made no
provider/API requests, and all 15 endpoint privacy checks returned 404.

The read-only monitor resumed after its intended deadline; it is now paused.
Stopping it did not change either Cloudflare producer or its schedule.
Production was not redeployed by this refactor verification.

[Compact observed run evidence](refactor-verification.json)

![Refactored preview after an actual scheduled publication](refactor-scheduled-board.png)
