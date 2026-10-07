# xyz

Personal website [`alexkan.xyz`](https://alexkan.xyz/) built in Rust on
[Cloudflare Workers](https://developers.cloudflare.com/workers/) via
[`workers-rs`](https://github.com/cloudflare/workers-rs).
[Static Assets](https://developers.cloudflare.com/workers/static-assets/)
serves the HTML/images from the edge; an
[R2](https://developers.cloudflare.com/r2/) binding backs the dynamic
`/image` endpoint.

## Layout

- `site/` — the [Astro](https://astro.build/) project that builds `dist/`
  (in `site/` because `src/` is the Worker):
  - `site/pages/` — one `.astro` file per page (`ideology.astro` →
    `/ideology`), including `404.astro`.
  - `site/layouts/Page.astro` — every page's `<head>`, the shared header
    (`site/components/SiteHeader.astro`) and the scripts every page loads.
    `site/components/ThemeScript.astro` sets the light/dark theme before the
    page paints.
  - `site/styles/site.css` — styles every page shares: fonts, colors, the
    page column, page transitions. Each page and component keeps its own
    styles in a scoped `<style>` block; Astro inlines a page's CSS into it.
  - `site/content/projects/` — one Markdown file per project on `/projects`;
    the schema is in `site/content.config.ts`.
  - `site/content/writing/` — one Markdown or MDX file per post, listed on
    `/writing` (`site/pages/writing.astro`) and rendered by
    `site/pages/writing/[slug].astro` with `site/layouts/Post.astro`.
  - `site/scripts/page-navigation.js` — changes pages without a reload: the
    header stays put and the outgoing page fades out. Used instead of Astro's
    `<ClientRouter />`, which measured 75-360 ms slower per page change and
    blocks clicks during the fade
    ([#35](https://github.com/akan72/xyz/pull/35)).
  - `site/scripts/screensaver.js` — idle screensaver: the
    `public/assets/xyz-logo/` mark bounces around after 5s without input. Set
    `ENABLED = false` at the top of the file to turn it off.
  - `site/integrations/agent-files.ts` — after the pages build, writes the
    files AI crawlers and agents read: a Markdown copy of each page
    (`/ideology.md`, `/index.md`), `llms.txt`, `llms-full.txt`, `sitemap.xml`
    (each page dated by its last git commit) and `_headers`.
- `public/` — images, `robots.txt`, the projects figure's script
  (`assets/subway-vis.js`) and other static files, copied into `dist/`
  unchanged.
- `docs/screensaver/` — design log for the screensaver: screenshots and
  recordings from each iteration. Not deployed.
- `src/lib.rs` — the Worker code. Handles `GET /image` (random cig HTML) and
  `GET /cig/{id}` (R2 fetch + stream), adds link-preview tags to pages, and
  serves a page's Markdown copy to requests sent with
  `Accept: text/markdown`. Unmatched paths get `404.html`.
- `src/link_preview.rs` — adds Open Graph / Twitter tags to every HTML page.
- `astro.config.ts` — Astro's settings: `site/` in, `dist/` out, one
  `.html` file per page.
- `wrangler.toml` — build command (Astro, then `worker-build`), assets directory, R2 binding, custom
  domain routes, and the `[previews]` block with the bindings PR previews get.
- `scripts/preview-url.sh`, `scripts/delete-preview.sh` — read a PR
  preview's URL and delete it, for the workflows in `.github/workflows/`.
- `Cargo.toml` — `workers-rs` deps; compiled to WASM by `worker-build`.

## Adding a page

Add an `.astro` file to `site/pages/` that wraps its content in the shared
layout, and add it to the header in `site/components/SiteHeader.astro` and
the `routes` in `site/scripts/page-navigation.js`:

    ---
    import Page from "../layouts/Page.astro";
    ---
    <Page title="Notes | alexkan.xyz" description="Things I've noticed.">
        <h2>Notes</h2>
        ...
    </Page>

    <style>
        /* this page's styles, scoped to it */
    </style>

The build adds it to `llms.txt`, `llms-full.txt`, `sitemap.xml` and its own
Markdown copy, dated by its last git commit. It fails if the title or
description is missing or its URL contains a dot. Pages passed `noindex`
instead of a description (like `404.astro`) are left out.

## Adding a project

Add a Markdown file to `site/content/projects/`, e.g.
`site/content/projects/notes.md`, with the details as frontmatter and a
sentence or two about it as the body:

    ---
    name: notes
    url: https://github.com/akan72/notes
    years:
      kind: since        # (2024-Present); or kind: range with start and end,
      start: 2024        # (2020-2023); or kind: single with year, (2025)
    stack:
      - Rust
      - Cloudflare Workers, R2
    order: 6             # position in the list, smallest first
    ---

    What it does. Links like [this one](https://example.com) open in a new tab.

`media: subway-vis` puts the live istheldown figure above the description.
`media: vesta-demo` embeds Vesta's generated offline board preview and text view.
See [docs/vesta/README.md](docs/vesta/README.md) for regeneration instructions
and the plan for securely serving refreshed market prices in a future update.
`astro build` fails if an entry doesn't match the schema in
`site/content.config.ts` (https URL, a known kind of years with the start
before the end, a non-empty stack), or if two projects share an `order`.

## Writing

Add a `.mdx` (or `.md`) file to `site/content/writing/`. Its filename is
its URL: `site/content/writing/my-post.mdx` is `/writing/my-post`.

    ---
    title: My post
    description: One sentence, for search results and llms.txt.
    date: 2026-10-07
    draft: true          # remove to publish
    ---

    Opening paragraph. The title and date render above it.

While `draft: true`, the post shows in `npm run dev` (with a Draft marker)
and the build leaves it out entirely. Published posts are listed on
`/writing`, newest first, and get a Markdown copy, an `llms.txt` entry under
"Writing" and a sitemap entry, like every page.

MDX can embed components, such as an interactive figure: put the component
in `site/components/`, then import and use it in the post:

    import MyFigure from "../../components/MyFigure.astro";

    <MyFigure />

Writing is in the header. The `/writing` list changes pages like the others;
posts load as full pages, so any scripts in them (like an interactive
figure's) run.

## Tests

    npm ci
    npm run check   # type-check site/ against the content collections
    npm run build   # build dist/; fails on a bad page or project
    npm test        # unit tests, then checks on the built dist/
    python3 -m unittest discover -s scripts   # Worker Preview workflow tests

## Local dev

Prerequisites:

    rustup target add wasm32-unknown-unknown
    cargo install worker-build
    npm install -g wrangler
    npm ci

Run against the real R2 bucket:

    wrangler dev --remote

The build (and `dist/`) reruns when `src/`, `public/` or `site/` change.
For faster page edits without the Worker, run `npm run dev`. It starts on
http://localhost:4321, or the next free port if that's taken (it's allowed to
run alongside another dev server; Astro prints the URL).

Open http://localhost:8787

## Deploy

Pushes to `master` deploy via GitHub Actions
(`.github/workflows/deploy.yml`). To deploy manually:

    wrangler deploy

Each PR gets a [Worker Preview](https://developers.cloudflare.com/workers/previews/)
of the `xyz` Worker, named `pr-<N>`, made with
`wrangler preview --name pr-<N>`, and CI comments its URL
(`https://pr-<N>-xyz.<subdomain>.workers.dev`) on the PR. Previews use
`wrangler.toml` too: they never get its custom-domain routes, and they
inherit none of its bindings, so its `[previews]` block declares them again
(`scripts/test_previews.py` checks it). A preview only gets a URL while
Preview URLs are on for the Worker (`preview_urls = true`, which production
deploys apply). `.github/workflows/pr-preview-cleanup.yml` deletes the
preview when the PR closes.

First-time setup:

1. Set `bucket_name` in `wrangler.toml` (under `[[r2_buckets]]` and
   `[[previews.r2_buckets]]`) to your R2 bucket.
2. `wrangler login` (or set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`).
3. Add repo secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and
   `CLOUDFLARE_EMAIL` for GitHub Actions. `CLOUDFLARE_EMAIL` is the email of
   the Cloudflare account that owns the token: wrangler prints it, and the
   Actions logs are public, but GitHub masks a secret in the log of any job
   that uses it. So each step that uses the token gets it too, and stops if
   it's missing.
4. Add your custom domain to Clodufalre.

## Generate Zyn Favicon

    python scripts/favicon.py

## Link Previews

Every HTML page gets link-preview tags (iMessage, Slack, Discord, etc.)
from the Worker: `og:title` from the page's `<title>`, `og:description`
from its `<meta name="description">`, and the default card
`public/assets/og.jpg`. New pages need nothing extra.

To override a default on one page, declare that tag in the page's
`<Fragment slot="head">`; root-relative paths are fine:

    <meta property="og:image" content="/assets/other-card.jpg">

Regenerate the default card (uses macOS system Georgia):

    uv run --with pillow python scripts/og.py          # add --dark for the dark card

## Inspiration

- [Tom Schmidt's Website](https://github.com/tomhschmidt/PersonalWebsite)
- [Artur Sapek's Website](https://github.com/artursapek/isometric-cubes/blob/main/artcx/src/main.rs)
- [0xichigo's Website](https://github.com/0xIchigo/0xIchigo-Website/tree/main)
