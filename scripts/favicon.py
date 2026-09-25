from PIL import Image
import os

# Set paths relative to script or run from root
base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
source_path = os.path.join(base_dir, 'public', 'assets', 'zyn.webp')
dest_path = os.path.join(base_dir, 'public', 'assets', 'favicon.ico')

img = Image.open(source_path)
# Save as multi-resolution ICO with standardized compact sizes to shrink file size significantly
img.save(dest_path, format='ICO', sizes=[(16, 16), (32, 32), (48, 48)])
print(f"Generated optimized favicon at: {dest_path}")
# iOS home-screen / iMessage / Slack icon: iOS fills transparency with black,
# so flatten onto the site background
touch_path = os.path.join(base_dir, 'public', 'assets', 'apple-touch-icon.png')
touch = Image.new('RGB', (180, 180), (244, 244, 244))
zyn = img.convert('RGBA').resize((152, 152), Image.LANCZOS)
touch.paste(zyn, (14, 14), zyn)
touch.save(touch_path, format='PNG', optimize=True)
print(f"Generated apple-touch-icon at: {touch_path}")
