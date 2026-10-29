from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
image = Image.new('RGBA', (160, 160), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((4, 4, 156, 156), radius=32, fill='#3d6484')
for x, y in ((32, 32), (88, 32), (32, 88), (88, 88)):
    draw.rounded_rectangle((x, y, x + 40, y + 40), radius=7, fill='#f5f7f9')
    draw.line((x + 9, y + 13, x + 29, y + 13), fill='#63829b', width=3)
    draw.line((x + 9, y + 22, x + 25, y + 22), fill='#a8bdcd', width=3)
image.save(root / 'icon.png')
