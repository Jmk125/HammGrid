"""
Converts an image to a real JPEG - built specifically for HEIC (an
iPhone/iPad camera's default format), which browsers can't display
directly no matter what filename extension or Content-Type it's served
with (see src/lib/documentFileTypes.js for the detection/reasoning side).
Not PDF-aware - this is for the document store's photo path only.

Usage:
    python convert_to_jpeg.py <input_path> <output_path>

Prints {"ok": true} to stdout on success.
"""
import argparse
import json
import sys

from PIL import Image, ImageOps
import pillow_heif

pillow_heif.register_heif_opener()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input_path")
    parser.add_argument("output_path")
    args = parser.parse_args()

    img = Image.open(args.input_path)
    # HEIC (like JPEG) can carry orientation as EXIF metadata rather than
    # actually rotating the pixels - bake it in now, since this app's own
    # <img>/canvas rendering path (document-view.js) doesn't apply EXIF
    # orientation, and most photos taken holding the phone sideways would
    # otherwise display rotated.
    img = ImageOps.exif_transpose(img)
    img.convert("RGB").save(args.output_path, "JPEG", quality=90)

    json.dump({"ok": True}, sys.stdout)


if __name__ == "__main__":
    main()
