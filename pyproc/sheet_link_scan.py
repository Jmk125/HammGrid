"""Find references to known sheet numbers in a single-sheet PDF.

Usage:
    python sheet_link_scan.py <source_sheet_id> <source_pdf> <targets_json>

`targets_json` is a list of {"id": int, "sheet_number": str}. Prints JSON:
    {"links": [{"target_sheet_id": 2, "rect": {"x": ..., "y": ..., "w": ..., "h": ...}, "label": "A101"}]}
"""
import argparse
import json
import math
import re
import sys

import fitz  # PyMuPDF

fitz.TOOLS.mupdf_display_errors(False)

# Single toggle to instantly disable callout-bubble detection and fall back to
# the plain padded-text-box rect below, without needing a code revert.
DETECT_CALLOUT_BUBBLES = True

# Detail/interior-elevation callout bubbles in real drawing sets run roughly
# 0.15"-1.3" (11-95pt) across. Below that it's more likely a door-swing arc or
# similar symbol; above it it's unlikely to be a text callout.
CALLOUT_MIN_PT = 10.0
CALLOUT_MAX_PT = 100.0
CALLOUT_MIN_ASPECT = 0.5
CALLOUT_MAX_ASPECT = 2.0
# How close to a perfect circle/oval the traced points must be (coefficient of
# variation of point-to-center radius; 0 = perfect circle). CAD-exported PDFs
# typically flatten circles to polylines rather than bezier curves, so this
# checks point-distance consistency instead of curve commands.
CALLOUT_MAX_RADIUS_CV = 0.05


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


def rect_to_fraction(x0, y0, x1, y1, page_rect):
    x0 = max(page_rect.x0, x0)
    y0 = max(page_rect.y0, y0)
    x1 = min(page_rect.x1, x1)
    y1 = min(page_rect.y1, y1)
    return {
        "x": (x0 - page_rect.x0) / page_rect.width,
        "y": (y0 - page_rect.y0) / page_rect.height,
        "w": (x1 - x0) / page_rect.width,
        "h": (y1 - y0) / page_rect.height,
    }


def expanded_rect(word_rect, page_rect, pad_pt=2.0):
    x0, y0, x1, y1 = word_rect
    return rect_to_fraction(x0 - pad_pt, y0 - pad_pt, x1 + pad_pt, y1 + pad_pt, page_rect)


def _polyline_points(drawing):
    # CAD-exported PDFs generally flatten circles/ovals to short straight
    # segments rather than bezier curves, so a callout bubble shows up here as
    # a closed path made entirely of 'l' (line) items.
    points = []
    for item in drawing.get("items", []):
        if item[0] != "l":
            return []
        p1, p2 = item[1], item[2]
        if not points:
            points.append(p1)
        points.append(p2)
    return points


def find_callout_bubbles(page):
    """Closed polylines on the page that trace a near-perfect circle/oval,
    small enough to plausibly be a detail/interior-elevation callout bubble
    rather than a title-block border, revision cloud, or equipment symbol."""
    bubbles = []
    for drawing in page.get_drawings():
        rect = drawing.get("rect")
        if not rect or rect.width <= 0 or rect.height <= 0:
            continue
        aspect = rect.width / rect.height
        if not (CALLOUT_MIN_ASPECT <= aspect <= CALLOUT_MAX_ASPECT):
            continue
        if not (CALLOUT_MIN_PT <= max(rect.width, rect.height) <= CALLOUT_MAX_PT):
            continue
        points = _polyline_points(drawing)
        if len(points) < 8:
            continue
        if abs(points[0].x - points[-1].x) > 1 or abs(points[0].y - points[-1].y) > 1:
            continue  # not a closed loop
        cx, cy = (rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2
        radii = [math.hypot(p.x - cx, p.y - cy) for p in points]
        mean_r = sum(radii) / len(radii)
        if mean_r == 0:
            continue
        variance = sum((r - mean_r) ** 2 for r in radii) / len(radii)
        if (variance ** 0.5) / mean_r > CALLOUT_MAX_RADIUS_CV:
            continue
        bubbles.append(rect)
    return bubbles


def enclosing_callout_bubble(word_rect, bubbles):
    wx0, wy0, wx1, wy1 = word_rect
    wcx, wcy = (wx0 + wx1) / 2, (wy0 + wy1) / 2
    best = None
    for rect in bubbles:
        if not (rect.x0 - 2 <= wcx <= rect.x1 + 2 and rect.y0 - 2 <= wcy <= rect.y1 + 2):
            continue
        if best is None or (rect.width * rect.height) < (best.width * best.height):
            best = rect  # prefer the tightest enclosing bubble
    return best


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
    callout_bubbles = None  # computed lazily, at most once per page

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

            rect = None
            if DETECT_CALLOUT_BUBBLES:
                if callout_bubbles is None:
                    try:
                        callout_bubbles = find_callout_bubbles(page)
                    except Exception:
                        # Never let bubble detection break the plain-text scan.
                        callout_bubbles = []
                bubble = enclosing_callout_bubble(word[:4], callout_bubbles)
                if bubble is not None:
                    rect = rect_to_fraction(bubble.x0, bubble.y0, bubble.x1, bubble.y1, page_rect)
            if rect is None:
                rect = expanded_rect(word[:4], page_rect)

            found.append({
                "target_sheet_id": int(target["id"]),
                "rect": rect,
                "label": target["sheet_number"],
            })

    doc.close()
    json.dump({"links": found}, sys.stdout)


if __name__ == "__main__":
    main()
