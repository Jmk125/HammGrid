# Drawing Management App — Project Spec

Internal drawing management tool for a construction CMR firm (K-12 school projects, Ohio).
Replaces the drawing-management portion of commercial "do everything" software that field
teams find slow and clumsy. Built by one developer. Optimize for simplicity, speed, and
maintainability over feature breadth.

## Mission

Fast, trustworthy drawing revision management. The three things that matter most,
in order:

1. **Revision management** — sheets as first-class entities with version history;
   publishing a revision is atomic and the field always sees the current set by default.
2. **Speed** — thumbnails and sheet viewing must feel instant on iPad in the field,
   including with no network connection.
3. **Access control and sharing** — role-based internal users; tokenized share links
   for contractors (no contractor accounts).

## Non-goals (v1)

- No RFI/submittal *workflow* (ball-in-court, review stamps, due dates). Documents are
  a dumb store that markups can link to. Do not rebuild Procore.
- No free rotation in overlay. Shift + scale only.
- No native iPad app. One responsive web app (PWA) serves PC and iPad.

## Architecture

- **Single responsive web app.** Same URL/app on PC and iPad. PC leans toward
  upload/admin workflows (mouse, keyboard shortcuts); iPad leans toward viewing/markup
  (touch targets, pinch-zoom). One codebase.
- **Server:** Node.js / Express / SQLite. Initially hosted on central server (office
  network / existing Pi infrastructure). Host must be easily configurable (the app is
  served from the host, so switching = new IP in the browser; keep any API base URL
  configurable rather than hardcoded in case a trailer-local Pi relay is added later).
- **PDF processing:** server-side pipeline using PyMuPDF (Python sidecar scripts are
  fine — matches developer's existing tooling) + Tesseract OCR for title block
  extraction. poppler-utils acceptable for rasterization if preferred.
- **Client viewer:** PDF.js rendering single-sheet PDFs, with an SVG overlay layer for
  markups.
- **Offline (iPad):** PWA with service worker. Sheets, thumbnails, and markup JSON
  cached in IndexedDB / OPFS (not HTTP cache). Request persistent storage
  (`navigator.storage.persist()`) so iOS doesn't evict under storage pressure.
  Sync model: "give me everything published since my last sync" — revision-aware,
  typically a few sheets / few MB. Background sync when on trailer WiFi; full function
  offline afterward. **Drawings render from local storage — network is never in the
  path of viewing a sheet.**

## Core data model

Sheets are entities; versions belong to sheets; markups belong to sheets (NOT versions —
this is how carry-forward works by default).

- `users` — id, name, username, pass_hash, role (`admin` | `editor` | `viewer`)
- `projects` — id, name, number, discipline_prefix_map (JSON, editable per project),
  created_at
- `ocr_regions` — id, project_id, scope (discipline prefix or upload batch),
  number_box (JSON rect), title_box (JSON rect). Established at first upload; reused
  for later revisions; may differ by discipline (lead architect vs. hired engineers
  often use slightly different title blocks).
- `revisions` — id, project_id, title, source (e.g. "ASI-014", "Addendum 3"), date,
  status (`draft` | `published`), created_by, published_at. Revision 0 = original set.
- `sheets` — id, project_id, sheet_number, discipline (derived from number prefix,
  overridable), current_version_id
- `sheet_versions` — id, sheet_id, revision_id, title, pdf_path, thumb_path,
  preview_path, ocr_confidence, extraction_status
- `markups` — id, sheet_id, author_id, visibility (`private` | `published`), type
  (`line` | `arrow` | `cloud` | `text` | `rect`), geometry (JSON, in sheet coordinate
  space), style (JSON), linked_document_id (nullable), created_at. Markups persist
  across revisions until deleted by an authorized user.
- `documents` — id, project_id, kind (`rfi` | `submittal`), number, title, date,
  status, pdf_path
- `shares` — id, project_id, token, scope (`live` | `snapshot`),
  snapshot_revision_id (nullable), discipline_filter (nullable), expires_at (nullable),
  revoked (bool), created_by
- `activity_log` — id, project_id, actor (user_id or share token), action, detail
  (JSON), created_at. Log at minimum: revision publishes, markup publishes, share link
  creation/revocation, share link access, set exports.

## Key workflows

### Upload & extraction (original set)
1. Editor/Admin creates project, uploads PDFs (individual sheets or large multi-page
   sets).
2. Server bursts multi-page PDFs into individual sheet PDFs and renders thumbnails
   (~300px WebP, 20–40KB) + medium previews at upload time. **Never render PDFs at
   view time — all raster assets are pre-generated.**
3. User draws number-box and title-box ONCE on a representative sheet; regions apply to
   the whole batch. OCR runs on those regions for every sheet.
4. Review screen: table of sheet number / title / discipline. Low-confidence or
   pattern-violating results (expect numbers like `[A-Z]{1,2}-?\d+(\.\d+)?`) flagged
   yellow for correction.
5. **Batch retry:** user can check any set of sheets (e.g., all civil sheets), draw new
   number/title boxes once, and re-OCR all checked sheets with the new regions. Also
   works for a single sheet. Successful regions are saved to `ocr_regions` scoped to
   that discipline for reuse on future revisions.
6. Discipline auto-derived from sheet number prefix via per-project editable map.
   Defaults: A→Architectural, S→Structural, C→Civil, P→Plumbing, M/H→Mechanical,
   E→Electrical, T→Technology, FP→Fire Protection.
7. User approves → publish (atomic). Field never sees a half-published set.

### Adding a revision
1. Editor creates revision: title, date, source. Uploads PDFs.
2. Same burst/OCR pipeline, reusing stored `ocr_regions` per discipline (user can
   adjust/retry as above).
3. Matching: each incoming sheet lands in one of three buckets —
   - **Replacement** (sheet number matches existing sheet)
   - **New sheet** (no match — common for SK/ASI supplemental sheets)
   - **Suspicious** (OCR misread, or number matched but title wildly different — warn,
     this catches misfiled sheets)
4. If a replaced sheet has markups, show an informational flag ("A101 has 4 published
   markups") — markups carry forward automatically; the flag is awareness only.
5. Review, correct, publish (atomic). Sheet's `current_version_id` flips on publish.

### Viewing
- Thumbnail grid, filterable by discipline and by revision. Grid loads pre-generated
  thumbnails only — must be instant, including offline on iPad.
- Sheet view opens latest published version by default; revision history accessible.
- Version-to-version **overlay**: color composite (à la red/blue) of two versions of a
  sheet. Default = perfectly aligned (same title block plots identically in most
  cases). Controls: drag-to-shift and scale nudge. No rotation. Consider pre-baking
  the common comparison (current vs. previous) server-side at publish time for instant
  load, with client-side interactive overlay for arbitrary pairs.

### Markups
- SVG layer over PDF.js canvas. Vector JSON, never burned into PDFs.
- Tools: line, arrow, cloud, text, rectangle. Good style control (color, weight).
- Private by default; author can publish. Viewers can create private markups only.
- Markup can link to a document (RFI/submittal). Clicking a linked markup opens the
  document in a new tab (easy download; "back" = close tab — foolproof on iPad Safari).
- Typical use case to honor: RFI response doesn't change the drawing, so a PM clouds
  the area and links the RFI — that cloud must persist through all future revisions
  until deleted.

### Sharing & export
- **Tokenized links, no contractor accounts.** Scope: `live` (always current published
  set — kills "is this the latest?" calls) or `snapshot` (frozen at a revision — for
  bids/subcontracts). Optional discipline filter, expiry, revocation. View/download
  only.
- Export: zip of current published sheet PDFs, or a single merged bookmarked PDF.
  Exports and share-link accesses are activity-logged (dispute protection: "we never
  got those drawings").

## Permissions

| Role | Can |
|---|---|
| Admin | Everything: projects, users, publish revisions, delete markups, manage shares |
| Editor | Upload, create draft revisions, publish revisions, markup + publish markups, create shares |
| Viewer | View published content, create **private** markups only |

Contractors are never users; they are share links.

## Build order

1. **Foundation:** Express server, SQLite schema, auth/sessions/roles, project CRUD.
2. **Ingest pipeline:** upload → burst → thumbnails/previews → box-drawing UI → OCR →
   review table → batch retry → publish. (This is the heart; get it right first.)
3. **Viewer:** thumbnail grid with discipline/revision filters, PDF.js sheet viewer.
4. **Revisions:** revision creation, matching buckets, markup-presence flags, atomic
   publish, version history, overlay.
5. **Markups:** SVG layer, tools, private/publish, document store (RFIs/submittals),
   markup→document linking.
6. **Field readiness:** PWA manifest, service worker, IndexedDB/OPFS sheet cache,
   persistent storage request, sync-since-last-sync endpoint, offline viewing.
7. **Sharing & audit:** share tokens (live/snapshot), export (zip + merged PDF),
   activity log surfaces.

## Performance rules (non-negotiable)

- All raster assets (thumbnails, previews, pre-baked overlays) generated at
  upload/publish time, never on demand.
- Thumbnail grid and sheet viewing must work fully offline on iPad from local storage.
- Sync payloads are deltas (sheets published since last sync), not full sets.
- Single-sheet PDFs only in the viewer; never ship multi-hundred-page PDFs to the
  client.

## Environment notes

- Developer's existing stack/patterns: Node/Express/SQLite (Bid Database), NeDB tools,
  Python + PyMuPDF + pytesseract (PDF Drawing Overlay, OCR snip tool), PDF.js (spec
  diff tool), poppler-utils (Drawing Comparator), systemd deployment on Raspberry Pi,
  portable Node on Windows. Reuse these patterns.
- Pi is RAM-constrained — keep the processing pipeline sequential/queue-based, not
  parallel, and consider running heavy ingest jobs on the Windows box if the Pi
  struggles with 400-sheet bursts.
