# xyz

Personal Website [`alexkan.xyz`](https://alexkan.xyz/) using [Axum](https://github.com/tokio-rs/axum), hosted on [fly.io](https://fly.io)

## Local Build

```{rust}
cargo run
```

Navigate to `localhost:8080`

## Deploy

Install fly.io cli

```{bash}
brew install flyctl
```

Deploy

```{bash}
fly deploy
```

Generate Zyn Favicon

```{python}
python scripts/favicon.py
```

## Details

- Axum webserver
- [`tower_serve_static`](https://docs.rs/tower-serve-static/latest/tower_serve_static/) to embed static assets into the Rust binary

## Inspiration

- [Tom Schmidt's Website](https://github.com/tomhschmidt/PersonalWebsite)
- [Artur Sapek's Website](https://github.com/artursapek/isometric-cubes/blob/main/artcx/src/main.rs)
- [0xichigo's Website](https://github.com/0xIchigo/0xIchigo-Website/tree/main)