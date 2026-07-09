"""
Composite a blue/red overlay of two single-sheet PDFs for revision comparison.

Old page -> blue, new page -> red, so: unchanged lines are black, blank
background is white, content removed since the old version is blue, content
added in the new version is red. (R = g_old, G = min(g_old, g_new), B = g_new
- must match the client-side formula in public/js/sheet.js exactly.)

No auto-alignment/rotation: assumes both pages are already registered (same
title block size/position), matching the "default = perfectly aligned"
assumption in CLAUDE.md.

Usage:
    python overlay.py <old_pdf> <new_pdf> <output_webp> [--size 1800]

Prints {"ok": true} to stdout on success.
"""
import argparse
import json
import sys

import fitz  # PyMuPDF
from PIL import Image, ImageChops

# See ocr_region.py for why this matters: MuPDF's internal diagnostics print
# straight to stdout, which would corrupt the JSON this script emits.
fitz.TOOLS.mupdf_display_errors(False)

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

    shared = ImageChops.darker(old_padded, new_padded)
    composite = Image.merge("RGB", (old_padded, shared, new_padded))
    composite.save(args.output, "WEBP", quality=85)

    json.dump({"ok": True}, sys.stdout)


if __name__ == "__main__":
    main()
