"""Extract plain text content from a single-sheet PDF for full-text indexing.

Usage:
    python sheet_text_extract.py <sheet_id> <source_pdf>

Prints JSON: {"text": "..."}
"""
import argparse
import json
import sys

import fitz  # PyMuPDF

fitz.TOOLS.mupdf_display_errors(False)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("sheet_id", type=int)  # unused here, kept for CLI-shape consistency with sheet_link_scan.py
    parser.add_argument("source_pdf")
    args = parser.parse_args()

    doc = fitz.open(args.source_pdf)
    page = doc[0]
    text = page.get_text()
    doc.close()
    json.dump({"text": text}, sys.stdout)


if __name__ == "__main__":
    main()
