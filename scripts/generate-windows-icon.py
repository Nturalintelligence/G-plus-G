from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"
BUILD.mkdir(parents=True, exist_ok=True)

canvas_size = 1024
image = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)

# Transparent outer canvas and 12.5% safe area keep Windows small-icon and
# shortcut masks from clipping the mark.
safe = 128
draw.rounded_rectangle(
    (safe, safe, canvas_size - safe, canvas_size - safe),
    radius=190,
    fill=(216, 101, 59, 255),
)

font_candidates = [
    Path("C:/Windows/Fonts/seguisb.ttf"),
    Path("C:/Windows/Fonts/segoeuib.ttf"),
    Path("C:/Windows/Fonts/arialbd.ttf"),
]
font_path = next((candidate for candidate in font_candidates if candidate.exists()), None)
if font_path is None:
    raise RuntimeError("A supported Windows bold font was not found")
font = ImageFont.truetype(str(font_path), 260)
label = "G+G"
bounds = draw.textbbox((0, 0), label, font=font, stroke_width=0)
width = bounds[2] - bounds[0]
height = bounds[3] - bounds[1]
position = ((canvas_size - width) / 2, (canvas_size - height) / 2 - bounds[1] - 8)
draw.text(position, label, font=font, fill=(255, 255, 255, 255))

master_path = BUILD / "icon.png"
ico_path = BUILD / "icon.ico"
image.save(master_path, "PNG", optimize=True)
image.save(
    ico_path,
    format="ICO",
    sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print(f"Generated {master_path} and {ico_path}")
