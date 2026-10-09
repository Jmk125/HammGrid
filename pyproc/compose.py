"""
Flatten a composite drawing's fragment manifest into a single-page PDF plus
thumbnail and preview WebP images - the same three outputs burst.py produces
per sheet, so a composite is indistinguishable from an ordinary sheet to
every downstream consumer (PDF.js viewer, thumbnail grid, take-off scale
math).

Each fragment is rendered at its OWN resolution (sized to its own real-world
footprint) and inserted into the PDF page as its own image, rather than all
fragments being pre-composited into one shared raster canvas first. This
matters: a shared canvas-wide pixel budget gets diluted further with every
fragment added (the whole point of a composite - stitching several drawings
into one zoomed-in take-off surface - is exactly what that starved), whereas
per-fragment resolution stays constant regardless of how many other
fragments exist. PDF.js (and this script's own pixmap render for thumb/
preview) composites the independently-resolutioned, independently-masked
images together the same way any PDF viewer composites overlapping image
XObjects - no different from an ordinary sheet with multiple embedded
images.

Deliberately rasterizes each fragment rather than embedding vector content:
thumb/preview are always rasters anyway, and every take-off/measure formula
only depends on scale_feet_per_inch plus rendered pixel geometry, never
vector fidelity. Trade-off: no selectable text inside a composite's own PDF
- acceptable for a take-off workspace, not a document of record.

Usage:
    python compose.py <manifest_json_path> <output_pdf> <output_thumb> <output_preview>
        [--thumb-size 300] [--preview-size 4000]

Manifest shape (canvas + fragments in PDF-point space, 72pt/in):
    {"canvas": {"width_pt": 2400.0, "height_pt": 1400.0},
     "fragments": [
       {"source_pdf_path": "...", "crop": {"x":.., "y":.., "width":.., "height":..},
        "mask_polygons": [[{"x":.., "y":..}, ...], ...], "place": {"x":.., "y":.., "width":.., "height":..},
        "rotation": 0, "z_order": 0, "visible": true},
       ...
     ]}
`mask_polygons` points are relative to the fragment's own crop origin (fragment-local),
not absolute source-page coordinates. `rotation` is degrees, clockwise-positive, applied
around the center of the (unrotated) place rect.

Prints {"ok": true, "page_width_pt": ..., "page_height_pt": ...} to stdout.
"""
import argparse
import io
import json
import sys

import fitz  # PyMuPDF
from PIL import Image, ImageChops, ImageDraw

from burst import save_webp  # reuse verbatim - see burst.py's own docstring

# See ocr_region.py for why this matters: MuPDF's internal diagnostics print
# straight to stdout, which would corrupt the JSON this script emits.
fitz.TOOLS.mupdf_display_errors(False)

# px/pt for each fragment's own rendered image - matches sheet.js's own
# RENDER_SCALE exactly, since that's the actual legibility bar ("as crisp as
# viewing this drawing directly"), not something to exceed. Applied per
# fragment, not per overall canvas - see the module docstring for why that
# distinction is the whole resolution fix. Was briefly 4.0 (deliberately
# higher) but benchmarking showed regenerate time scales ~quadratically with
# this value (roughly (4/2.5)^2 = 2.6x) for no perceptible quality gain over
# 2.5 - not a good trade once regenerate speed became the active complaint.
RENDER_SCALE = 2.5
# Cap on any one fragment's rendered longest side - same ceiling burst.py
# already uses for a whole sheet (see its own MAX_RENDER_PX comment re:
# memory-constrained/iPad rendering). Only relevant for a fragment cropped
# almost as large as an entire sheet; a typical targeted crop is well under
# this regardless.
MAX_FRAGMENT_PX = 6000


def render_fragment(source_pdf_path, crop, zoom):
    """Renders just the cropped region of a fragment's source PDF, at the
    resolution this fragment was budgeted (see RENDER_SCALE/MAX_FRAGMENT_PX),
    as an RGBA image with the source's white/blank background already made
    transparent (see whiten_to_alpha) - punched further by mask_polygons
    below if present."""
    doc = fitz.open(source_pdf_path)
    page = doc[0]
    clip = fitz.Rect(crop["x"], crop["y"], crop["x"] + crop["width"], crop["y"] + crop["height"])
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=clip, alpha=False)
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples).convert("RGBA")
    doc.close()
    return whiten_to_alpha(img)


def whiten_to_alpha(img):
    """Makes a drawing's white/blank background transparent, keeping only
    actual ink (lines, text, hatching) opaque - lets stitched fragments
    overlap cleanly even when a crop's edge isn't pixel-perfectly tight
    around the drawing content, since the surrounding blank paper no longer
    covers whatever fragment is underneath it. Alpha is derived from each
    pixel's darkest channel (not average brightness), so saturated colors
    like red markup lines - which read as "bright" on their own red channel -
    still come out fully opaque; only pixels that are close to white on
    every channel fade out."""
    r, g, b, _ = img.split()
    darkest_channel = ImageChops.darker(ImageChops.darker(r, g), b)
    alpha = ImageChops.invert(darkest_channel)  # white (255,255,255) -> alpha 0; black -> alpha 255
    img.putalpha(alpha)
    return img


def apply_mask(img, mask_polygons, zoom):
    """Punches mask_polygons (fragment-local source-PDF points, as {"x":..,
    "y":..} objects - same point shape as every other geometry in this app,
    take-off instances included) to alpha=0 - same "cut a hole out of the
    shape" mental model as take-off subtraction, applied to a raster
    fragment instead of a take-off area. Combined with (not overwriting)
    whiten_to_alpha's own alpha via "darker wins" - either effect making a
    pixel more transparent should stick, so an explicit mask still fully
    hides dark ink (a title block border, a stamp) that whiten_to_alpha
    alone would have left opaque."""
    if not mask_polygons:
        return img
    mask = Image.new("L", img.size, 255)
    draw = ImageDraw.Draw(mask)
    for polygon in mask_polygons:
        scaled = [(p["x"] * zoom, p["y"] * zoom) for p in polygon]
        if len(scaled) >= 3:
            draw.polygon(scaled, fill=0)
    combined_alpha = ImageChops.darker(img.getchannel("A"), mask)
    img.putalpha(combined_alpha)
    return img


def rotate_fragment(img, degrees):
    """Rotates a fragment image about its own center by `degrees` (clockwise-
    positive - PIL's own rotate() is counter-clockwise-positive, hence the
    negation), expanding the canvas so no corner gets clipped. The returned
    image is larger than the input whenever degrees isn't a multiple of 180
    - callers must re-center it on the original place rect's center, not its
    top-left, when computing where to insert it (see main())."""
    if not degrees:
        return img
    return img.rotate(-degrees, expand=True, resample=Image.BICUBIC)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest_json_path")
    parser.add_argument("output_pdf")
    parser.add_argument("output_thumb")
    parser.add_argument("output_preview")
    parser.add_argument("--thumb-size", type=int, default=300)
    # Matches burst.py's own preview-size bump - a composite's preview needs
    # to stay indistinguishable from an ordinary sheet's to every downstream
    # consumer, per this file's own docstring.
    parser.add_argument("--preview-size", type=int, default=4000)
    args = parser.parse_args()

    with open(args.manifest_json_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    canvas_width_pt = manifest["canvas"]["width_pt"]
    canvas_height_pt = manifest["canvas"]["height_pt"]

    doc = fitz.open()
    page = doc.new_page(width=canvas_width_pt, height=canvas_height_pt)

    fragments = sorted(manifest["fragments"], key=lambda f: f["z_order"])
    for frag in fragments:
        if not frag.get("visible", True):
            continue
        crop = frag["crop"]
        place = frag["place"]
        rotation = frag.get("rotation") or 0

        frag_longest_pt = max(crop["width"], crop["height"])
        zoom = min(RENDER_SCALE, MAX_FRAGMENT_PX / frag_longest_pt) if frag_longest_pt > 0 else RENDER_SCALE

        img = render_fragment(frag["source_pdf_path"], crop, zoom)
        img = apply_mask(img, frag.get("mask_polygons") or [], zoom)

        place_px_w = max(1, round(place["width"] * zoom))
        place_px_h = max(1, round(place["height"] * zoom))
        if (place_px_w, place_px_h) != img.size:
            img = img.resize((place_px_w, place_px_h), Image.LANCZOS)

        img = rotate_fragment(img, rotation)
        # rotate_fragment's expand=True may have grown the image beyond
        # place_px_w/h - re-derive the insert rect from the ROTATED image's
        # own size, centered on the unrotated rect's center, so rotation
        # pivots in place instead of the fragment drifting.
        center_x = place["x"] + place["width"] / 2
        center_y = place["y"] + place["height"] / 2
        rect_w_pt = img.width / zoom
        rect_h_pt = img.height / zoom
        rect = fitz.Rect(
            center_x - rect_w_pt / 2,
            center_y - rect_h_pt / 2,
            center_x + rect_w_pt / 2,
            center_y + rect_h_pt / 2,
        )

        buf = io.BytesIO()
        img.save(buf, format="PNG")
        page.insert_image(rect, stream=buf.getvalue())

    # thumb/preview - render the fully-assembled page (every fragment
    # already inserted, PyMuPDF compositing their individual alpha same as
    # any PDF viewer would) at a small size, same "render once, derive
    # thumbnail from it" pattern burst.py uses for an ordinary sheet page.
    # Done before save() purely so there's no question of a saved-to-disk
    # document's in-memory page object being touched by anything - save()
    # doesn't actually mutate it, but there's no reason to rely on that.
    longest_pt = max(canvas_width_pt, canvas_height_pt)
    preview_zoom = args.preview_size / longest_pt if longest_pt > 0 else 1.0
    preview_pix = page.get_pixmap(matrix=fitz.Matrix(preview_zoom, preview_zoom), alpha=False)
    preview_img = Image.frombytes("RGB", (preview_pix.width, preview_pix.height), preview_pix.samples)

    # Same save flags as burst.py's bloat fix - garbage=4 drops unreferenced
    # objects, clean=True lets garbage collection actually reach them,
    # deflate recompresses what's left.
    doc.save(args.output_pdf, garbage=4, deflate=True, clean=True)
    doc.close()

    save_webp(preview_img, args.output_preview, args.preview_size, quality=92)
    save_webp(preview_img, args.output_thumb, args.thumb_size, quality=78)

    json.dump({"ok": True, "page_width_pt": canvas_width_pt, "page_height_pt": canvas_height_pt}, sys.stdout)


if __name__ == "__main__":
    main()
