# -*- coding: utf-8 -*-
"""生成 exe 图标（多尺寸 .ico）：蓝底圆角 + 白色环形仪表。"""
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "build", "app.ico")

SS = 4          # 超采样
BASE = 256


def rr(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def render(size):
    n = size * SS
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = int(n * 0.02)
    rr(d, (pad, pad, n - pad - 1, n - pad - 1), int(n * 0.22),
       (77, 107, 254, 255))
    # 顶部高光
    hl = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    dh = ImageDraw.Draw(hl)
    rr(dh, (pad, pad, n - pad - 1, int(n * 0.46)), int(n * 0.22),
       (255, 255, 255, 26))
    img.alpha_composite(hl)

    m = int(n * 0.24)
    box = (m, m, n - m, n - m)
    width = int(n * 0.085)
    d.arc(box, 0, 360, fill=(255, 255, 255, 70), width=width)
    d.arc(box, start=-90, end=-90 + 120, fill=(255, 255, 255, 255), width=width)
    r = int(n * 0.035)
    cx, cy = n // 2, n // 2
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(255, 255, 255, 235))
    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    sizes = [16, 24, 32, 48, 64, 128, 256]
    imgs = [render(s) for s in sizes]
    imgs[-1].save(OUT, format="ICO", sizes=[(s, s) for s in sizes],
                  append_images=imgs[:-1])
    imgs[-1].resize((128, 128), Image.LANCZOS).save(
        os.path.join(ROOT, "build", "icon-preview.png"))
    print("ico:", OUT, os.path.getsize(OUT), "bytes")


if __name__ == "__main__":
    main()
