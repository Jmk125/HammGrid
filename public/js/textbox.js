// Shared by the editor (markups.js) and the read-only share viewer
// (share-sheet.js): a "text box" markup is the existing `text` type with a
// w/h in its geometry - wrapped text inside a bordered, filled box. Plain
// `text` markups (no w) keep rendering as a single unboxed line.
const SVG_NS = 'http://www.w3.org/2000/svg';
const FONT_FAMILY = 'sans-serif';
export const TEXTBOX_DEFAULT_FONT_SIZE = 20;

export function isTextbox(m) {
  return m.type === 'text' && m.geometry && m.geometry.w > 0 && m.geometry.h > 0;
}

let measureCtx = null;
function textWidth(str, fontSize) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = `${fontSize}px ${FONT_FAMILY}`;
  return measureCtx.measureText(str).width;
}

// Greedy word wrap to maxWidth, honoring typed line breaks and splitting a
// single over-long word (a long part number, say) by character so it never
// overflows the box sideways.
function wrapLines(text, maxWidth, fontSize) {
  const lines = [];
  for (const para of String(text || '').split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, fontSize) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      let rest = word;
      while (textWidth(rest, fontSize) > maxWidth && rest.length > 1) {
        let n = rest.length - 1;
        while (n > 1 && textWidth(rest.slice(0, n), fontSize) > maxWidth) n--;
        lines.push(rest.slice(0, n));
        rest = rest.slice(n);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

// Box height grows to fit the text if the drawn box is too short, so
// nothing is ever clipped - the stored h is only the minimum.
export function textboxLayout(m, vbW, vbH) {
  const fontSize = (m.style && m.style.fontSize) || TEXTBOX_DEFAULT_FONT_SIZE;
  const pad = fontSize * 0.4;
  const lineH = fontSize * 1.25;
  const boxW = m.geometry.w * vbW;
  const lines = wrapLines(m.geometry.text, Math.max(boxW - pad * 2, fontSize), fontSize);
  const height = Math.max(m.geometry.h * vbH, lines.length * lineH + pad * 2);
  return { fontSize, pad, lineH, lines, x: m.geometry.x * vbW, y: m.geometry.y * vbH, w: boxW, h: height };
}

export function buildTextboxNode(m, vbW, vbH, { color, strokeWidth }) {
  const L = textboxLayout(m, vbW, vbH);
  const g = document.createElementNS(SVG_NS, 'g');
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('x', L.x);
  rect.setAttribute('y', L.y);
  rect.setAttribute('width', L.w);
  rect.setAttribute('height', L.h);
  rect.setAttribute('fill', '#ffffff');
  rect.setAttribute('fill-opacity', '0.92');
  rect.setAttribute('stroke', color);
  rect.setAttribute('stroke-width', strokeWidth);
  g.appendChild(rect);
  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('fill', color);
  text.setAttribute('font-size', L.fontSize);
  text.setAttribute('font-family', FONT_FAMILY);
  L.lines.forEach((line, i) => {
    const t = document.createElementNS(SVG_NS, 'tspan');
    t.setAttribute('x', L.x + L.pad);
    t.setAttribute('y', L.y + L.pad + L.fontSize * 0.95 + i * L.lineH);
    t.textContent = line;
    text.appendChild(t);
  });
  g.appendChild(text);
  return g;
}
