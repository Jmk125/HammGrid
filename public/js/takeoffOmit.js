// polygon-clipping.umd.min.js is loaded by a plain <script> in sheet.html (the ESM build
// needs bare-specifier resolution, which browsers don't do) and exposes this global.
const polygonClipping = window.polygonClipping;

// "Omit" for area take-offs: the parts of a freshly traced area that overlap
// already-placed area instances become holes in it (the same `geometry.holes`
// that Subtract Area writes), so the net quantity excludes them without the
// user tracing each opening by hand.

const toRing = (pts) => {
  const ring = pts.map((p) => [p.x, p.y]);
  ring.push([pts[0].x, pts[0].y]);
  return ring;
};

// An instance's shape as a polygon-clipping polygon: outer ring plus its own
// holes, so an already-omitted opening isn't treated as occupied area.
const toPolygon = (geometry) => [toRing(geometry.points), ...(geometry.holes || []).map(toRing)];

// Returns the hole rings ([{x, y}, ...], no closing duplicate) to cut out of
// `points` where it overlaps any of `omittedGeometries`. Overlapping omitted
// shapes are unioned first so shared ground is only cut once. Any ring nested
// inside an intersection piece (an island the omitted shape itself had a hole
// over) is ignored - its area stays omitted, a negligible error in practice.
export function computeOmitHoles(points, omittedGeometries) {
  const usable = omittedGeometries.filter((g) => g && g.points && g.points.length >= 3);
  if (points.length < 3 || usable.length === 0) return [];
  const omitted = polygonClipping.union(...usable.map(toPolygon));
  const pieces = polygonClipping.intersection([toRing(points)], omitted);
  return pieces.map((poly) => poly[0].slice(0, -1).map(([x, y]) => ({ x, y })));
}
