# modal_assets

Generates the images for the remix styles (`public/assets/remix/`) on the
Qwen-Image endpoints deployed from [`hayek`](https://github.com/akan72/hayek):
`qwen-image` (Qwen-Image-2512, text to image) and `qwen-image-edit`
(Qwen-Image-Edit-2511, restyles the homepage avatar). Both are Apache 2.0,
run on one H100 per container and scale to zero, so nothing here deploys or
tears anything down.

- `assets.py`: every asset: which style it's for, where it goes, what a good
  candidate looks like, its prompt variants, and how it's post-processed.
  Written from [`docs/theme-remix/brief.md`](../docs/theme-remix/brief.md).
- `generate.py`: batches requests (4 at a time), caches each result as it
  arrives, keeps a spend ledger, and builds grids and contact sheets.
- `optimize.py`: turns a picked candidate into site files: AVIF + WebP at
  1x/2x, a seamless tile, or a one-color SVG traced with potrace.
- `out/` (gitignored): candidates, sidecars, `ledger.jsonl`, grids, contact
  sheets.

## Credentials

The endpoints need a Modal proxy-auth token: `MODAL_KEY` / `MODAL_SECRET`
in the environment, or in an env file passed with `--env-file` (default
`~/projects/hayek/v1-custom/.env`, the file wargames reads). They're only
sent as request headers, never printed or written.

## Workflow

    uv run modal_assets/generate.py plan                        # what's left and what it should cost
    uv run modal_assets/generate.py run --mode lightning --assets kvlt-logo   # optional: scout a prompt at 4 steps
    uv run modal_assets/generate.py run                         # every candidate, 50 steps
    uv run modal_assets/generate.py grid --asset kvlt-logo      # numbered sheet to judge
    uv run modal_assets/generate.py keep --asset kvlt-logo --picks 7 2 11 4 9 --notes "..."
    uv run modal_assets/generate.py contact                     # out/contact/index.html: top 5 per asset
    uv run modal_assets/optimize.py kvlt-logo --pick B          # after picking a winner

`run` skips anything already in `out/`, so an interrupted or preempted batch
resumes where it stopped; failed requests are retried three times and
otherwise left for the next run. Changing a prompt changes its hash and
starts a new directory. `--mock` draws placeholders into `out-mock/` to try
the pipeline without credentials.

Judging: Claude reads each `grid.jpg` against the asset's `use` line and the
brief, records the top five with `keep`, and `contact` lays them out for a
human to pick the winner.

## Cost

The estimate is the H100 rate ($3.95/h) plus 15% for CPU and memory, times
the seconds requests took, plus the 5-minute idle tail each container bills
after a batch. `run` prints it as it goes and refuses to start a batch that
would pass `--budget` (default $50). `spend` sums the ledger. The full asset
list is about 140 images, roughly $11.

## Rules

Images are texture and illustration only; text stays in HTML/CSS. The kvlt
logo is the one piece of lettering, drawn over the real heading text, which
stays in the page. Prompts name genres, never real brands, band logos or
characters; the edit prompts restyle the site's own avatar without changing
it.
