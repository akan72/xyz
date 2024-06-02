from PIL import Image

filename = r'assets/zyn.webp'

img = Image.open(filename)
img.save('favicon.ico')