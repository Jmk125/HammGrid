"""
OCR the number-box and title-box regions of a single-sheet PDF.

Usage:
    python ocr_region.py <sheet_pdf> <number_box_json> <title_box_json> \
        [--tesseract-cmd PATH]

Box JSON is a normalized rect relative to the page: {"x":0,"y":0,"w":1,"h":1}
(0-1 range), so the same region works across sheets whose page size varies
slightly.

Prints JSON to stdout:
    {"number_text": "A-101", "number_confidence": 91.4,
     "title_text": "FIRST FLOOR PLAN", "title_confidence": 88.2}
"""
import argparse
import json
import sys

import fitz  # PyMuPDF
import pytesseract
from pytesseract import Output
from PIL import Image

# MuPDF prints its own diagnostics (e.g. "MuPDF error: limit error: Overly
# large image") straight to stdout via its internal fprintf, not through a
# Python exception - left enabled, that silently corrupts the JSON this
# script prints, which is exactly what broke a large-format sheet upload.
fitz.TOOLS.mupdf_display_errors(False)

# Each box is rendered directly from the PDF's vector data at a resolution
# targeting this pixel height, rather than rasterizing the whole page once
# (capped for large-format sheets) and cropping a low-res region out of it.
# A number/title box is a tiny fraction of the page, so rendering it alone
# at high effective DPI is cheap (MuPDF's clip rect limits the actual
# rasterization work) and gives Tesseract far more detail per character
# than upscaling a blurry crop after the fact.
TARGET_BOX_HEIGHT_PX = 400
# Safety cap on zoom for a pathologically short/degenerate box, so a near-
# zero-height rect can't request an enormous render.
MAX_ZOOM = 12.0

# Sheet numbers are single-line, uppercase, and only ever contain these
# characters (see NUMBER_PATTERN in revision.js: [A-Z]{1,2}-?\d+(\.\d+)?) -
# restricting Tesseract to this whitelist stops it from ever emitting
# unrelated symbols in the number field. This was added after a recurring
# misread on one drawing set where "7" was consistently read as "/".
NUMBER_TESSERACT_CONFIG = "--psm 7 -c tessedit_char_whitelist=0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ.-"
# Titles are free text, so no whitelist - and no PSM override either.
# Tesseract's default (psm 3, fully automatic page segmentation) measurably
# beat every forced single-line/single-block mode in a side-by-side test
# against a real title box: psm 6/7/11/12 all pulled in a few extra stray
# characters from elsewhere in the box (dropping confidence from ~95% to
# ~83%) that psm 3's own auto-segmentation correctly excluded. Don't
# "helpfully" add a PSM override here without re-testing against a real
# sample first - it's counIntuitive but the default outperforms the more
# specific modes for this title-block layout - counterintuitive, but
# verified, not assumed.
TITLE_TESSERACT_CONFIG = ""


def render_box_region(pdf_path, box):
    doc = fitz.open(pdf_path)
    page = doc[0]
    rect = page.rect
    box_rect = fitz.Rect(
        box["x"] * rect.width,
        box["y"] * rect.height,
        (box["x"] + box["w"]) * rect.width,
        (box["y"] + box["h"]) * rect.height,
    )
    if box_rect.width <= 0 or box_rect.height <= 0:
        doc.close()
        return None
    zoom = min(TARGET_BOX_HEIGHT_PX / box_rect.height, MAX_ZOOM)
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=box_rect, alpha=False)
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    doc.close()
    return img


def _ocr_single(img, config):
    # Defensive fallback - render_box_region already targets ~400px tall,
    # but a very short/degenerate box can still come out smaller than that
    # after the MAX_ZOOM cap, and tesseract does noticeably better above
    # ~200px tall.
    if img.height < 200:
        scale = 200 / img.height
        img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    gray = img.convert("L")
    data = pytesseract.image_to_data(gray, output_type=Output.DICT, config=config)
    words = []
    confidences = []
    for text, conf in zip(data["text"], data["conf"]):
        text = text.strip()
        conf = float(conf)
        if text and conf >= 0:
            words.append(text)
            confidences.append(conf)
    joined = " ".join(words).strip()
    avg_conf = sum(confidences) / len(confidences) if confidences else 0.0
    return joined, avg_conf


def ocr_crop(img, config):
    if img is None:
        return "", 0.0

    candidates = [img]
    # A box drawn much taller than it is wide usually means the text inside
    # it is rotated 90 degrees (some title blocks run the sheet number/name
    # vertically along an edge) - try both rotations and keep whichever
    # reads with higher confidence, rather than assuming horizontal text.
    if img.height > img.width * 1.3:
        candidates.append(img.rotate(-90, expand=True))
        candidates.append(img.rotate(90, expand=True))

    best_text, best_conf = "", -1.0
    for candidate in candidates:
        text, conf = _ocr_single(candidate, config)
        if conf > best_conf:
            best_text, best_conf = text, conf
    return best_text, max(best_conf, 0.0)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("sheet_pdf")
    parser.add_argument("number_box")
    parser.add_argument("title_box")
    parser.add_argument("--tesseract-cmd", default=None)
    args = parser.parse_args()

    if args.tesseract_cmd:
        pytesseract.pytesseract.tesseract_cmd = args.tesseract_cmd

    number_box = json.loads(args.number_box)
    title_box = json.loads(args.title_box)

    number_text, number_conf = ocr_crop(render_box_region(args.sheet_pdf, number_box), NUMBER_TESSERACT_CONFIG)
    title_text, title_conf = ocr_crop(render_box_region(args.sheet_pdf, title_box), TITLE_TESSERACT_CONFIG)

    json.dump({
        "number_text": number_text,
        "number_confidence": number_conf,
        "title_text": title_text,
        "title_confidence": title_conf,
    }, sys.stdout)


if __name__ == "__main__":
    main()
