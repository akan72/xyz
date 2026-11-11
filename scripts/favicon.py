# /// script
# dependencies = ["pillow", "resvg-py"]
# ///
"""Generates the site's icons from the screensaver's XYZ logo.

- favicon-light.svg / favicon-dark.svg: the tab icon, swapped with the page
  theme by site/components/ThemeScript.astro. Green, the screensaver's first
  color, from public/assets/xyz-logo/README.md.
- favicon.ico: fallback for browsers without SVG favicons.
- apple-touch-icon.png: iOS home screen and iMessage/Slack link previews.

Run with: uv run scripts/favicon.py
"""

import io
import os
import re

import resvg_py
from PIL import Image

base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
assets = os.path.join(base_dir, "public", "assets")
logo_path = os.path.join(assets, "xyz-logo", "xyz-currentcolor.svg")

COLORS = {"light": "#018535", "dark": "#45D66B"}
TOUCH_BACKGROUND = (
    244,
    244,
    244,
)  # --bg in site/styles/site.css; iOS fills transparency with black

# Share of the tab icon's height the letters fill. The logo is a 550x260
# wordmark, so fitting it whole leaves it a thin strip next to other sites'
# favicons; instead the letters are narrowed to fill the square.
LETTERS_HEIGHT = 0.85

with open(logo_path) as f:
    logo = re.sub(r"<metadata>.*?</metadata>", "", f.read(), flags=re.DOTALL)
logo = logo.replace(' xmlns:c2pa="http://c2pa.org/manifest"', "")
ORIGINAL_SIZE = 'viewBox="0 0 550 260" width="550" height="260"'
if ORIGINAL_SIZE not in logo:
    raise SystemExit(f"unexpected viewBox in {logo_path}")

# Tab icon: only the letters (x 22-522.8, y 52.6-192.6), stretched to the
# square's full width and LETTERS_HEIGHT of its height. The thin bars above
# and below are dropped: they vanish at 16px.
span = 140 / LETTERS_HEIGHT
tab_icon, bars = re.subn(
    r'\s*<rect x="0" y="(?:0|252)" width="550" height="8"/>', "", logo
)
if bars != 2:
    raise SystemExit(f"expected the logo's 2 bars in {logo_path}, found {bars}")
tab_icon = tab_icon.replace(
    ORIGINAL_SIZE,
    f'viewBox="22 {122.6 - span / 2:.1f} 500.8 {span:.1f}" width="32" height="32" preserveAspectRatio="none"',
)
# Home-screen icon: the whole logo, centered in a square.
full_logo = logo.replace(ORIGINAL_SIZE, 'viewBox="0 -145 550 550"')


def colored(svg, theme):
    return svg.replace('fill="currentColor"', f'fill="{COLORS[theme]}"')


def render(svg, size):
    png = resvg_py.svg_to_bytes(svg_string=svg, width=size, height=size)
    return Image.open(io.BytesIO(bytes(png))).convert("RGBA")


for theme in COLORS:
    path = os.path.join(assets, f"favicon-{theme}.svg")
    with open(path, "w") as f:
        f.write(colored(tab_icon, theme))
    print(f"Generated {path}")

ico_path = os.path.join(assets, "favicon.ico")
render(colored(tab_icon, "light"), 256).save(
    ico_path, format="ICO", sizes=[(16, 16), (32, 32), (48, 48)]
)
print(f"Generated {ico_path}")

touch_path = os.path.join(assets, "apple-touch-icon.png")
touch = Image.new("RGB", (180, 180), TOUCH_BACKGROUND)
mark = render(colored(full_logo, "light"), 152)
touch.paste(mark, (14, 14), mark)
touch.save(touch_path, format="PNG", optimize=True)
print(f"Generated {touch_path}")
