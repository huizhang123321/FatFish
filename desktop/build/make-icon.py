"""Generate the FatFish icon set from concept B (speech bubble + fish tail).

One master drawing at 1024 px is downsampled for every target, so the 16 px icon is
the same design rather than a hand-tuned different one. Outputs:

  desktop/build/icon.ico          16/24/32/48/64/128/256 for Windows + installer
  desktop/build/icon.png          512, for in-app / store use
  desktop/build/icon-256.png      256
  minimost/.../favicon.svg        vector, transparent hole
  minimost/.../minimost-icon-*.svg
  Android mipmap-* (legacy, round, adaptive foreground) + colors.xml background

Run with a Python that has Pillow.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
S = 1024
BG = (11, 18, 32, 255)
BLUE = (76, 194, 255, 255)

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def draw_master(with_tile: bool) -> Image.Image:
    """The bubble+tail mark. ``with_tile`` adds the rounded dark plate."""
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if with_tile:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.225), fill=BG)

    left, top = S * 0.17, S * 0.21
    right, bottom = S * 0.83, S * 0.67
    radius = S * 0.16

    # Tail first so the bubble's rounded corner sits on top of the join.
    d.polygon(
        [
            (left + S * 0.12, bottom - S * 0.02),
            (left + S * 0.01, S * 0.845),
            (left + S * 0.29, S * 0.695),
        ],
        fill=BLUE,
    )
    d.rounded_rectangle([left, top, right, bottom], radius=radius, fill=BLUE)

    # The message dot: punched through to the plate, so it reads as a hole rather
    # than a painted circle. For the transparent variant it stays a soft tint so it
    # does not vanish on a dark browser tab.
    r = S * 0.062
    cx, cy = S * 0.50, S * 0.44
    if with_tile:
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=BG)
    else:
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(11, 18, 32, 255))
    return img


def ico(img: Image.Image, path: Path) -> None:
    img.save(path, format="ICO", sizes=[(s, s) for s in ICO_SIZES])


def png(img: Image.Image, path: Path, size: int) -> None:
    img.resize((size, size), Image.LANCZOS).save(path)


SVG_TEMPLATE = """<svg width="{w}" height="{w}" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
  <!-- FatFish mark: a speech bubble whose tail doubles as a fish tail. -->
  <path fill="#4cc2ff" fill-rule="evenodd" d="
    M175 365 Q175 215 325 215 H725 Q875 215 875 365 V560 Q875 686 749 686 H300 L14 866 L123 691
    Q175 675 175 610 Z
    M512 391 A64 64 0 1 0 512 519 A64 64 0 1 0 512 391 Z"/>
</svg>
"""


def main() -> None:
    tiled = draw_master(True)
    tiled.save(ROOT / "icon.png")  # 1024 master; resized copies follow
    png(tiled, ROOT / "icon.png", 512)
    png(tiled, ROOT / "icon-256.png", 256)
    ico(tiled, ROOT / "icon.ico")

    # Android: legacy 48..192, round, and adaptive foreground at 108..432.
    mipmaps = {
        "mdpi": (48, 108),
        "hdpi": (72, 162),
        "xhdpi": (96, 216),
        "xxhdpi": (144, 324),
        "xxxhdpi": (192, 432),
    }
    android = ROOT.parent.parent / "安卓端" / "app" / "res"
    if (android / "mipmap-mdpi").is_dir():
        for density, (legacy, fg) in mipmaps.items():
            png(tiled, android / f"mipmap-{density}" / "ic_launcher.png", legacy)
            png(tiled, android / f"mipmap-{density}" / "ic_launcher_round.png", legacy)
            # Adaptive foreground: same mark, transparent, scaled into the safe zone.
            fg_img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
            mark = draw_master(False).resize((int(S * 0.66), int(S * 0.66)), Image.LANCZOS)
            fg_img.paste(mark, (int(S * 0.17), int(S * 0.17)), mark)
            png(fg_img, android / f"mipmap-{density}" / "ic_launcher_foreground.png", fg)
        png(tiled, android / "drawable-nodpi" / "brand_icon.png", 512)

    static = ROOT.parent.parent / "minimost" / "src" / "minimost" / "static"
    for size in (16, 32, 60):
        (static / f"minimost-icon-{size}.svg").write_text(
            SVG_TEMPLATE.format(w=size), encoding="utf-8"
        )
    (static / "favicon.svg").write_text(SVG_TEMPLATE.format(w=32), encoding="utf-8")

    print("wrote icon.ico", [s for s in ICO_SIZES])
    print("wrote icon.png 512, icon-256.png")
    print("wrote favicon.svg + 3 svg sizes")
    print("android mipmaps:", "yes" if (android / "mipmap-mdpi").is_dir() else "skipped")


if __name__ == "__main__":
    main()
