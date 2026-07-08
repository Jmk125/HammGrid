// Single-concurrency queue for PDF processing jobs. The Pi is RAM-constrained
// (see CLAUDE.md environment notes), so burst/OCR work must run one job at a
// time rather than fanning out per-request.
let tail = Promise.resolve();

function enqueue(fn) {
  const result = tail.then(fn);
  // Swallow rejections in the chain itself so one failed job doesn't wedge
  // the queue for subsequent jobs; the caller still sees the real error.
  tail = result.catch(() => {});
  return result;
}

module.exports = { enqueue };
