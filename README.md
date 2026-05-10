# xyz

Personal website [`alexkan.xyz`](https://alexkan.xyz/) built in Rust on
[Cloudflare Workers](https://developers.cloudflare.com/workers/) via
[`workers-rs`](https://github.com/cloudflare/workers-rs).
[Static Assets](https://developers.cloudflare.com/workers/static-assets/)
serves the HTML/images from the edge; an
[R2](https://developers.cloudflare.com/r2/) binding backs the dynamic
`/image` endpoint.

## Layout

- `public/` — static HTML and images served by Workers Static Assets.
- `src/lib.rs` — the Worker code. Handles `GET /image` (random cig HTML) and
  `GET /cig/{id}` (R2 fetch + stream). Falls back to `404.html` for
  unmatched paths.
- `wrangler.toml` — assets directory, R2 binding, custom domain routes.
- `Cargo.toml` — `workers-rs` deps; compiled to WASM by `worker-build`.

## Local dev

Prerequisites:

    rustup target add wasm32-unknown-unknown
    cargo install worker-build
    npm install -g wrangler

Run against the real R2 bucket:

    wrangler dev --remote

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

## Inspiration

- [Tom Schmidt's Website](https://github.com/tomhschmidt/PersonalWebsite)
- [Artur Sapek's Website](https://github.com/artursapek/isometric-cubes/blob/main/artcx/src/main.rs)
- [0xichigo's Website](https://github.com/0xIchigo/0xIchigo-Website/tree/main)
