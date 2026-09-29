# Remix styles: audit and asset brief

The homepage's style picker remixes the whole site into one of three
identities: black metal (`kvlt`), takeout menu (`takeout`) and tv dinner
(`tvdinner`). gm, the default, is the site as it was. Each style was rebuilt
in CSS alone from the prototype screenshots, with its fonts self-hosted.
This brief records where that CSS-only version falls short, and which
generated images (prompts in [`modal_assets/assets.py`](../../modal_assets/assets.py))
would close the gap.

Screenshots of every page in every style, at 1280×900 and 390×844, are in
[`audit/`](audit/). Contact sheets: [desktop](audit-desktop.webp),
[mobile](audit-mobile.webp).

## Rules the assets follow

- **Text stays in HTML/CSS.** Images are texture and illustration only. The
  kvlt logo is the one piece of lettering. It is drawn over the real `<h2>`,
  which screen readers and search still read. 菜單 is set in a 2-glyph font
  subset (1.6 KB), not generated.
- **gm ships nothing new.** It loads 0 B of remix files. Its only costs are
  `theme.js` (2,263 → 5,946 B, mostly comments), the picker markup on the
  homepage (+692 B), and a `data-page` attribute on each page (+21 B).
- **Each style's assets load only while it's picked.** Every image is a CSS
  background or mask under `html[data-remix="…"]`, so browsers never request
  another style's images, the same way its fonts work.
- **Formats.** Rasters are AVIF with a WebP fallback at 1x and 2x, via
  `image-set()`. Logos, illustrations and ornaments are traced to one-color
  SVGs and used as CSS masks, so the stylesheet picks their color.
- **Prompts.** They name genres, never real brands, band logos or
  characters. The two edit prompts restyle the site's own avatar
  (`milady.jpg`) and ask to keep the character unchanged.

## Black metal (`kvlt`)

The layout matches the reference: an album cover with a tracklist. It uses
Metal Mania for titles and Courier for the liner notes. The avatar is shown
in grayscale with the cig pasted over its corner, under a procedural
`feTurbulence` grain.

What CSS can't do convincingly:

1. **The logo.** Metal Mania reads as heavy metal, not black metal. A real
   black metal logo is hand-inked, symmetrical and thorny, which no font
   gives.
2. **The cover art.** Grayscale plus contrast on a smooth 3D render still
   looks like a 3D render. A genre cover would be a xerox or a woodcut: a
   change of medium, not a filter.
3. **The paper.** `feTurbulence` is even digital noise. Photocopied black has
   uneven toner, dust, scratches and scanner streaks.
4. **Atmosphere** (optional). The genre's misty treeline photo has no CSS
   equivalent.

| Asset | Hook in `kvlt.css` | Output | Budget (2x) |
|---|---|---|---|
| `kvlt-logo`: spiky ALEX KAN logo, 3 prompt variants × 6 | `--kvlt-logo` | one-color SVG mask | ≤ 10 KB |
| `kvlt-hero`: avatar restyled as xerox / woodcut / grim photo, 3 × 6 edits | `--kvlt-hero` | AVIF/WebP, 420 px wide | ≤ 40 KB |
| `kvlt-texture`: black photocopied page, seamless, 8 | `--kvlt-cover-texture` | AVIF/WebP tile, 256 px | ≤ 15 KB |
| `kvlt-forest` (optional): foggy dead forest, 8 | `--kvlt-forest` | AVIF/WebP strip, 620 px wide | ≤ 25 KB |

## Takeout menu (`takeout`)

The layout matches the reference, with a few additions:

- The menu card has a double crimson border.
- 菜單 and ALEX KAN head the card, followed by the address line.
- The menu rows have codes, dotted leaders and prices, and Ideology gets two
  chilis.
- The combo box holds the milady, the cig and the random-cig add-on.
- THANK YOU closes the card.
- Subpages are menu sections, and the 404 page is "sold out".

What CSS can't do convincingly:

1. **Illustrations.** Real takeout menus are dotted with red-ink line
   drawings of dishes. The card has four empty corners waiting for them.
2. **The paper.** The card is a flat `#fffdf8`. Cheap menu paper has fibers
   and mottling, and sometimes a grease spot.
3. **The header** (optional). A red-ink ornament behind 菜單 would finish
   the masthead.

| Asset | Hook in `takeout.css` | Output | Budget (2x) |
|---|---|---|---|
| `takeout-dumplings`, `-noodles`, `-fortune`, `-rice`, `-teapot`: red-ink line drawings, 6 each; you pick four | `--takeout-spot-top-l/-r`, `--takeout-spot-foot-l/-r` | one-color SVG masks, 44–56 px | ≤ 6 KB each |
| `takeout-paper`: menu paper, plain or with grease spots, 6 + 6 | `--takeout-paper` | AVIF/WebP tile, 256 px | ≤ 15 KB |
| `takeout-ornament` (optional): pagoda and cloud scrolls, 6 | `--takeout-ornament` | one-color SVG mask, 240 px wide | ≤ 6 KB |

## TV dinner (`tvdinner`)

The layout matches the reference:

- A red lid carries the script name, SPACE-AGE WEB DINNER and a gm
  starburst.
- The aluminum tray has main course, side dish and dessert compartments,
  with red pills for the links.
- The picker sits on the tray's foot, over an atomic-age wallpaper (a
  771 B SVG).

What CSS can't do convincingly:

1. **The box art.** TV dinners were sold by a painted meal on the lid. The
   lid is a flat red band, and CSS can't paint turkey, peas and potatoes.
2. **The aluminum.** The gradients and inset shadows read as gray plastic.
   Foil needs brushed grain.
3. **The starbursts.** The clip-path badge is too regular. Hand-inked bursts
   and atomic sparkles are what make it look like the period.
4. **The avatar** (optional). The 3D render clashes with painted 1950s art.
   A gouache repaint would match.

The procedural wallpaper already works, so it stays CSS.

| Asset | Hook in `tvdinner.css` | Output | Budget (2x) |
|---|---|---|---|
| `tvdinner-meal`: gouache TV dinner, plain or floating with sparkles, 6 + 6 | `--tvdinner-lid-art` | AVIF/WebP, 260 px wide, feathered into the lid | ≤ 35 KB |
| `tvdinner-tray`: brushed aluminum, seamless, 8 | `--tvdinner-tray` | AVIF/WebP tile, 256 px | ≤ 15 KB |
| `tvdinner-badge`: hand-inked sticker burst, 6 | `--tvdinner-badge` | one-color SVG mask, 80 px | ≤ 4 KB |
| `tvdinner-sparkle`: atomic star and twinkle, 5 + 5 | lid and tray corners | one-color SVG masks | ≤ 3 KB each |
| `tvdinner-hero` (optional): avatar repainted in gouache, 6 edits | new hook over `#milady` | AVIF/WebP, 300 px wide | ≤ 35 KB |

## Bytes per style

These are what a 2x screen downloads, as measured by
`uv run scripts/remix_check.py shots` ([`audit/bytes.json`](audit/bytes.json)).
CSS is counted uncompressed; Cloudflare compresses it in transit.

| Style | Now: CSS + fonts | Planned images (required / with optionals) | Total |
|---|---|---|---|
| gm | 0 | 0 | 0 |
| kvlt | 38.2 KB | ≤ 65 / ≤ 90 KB | ≤ 105 / ≤ 130 KB |
| takeout | 31.4 KB | ≤ 39 / ≤ 45 KB | ≤ 71 / ≤ 77 KB |
| tvdinner | 51.8 KB | ≤ 60 / ≤ 95 KB | ≤ 112 / ≤ 147 KB |

Two restyles, `kvlt-hero` and the optional `tvdinner-hero`, sit over
`#milady`. The page still loads `milady.jpg` (32 KB) for them, but it's
cached from gm.

## Generation

`uv run modal_assets/generate.py plan` lists 142 candidates. They cost about
$11 at 50 steps, which includes the idle time each H100 bills after a batch.
The runs go to hayek's existing `qwen-image` and `qwen-image-edit`
endpoints, 4 requests at a time, with a hard stop at $50. The plan allows
up to $200.

Claude scores each asset's candidates against its row above and keeps the
top five. Contact sheets (`out/contact/`) then show them for you to pick
the winners. `optimize.py` turns a winner into the files and budgets above,
and each hook in the stylesheets takes one line to wire.
