"""
Composite a red/cyan overlay of two single-sheet PDFs for revision comparison.

Old page -> red channel, new page -> cyan (green+blue) channels, so: unchanged
lines are black, blank background is white, content removed since the old
version is red, content added in the new version is cyan.

No auto-alignment/rotation: assumes both pages are already registered (same
title block size/position), matching the "default = perfectly aligned"
assumption in CLAUDE.md. Interactive shift/scale nudging happens client-side.

Usage:
    python overlay.py <old_pdf> <new_pdf> <output_webp> [--size 1800]

Prints {"ok": true} to stdout on success.
"""
import argparse
import json
import sys

import fitz  # PyMuPDF
from PIL import Image

POINTS_PER_INCH = 72.0


def render_gray(pdf_path, target_px):
    doc = fitz.open(pdf_path)
    page = doc[0]
    rect = page.rect
    longest_pt = max(rect.width, rect.height)
    zoom = target_px / longest_pt if longest_pt > 0 else 1.0
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples).convert("L")
    doc.close()
    return img


def pad_to(img, width, height):
    canvas = Image.new("L", (width, height), 255)
    canvas.paste(img, (0, 0))
    return canvas


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("old_pdf")
    parser.add_argument("new_pdf")
    parser.add_argument("output")
    parser.add_argument("--size", type=int, default=1800)
    args = parser.parse_args()

    old_img = render_gray(args.old_pdf, args.size)
    new_img = render_gray(args.new_pdf, args.size)

    width = max(old_img.width, new_img.width)
    height = max(old_img.height, new_img.height)
    old_padded = pad_to(old_img, width, height)
    new_padded = pad_to(new_img, width, height)

    composite = Image.merge("RGB", (new_padded, old_padded, old_padded))
    composite.save(args.output, "WEBP", quality=85)

    json.dump({"ok": True}, sys.stdout)


if __name__ == "__main__":
    main()
