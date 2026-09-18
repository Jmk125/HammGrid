import argparse, json, sys, fitz
fitz.TOOLS.mupdf_display_errors(False)

def color(hex_value):
    h=(hex_value or '#e11d48').lstrip('#')
    if len(h)!=6: h='e11d48'
    return tuple(int(h[i:i+2],16)/255 for i in (0,2,4))

def draw_markup(page, m):
    r=page.rect; w,h=r.width,r.height
    g=m.get('geometry') or {}; st=m.get('style') or {}
    c=color(st.get('color')); width=float(st.get('strokeWidth') or 2)*0.75
    t=m.get('type')
    if t in ('line','arrow'):
        p1=fitz.Point(g.get('x1',0)*w, g.get('y1',0)*h); p2=fitz.Point(g.get('x2',0)*w, g.get('y2',0)*h)
        page.draw_line(p1,p2,color=c,width=width)
        if t=='arrow':
            import math
            ang=math.atan2(p2.y-p1.y,p2.x-p1.x); size=10
            pts=[]
            for a in (ang+2.55, ang-2.55): pts.append(fitz.Point(p2.x+math.cos(a)*size,p2.y+math.sin(a)*size))
            page.draw_polyline([pts[0],p2,pts[1]],color=c,width=width)
    elif t in ('rect','cloud'):
        rect=fitz.Rect(g.get('x',0)*w,g.get('y',0)*h,(g.get('x',0)+g.get('w',0))*w,(g.get('y',0)+g.get('h',0))*h)
        page.draw_rect(rect,color=c,width=width)
    elif t=='text':
        page.insert_text(fitz.Point(g.get('x',0)*w,g.get('y',0)*h), str(g.get('text','')), color=c, fontsize=14)

# Take-off shapes for the sheet pane's legend-toggle export - geometry is
# already normalized to 0-1 page fractions client-side (see sheet.js's
# buildTakeoffExportPayload), same convention as markup geometry above, so
# this only ever multiplies by the page's own width/height, never the
# render-pixel space the live pane's SVG overlay actually stores points in.
# Mirrors sheet.js's renderTakeoffInstances/drawTakeoffShapeMarker: count is
# a fixed-size filled marker, area is a filled+stroked polygon (even-odd
# multi-subpath when it has holes), linear/perimeter is a plain open
# polyline. Fixed point sizes throughout - there's no "current zoom" for a
# static export to match, unlike the on-screen version.
COUNT_MARKER_SIZE = 5  # pt

def draw_takeoff(page, t):
    r=page.rect; w,h=r.width,r.height
    c=color(t.get('color'))
    pts=t.get('points') or []
    if not pts: return
    to_pt=lambda p: fitz.Point((p.get('x') or 0)*w, (p.get('y') or 0)*h)
    typ=t.get('type')
    if typ=='count':
        p=to_pt(pts[0]); shape=t.get('shape') or 'square'; s=COUNT_MARKER_SIZE
        if shape=='circle':
            page.draw_circle(p, s, color=c, fill=c)
        elif shape=='triangle':
            sh=page.new_shape()
            sh.draw_polyline([fitz.Point(p.x,p.y-s), fitz.Point(p.x+s,p.y+s), fitz.Point(p.x-s,p.y+s)])
            sh.finish(color=c, fill=c, closePath=True); sh.commit()
        elif shape=='diamond':
            sh=page.new_shape()
            sh.draw_polyline([fitz.Point(p.x,p.y-s), fitz.Point(p.x+s,p.y), fitz.Point(p.x,p.y+s), fitz.Point(p.x-s,p.y)])
            sh.finish(color=c, fill=c, closePath=True); sh.commit()
        else:
            page.draw_rect(fitz.Rect(p.x-s,p.y-s,p.x+s,p.y+s), color=c, fill=c)
    elif typ=='area':
        outer=[to_pt(p) for p in pts]
        holes=t.get('holes') or []
        sh=page.new_shape()
        sh.draw_polyline(outer)
        for hole in holes:
            sh.draw_polyline([to_pt(p) for p in hole])
        sh.finish(color=c, fill=c, width=1.5, fill_opacity=0.15, even_odd=True, closePath=True)
        sh.commit()
    else:  # linear, perimeter
        sh=page.new_shape()
        sh.draw_polyline([to_pt(p) for p in pts])
        sh.finish(color=c, width=2.25, closePath=False)
        sh.commit()

# Longest prefix of `text` (plus "...") that fits within max_width at this
# font - same idea as the on-screen box's CSS text-overflow:ellipsis, needed
# here because insert_textbox would otherwise wrap an overlong name onto a
# second line and run into the row below it instead of just cutting it off.
# Three periods, not the U+2026 ellipsis glyph - PyMuPDF's base-14 "helv"
# uses a WinAnsi-ish simple encoding that doesn't have it and silently
# substitutes "?" instead.
def truncate_to_width(text, fontname, fontsize, max_width):
    if fitz.get_text_length(text, fontname=fontname, fontsize=fontsize) <= max_width:
        return text
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if fitz.get_text_length(text[:mid] + '...', fontname=fontname, fontsize=fontsize) <= max_width:
            lo = mid
        else:
            hi = mid - 1
    return (text[:lo] + '...') if lo > 0 else '...'

# Draggable/resizable box the pane already previews live on screen (same
# takeoffLegendRect fraction of the canvas). Font size is a fraction of the
# box's own WIDTH (FONT_RATIO, matching the on-screen box's CSS container-
# query sizing - see style.css's .takeoff-legend-item) rather than of its
# height or item count - drag the box wider and the text grows the same way
# in both places. Height then only controls how many rows fit; items past
# that are dropped, not shrunk further ("you sized it, you own the
# overflow", same rule the on-screen box uses).
FONT_RATIO = 0.045
def draw_legend(page, legend):
    if not legend: return
    r=page.rect; w,h=r.width,r.height
    x=(legend.get('x') or 0)*w; y=(legend.get('y') or 0)*h
    lw=(legend.get('w') or 0.25)*w; lh=(legend.get('h') or 0.18)*h
    if lw<=0 or lh<=0: return
    box=fitz.Rect(x,y,x+lw,y+lh)
    page.draw_rect(box, color=(0.2,0.2,0.2), fill=(1,1,1), fill_opacity=0.92, width=1)

    font_size=min(28, max(7, lw*FONT_RATIO))
    # insert_textbox below needs noticeably more vertical room than the bare
    # font size to fit even a single line without silently refusing to draw
    # it at all (confirmed empirically - a 1.7x row height reliably fits by
    # width but intermittently fails by height) - 2x leaves real headroom.
    # No independent upper clamp here: capping row_h below what a large
    # font_size needs (e.g. both pinned at the same fixed max) recreates the
    # exact "too little height" failure this multiplier exists to avoid.
    row_h=max(9, font_size*2.0)
    title_h=row_h
    title=fitz.Rect(box.x0,box.y0,box.x1,box.y0+title_h)
    page.draw_rect(title, color=(0.2,0.2,0.2), fill=(0.2,0.2,0.2), width=0)
    page.insert_textbox(fitz.Rect(title.x0+6,title.y0,title.x1-6,title.y1), 'LEGEND',
                         fontsize=font_size, color=(1,1,1), fontname='hebo')

    body=fitz.Rect(box.x0,title.y1,box.x1,box.y1)
    items=legend.get('items') or []
    if not items:
        page.insert_textbox(fitz.Rect(body.x0+6,body.y0+4,body.x1-6,body.y1-4),
                             'No visible take-offs on this sheet', fontsize=font_size, color=(0.4,0.44,0.53), fontname='helv')
        return

    pad=6
    swatch=min(font_size*0.9, row_h*0.6)
    for i, item in enumerate(items):
        row_y=body.y0+pad/2+i*row_h
        if row_y+row_h>body.y1: break
        ic=color(item.get('color'))
        sw=fitz.Rect(body.x0+pad, row_y+(row_h-swatch)/2, body.x0+pad+swatch, row_y+(row_h-swatch)/2+swatch)
        page.draw_rect(sw, color=(0,0,0), fill=ic, width=0.5)

        # +2 padding on each reserved text width below - insert_textbox can
        # refuse to draw anything at all (not even a fallback line) when a
        # box is sized to *exactly* a string's measured width, so an exact
        # fit is treated as unsafe, not sufficient.
        qty=str(item.get('quantity') or '').strip()
        qty_w=(fitz.get_text_length(qty, fontname='helv', fontsize=font_size)+2) if qty else 0
        name_rect=fitz.Rect(sw.x1+5, row_y, body.x1-pad-(qty_w+6 if qty else 0), row_y+row_h)
        name=truncate_to_width(str(item.get('name') or ''), 'helv', font_size, name_rect.width-2)
        page.insert_textbox(name_rect, name, fontsize=font_size, color=(0.1,0.1,0.1), fontname='helv')
        if qty:
            qty_rect=fitz.Rect(body.x1-pad-qty_w, row_y, body.x1-pad, row_y+row_h)
            page.insert_textbox(qty_rect, qty, fontsize=font_size, color=(0.35,0.35,0.35), fontname='helv', align=fitz.TEXT_ALIGN_RIGHT)

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('input'); ap.add_argument('markups_json'); ap.add_argument('output')
    a=ap.parse_args()
    doc=fitz.open(a.input); page=doc[0]
    with open(a.markups_json,'r',encoding='utf-8') as f: data=json.load(f)
    for m in (data.get('markups') or []): draw_markup(page,m)
    for t in (data.get('takeoffs') or []): draw_takeoff(page,t)
    draw_legend(page, data.get('legend'))
    doc.save(a.output, garbage=4, deflate=True); doc.close(); print(json.dumps({'ok':True}))
if __name__=='__main__': main()
