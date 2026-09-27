from PIL import Image, ImageDraw, ImageFont
import os
import sys

# Renders the 1200x630 Open Graph card that iMessage, Slack, Discord, etc. show
# when a link to the site is pasted. Colors and font match public/index.html.
base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
assets = os.path.join(base_dir, 'public', 'assets')
dest_path = os.path.join(assets, 'og.jpg')
font_dir = '/System/Library/Fonts/Supplemental'

W, H = 1200, 630
# Pass --dark for the inverted palette
if '--dark' in sys.argv:
    BG, INK, MUTED = (17, 17, 17), (244, 244, 244), (150, 150, 150)
else:
    BG, INK, MUTED = (244, 244, 244), (17, 17, 17), (115, 115, 115)


def font(name, size):
    return ImageFont.truetype(os.path.join(font_dir, name), size)


def portrait(name, height):
    img = Image.open(os.path.join(assets, name)).convert('RGB')
    return img.resize((round(img.width * height / img.height), height), Image.LANCZOS)


img = Image.new('RGB', (W, H), BG)
d = ImageDraw.Draw(img)

# Milady runs edge to edge down the left side
milady = portrait('milady.jpg', H)
img.paste(milady, (0, 0))

x = milady.width + 72
d.line([x, 200, x + 80, 200], fill=INK, width=4)
d.text((x, 236), 'alexkan.xyz', font=font('Georgia Bold.ttf', 92), fill=INK)
d.text((x, 358), 'Alex Kan', font=font('Georgia.ttf', 40), fill=MUTED)

# JPEG keeps the card well under WhatsApp's ~300KB og:image limit
img.save(dest_path, 'JPEG', quality=90, optimize=True)
print(f"Generated Open Graph card at: {dest_path}")
