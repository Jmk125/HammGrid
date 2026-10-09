"""Find references to known sheet numbers in a single-sheet PDF.

Usage:
    python sheet_link_scan.py <source_sheet_id> <source_pdf> <targets_json>

`targets_json` is a list of {"id": int, "sheet_number": str}. Prints JSON:
    {"links": [{"target_sheet_id": 2, "rect": {"x": ..., "y": ..., "w": ..., "h": ...}, "label": "A101"}]}
"""
import argparse
import json
import re
import sys

import fitz  # PyMuPDF

fitz.TOOLS.mupdf_display_errors(False)


def normalize_token(value):
    return re.sub(r"[^A-Z0-9]", "", (value or "").upper())


def is_sheet_number_candidate(value):
    # Avoid turning every detail bubble/grid bubble/room tag into a link. In
    # real drawing sets, sheet references are normally discipline-prefixed
    # (A101, S201, E3.01, etc.). Short numeric-only values like 1, 2, 3, 4.8,
    # 10 appear constantly as detail numbers, grid lines, notes, dimensions,
    # and room labels, so auto-linking them creates hotspots "everywhere".
    # Manual links can still cover numeric-only sheet sets later if needed.
    return len(value) >= 3 and any(ch.isalpha() for ch in value) and any(ch.isdigit() for ch in value)


def expanded_rect(word_rect, page_rect, pad_pt=2.0):
    x0, y0, x1, y1 = word_rect
    x0 = max(page_rect.x0, x0 - pad_pt)
    y0 = max(page_rect.y0, y0 - pad_pt)
    x1 = min(page_rect.x1, x1 + pad_pt)
    y1 = min(page_rect.y1, y1 + pad_pt)
    return {
        "x": (x0 - page_rect.x0) / page_rect.width,
        "y": (y0 - page_rect.y0) / page_rect.height,
        "w": (x1 - x0) / page_rect.width,
        "h": (y1 - y0) / page_rect.height,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source_sheet_id", type=int)
    parser.add_argument("source_pdf")
    parser.add_argument("targets_json")
    args = parser.parse_args()

    targets = []
    for target in json.loads(args.targets_json):
        if int(target["id"]) == args.source_sheet_id:
            continue
        normalized = normalize_token(target.get("sheet_number"))
        if is_sheet_number_candidate(normalized):
            targets.append({**target, "normalized": normalized})

    doc = fitz.open(args.source_pdf)
    page = doc[0]
    page_rect = page.rect
    found = []
    seen = set()

    # Text extraction is vector-based and much faster than OCR. It will not
    # catch raster-only scans, but it gives us a safe first pass that can run
    # after publish without affecting sheet-view load time.
    for word in page.get_text("words"):
        word_text = word[4]
        normalized_word = normalize_token(word_text)
        if not is_sheet_number_candidate(normalized_word):
            continue
        for target in targets:
            if normalized_word != target["normalized"]:
                continue
            key = (target["id"], round(word[0], 1), round(word[1], 1), round(word[2], 1), round(word[3], 1))
            if key in seen:
                continue
            seen.add(key)
            found.append({
                "target_sheet_id": int(target["id"]),
                "rect": expanded_rect(word[:4], page_rect),
                "label": target["sheet_number"],
            })

    doc.close()
    json.dump({"links": found}, sys.stdout)


if __name__ == "__main__":
    main()
