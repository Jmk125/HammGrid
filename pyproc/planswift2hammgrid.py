#!/usr/bin/env python3
"""
planswift2hammgrid - convert a PlanSwift job folder into a HammGrid import package.

PlanSwift (local storage) keeps each job as a folder tree. Every node is a
folder containing a Data.xml:

    <Item Class="Page|Area|Area Section|Dimension|Overlay|Folder|..." Name=".." GUID="..">
      <Properties>
        <Property Class="Text|Number|Color|..." Name="..." ...>value</Property>
      </Properties>
    </Item>

Pages store their raster in the same folder as <ImageGUID>.tiff (150 DPI in
the jobs seen so far). Drawn geometry lives in a "DigitizerData" property: an
escaped XML <Points> list in *image pixel* coordinates, plus a PageGUID
property pointing at the page it was drawn on. Page scale is ScaleX/ScaleY in
pixels per "Scale Units" (e.g. 150 DPI at 1" = 30' -> 5 px/ft).

Output package (one folder, drop-in for a HammGrid importer):

    <out>/
      hammgrid-import.json   everything: job, sheets, takeoff items, shapes
      takeoff.csv            flat quantity summary (one row per shape)
      sheets/<guid>.pdf      one-page sheet PDF (lossless image)    [--images hammgrid]
      sheets/<guid>_thumb.webp / _preview.webp   same sizes as HammGrid's burst.py
      preview/<page>.png     sheets with takeoff drawn on top      [--preview]
      README.txt

    Import it with HammGrid's  npm run import-planswift -- <package folder>

Geometry is written twice: raw pixel coords and normalized 0..1 coords
(x / image width, y / image height), so HammGrid can place shapes on the
matching PDF page regardless of render resolution.

Usage:
    python planswift2hammgrid.py "C:\\...\\OldPlanswiftLocal\\1234" [-o OUT] [--preview]
    python planswift2hammgrid.py            (no args -> folder picker dialog)

Needs Python 3.8+ with Pillow and PyMuPDF for sheet files (both already in
HammGrid's requirements.txt). The JSON/CSV export alone works without them.
"""
from __future__ import annotations

import argparse
import csv
import datetime as _dt
import html
import json
import math
import os
import re
import sys
import xml.etree.ElementTree as ET

FORMAT_ID = "hammgrid-planswift-import"
FORMAT_VERSION = 1

# Properties that are UI/bookkeeping noise, not data worth carrying over.
SKIP_PROPS = {
    "Form Layout", "DigitizerData", "OrderIndex", "PagesWindow_Expanded",
    "TakeoffSummary_Expanded", "SwiftTube VideoID", "ShowChildInputs",
    "DoubleClickAction", "DragDropAction", "LaunchAction", "Icon",
}
NO_COLOR = {536870911, 0x1FFFFFFF, 0x20000000}


# --------------------------------------------------------------------------- parsing
class Node:
    def __init__(self, path, rel, cls, name, guid, props):
        self.path = path            # absolute folder path
        self.rel = rel              # folder path relative to job root, "/" separated
        self.cls = cls
        self.name = name
        self.guid = guid
        self.props = props          # name -> {"class", "value", "attrs"}
        self.parent: Node | None = None
        self.children: list[Node] = []

    def val(self, name, default=None):
        p = self.props.get(name)
        return default if p is None or p["value"] in (None, "") else p["value"]

    def num(self, name):
        v = self.val(name)
        try:
            return float(v)
        except (TypeError, ValueError):
            return None


def parse_item(xml_path):
    try:
        root = ET.parse(xml_path).getroot()
    except ET.ParseError:
        # Fall back to a lenient read (some builds write stray bytes).
        text = open(xml_path, encoding="utf-8", errors="replace").read()
        root = ET.fromstring(text.strip().lstrip("\ufeff"))
    if root.tag != "Item":
        return None
    props = {}
    pe = root.find("Properties")
    if pe is not None:
        for p in pe.findall("Property"):
            n = p.get("Name")
            if not n:
                continue
            props[n] = {"class": p.get("Class"), "value": p.text, "attrs": dict(p.attrib)}
    return root.get("Class") or "", root.get("Name") or "", root.get("GUID") or "", props


def load_tree(job_dir):
    nodes, by_dir = [], {}
    for dirpath, dirnames, filenames in os.walk(job_dir):
        dirnames.sort()
        if "Data.xml" not in filenames:
            continue
        parsed = parse_item(os.path.join(dirpath, "Data.xml"))
        if not parsed:
            continue
        cls, name, guid, props = parsed
        rel = os.path.relpath(dirpath, job_dir).replace(os.sep, "/")
        n = Node(dirpath, "" if rel == "." else rel, cls, name, guid, props)
        nodes.append(n)
        by_dir[os.path.normcase(os.path.abspath(dirpath))] = n
    for n in nodes:
        d = os.path.dirname(os.path.abspath(n.path))
        while True:
            p = by_dir.get(os.path.normcase(d))
            if p is not None and p is not n:
                n.parent = p
                p.children.append(n)
                break
            nd = os.path.dirname(d)
            if nd == d or not os.path.normcase(nd).startswith(os.path.normcase(os.path.abspath(job_dir))):
                break
            d = nd
    return nodes


def parse_points(raw):
    if not raw:
        return []
    text = raw
    if "&lt;" in text:
        text = html.unescape(text)
    text = text.strip()
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        pts = re.findall(r'X="([-\d.eE]+)"\s+Y="([-\d.eE]+)"(?:\s+PointType="(\w+)")?', text)
        return [(float(x), float(y), t or "Normal") for x, y, t in pts]
    out = []
    for p in root.iter("Point"):
        try:
            out.append((float(p.get("X")), float(p.get("Y")), p.get("PointType") or "Normal"))
        except (TypeError, ValueError):
            pass
    return out


def tcolor_to_hex(v):
    """Delphi TColor (0x00BBGGRR) -> #rrggbb. None for clNone/system colors."""
    try:
        c = int(float(v))
    except (TypeError, ValueError):
        return None
    if c < 0 or c in NO_COLOR or c > 0xFFFFFF:
        return None
    r, g, b = c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF
    return f"#{r:02x}{g:02x}{b:02x}"


def clean_props(node):
    out = {}
    for k, p in node.props.items():
        if k in SKIP_PROPS or k.startswith("OrderIndex_") or k == "GUID":
            continue
        v = p["value"]
        if v is None or v == "":
            continue
        if p["class"] in ("Image", "Large Image", "Memo"):
            continue
        out[k] = v
    return out


def is_formula(v):
    return isinstance(v, str) and v.startswith("[") and v.endswith("]")


# --------------------------------------------------------------------------- geometry
def shape_kind(node):
    names = [node.cls, node.val("Type", "") or ""]
    if node.parent is not None:
        names += [node.parent.cls]
    s = " ".join(names).lower()
    if "overlay" in s:
        return "overlay"
    if "dimension" in s:
        return "dimension"
    if "area" in s:
        return "area"
    if "count" in s:
        return "count"
    if any(k in s for k in ("linear", "segment", "line", "length", "perimeter")):
        return "linear"
    return "unknown"


def polyline_len(pts, sx, sy, closed=False):
    total = 0.0
    seq = pts + ([pts[0]] if closed and len(pts) > 2 else [])
    for (x1, y1, *_), (x2, y2, *_) in zip(seq, seq[1:]):
        total += math.hypot((x2 - x1) / sx, (y2 - y1) / sy)
    return total


def polygon_area(pts, sx, sy):
    a = 0.0
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i][0] / sx, pts[i][1] / sy
        x2, y2 = pts[(i + 1) % n][0] / sx, pts[(i + 1) % n][1] / sy
        a += x1 * y2 - x2 * y1
    return abs(a) / 2.0


# --------------------------------------------------------------------------- conversion
def find_page_image(node):
    img = node.props.get("Image")
    gid = img["attrs"].get("GUID") if img else None
    files = os.listdir(node.path)
    if gid:
        for f in files:
            if f.lower().startswith(gid.lower()) and not f.lower().endswith(".xml"):
                return os.path.join(node.path, f)
    for f in files:
        if os.path.splitext(f)[1].lower() in (".tif", ".tiff", ".png", ".jpg", ".jpeg", ".bmp", ".pdf"):
            return os.path.join(node.path, f)
    return None


def folder_path(node, stop_rel):
    """Names of Folder ancestors below the top-level Pages/Takeoff folder."""
    parts = []
    p = node.parent
    while p is not None and p.rel not in ("", stop_rel):
        parts.append(p.name)
        p = p.parent
    return list(reversed(parts))


def convert(job_dir, out_dir, images="png", preview=False, log=print, progress=None):
    """progress(done, total) is called once per page (the slow part: every
    page's TIFF is re-encoded into a PDF + thumb + preview)."""
    job_dir = os.path.abspath(job_dir)
    root_xml = os.path.join(job_dir, "Data.xml")
    if not os.path.isfile(root_xml):
        raise SystemExit(f"Not a PlanSwift job folder (no Data.xml): {job_dir}")
    nodes = load_tree(job_dir)
    job = next((n for n in nodes if n.rel == ""), None)
    if job is None or (job.val("Type") or "").lower() != "job":
        log("warning: root Data.xml is not Type=Job; converting anyway")
    warnings = []
    os.makedirs(out_dir, exist_ok=True)

    try:
        from PIL import Image  # noqa
        Image.MAX_IMAGE_PIXELS = None
        have_pil = True
    except ImportError:
        have_pil = False
        if images != "none" or preview:
            warnings.append("Pillow not installed: sheet images/previews skipped (pip install pillow)")
            images, preview = "none", False

    # ---- sheets
    sheets, sheet_by_guid = [], {}
    page_nodes = [n for n in nodes if n.cls == "Page"]
    if progress:
        progress(0, len(page_nodes))
    for page_index, n in enumerate(page_nodes, 1):
        img_path = find_page_image(n)
        w = h = None
        dpi = None
        out_img = None
        if img_path and have_pil:
            from PIL import Image
            try:
                with Image.open(img_path) as im:
                    w, h = im.size
                    d = im.info.get("dpi")
                    dpi = float(d[0]) if d and d[0] else None
                    if not dpi:
                        dpi = 150.0
                        warnings.append(f"page '{n.name}' image has no DPI; assuming 150")
                    base = n.guid.strip("{}")
                    if images == "hammgrid":
                        os.makedirs(os.path.join(out_dir, "sheets"), exist_ok=True)
                        out_img = _write_hammgrid_sheet(im, img_path, dpi, os.path.join(out_dir, "sheets"), base)
                    elif images == "png":
                        rel = f"sheets/{base}.png"
                        os.makedirs(os.path.join(out_dir, "sheets"), exist_ok=True)
                        im.save(os.path.join(out_dir, rel))
                        out_img = {"image": rel}
            except Exception as e:  # noqa
                warnings.append(f"could not read image for page '{n.name}': {e}")
        elif not img_path:
            warnings.append(f"page '{n.name}' has no image file")
        sx, sy = n.num("ScaleX"), n.num("ScaleY")
        scale = None
        if sx and sy:
            units = (n.val("Scale Units") or "FT").strip().upper()
            fpi = None
            if dpi:
                if units in ("FT", "'", "FEET"):
                    fpi = dpi / sx
                elif units in ("IN", '"', "INCHES"):
                    fpi = dpi / sx / 12.0
                else:
                    warnings.append(f"page '{n.name}' uses scale units {units}; HammGrid scale left blank")
            scale = {
                "label": (n.val("AutoScaled") or "").strip() or None,
                "px_per_unit_x": sx,
                "px_per_unit_y": sy,
                "units": units,
                "measurement": n.val("Measurement Type") or None,
                "feet_per_inch": round(fpi, 6) if fpi else None,
            }
            if abs(sx - sy) > 1e-9:
                warnings.append(f"page '{n.name}' has different X/Y scales ({sx} vs {sy}); HammGrid uses X")
        name = (n.name or "").strip()
        number, title = _split_sheet_name(name)
        s = {
            "id": n.guid,
            "name": name,
            "sheet_number": number or os.path.basename(n.rel),
            "title": title if number else name,
            "folder": folder_path(n, "Pages"),
            "source_folder": n.rel,
            "source_image": os.path.relpath(img_path, job_dir).replace(os.sep, "/") if img_path else None,
            "files": out_img,
            "width_px": w, "height_px": h, "dpi": dpi,
            "width_pt": round(w * 72.0 / dpi, 4) if w and dpi else None,
            "height_pt": round(h * 72.0 / dpi, 4) if h and dpi else None,
            "scale": scale,
        }
        sheets.append(s)
        sheet_by_guid[n.guid.upper()] = s
        if progress:
            progress(page_index, len(page_nodes))

    _dedupe_sheet_numbers(sheets)

    # ---- shapes (anything with DigitizerData)
    def inherited_page(n):
        # Subtract sections (cutouts) carry no PageGUID - they live on their
        # parent section's page.
        p = n
        while p is not None:
            v = p.val("PageGUID")
            if v:
                return v.upper()
            p = p.parent
        return ""

    def make_shape(n):
        # PlanSwift writes (-1,-1) placeholder points for a shape that was
        # started but never drawn.
        pts = [pt for pt in parse_points(n.val("DigitizerData")) if not (pt[0] == -1 and pt[1] == -1)]
        pg = inherited_page(n)
        sheet = sheet_by_guid.get(pg)
        kind = shape_kind(n)
        odd = sorted({t for *_, t in pts if t != "Normal"})
        if odd:
            warnings.append(f"'{n.name}' ({n.rel}) uses point types {odd}; drawn as straight segments")
        shp = {
            "id": n.guid, "name": n.name, "class": n.cls, "kind": kind,
            "sheet_id": sheet["id"] if sheet else (pg or None),
            "visible": (n.val("Visible", "True") != "False"),
            "points_px": [[round(x, 3), round(y, 3)] for x, y, _ in pts],
            "point_types": [t for *_, t in pts] if odd else None,
            "points_norm": None, "points_pt": None, "quantity": None,
        }
        if sheet is None:
            warnings.append(f"'{n.name}' ({n.rel}) references unknown page {pg}")
        else:
            if sheet["width_px"] and sheet["height_px"]:
                W, H = sheet["width_px"], sheet["height_px"]
                shp["points_norm"] = [[round(x / W, 6), round(y / H, 6)] for x, y, _ in pts]
                k = 72.0 / sheet["dpi"]
                shp["points_pt"] = [[round(x * k, 4), round(y * k, 4)] for x, y, _ in pts]
            sc = sheet["scale"]
            if sc and pts and kind in ("area", "linear", "count", "dimension"):
                sx, sy, u = sc["px_per_unit_x"], sc["px_per_unit_y"], sc["units"]
                if kind == "area":
                    shp["quantity"] = {
                        "value": round(polygon_area(pts, sx, sy), 3), "units": f"SQ {u}",
                        "perimeter": round(polyline_len(pts, sx, sy, closed=True), 3), "perimeter_units": u,
                    }
                elif kind in ("linear", "dimension"):
                    shp["quantity"] = {"value": round(polyline_len(pts, sx, sy), 3), "units": u}
                elif kind == "count":
                    shp["quantity"] = {"value": len(pts), "units": "EA"}
            elif kind == "count" and pts:
                shp["quantity"] = {"value": len(pts), "units": "EA"}
            elif kind in ("area", "linear") and not sc:
                warnings.append(f"'{n.name}' is on unscaled sheet '{sheet['name']}'; quantity not computed")
        shp["_pts"] = pts
        shp["_sheet"] = sheet
        return shp

    shape_nodes = {id(n) for n in nodes if "DigitizerData" in n.props}
    # Section nodes are drawn geometry, never take-off items - a Section with
    # no DigitizerData is an abandoned click in PlanSwift and is dropped.
    empty_sections = {id(n) for n in nodes if "section" in n.cls.lower() and id(n) not in shape_nodes}
    is_subtract = lambda n: "subtract" in n.cls.lower()

    # ---- takeoff items (non-folder, non-shape nodes under Takeoff/)
    items, item_by_node = [], {}
    for n in nodes:
        top = n.rel.split("/")[0] if n.rel else ""
        if (top != "Takeoff" or n.rel == "Takeoff" or n.cls == "Folder"
                or id(n) in shape_nodes or id(n) in empty_sections):
            continue
        props = clean_props(n)
        it = {
            "id": n.guid, "name": n.name, "class": n.cls,
            "kind": shape_kind(n) if n.cls != "Item" else "item",
            "parent_id": None,
            "folder": folder_path(n, "Takeoff"),
            "color": tcolor_to_hex(n.val("Color")),
            "description": n.val("Description"),
            "item_number": n.val("Item #"),
            "cost_code": n.val("Cost Code"), "division": n.val("Division"),
            "phase": n.val("Phase"), "location": n.val("Location"),
            "scale_units": n.val("Scale Units"),
            "planswift_qty": props.get("Qty"),
            "numeric_properties": _numeric_props(props),
            "properties": props,
            "shapes": [], "total": None,
        }
        items.append(it)
        item_by_node[id(n)] = it
    for n in nodes:
        it = item_by_node.get(id(n))
        if not it:
            continue
        p = n.parent
        while p is not None and id(p) not in item_by_node:
            p = p.parent
        if p is not None:
            it["parent_id"] = item_by_node[id(p)]["id"]
            it["folder"] = []

    annotations, overlays, orphans = [], [], []
    shape_by_node = {}
    pending_holes = []
    stats_empty = 0
    for n in nodes:
        if id(n) not in shape_nodes:
            continue
        shp = make_shape(n)
        if not shp["_pts"]:
            stats_empty += 1
            continue
        if is_subtract(n):
            pending_holes.append((n, shp))
            continue
        shape_by_node[id(n)] = shp
        p = n
        while p is not None and id(p) not in item_by_node:
            p = p.parent
        if p is not None:
            owner = item_by_node[id(p)]
            if owner["color"] and not shp.get("color"):
                shp["color"] = owner["color"]
            owner["shapes"].append(shp)
        elif shp["kind"] == "overlay":
            shp["overlay_sheet_id"] = n.val("OverlayPage")
            shp["color"] = tcolor_to_hex(n.val("Color"))
            shp["note"] = "PlanSwift page-overlay alignment points (compare two revisions), not takeoff"
            overlays.append(shp)
        elif shp["kind"] == "dimension":
            shp["color"] = tcolor_to_hex(n.val("Color"))
            annotations.append(shp)
        else:
            orphans.append(shp)
            warnings.append(f"shape '{n.name}' ({n.rel}) not under a takeoff item; exported as annotation")
    annotations += orphans

    # Cutouts: attach each Subtract Section to its nearest ancestor shape as a
    # hole; area = outer - holes, perimeter = outer only (same as HammGrid).
    for n, hole in pending_holes:
        p = n.parent
        while p is not None and id(p) not in shape_by_node:
            p = p.parent
        parent = shape_by_node.get(id(p)) if p is not None else None
        if parent is None or parent["kind"] != "area":
            warnings.append(f"cutout '{n.name}' ({n.rel}) has no parent area; ignored")
            continue
        for key in ("points_px", "points_norm", "points_pt"):
            if hole[key] is not None:
                parent.setdefault("holes_" + key.split("_")[1], []).append(hole[key])
        sh = parent["_sheet"]
        if parent["quantity"] and sh and sh["scale"]:
            sc = sh["scale"]
            cut = polygon_area(hole["_pts"], sc["px_per_unit_x"], sc["px_per_unit_y"])
            q = parent["quantity"]
            q["gross"] = q.get("gross", q["value"])
            q["value"] = round(max(0.0, q["value"] - cut), 3)
            q["cutouts"] = round(q.get("cutouts", 0) + cut, 3)
    if stats_empty:
        warnings.append(f"{stats_empty} empty/undrawn PlanSwift shapes skipped")
    for coll in ([s for it in items for s in it["shapes"]], annotations, overlays):
        for shp in coll:
            shp.pop("_pts", None)
            shp.pop("_sheet", None)

    for it in items:
        q = [s["quantity"] for s in it["shapes"] if s["quantity"]]
        if q:
            units = {x["units"] for x in q}
            it["total"] = {"value": round(sum(x["value"] for x in q), 3),
                           "units": units.pop() if len(units) == 1 else "MIXED"}
        if it["planswift_qty"] and is_formula(it["planswift_qty"]):
            it["qty_note"] = "PlanSwift stores Qty as a formula; 'total' is recomputed from geometry"

    used_sheets = sorted({s["sheet_id"] for it in items for s in it["shapes"] if s["sheet_id"]})
    doc = {
        "format": FORMAT_ID, "version": FORMAT_VERSION,
        "converted_at": _dt.datetime.now().isoformat(timespec="seconds"),
        "converter": "planswift2hammgrid.py",
        "coordinate_system": {
            "points_px": "PlanSwift image pixels, origin top-left, y down",
            "points_norm": "0..1 fraction of sheet width/height, origin top-left, y down",
        },
        "job": {
            "id": job.guid if job else None,
            "name": job.name if job else os.path.basename(job_dir),
            "description": job.val("Description") if job else None,
            "measurement_type": job.val("Measurement Type") if job else None,
            "source_folder": job_dir,
        },
        "sheets": sheets,
        "takeoff_sheet_ids": used_sheets,
        "takeoff_items": items,
        "annotations": annotations,
        "overlays": overlays,
        "warnings": warnings,
    }
    with open(os.path.join(out_dir, "hammgrid-import.json"), "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)

    with open(os.path.join(out_dir, "takeoff.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["Item", "Item Folder", "Kind", "Shape", "Sheet", "Quantity", "Units",
                    "Perimeter", "Color", "Item GUID", "Shape GUID"])
        for it in items:
            for s in it["shapes"]:
                sh = sheet_by_guid.get((s["sheet_id"] or "").upper())
                q = s["quantity"] or {}
                w.writerow([it["name"], "/".join(it["folder"]), s["kind"], s["name"],
                            sh["name"] if sh else s["sheet_id"], q.get("value"), q.get("units"),
                            q.get("perimeter"), it["color"], it["id"], s["id"]])

    if preview:
        _render_previews(doc, job_dir, out_dir, sheet_by_guid, log)

    _write_readme(out_dir, doc)
    n_shapes = sum(len(it["shapes"]) for it in items)
    log(f"job '{doc['job']['name']}': {len(sheets)} sheets, {len(items)} takeoff items, "
        f"{n_shapes} shapes on {len(used_sheets)} sheets, {len(annotations)} annotations, "
        f"{len(overlays)} overlays, {len(warnings)} warnings")
    log(f"wrote {out_dir}")
    return doc


SHEET_NO = re.compile(r"^(?:[A-Z]{1,4}[-.]?\d{1,4}(?:[-.]\d{1,3})*[A-Z]?|\d{1,3})$", re.I)
SHEET_NO_LEAD = re.compile(r"^([A-Z]{1,4}[-.]?\d{2,4}(?:[-.]\d{1,3})*[A-Z]?)(?![\w.-])[\s_-]*(.*)$", re.I)


def _split_sheet_name(name):
    """'HILLTOP - C200 - GEOMETRIC PLAN' -> ('C200', 'GEOMETRIC PLAN');
    'CES301 GRADING PLAN' -> ('CES301', 'GRADING PLAN'); no number -> (None, name)."""
    parts = [p.strip() for p in re.split(r"\s+-\s+", name or "") if p.strip()]
    for i, p in enumerate(parts):
        if SHEET_NO.match(p):
            return p.upper(), " - ".join(parts[i + 1:]) or " - ".join(parts[:i])
    m = SHEET_NO_LEAD.match(name or "")
    if m:
        return m.group(1).upper(), m.group(2).strip()
    return None, name


def _dedupe_sheet_numbers(sheets):
    """HammGrid needs unique sheet numbers per project. PlanSwift jobs often hold
    the same sheet in several page folders (GMP, Bulletin 02, ...): suffix those
    with their folder, then number any remaining collisions."""
    from collections import Counter
    counts = Counter(s["sheet_number"].upper() for s in sheets)
    for s in sheets:
        if counts[s["sheet_number"].upper()] > 1 and s["folder"]:
            s["sheet_number"] = f"{s['sheet_number']} ({s['folder'][0]})"
    seen = {}
    for s in sheets:
        key = s["sheet_number"].upper()
        seen[key] = seen.get(key, 0) + 1
        if seen[key] > 1:
            s["sheet_number"] = f"{s['sheet_number']} #{seen[key]}"


def _numeric_props(props):
    out = []
    for k in ("Depth", "Wall Height", "Height", "Width", "Thickness", "Waste %", "Multiplier"):
        v = props.get(k)
        try:
            f = float(v)
        except (TypeError, ValueError):
            continue
        out.append({"name": k.replace("%", "Pct").strip(), "value": f})
    return out


def _write_hammgrid_sheet(im, img_path, dpi, out_dir, base):
    """Same asset set HammGrid's pyproc/burst.py produces for an uploaded sheet:
    single-page PDF + ~300px thumb + 4000px preview WebP."""
    from PIL import Image
    w, h = im.size
    wpt, hpt = w * 72.0 / dpi, h * 72.0 / dpi
    pdf = os.path.join(out_dir, base + ".pdf")
    try:
        try:
            import pymupdf as fitz  # PyMuPDF >= 1.24 - lossless (Flate) image embed
        except ImportError:
            import fitz
        doc = fitz.open()
        page = doc.new_page(width=wpt, height=hpt)
        page.insert_image(page.rect, filename=img_path)
        doc.save(pdf, garbage=4, deflate=True)
        doc.close()
    except ImportError:
        im.convert("RGB").save(pdf, "PDF", resolution=dpi, quality=95)
    rgb = im.convert("RGB")
    for suffix, longest, q in (("_preview.webp", 4000, 92), ("_thumb.webp", 300, 78)):
        k = longest / max(w, h)
        img = rgb.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS) if k < 1 else rgb
        img.save(os.path.join(out_dir, base + suffix), "WEBP", quality=q)
    return {"pdf": f"sheets/{base}.pdf", "thumb": f"sheets/{base}_thumb.webp",
            "preview": f"sheets/{base}_preview.webp"}


def _render_previews(doc, job_dir, out_dir, sheet_by_guid, log):
    from PIL import Image, ImageDraw
    os.makedirs(os.path.join(out_dir, "preview"), exist_ok=True)
    per_sheet = {}
    for it in doc["takeoff_items"]:
        for s in it["shapes"]:
            per_sheet.setdefault((s["sheet_id"] or "").upper(), []).append((it, s))
    for a in doc["annotations"]:
        per_sheet.setdefault((a["sheet_id"] or "").upper(), []).append((None, a))
    for gid, shapes in per_sheet.items():
        sh = sheet_by_guid.get(gid)
        if not sh or not sh["source_image"]:
            continue
        with Image.open(os.path.join(job_dir, sh["source_image"])) as im:
            base = im.convert("RGB")
        k = min(1.0, 2400 / max(base.size))
        base = base.resize((int(base.width * k), int(base.height * k)))
        over = Image.new("RGBA", base.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(over)
        for it, s in shapes:
            col = (s.get("color") or (it or {}).get("color") or "#ff0000").lstrip("#")
            rgb = tuple(int(col[i:i + 2], 16) for i in (0, 2, 4))
            pts = [(x * k, y * k) for x, y in s["points_px"]]
            if not pts:
                continue
            if s["kind"] == "area" and len(pts) > 2:
                d.polygon(pts, fill=rgb + (90,), outline=rgb + (255,))
                for hole in s.get("holes_px") or []:
                    hp = [(x * k, y * k) for x, y in hole]
                    if len(hp) > 2:
                        d.polygon(hp, fill=(255, 255, 255, 170), outline=rgb + (255,))
            elif s["kind"] == "count":
                for x, y in pts:
                    d.ellipse([x - 8, y - 8, x + 8, y + 8], fill=rgb + (200,))
            else:
                d.line(pts, fill=rgb + (255,), width=4)
            q = s.get("quantity")
            if q:
                cx = sum(p[0] for p in pts) / len(pts)
                cy = sum(p[1] for p in pts) / len(pts)
                label = f"{(it or s)['name']}: {q['value']:,.1f} {q['units']}"
                d.rectangle([cx - 4, cy - 14, cx + 8 * len(label), cy + 6], fill=(255, 255, 255, 220))
                d.text((cx, cy - 12), label, fill=(0, 0, 0, 255))
        out = Image.alpha_composite(base.convert("RGBA"), over).convert("RGB")
        fn = re.sub(r"[^\w\-() #]+", "_", f"{sh['sheet_number']} - {sh['title'] or sh['name']}").strip() + ".png"
        out.save(os.path.join(out_dir, "preview", fn))
        log(f"preview: preview/{fn}")


def _write_readme(out_dir, doc):
    with open(os.path.join(out_dir, "README.txt"), "w", encoding="utf-8") as f:
        f.write(f"""HammGrid import package - converted from PlanSwift
Job: {doc['job']['name']} - {doc['job']['description'] or ''}
Converted: {doc['converted_at']}

hammgrid-import.json  full data (format {FORMAT_ID} v{FORMAT_VERSION})
takeoff.csv           one row per drawn shape with recomputed quantity

Import into HammGrid (from the drawing-app folder):
    npm run import-planswift -- "<this folder>"
sheets/               sheet PDFs + thumbnails, named by PlanSwift page GUID
preview/              sheets with takeoff drawn on top (for checking)

Quantities are recomputed from geometry and page scale; PlanSwift itself
stores Qty as a formula. Check 'warnings' in the JSON before trusting totals.
""")


# --------------------------------------------------------------------------- CLI / GUI
def main(argv=None):
    ap = argparse.ArgumentParser(description="Convert a PlanSwift job folder to a HammGrid import package.")
    ap.add_argument("job", nargs="?", help="PlanSwift job folder (the one containing Data.xml with Type=Job)")
    ap.add_argument("-o", "--out", help="output folder (default: <job name>_hammgrid next to the job)")
    ap.add_argument("--images", choices=["hammgrid", "png", "none"], default="hammgrid",
                    help="hammgrid = PDF + thumb/preview per sheet (default), png = plain PNG, none = skip")
    ap.add_argument("--preview", action="store_true", help="also render sheets with takeoff drawn on top")
    ap.add_argument("--json", action="store_true",
                    help="machine mode for the HammGrid server: stdout is ONLY a final JSON summary; "
                         "log lines and 'PROGRESS n/m' (like burst.py) go to stderr")
    a = ap.parse_args(argv)
    if a.json:
        if not a.job:
            ap.error("job folder is required with --json")
        return _main_json(a)

    job = a.job
    if not job:
        try:
            import tkinter as tk
            from tkinter import filedialog, messagebox
        except ImportError:
            ap.error("job folder is required")
        tk.Tk().withdraw()
        job = filedialog.askdirectory(title="Select PlanSwift job folder")
        if not job:
            return 1
        out = filedialog.askdirectory(title="Select where to save the HammGrid package") or os.path.dirname(job)
        out = os.path.join(out, os.path.basename(os.path.normpath(job)) + "_hammgrid")
        doc = convert(job, out, "hammgrid", True)
        messagebox.showinfo("planswift2hammgrid",
                            f"Converted '{doc['job']['name']}'\n{len(doc['takeoff_items'])} takeoff items\n"
                            f"{len(doc['warnings'])} warnings\n\nSaved to:\n{out}")
        return 0
    out = a.out or os.path.join(os.path.dirname(os.path.abspath(job)),
                                os.path.basename(os.path.normpath(job)) + "_hammgrid")
    doc = convert(job, out, a.images, a.preview)
    for w in doc["warnings"]:
        print("  warning:", w)
    return 0


def _main_json(a):
    # Same contract as burst.py: stdout is reserved for the JSON the server
    # parses, so anything else (our log lines, stray prints, MuPDF's own
    # C-level diagnostics) must not land there.
    try:
        import pymupdf as fitz
    except ImportError:
        try:
            import fitz
        except ImportError:
            fitz = None
    if fitz is not None:
        fitz.TOOLS.mupdf_display_errors(False)
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        out = a.out or os.path.join(os.path.dirname(os.path.abspath(a.job)),
                                    os.path.basename(os.path.normpath(a.job)) + "_hammgrid")
        log = lambda msg: print(msg, file=sys.stderr, flush=True)
        prog = lambda done, total: print(f"PROGRESS {done}/{total}", file=sys.stderr, flush=True)
        doc = convert(a.job, out, a.images, a.preview, log=log, progress=prog)
    finally:
        sys.stdout = real_stdout
    summary = {
        "out_dir": os.path.abspath(out),
        "job": doc["job"],
        "sheet_count": len(doc["sheets"]),
        "takeoff_item_count": len(doc["takeoff_items"]),
        "warning_count": len(doc["warnings"]),
    }
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
