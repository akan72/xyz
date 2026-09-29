"""The assets each remix style needs, as prompts for Qwen-Image / Qwen-Image-Edit.

Written from the per-style brief (docs/theme-remix/brief.md): every asset
names where it goes and what makes a candidate good, which the judge scores
against. Prompts describe generic genres only: no real brands, band logos or
copyrighted characters. The one exception is the edit input, the site's own
milady.jpg avatar, which the edit prompts restyle without changing.

Text stays in HTML/CSS. The only lettering generated here is the kvlt logo,
which is decoration over the real heading text (kept for screen readers and
search); every other prompt asks for no text.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Asset:
    id: str
    style: str  # kvlt | takeout | tvdinner
    kind: str  # generate (Qwen-Image-2512) | edit (Qwen-Image-Edit-2511, restyles `image`)
    use: str  # where it goes and what a good candidate looks like
    variants: dict[str, str]  # variant id -> prompt; each gets `seeds` candidates
    post: str  # after picking: raster (AVIF/WebP 1x/2x) | tile (seamless AVIF/WebP) | vector (potrace SVG)
    width: int  # CSS px it's shown at (a tile's size); the 2x file is twice this
    size: tuple[int, int] = (1024, 1024)  # generate only; multiples of 16
    seeds: int = 6
    negative: str = " "
    image: str | None = None  # edit input, relative to the repo root
    steps: int | None = None  # None = endpoint default (50 generate, 40 edit)
    cfg: float = 4.0


NO_TEXT = "text, letters, words, numbers, watermark, signature, logo, brand name, label"
LOW_QUALITY = "blurry, low resolution, jpeg artifacts, noisy, deformed, extra limbs"
SAME_CHARACTER = ("Keep the same character, pose, framing, hair, glasses, face and T-shirt exactly as they are; "
                  "change only the rendering style.")

_assets = [
    # --- kvlt: black metal album cover -------------------------------------
    Asset(
        id="kvlt-logo",
        style="kvlt",
        kind="generate",
        use="--kvlt-logo: the homepage title, an illegible spiky black metal logo that (barely) reads ALEX KAN, "
            "vectorized to a one-color SVG mask in bone white; the real h2 text stays for screen readers. Good: "
            "symmetrical, thorny, crisp solid shapes, no gray, still recognizably ALEX KAN if you squint.",
        variants={
            "thorns": 'A black metal band logo that spells "ALEX KAN", white ink on a solid pure black background. '
                      "Razor-sharp gothic letterforms with long thorn spikes shooting up and down from every stroke, "
                      "tangled branch-like tendrils, mirrored symmetrical composition, nearly illegible in the classic "
                      "underground black metal style. Hand-inked with a technical pen, crisp solid white shapes with "
                      "no gray tones, isolated in the center with wide black margins, flat vector artwork.",
            "arch": 'A black metal band logo that spells "ALEX KAN", white ink on a solid pure black background, the '
                    "letters arranged in a gentle arch over an inverted-triangle silhouette of dripping spikes, "
                    "jagged barbed serifs, symmetrical, extremely spiky and hard to read, hand-drawn with a dip pen, "
                    "crisp solid white shapes with no gray, centered with wide black margins, flat vector artwork.",
            "frost": 'A black metal band logo that spells "ALEX KAN", white on a solid pure black background, sharp '
                     "icicle-like strokes and frostbitten cracked edges, long symmetrical spikes above and below, "
                     "chaotic but balanced, raw hand-drawn ink, crisp solid white shapes with no gray, centered with "
                     "wide black margins, flat vector artwork.",
        },
        post="vector",
        width=520,
        size=(1664, 928),
        seeds=6,
        negative="color, gray, gradient, shading, 3D, bevel, glow, photo, texture, frame, border, extra words, "
                 "other letters, watermark, signature",
    ),
    Asset(
        id="kvlt-hero",
        style="kvlt",
        kind="edit",
        use="--kvlt-hero: the cover art over #milady, the avatar restyled as a real medium change (xerox, "
            "woodcut) where CSS now fakes it with grayscale + contrast. Good: same character and framing, "
            "convincing print texture, no color, face still readable at 420px wide.",
        variants={
            "xerox": "Restyle this picture as a harsh black-and-white photocopy: pure grayscale, crushed blacks, "
                     "blown-out whites, coarse toner grain, faint scanner streaks and dust, like the cover of an "
                     "underground 1990s black metal demo tape. " + SAME_CHARACTER,
            "woodcut": "Redraw this picture as a black-and-white woodcut print: bold carved black lines, white gouge "
                       "marks, high contrast, no gray tones, ink texture from the wood grain. " + SAME_CHARACTER,
            "grim": "Turn this picture into a grainy black-and-white film photograph lit from below by one harsh "
                    "light, deep shadows, heavy vignette, drifting fog, cold and bleak mood. " + SAME_CHARACTER,
        },
        post="raster",
        width=420,
        image="public/assets/milady.jpg",
        seeds=6,
        negative="color, " + LOW_QUALITY + ", different person, different face, " + NO_TEXT,
    ),
    Asset(
        id="kvlt-texture",
        style="kvlt",
        kind="generate",
        use="--kvlt-cover-texture: tiling background for the cover panel, a black photocopied page replacing "
            "the uniform feTurbulence grain. Good: dark enough for bone text (mostly #0c0c0c-#181818), uneven "
            "toner, dust and scratches, no obvious repeating features.",
        variants={
            "toner": "Seamless tileable texture of a black photocopied page: deep black toner, scattered tiny white "
                     "dust specks and hair-thin scratches, faint horizontal scanner streaks, subtle uneven grain, "
                     "uniform even lighting, flat top-down scan, no objects, no vignette.",
        },
        post="tile",
        width=256,
        seeds=8,
        negative="objects, vignette, light leaks, color, " + NO_TEXT,
    ),
    Asset(
        id="kvlt-forest",
        style="kvlt",
        kind="generate",
        use="--kvlt-forest (optional): a treeline strip along the bottom of the cover, fading up into black, the "
            "genre's classic misty-forest photo. Good: bare trees in fog, mostly black, quiet behind the picker.",
        variants={
            "fog": "Grainy black-and-white night photograph of a dead winter forest: bare twisted trees and tall "
                   "pines silhouetted against dense fog, a pale moon behind thin clouds, bleak and desolate, very "
                   "high contrast, crushed blacks, film grain, wide panoramic composition, no people, no buildings.",
        },
        post="raster",
        width=620,
        size=(1664, 928),
        seeds=8,
        negative="color, people, buildings, " + NO_TEXT,
    ),
    # --- takeout: Chinese-American takeout menu ------------------------------
    *[
        Asset(
            id=f"takeout-{dish}",
            style="takeout",
            kind="generate",
            use=f"--takeout-spot-*: a red-ink spot illustration ({dish}) for a corner of the menu card, vectorized "
                "to a one-color SVG that CSS tints crimson (four of the five dishes get a corner). Good: clean "
                "single-weight outlines, no fills or gray wash, reads at 44-56px.",
            variants={
                "ink": f"A simple line illustration of {subject}, drawn in thin red ink with a fine brush pen on plain "
                       "white paper. Clean confident outlines, a little hatching, no fills, no shading, no background, "
                       "isolated in the center, vintage American Chinese restaurant menu illustration style.",
            },
            post="vector",
            width=80,
            seeds=6,
            negative="color fill, gray wash, shading, photo, background, frame, border, " + NO_TEXT,
        )
        for dish, subject in {
            "dumplings": "four pleated dumplings in a round bamboo steamer basket",
            "noodles": "an open folded paper takeout box with a wire handle, noodles and a pair of chopsticks sticking out",
            "fortune": "a fortune cookie with a small blank paper slip sticking out",
            "rice": "a bowl of steamed rice with a pair of chopsticks resting across the top",
            "teapot": "a round teapot with a small handleless tea cup beside it",
        }.items()
    ],
    Asset(
        id="takeout-paper",
        style="takeout",
        kind="generate",
        use="--takeout-paper: tiling paper for the menu card. Good: very light (stays under crimson and ink "
            "text), fine fibers, no features that repeat visibly.",
        variants={
            "plain": "Seamless tileable texture of cheap uncoated off-white menu paper, fine visible paper fibers, "
                     "subtle warm mottling, very light, flat and evenly lit, top-down scan, no stains, no creases, "
                     "no objects.",
            "greasy": "Seamless tileable texture of cheap uncoated off-white menu paper, fine visible paper fibers, "
                      "subtle warm mottling and two or three faint translucent grease spots, very light, flat and "
                      "evenly lit, top-down scan, no creases, no objects.",
        },
        post="tile",
        width=256,
        seeds=6,
        negative="dark, creases, folds, objects, shadows, vignette, " + NO_TEXT,
    ),
    Asset(
        id="takeout-ornament",
        style="takeout",
        kind="generate",
        use="--takeout-ornament (optional): a band behind 菜單, vectorized to a one-color crimson SVG. Good: "
            "symmetrical, thin even lines, quiet enough that 菜單 still reads on top, 240px wide.",
        variants={
            "pagoda": "A symmetrical decorative header ornament drawn in thin red ink on plain white paper: a small "
                      "pagoda roof in the center with stylized cloud scrolls curling out to both sides, vintage "
                      "American Chinese takeout menu, clean line art, no fills, isolated in the center.",
        },
        post="vector",
        width=240,
        size=(1664, 928),
        seeds=6,
        negative="color fill, shading, photo, background, frame, " + NO_TEXT,
    ),
    # --- tvdinner: 1950s retrofuturistic TV dinner box -----------------------
    Asset(
        id="tvdinner-meal",
        style="tvdinner",
        kind="generate",
        use="--tvdinner-lid-art: the box-lid hero, a painted mid-century meal on the red lid, left of the title "
            "on desktop (the gm badge holds the right). Good: glossy, appetizing, clearly a divided aluminum tray, "
            "flat background that masks cleanly, no text.",
        variants={
            "tray": "Mid-century 1950s advertising illustration, painted in gouache, of a frozen TV dinner in a "
                    "divided aluminum tray: slices of roast turkey with gravy, a scoop of whipped mashed potatoes "
                    "with a pat of butter, bright green peas and glazed carrot coins. Glossy and appetizing, soft "
                    "airbrushed highlights, slightly idealized, three-quarter top view, isolated on a plain flat "
                    "cream background, no packaging.",
            "rocket": "Mid-century 1950s space-age advertising illustration, painted in gouache: a divided aluminum "
                      "TV dinner tray of roast turkey, mashed potatoes, peas and carrots floating in the air with a "
                      "wisp of steam and a few small atomic sparkles around it, glossy and appetizing, soft "
                      "airbrushed highlights, isolated on a plain flat cream background.",
        },
        post="raster",
        width=260,
        size=(1328, 1024),
        seeds=6,
        negative="photo, modern, plastic packaging, " + NO_TEXT + ", " + LOW_QUALITY,
    ),
    Asset(
        id="tvdinner-badge",
        style="tvdinner",
        kind="generate",
        use="--tvdinner-badge: the \"gm\" sticker on the lid's corner, a hand-inked starburst silhouette "
            "replacing the geometric one, vectorized to a one-color SVG mask (mustard; the text stays in CSS). "
            "Good: 16-24 irregular points, solid, no inner detail, reads at 72px.",
        variants={
            "burst": "A single solid starburst price sticker silhouette with about twenty sharp irregular points, "
                     "like a 1950s supermarket 'new!' burst, flat solid black shape on plain white paper, hand-inked "
                     "edges, no inner detail, centered, isolated.",
        },
        post="vector",
        width=80,
        seeds=6,
        negative="color, gradient, shading, outline only, 3D, photo, " + NO_TEXT,
    ),
    Asset(
        id="tvdinner-sparkle",
        style="tvdinner",
        kind="generate",
        use="Atomic-age starburst ornaments for the lid and tray corners (and optionally the page wallpaper), "
            "vectorized to one-color SVGs that CSS tints mustard or teal. Good: the classic mid-century star of "
            "thin rays around a dot, crisp, reads at 24-40px.",
        variants={
            "atomic": "A single mid-century modern atomic starburst ornament: eight long thin pointed rays of "
                      "different lengths around a small round dot, flat solid black on plain white paper, crisp "
                      "clean vector shape, centered, isolated.",
            "twinkle": "A single four-pointed twinkle star with long thin concave points and a small circle in the "
                       "middle, 1950s space-age ornament, flat solid black on plain white paper, crisp clean vector "
                       "shape, centered, isolated.",
        },
        post="vector",
        width=40,
        seeds=5,
        negative="color, gradient, shading, 3D, photo, background pattern, " + NO_TEXT,
    ),
    Asset(
        id="tvdinner-tray",
        style="tvdinner",
        kind="generate",
        use="--tvdinner-tray: tiling brushed aluminum under the tray's CSS shading, which now reads as gray "
            "plastic. Good: fine even grain, light silver, no dents or reflections that would repeat visibly.",
        variants={
            "brushed": "Seamless tileable texture of a brushed aluminum foil tray surface: fine parallel brushed "
                       "grain, soft silver sheen, very subtle crinkles, evenly lit, flat top-down, no objects.",
        },
        post="tile",
        width=256,
        seeds=8,
        negative="dents, objects, reflections, dark, rust, " + NO_TEXT,
    ),
    Asset(
        id="tvdinner-hero",
        style="tvdinner",
        kind="edit",
        use="Optional: the main-course avatar repainted as 1950s advertising art. Good: same character, warm "
            "limited palette, airbrushed gouache look.",
        variants={
            "gouache": "Repaint this picture as a 1950s gouache advertising illustration with soft airbrushed "
                       "shading, a warm limited palette and slightly faded printing. " + SAME_CHARACTER,
        },
        post="raster",
        width=300,
        image="public/assets/milady.jpg",
        seeds=6,
        negative=LOW_QUALITY + ", different person, different face, " + NO_TEXT,
    ),
]

ASSETS = {a.id: a for a in _assets}
