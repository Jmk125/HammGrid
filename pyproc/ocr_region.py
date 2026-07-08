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

POINTS_PER_INCH = 72.0


def render_full_page(pdf_path, dpi):
    doc = fitz.open(pdf_path)
    page = doc[0]
    zoom = dpi / POINTS_PER_INCH
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


def ocr_crop(img):
    if img is None:
        return "", 0.0
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
