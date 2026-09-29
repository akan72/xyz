# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.3", "numpy", "potracer"]
# ///
"""Turn a picked candidate into site files under public/assets/remix/<style>/.

    uv run modal_assets/optimize.py kvlt-hero                    # the judge's #1 (out/<asset>/top.json)
    uv run modal_assets/optimize.py kvlt-hero --pick B           # a contact-sheet letter
    uv run modal_assets/optimize.py kvlt-hero --pick path/to.png # any image

What happens depends on the asset's `post` (modal_assets/assets.py):
  raster  AVIF + WebP at 1x and 2x its CSS width: <name>.avif, <name>@2x.avif, ...
  tile    made seamless, then AVIF + WebP tiles at 1x and 2x
  vector  thresholded and traced with potrace into a one-color SVG, for CSS
          `mask-image` (so CSS picks the color) or `content: url()`

Tiles are healed without a model: the image is offset by half (so its edges
wrap), and the seam cross that leaves in the middle is covered by patches of
the original that are continuous there, blended with variance-preserving
weights so the blend doesn't look washed out. Uneven lighting is removed
first, since it would otherwise repeat as a visible plaid. That suits stochastic textures
(toner, paper, brushed metal), which is all the tile assets are.
"""

import argparse
import io
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from assets import ASSETS, Asset  # noqa: E402

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
OUT = HERE / "out"
SITE = REPO / "public/assets/remix"

AVIF_QUALITY = 52
WEBP_QUALITY = 76
HEAL_BAND = 0.14  # fraction of the tile each side of the seam cross that gets healed
FLATTEN = 1 / 8  # blur radius (fraction of the tile) of the uneven lighting removed before tiling


def pick_file(asset: Asset, pick: str | None) -> Path:
    if pick and Path(pick).exists():
        return Path(pick)
    top = json.loads((OUT / asset.id / "top.json").read_text())["picks"]
    if pick is None:
        return OUT / top[0]["file"]
    index = "ABCDEFGHIJ".index(pick.upper())
    return OUT / top[index]["file"]


def name_of(asset: Asset) -> str:
    return asset.id.removeprefix(asset.style + "-")


def save_pair(im: Image.Image, stem: Path) -> list[Path]:
    """AVIF + WebP of one image; returns the written paths."""
    stem.parent.mkdir(parents=True, exist_ok=True)
    avif, webp = stem.with_suffix(".avif"), stem.with_suffix(".webp")
    mode = "RGBA" if "A" in im.getbands() else "RGB"
    im.convert(mode).save(avif, "AVIF", quality=AVIF_QUALITY, speed=4)
    im.convert(mode).save(webp, "WEBP", quality=WEBP_QUALITY, method=6)
    return [avif, webp]


def resize_wrapped(im: Image.Image, size: int) -> Image.Image:
    """Resizes a seamless tile without clamping its edges, so it stays seamless."""
    pad = im.width // 16
    arr = np.pad(np.asarray(im), ((pad, pad), (pad, pad), (0, 0)), mode="wrap")
    scale = size / im.width
    big = Image.fromarray(arr).resize((round(arr.shape[1] * scale), round(arr.shape[0] * scale)), Image.LANCZOS)
    off = round(pad * scale)
    return big.crop((off, off, off + size, off + size))


# --- raster -------------------------------------------------------------------


def do_raster(asset: Asset, src: Path) -> list[Path]:
    im = Image.open(src).convert("RGB")
    written = []
    for scale, suffix in ((1, ""), (2, "@2x")):
        w = asset.width * scale
        h = round(im.height * w / im.width)
        written += save_pair(im.resize((w, h), Image.LANCZOS), SITE / asset.style / f"{name_of(asset)}{suffix}")
    return written


# --- tile ---------------------------------------------------------------------


def flatten(im: Image.Image) -> np.ndarray:
    """Removes uneven lighting (vignetting, gradients), which would repeat as a plaid once tiled."""
    from PIL import ImageFilter

    a = np.asarray(im, dtype=np.float64)
    radius = im.width * FLATTEN
    pad = int(3 * radius)  # mirror the edges so the blur isn't biased at the corners
    padded = Image.fromarray(np.pad(np.asarray(im), ((pad, pad), (pad, pad), (0, 0)), mode="reflect"))
    low = np.asarray(padded.filter(ImageFilter.GaussianBlur(radius)), dtype=np.float64)[pad:-pad, pad:-pad]
    return np.clip(a - low + a.mean(axis=(0, 1), keepdims=True), 0, 255).astype(np.uint8)


def heal(arr: np.ndarray) -> np.ndarray:
    """Seamless version of a square texture (see the module docstring)."""
    a = arr.astype(np.float64)
    n = a.shape[0]
    half = n // 2
    rolled = np.roll(a, (half, half), axis=(0, 1))  # wraps at the edges; seam cross in the middle
    vband = np.roll(a, half, axis=0)  # continuous across the vertical seam, wraps top/bottom
    hband = np.roll(a, half, axis=1)  # continuous across the horizontal seam, wraps left/right
    band = HEAL_BAND * n
    d = np.abs(np.arange(n) - half + 0.5)
    w = np.clip(1 - d / band, 0, 1)
    w = w * w * (3 - 2 * w)  # smoothstep: 1 on the seam, 0 at the band's edge
    wx, wy = w[None, :, None], w[:, None, None]
    # Four sources: the rolled image, the two band patches, and the original in the middle
    weights = [(1 - wx) * (1 - wy), wx * (1 - wy), (1 - wx) * wy, wx * wy]
    sources = [rolled, vband, hband, a]
    mean = a.mean(axis=(0, 1), keepdims=True)
    mixed = sum(k * (s - mean) for k, s in zip(weights, sources))
    norm = np.sqrt(sum(k * k for k in weights))  # keeps the texture's contrast where sources blend
    return np.clip(mean + mixed / norm, 0, 255).astype(np.uint8)


def seam_score(arr: np.ndarray) -> float:
    """Mean jump across the wrap-around edges, relative to the texture's typical neighbor difference."""
    a = arr.astype(np.float64)
    edge = (np.abs(a[:, 0] - a[:, -1]).mean() + np.abs(a[0] - a[-1]).mean()) / 2
    inner = (np.abs(np.diff(a, axis=1)).mean() + np.abs(np.diff(a, axis=0)).mean()) / 2
    return edge / max(inner, 1e-6)


def do_tile(asset: Asset, src: Path) -> list[Path]:
    im = Image.open(src).convert("RGB")
    side = min(im.size)
    im = im.crop((0, 0, side, side))
    arr = flatten(im)
    healed = heal(arr)
    print(f"  seam score {seam_score(arr):.2f} -> {seam_score(healed):.2f} (1.0 = no worse than inside the texture)")
    tile = Image.fromarray(healed)
    written = []
    for scale, suffix in ((1, ""), (2, "@2x")):
        written += save_pair(resize_wrapped(tile, asset.width * scale), SITE / asset.style / f"{name_of(asset)}{suffix}")
    # a 2x2 preview makes a failed heal obvious
    preview = Image.new("RGB", (side * 2, side * 2))
    for x in (0, side):
        for y in (0, side):
            preview.paste(tile, (x, y))
    preview_path = SITE / asset.style / f"{name_of(asset)}-preview.jpg"
    preview.resize((1024, 1024)).save(preview_path, quality=85)
    print(f"  2x2 preview: {preview_path}")
    return written


# --- vector -------------------------------------------------------------------


def ink_mask(im: Image.Image) -> np.ndarray:
    """True where the drawing is: dark ink on light paper, or light ink on a dark ground."""
    gray = np.asarray(im.convert("L"), dtype=np.float64)
    hist, _ = np.histogram(gray, bins=256, range=(0, 256))
    # Otsu's threshold
    total, sum_all = gray.size, np.dot(np.arange(256), hist)
    best, threshold, w0, sum0 = -1.0, 128, 0, 0.0
    for t in range(256):
        w0 += hist[t]
        if w0 == 0 or w0 == total:
            continue
        sum0 += t * hist[t]
        m0, m1 = sum0 / w0, (sum_all - sum0) / (total - w0)
        between = w0 * (total - w0) * (m0 - m1) ** 2
        if between > best:
            best, threshold = between, t
    dark = gray <= threshold
    # the ground is whatever covers most of the border
    border = np.concatenate([dark[0], dark[-1], dark[:, 0], dark[:, -1]])
    return ~dark if border.mean() > 0.5 else dark


def svg_path(mask: np.ndarray, turdsize: int) -> str:
    import potrace

    traced = potrace.Bitmap(~mask).trace(  # potracer traces the False (dark) pixels
        turdsize=turdsize, alphamax=1.0, opticurve=True, opttolerance=0.2)

    def pt(p):
        return f"{p.x:.1f} {p.y:.1f}"

    parts = []
    for curve in traced.curves:
        d = [f"M{pt(curve.start_point)}"]
        for seg in curve.segments:
            if seg.is_corner:
                d.append(f"L{pt(seg.c)}L{pt(seg.end_point)}")
            else:
                d.append(f"C{pt(seg.c1)} {pt(seg.c2)} {pt(seg.end_point)}")
        parts.append("".join(d) + "Z")
    return "".join(parts)


def do_vector(asset: Asset, src: Path) -> list[Path]:
    im = Image.open(src).convert("RGB")
    mask = ink_mask(im)
    ys, xs = np.nonzero(mask)
    if not len(xs):
        sys.exit("error: no ink found")
    margin = 8
    x0, y0 = max(xs.min() - margin, 0), max(ys.min() - margin, 0)
    x1, y1 = min(xs.max() + margin, mask.shape[1]), min(ys.max() + margin, mask.shape[0])
    mask = mask[y0:y1, x0:x1]
    d = svg_path(mask, turdsize=max(4, mask.size // 200_000))
    h, w = mask.shape
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}">'
           f'<path fill-rule="evenodd" d="{d}"/></svg>\n')
    path = SITE / asset.style / f"{name_of(asset)}.svg"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(svg)
    # render it back next to the source so a bad trace is easy to spot
    return [path]


def main():
    global SITE
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("asset", choices=sorted(ASSETS))
    parser.add_argument("--pick", help="contact-sheet letter or image path (default: the judge's #1)")
    parser.add_argument("--dest", type=Path, default=SITE, help="output root instead of public/assets/remix")
    args = parser.parse_args()
    SITE = args.dest
    asset = ASSETS[args.asset]
    src = pick_file(asset, args.pick)
    print(f"{asset.id}: {asset.post} from {src}")
    written = {"raster": do_raster, "tile": do_tile, "vector": do_vector}[asset.post](asset, src)
    for f in written:
        print(f"  {f.relative_to(REPO) if f.is_relative_to(REPO) else f}  {f.stat().st_size:,d} B")
    print(f"  total {sum(f.stat().st_size for f in written):,d} B")


if __name__ == "__main__":
    main()
