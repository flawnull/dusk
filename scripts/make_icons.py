"""Draws the Dusk icon (a crescent on a dark rounded square) at every size Safari needs."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

def draw(size):
    s = size * 4  # supersample, then shrink for smooth edges
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=s // 4.5, fill=(28, 28, 46, 255))
    pad = s * 0.2
    d.ellipse([pad, pad, s - pad, s - pad], fill=(196, 204, 255, 255))
    off = s * 0.17
    d.ellipse([pad + off, pad - off * 0.6, s - pad + off, s - pad - off * 0.6], fill=(28, 28, 46, 255))
    return img.resize((size, size), Image.LANCZOS)

for size in (16, 32, 48, 96, 128, 256, 512):
    draw(size).save(OUT / f"icon-{size}.png")
print("icons written to", OUT)
