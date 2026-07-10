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

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('input'); ap.add_argument('markups_json'); ap.add_argument('output')
    a=ap.parse_args()
    doc=fitz.open(a.input); page=doc[0]
    with open(a.markups_json,'r',encoding='utf-8') as f: markups=json.load(f)
    for m in markups: draw_markup(page,m)
    doc.save(a.output, garbage=4, deflate=True); doc.close(); print(json.dumps({'ok':True}))
if __name__=='__main__': main()
