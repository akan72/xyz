---
name: cig_scraper
url: https://github.com/akan72/cig_scraper
years:
  kind: single
  year: 2025
stack:
  - Python
  - Modal
  - Cloudflare R2
order: 5
---

Ingests all [Cigawrette Packs](https://opensea.io/collection/cigawrettepacks)
NFT images from IPFS and writes to an R2 bucket. Scale horizontally with Modal
to ingest them more quickly. This is what powers the random-cig button on the
homepage.
