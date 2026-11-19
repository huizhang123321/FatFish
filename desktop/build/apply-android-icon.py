"""Build the FatFish icon set from the Android app's icon (the fish mark).

The Android APK ships the reference artwork at 512 px; this script uses it as the
single master and derives every Windows/Android size from it, so the desktop icon
and the phone icon are visibly the same drawing.

Usage: python apply-android-icon.py <master.png>
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def main() -> None:
    master_path = Path(sys.argv[1])
    master = Image.open(master_path).convert("RGBA")
    if master.size != (512, 512):
        master = master.resize((512, 512), Image.LANCZOS)

    # Windows: the same drawing at seven sizes inside one .ico.
    master.save(ROOT / "icon.png")
    master.resize((256, 256), Image.LANCZOS).save(ROOT / "icon-256.png")
    master.save(ROOT / "icon.ico", format="ICO", sizes=[(s, s) for s in ICO_SIZES])

    # Android: legacy launcher at five densities, round variants, and the adaptive
    # foreground (the mark inset into the 66% safe zone, transparent elsewhere).
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
            master.resize((legacy, legacy), Image.LANCZOS).save(
                android / f"mipmap-{density}" / "ic_launcher.png"
            )
            master.resize((legacy, legacy), Image.LANCZOS).save(
                android / f"mipmap-{density}" / "ic_launcher_round.png"
            )
            plate = master.resize((fg, fg), Image.LANCZOS)
            overlay = Image.new("RGBA", (fg, fg), (0, 0, 0, 0))
            overlay.paste(plate, (0, 0), plate)
            overlay.save(android / f"mipmap-{density}" / "ic_launcher_foreground.png")
        master.save(android / "drawable-nodpi" / "brand_icon.png")

    print("icon.ico", ICO_SIZES)
    print("icon.png 512, icon-256.png")
    print("android mipmaps updated")


if __name__ == "__main__":
    main()
