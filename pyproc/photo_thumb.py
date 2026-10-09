"""
Downscaled JPEG thumbnail for a photo in the document store - what the
Documents thumbnail grid and the photo-pin popup show, so a folder of
full-size phone photos doesn't have to be downloaded just to browse it.

Usage:
    python photo_thumb.py <input_path> <output_path> [max_px]

Prints {"ok": true} to stdout on success.
"""
import argparse
import json
import sys

from PIL import Image, ImageOps


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input_path")
    parser.add_argument("output_path")
    parser.add_argument("max_px", nargs="?", type=int, default=480)
    args = parser.parse_args()

    img = Image.open(args.input_path)
    # Same reason as convert_to_jpeg.py: the browser-side rendering here
    # doesn't apply EXIF orientation, so bake it into the pixels.
    img = ImageOps.exif_transpose(img)
    img.thumbnail((args.max_px, args.max_px))
    img.convert("RGB").save(args.output_path, "JPEG", quality=80)

    json.dump({"ok": True}, sys.stdout)


if __name__ == "__main__":
    main()
