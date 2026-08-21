"""
Burst a multi-page PDF into single-sheet PDFs, plus a thumbnail and preview
WebP image for each page. Renders each page once and derives the thumbnail
from the preview raster (avoids a second, expensive re-render per page).

Usage:
    python burst.py <input_pdf> <output_dir> [--thumb-size 300] [--preview-size 4000]

Prints a JSON array to stdout, one entry per page, in page order:
    [{"page_number": 1, "pdf_path": "...", "thumb_path": "...",
      "preview_path": "...", "page_width_pt": 612.0, "page_height_pt": 792.0}, ...]
"""
import argparse
import io
import json
import os
import sys

import fitz  # PyMuPDF
from PIL import Image

# See ocr_region.py for why this matters: MuPDF's internal diagnostics print
# straight to stdout, which would corrupt the JSON this script emits.
fitz.TOOLS.mupdf_display_errors(False)


def render_page(doc, page_index, preview_px):
    page = doc[page_index]
    rect = page.rect
    longest_pt = max(rect.width, rect.height)
    zoom = preview_px / longest_pt if longest_pt > 0 else 1.0
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    return img, rect.width, rect.height


def save_webp(img, path, longest_side, quality):
    w, h = img.size
    scale = longest_side / max(w, h)
    if scale < 1.0:
        img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    img.save(path, "WEBP", quality=quality)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input_pdf")
    parser.add_argument("output_dir")
    parser.add_argument("--thumb-size", type=int, default=300)
    # Preview feeds the version-overlay comparison (sheet.js's computeOverlay
    # composites two of these client-side) as well as the staged-sheet
    # review screen. A full-size architectural sheet (e.g. 48"x36" ARCH E1)
    # is long enough that even 2200px works out to under 50 DPI - visibly
    # soft the moment you zoom into the overlay at all. 4000px gets a 48"
    # sheet to ~83 DPI, a real improvement, without the file-size/composite
    # cost of chasing print-grade DPI. The earlier, more conservative 1800/
    # 2200 values were sized for RAM-constrained Pi deployment; the target
    # deploy is a Windows box now; see CLAUDE.md/project memory.
    parser.add_argument("--preview-size", type=int, default=4000)
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)

    doc = fitz.open(args.input_pdf)
    results = []
    total_pages = len(doc)

    # Progress goes to stderr, one line per completed page, as
    # "PROGRESS <done>/<total>" - stdout is reserved entirely for the final
    # JSON array (see the mupdf_display_errors comment above for why stdout
    # has to stay pristine). A large multi-hundred-page upload can take
    # minutes; without this the caller has no visibility into it beyond
    # "still running" for the whole duration.
    print(f"PROGRESS 0/{total_pages}", file=sys.stderr, flush=True)

    for i in range(total_pages):
        page_number = i + 1
        img, width_pt, height_pt = render_page(doc, i, args.preview_size)

        pdf_path = os.path.join(args.output_dir, f"{page_number:04d}.pdf")
        thumb_path = os.path.join(args.output_dir, f"{page_number:04d}_thumb.webp")
        preview_path = os.path.join(args.output_dir, f"{page_number:04d}_preview.webp")

        single_page = fitz.open()
        single_page.insert_pdf(doc, from_page=i, to_page=i)
        # insert_pdf() carries over the source doc's whole object graph
        # (every page's annotations/fonts/XObjects, OCG layers, etc.), not
        # just the one page's - a plain save() leaves all of that as
        # unreferenced bytes in the file. garbage=4 drops unreferenced
        # objects, clean=True sanitizes/rewrites content streams (needed for
        # garbage collection to actually reach objects a content stream still
        # nominally points at), and deflate recompresses what's left. On one
        # real multi-hundred-sheet structural set this took single burst
        # files from ~230MB down to ~0.3MB with pixel-identical output -
        # without it, every sheet's file silently carries the entire source
        # document's data.
        single_page.save(pdf_path, garbage=4, deflate=True, clean=True)
        single_page.close()

        save_webp(img, preview_path, args.preview_size, quality=92)
        save_webp(img, thumb_path, args.thumb_size, quality=78)

        # These paths get stored verbatim in the DB and may later be read on
        # a different OS than the one that ran this script (per CLAUDE.md,
        # ingest can run on the Windows dev box while serving happens from
        # the Pi) - os.path.join uses a backslash separator on Windows,
        # which isn't a path separator on Linux at all, so normalize to
        # forward slashes here at the source.
        results.append({
            "page_number": page_number,
            "pdf_path": pdf_path.replace(os.sep, "/"),
            "thumb_path": thumb_path.replace(os.sep, "/"),
            "preview_path": preview_path.replace(os.sep, "/"),
            "page_width_pt": width_pt,
            "page_height_pt": height_pt,
        })
        print(f"PROGRESS {page_number}/{total_pages}", file=sys.stderr, flush=True)

    doc.close()
    json.dump(results, sys.stdout)


if __name__ == "__main__":
    main()
