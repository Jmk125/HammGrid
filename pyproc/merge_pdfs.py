"""
Merge multiple single-sheet PDFs into one bookmarked PDF.

Usage:
    python merge_pdfs.py <manifest_json_path> <output_pdf>

manifest_json_path points to a JSON file: [{"path": "...", "title": "A-101 - FIRST FLOOR PLAN"}, ...]
Order in the array is the order sheets appear in the merged output.

Prints {"ok": true, "pages": N} to stdout.
"""
import argparse
import json
import sys

import fitz  # PyMuPDF

# See ocr_region.py for why this matters: MuPDF's internal diagnostics print
# straight to stdout, which would corrupt the JSON this script emits.
fitz.TOOLS.mupdf_display_errors(False)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('manifest')
    parser.add_argument('output')
    args = parser.parse_args()

    with open(args.manifest, 'r', encoding='utf-8') as f:
        entries = json.load(f)

    out = fitz.open()
    toc = []
    for entry in entries:
        src = fitz.open(entry['path'])
        start_page = len(out)
        out.insert_pdf(src)
        toc.append([1, entry['title'], start_page + 1])
        src.close()

    if toc:
        out.set_toc(toc)
    out.save(args.output)
    pages = len(out)
    out.close()

    json.dump({"ok": True, "pages": pages}, sys.stdout)


if __name__ == '__main__':
    main()
