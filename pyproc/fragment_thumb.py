"""
Renders a single composite fragment (crop + mask applied, no placement
scaling or rotation) once, at the same resolution compose.py itself budgets
for this fragment (see RENDER_SCALE/MAX_FRAGMENT_PX there), and derives two
assets from that one render - same "render once, derive the small one from
it" pattern burst.py uses for an ordinary sheet page:

  - a full-res RGBA WebP "preview" - fetched once client-side when entering
    Edit Layout mode so a fragment can be dragged/rotated live with zero
    server round-trip per frame (see fetchFragmentPreviewImages in sheet.js)
    - what you see moving is pixel-identical to what the next flatten
      actually produces, since it's the exact same render_fragment/
      apply_mask output compose.py inserts into the PDF.
  - a small RGB WebP "thumb" for the fragment-palette list.

Both are regenerated only when a fragment's crop or mask changes - not on
every reposition/rotate/reorder - since masks are per-placement and fixed
once traced, and placement/rotation are applied on top of this asset rather
than baked into it.

Usage:
    python fragment_thumb.py <source_pdf_path> <crop_json> <mask_polygons_json>
        <output_thumb> <output_preview> [--thumb-size 200]

Prints {"ok": true} to stdout.
"""
import argparse
import json
import sys

import fitz  # PyMuPDF
from PIL import Image

from compose import render_fragment, apply_mask, RENDER_SCALE, MAX_FRAGMENT_PX

# See ocr_region.py for why this matters: MuPDF's internal diagnostics print
# straight to stdout, which would corrupt the JSON this script emits.
fitz.TOOLS.mupdf_display_errors(False)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source_pdf_path")
    parser.add_argument("crop_json")
    parser.add_argument("mask_polygons_json")
    parser.add_argument("output_thumb")
    parser.add_argument("output_preview")
    parser.add_argument("--thumb-size", type=int, default=200)
    args = parser.parse_args()

    crop = json.loads(args.crop_json)
    mask_polygons = json.loads(args.mask_polygons_json)

    longest_pt = max(crop["width"], crop["height"])
    zoom = min(RENDER_SCALE, MAX_FRAGMENT_PX / longest_pt) if longest_pt > 0 else RENDER_SCALE

    img = render_fragment(args.source_pdf_path, crop, zoom)
    img = apply_mask(img, mask_polygons, zoom)

    # Full-res, alpha preserved - WebP supports RGBA same as PNG.
    img.save(args.output_preview, "WEBP", quality=90)

    thumb = img.copy()
    thumb.thumbnail((args.thumb_size, args.thumb_size), Image.LANCZOS)
    thumb.convert("RGB").save(args.output_thumb, "WEBP", quality=78)

    json.dump({"ok": True}, sys.stdout)


if __name__ == "__main__":
    main()
