// Shared scroll-to-zoom (cursor-centered) + drag-to-pan + shift-scroll
// horizontal pan, used by the sheet viewer, the document viewer, and the
// revision box-drawing tool. Applies a CSS transform to innerEl inside
// wrapEl - coordinate math elsewhere (SVG viewBox ratios, canvas-relative
// mouse positions) keeps working unmodified because getBoundingClientRect()
// already reflects applied transforms.

export function setupZoomPan({ wrapEl, innerEl, isPanBlocked, onChange, panButton = 0 }) {
  const state = { scale: 1, x: 0, y: 0 };

  // When panning is bound to the right mouse button (box-drawing tool, so
  // left-drag is free to draw), suppress the browser's right-click context
  // menu on the wrap - otherwise every pan attempt pops it open instead.
  if (panButton !== 0) {
    wrapEl.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function apply() {
    innerEl.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
    if (onChange) onChange(state);
  }

  function fitToView(contentWidth, contentHeight) {
    const rect = wrapEl.getBoundingClientRect();
    if (!contentWidth || !rect.width) return;
    const fitScale = Math.min(rect.width / contentWidth, rect.height / contentHeight) * 0.96;
    state.scale = fitScale;
    state.x = (rect.width - contentWidth * fitScale) / 2;
    state.y = (rect.height - contentHeight * fitScale) / 2;
    apply();
  }

  wrapEl.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (e.shiftKey) {
        state.x -= e.deltaY;
      } else {
        const rect = wrapEl.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        const newScale = Math.min(6, Math.max(0.1, state.scale * factor));
        state.x = cx - (cx - state.x) * (newScale / state.scale);
        state.y = cy - (cy - state.y) * (newScale / state.scale);
        state.scale = newScale;
      }
      apply();
    },
    { passive: false }
  );

  let pan = null;
  wrapEl.addEventListener('mousedown', (e) => {
    if (e.button !== panButton) return;
    if (isPanBlocked && isPanBlocked(e)) return;
    if (panButton !== 0) e.preventDefault();
    pan = { startX: e.clientX, startY: e.clientY, origX: state.x, origY: state.y };
    wrapEl.classList.add('panning');
  });
  window.addEventListener('mousemove', (e) => {
    if (!pan) return;
    state.x = pan.origX + (e.clientX - pan.startX);
    state.y = pan.origY + (e.clientY - pan.startY);
    apply();
  });
  window.addEventListener('mouseup', () => {
    pan = null;
    wrapEl.classList.remove('panning');
  });

  return { fitToView, apply, state };
}
