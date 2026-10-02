// Right-pane section order (sheet viewer). Shared by the sheet viewer (drag to
// reorder) and the Settings page (up/down list) so both agree on the ids,
// labels, and how a saved order is reconciled with what the user can see.
export const PANE_SECTIONS = [
  { id: 'markup', label: 'Markup Tools' },
  { id: 'reference', label: 'Reference' },
  { id: 'measure', label: 'Measure' },
  { id: 'takeoffs', label: 'Take-offs', needsTakeoff: true },
];

// Saved order -> full list of section ids the user is allowed to see. Unknown
// ids are dropped; sections missing from the saved list (e.g. added later)
// keep their default relative position at the end.
export function resolvePaneOrder(saved, canTakeoff) {
  const allowed = PANE_SECTIONS.filter((s) => canTakeoff || !s.needsTakeoff).map((s) => s.id);
  const out = [];
  if (Array.isArray(saved)) {
    for (const id of saved) if (allowed.includes(id) && !out.includes(id)) out.push(id);
  }
  for (const id of allowed) if (!out.includes(id)) out.push(id);
  return out;
}
