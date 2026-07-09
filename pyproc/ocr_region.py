"""
OCR the number-box and title-box regions of a single-sheet PDF.

Usage:
    python ocr_region.py <sheet_pdf> <number_box_json> <title_box_json> \
        [--dpi 400] [--tesseract-cmd PATH]

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

POINTS_PER_INCH = 72.0
# Hard cap so a large-format sheet (E-size and bigger) can't blow past
# MuPDF's internal "overly large image" limit at a fixed DPI - mirrors
# burst.py's target-pixel-size approach instead of a blind DPI multiply.
MAX_RENDER_PX = 6000


def render_full_page(pdf_path, dpi):
    doc = fitz.open(pdf_path)
    page = doc[0]
    rect = page.rect
    longest_pt = max(rect.width, rect.height)
    dpi_zoom = dpi / POINTS_PER_INCH
    max_zoom = MAX_RENDER_PX / longest_pt if longest_pt > 0 else dpi_zoom
    zoom = min(dpi_zoom, max_zoom)
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    doc.close()
    return img


def crop_box(img, box):
    w, h = img.size
    left = max(0, round(box["x"] * w))
    top = max(0, round(box["y"] * h))
    right = min(w, round((box["x"] + box["w"]) * w))
    bottom = min(h, round((box["y"] + box["h"]) * h))
    if right <= left or bottom <= top:
        return None
    return img.crop((left, top, right, bottom))


def _ocr_single(img):
    # Upscale small crops; tesseract does noticeably better above ~200px tall.
    if img.height < 200:
        scale = 200 / img.height
        img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    gray = img.convert("L")
    data = pytesseract.image_to_data(gray, output_type=Output.DICT)
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


def ocr_crop(img):
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
        text, conf = _ocr_single(candidate)
        if conf > best_conf:
            best_text, best_conf = text, conf
    return best_text, max(best_conf, 0.0)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("sheet_pdf")
    parser.add_argument("number_box")
    parser.add_argument("title_box")
    parser.add_argument("--dpi", type=int, default=400)
    parser.add_argument("--tesseract-cmd", default=None)
    args = parser.parse_args()

    if args.tesseract_cmd:
        pytesseract.pytesseract.tesseract_cmd = args.tesseract_cmd

    number_box = json.loads(args.number_box)
    title_box = json.loads(args.title_box)

    img = render_full_page(args.sheet_pdf, args.dpi)

    number_text, number_conf = ocr_crop(crop_box(img, number_box))
    title_text, title_conf = ocr_crop(crop_box(img, title_box))

    json.dump({
        "number_text": number_text,
        "number_confidence": number_conf,
        "title_text": title_text,
        "title_confidence": title_conf,
    }, sys.stdout)


if __name__ == "__main__":
    main()
