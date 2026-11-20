"""Light background, red trend bars, clean and modern."""
from PIL import Image, ImageDraw
import os

def generate_icon(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    corner = max(2, int(size * 0.22))

    # Light warm white gradient background
    for y in range(size):
        t = y / size
        r = int(250 + (242 - 250) * t)
        g = int(252 + (245 - 252) * t)
        b = int(255 + (250 - 255) * t)
        for x in range(size):
            img.putpixel((x, y), (r, g, b, 255))

    mask = Image.new("L", (size, size), 0)
    mdraw = ImageDraw.Draw(mask)
    mdraw.rounded_rectangle([0, 0, size-1, size-1], radius=corner, fill=255)

    pad = int(size * 0.20)
    base_y = size - pad

    # 4 red bars, increasing, with subtle shadow
    bar_count = 4
    gap = max(1, int(size * 0.04))
    bar_w = max(2, (size - pad * 2 - gap * (bar_count - 1)) // bar_count)
    heights = [0.28, 0.46, 0.64, 0.92]

    for i, h in enumerate(heights):
        x = pad + i * (bar_w + gap)
        bh = int(h * (size - pad * 2))
        y = base_y - bh
        # Subtle gradient: lighter red at top, deeper at bottom
        top_r, top_g, top_b = 239, 83, 80
        bot_r, bot_g, bot_b = 211, 47, 47
        alpha = 220 + int(35 * (h / 0.92))
        draw.rounded_rectangle(
            [x, y, x + bar_w - 1, base_y - 1],
            radius=max(1, bar_w // 3),
            fill=(top_r, top_g, top_b, alpha)
        )
        # Lighter top portion for depth
        mid_y = y + int(bh * 0.3)
        draw.rounded_rectangle(
            [x, y, x + bar_w - 1, mid_y],
            radius=max(1, bar_w // 3),
            fill=(245, 120, 110, alpha)
        )

    # Red arrow above last bar
    last_x = pad + (bar_count - 1) * (bar_w + gap) + bar_w // 2
    last_top = base_y - int(heights[-1] * (size - pad * 2))
    arr_h = max(3, int(size * 0.10))
    arr_w = max(2, int(size * 0.07))
    arr_bot = last_top - max(1, int(size * 0.03))
    draw.polygon([
        (last_x, arr_bot - arr_h),
        (last_x - arr_w, arr_bot),
        (last_x + arr_w, arr_bot),
    ], fill=(220, 53, 56, 255))

    # Light border
    border_w = max(1, int(size * 0.025))
    border_color = (200, 200, 210, 80)
    draw.rounded_rectangle(
        [0, 0, size-1, size-1],
        radius=corner,
        outline=border_color,
        width=border_w
    )

    img.putalpha(mask)
    return img

base_dir = os.path.dirname(os.path.abspath(__file__))
icons_dir = os.path.join(base_dir, "icons")
os.makedirs(icons_dir, exist_ok=True)

for sz in [16, 48, 128]:
    img = generate_icon(sz)
    path = os.path.join(icons_dir, f"icon{sz}.png")
    img.save(path, "PNG")
    print(f"Generated {path} ({os.path.getsize(path)} bytes)")
