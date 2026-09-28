# xyz

Personal website [`alexkan.xyz`](https://alexkan.xyz/) built in Rust on
[Cloudflare Workers](https://developers.cloudflare.com/workers/) via
[`workers-rs`](https://github.com/cloudflare/workers-rs).
[Static Assets](https://developers.cloudflare.com/workers/static-assets/)
serves the HTML/images from the edge; an
[R2](https://developers.cloudflare.com/r2/) binding backs the dynamic
`/image` endpoint.

## Layout

- `public/` — hand-written HTML, images and `robots.txt`.
- `public/assets/screensaver.js` — idle screensaver loaded by every page: the
  `public/assets/xyz-logo/` mark bounces around after 5s without input. Set
  `ENABLED = false` at the top of the file to turn it off.
- `docs/screensaver/` — design log for the screensaver: screenshots and
  recordings from each iteration. Not deployed.
- `scripts/sitegen.py` — runs in the wrangler build. Copies `public/` to
  `dist/` (served by Workers Static Assets) and generates the files AI
  crawlers and agents read: `llms.txt`, `llms-full.txt`, a Markdown copy of
  each page (`/ideology.md`, `/index.md`) and `sitemap.xml`.
- `src/lib.rs` — the Worker code. Handles `GET /image` (random cig HTML) and
  `GET /cig/{id}` (R2 fetch + stream), adds link-preview tags to pages, and
  serves a page's Markdown copy to requests sent with
  `Accept: text/markdown`. Unmatched paths get `404.html`.
- `src/link_preview.rs` — adds Open Graph / Twitter tags to every HTML page.
- `wrangler.toml` — build command, assets directory, R2 binding, custom
  domain routes.
- `Cargo.toml` — `workers-rs` deps; compiled to WASM by `worker-build`.

## Adding a page

Add an `.html` file to `public/` with a `<title>` and a
`<meta name="description">`. The build adds it to `llms.txt`,
`llms-full.txt`, `sitemap.xml` and its own Markdown copy, dated by its last
git commit. It fails if either tag is missing. Pages with
`<meta name="robots" content="noindex">` (like `404.html`) are left out.

Test the generator with:

    python3 -m unittest discover -s scripts

## Local dev

Prerequisites:

    rustup target add wasm32-unknown-unknown
    cargo install worker-build
    npm install -g wrangler

Run against the real R2 bucket:

    wrangler dev --remote

The build (and `dist/`) reruns when `src/`, `public/` or `scripts/` change.

Open http://localhost:8787

## Deploy

Pushes to `master` deploy via GitHub Actions
(`.github/workflows/deploy.yml`). To deploy manually:

    wrangler deploy

First-time setup:

1. Set `bucket_name` in `wrangler.toml` to your R2 bucket.
2. `wrangler login` (or set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`).
3. Add repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` for
   GitHub Actions.
4. Add your custom domain to Clodufalre.

## Generate Zyn Favicon

    python scripts/favicon.py

## Link Previews

Every HTML page gets link-preview tags (iMessage, Slack, Discord, etc.)
from the Worker: `og:title` from the page's `<title>`, `og:description`
from its `<meta name="description">`, and the default card
`public/assets/og.jpg`. New pages need nothing extra.

To override a default on one page, declare that tag in the page's `<head>`;
root-relative paths are fine:

    <meta property="og:image" content="/assets/other-card.jpg">

Regenerate the default card (uses macOS system Georgia):

    uv run --with pillow python scripts/og.py          # add --dark for the dark card

## Inspiration

- [Tom Schmidt's Website](https://github.com/tomhschmidt/PersonalWebsite)
- [Artur Sapek's Website](https://github.com/artursapek/isometric-cubes/blob/main/artcx/src/main.rs)
- [0xichigo's Website](https://github.com/0xIchigo/0xIchigo-Website/tree/main)
