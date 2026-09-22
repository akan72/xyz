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