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

with open(logo_path) as f:
    logo = f.read()

# The logo is 550x260: center it in a 550x550 square so browsers don't stretch it.
logo = re.sub(r"<metadata>.*?</metadata>", "", logo, flags=re.DOTALL)
logo = logo.replace(' xmlns:c2pa="http://c2pa.org/manifest"', "")
logo = logo.replace(
    'viewBox="0 0 550 260" width="550" height="260"', 'viewBox="0 -145 550 550"'
)
if 'viewBox="0 -145 550 550"' not in logo:
    raise SystemExit(f"unexpected viewBox in {logo_path}")


def colored(theme):
    return logo.replace('fill="currentColor"', f'fill="{COLORS[theme]}"')


def render(svg, size):
    png = resvg_py.svg_to_bytes(svg_string=svg, width=size, height=size)
    return Image.open(io.BytesIO(bytes(png))).convert("RGBA")


for theme in COLORS:
    path = os.path.join(assets, f"favicon-{theme}.svg")
    with open(path, "w") as f:
        f.write(colored(theme))
    print(f"Generated {path}")

# The pages link /assets/favicon.ico; /favicon.ico is the copy browsers and
# crawlers fetch on their own.
ico = render(colored("light"), 256)
for ico_path in (
    os.path.join(assets, "favicon.ico"),
    os.path.join(base_dir, "public", "favicon.ico"),
):
    ico.save(ico_path, format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])
    print(f"Generated {ico_path}")

touch_path = os.path.join(assets, "apple-touch-icon.png")
touch = Image.new("RGB", (180, 180), TOUCH_BACKGROUND)
mark = render(colored("light"), 152)
touch.paste(mark, (14, 14), mark)
touch.save(touch_path, format="PNG", optimize=True)
print(f"Generated {touch_path}")
