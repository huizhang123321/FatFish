"""Generate the FatFish application icons from code.

The artwork is drawn here rather than shipped as a binary so the project has no
opaque image assets to audit, and so every icon size is a clean downsample of one
1024 px master instead of a separately hand-tuned file.

Outputs
-------
* ``desktop/build/icon.ico``          -- electron-builder's window/installer icon
* ``desktop/build/icon.png``          -- 512 px, used by the installer and docs
* ``packaging/minimost-server.ico``   -- PyInstaller icon for minimost-server.exe

Usage::

    python packaging/make_assets.py

Needs Pillow. On a machine without it::

    pip install Pillow
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image, ImageChops, ImageDraw
except ImportError:  # pragma: no cover - developer tooling
    sys.exit(
        "Pillow is required to regenerate the icons.\n"
        "Install it with:  pip install Pillow"
    )

ROOT = Path(__file__).resolve().parents[1]
DESKTOP_BUILD = ROOT / "desktop" / "build"
PACKAGING = ROOT / "packaging"

#: Master render size. Everything downstream is a high-quality downsample.
MASTER = 1024

#: Icon sizes Windows and Electron ask for.
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# Palette (kept in one place so the SVG mark and the raster icon stay related).
PLATE_TOP = (20, 26, 36, 255)
PLATE_BOTTOM = (11, 14, 20, 255)
BODY_LIGHT = (99, 210, 255, 255)
BODY_DARK = (59, 130, 246, 255)
EYE = (11, 14, 20, 255)


def _vertical_gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    """A top-to-bottom linear gradient, used for the plate and the fish body."""
    gradient = Image.new("RGBA", (1, size))
    for y in range(size):
        t = y / max(size - 1, 1)
        gradient.putpixel(
            (0, y),
            tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(4)),
        )
    return gradient.resize((size, size))


def _fish_mask(size: int) -> Image.Image:
    """The fish silhouette as an alpha mask, drawn at 4x then downsampled."""
    scale = 4
    canvas = size * scale
    mask = Image.new("L", (canvas, canvas), 0)
    draw = ImageDraw.Draw(mask)

    unit = canvas / 1024.0

    def box(*values):
        return [v * unit for v in values]

    # Body: a plump ellipse that still reads as "fish" at 16 px.
    draw.ellipse(box(150, 330, 760, 690), fill=255)
    # Tail: a triangle off the back, overlapping the body so there is no seam.
    draw.polygon(
        [(690 * unit, 510 * unit), (905 * unit, 355 * unit), (905 * unit, 665 * unit)],
        fill=255,
    )

    return mask.resize((size, size), Image.LANCZOS)


def _fin_mask(size: int) -> Image.Image:
    """A pectoral fin, painted a shade darker than the body."""
    scale = 4
    canvas = size * scale
    mask = Image.new("L", (canvas, canvas), 0)
    draw = ImageDraw.Draw(mask)
    unit = canvas / 1024.0
    draw.polygon(
        [(400 * unit, 470 * unit), (560 * unit, 470 * unit), (470 * unit, 600 * unit)],
        fill=255,
    )
    return mask.resize((size, size), Image.LANCZOS)


def _eye_mask(size: int) -> Image.Image:
    """The eye, punched out of the body after it is coloured."""
    scale = 4
    canvas = size * scale
    mask = Image.new("L", (canvas, canvas), 0)
    draw = ImageDraw.Draw(mask)
    unit = canvas / 1024.0
    draw.ellipse([285 * unit, 425 * unit, 385 * unit, 525 * unit], fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def render_master() -> Image.Image:
    """Draw the 1024 px master icon."""
    canvas = Image.new("RGBA", (MASTER, MASTER), (0, 0, 0, 0))

    # Rounded plate: the shape Windows uses for a modern app tile.
    plate_mask = Image.new("L", (MASTER, MASTER), 0)
    ImageDraw.Draw(plate_mask).rounded_rectangle(
        [0, 0, MASTER - 1, MASTER - 1], radius=int(MASTER * 0.22), fill=255
    )
    plate = _vertical_gradient(MASTER, PLATE_TOP, PLATE_BOTTOM)
    canvas.paste(plate, (0, 0), plate_mask)

    body = _vertical_gradient(MASTER, BODY_LIGHT, BODY_DARK)
    body_mask = _fish_mask(MASTER)
    canvas.paste(body, (0, 0), body_mask)

    # Fin: same silhouette, a shade darker, clipped to the body. The colour is
    # fully opaque and only the *mask* is attenuated, so blending the layer
    # cannot punch a translucent hole through the plate underneath.
    fin = Image.new("RGBA", (MASTER, MASTER), (20, 84, 156, 255))
    fin_mask = ImageChops.multiply(_fin_mask(MASTER), body_mask).point(
        lambda value: int(value * 0.55)
    )
    canvas.paste(fin, (0, 0), fin_mask)

    canvas.paste(Image.new("RGBA", (MASTER, MASTER), EYE), (0, 0), _eye_mask(MASTER))

    return canvas


def main() -> int:
    master = render_master()

    DESKTOP_BUILD.mkdir(parents=True, exist_ok=True)
    PACKAGING.mkdir(parents=True, exist_ok=True)

    png_path = DESKTOP_BUILD / "icon.png"
    master.resize((512, 512), Image.LANCZOS).save(png_path, format="PNG")
    print(f"wrote {png_path.relative_to(ROOT)} (512x512)")

    ico_path = DESKTOP_BUILD / "icon.ico"
    master.save(ico_path, format="ICO", sizes=[(s, s) for s in ICO_SIZES])
    print(f"wrote {ico_path.relative_to(ROOT)} ({', '.join(str(s) for s in ICO_SIZES)})")

    server_ico = PACKAGING / "minimost-server.ico"
    master.save(server_ico, format="ICO", sizes=[(s, s) for s in ICO_SIZES])
    print(f"wrote {server_ico.relative_to(ROOT)}")

    # A tray/app-menu sized PNG so the renderer and docs can reuse it.
    small = DESKTOP_BUILD / "icon-256.png"
    master.resize((256, 256), Image.LANCZOS).save(small, format="PNG")
    print(f"wrote {small.relative_to(ROOT)} (256x256)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
