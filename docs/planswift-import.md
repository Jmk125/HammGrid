# PlanSwift import — format notes & current tooling

Status: built into the app (Dashboard → New Project → Import from… → PlanSwift),
plus the original CLI. Tested on real jobs 1234, 5713 - SD Hilltop and 5713 Bryden DD
(146 sheets, 323 items, 5882 instances — conversion ~8 min on the Windows box).

## Pieces

| File | What it does |
|---|---|
| `pyproc/planswift2hammgrid.py` | Reads a PlanSwift job folder, writes a *package* folder: `hammgrid-import.json`, `takeoff.csv`, `sheets/<pageGUID>.pdf` + `_thumb.webp` + `_preview.webp` (same sizes as `burst.py`), optional `preview/` PNGs with take-off drawn on. Needs Pillow + PyMuPDF (already in requirements.txt). `--json` = server mode: stdout is **only** a final JSON summary (`out_dir`, `job`, counts); log lines and `PROGRESS n/m` (one per page, like `burst.py`) go to stderr. |
| `src/lib/importers/planswift.js` | The importer: `defaultRoot` / `setDefaultRoot` (jobs folder: saved in the app's `app_settings`, else `.env` `PLANSWIFT_JOBS_DIR`), `browse` / `resolveJob` (jobs under the default or a typed folder), `convert` (runs the converter via `runPythonWithProgress`, 60 min timeout, abortable), `review` (sheet list + counts via a dry-run import), `importPackage({pkgDir, name, number, userId, dryRun})` — creates a new project + one published revision "PlanSwift import", sheets/versions (files copied into `data/projects/<id>/sheets/<sheetId>/v<rev>_planswift*`), take_off_folders, take_off_items, take_off_instances. One DB transaction; copied files removed on failure; logs `planswift_import` to activity_log. |
| `src/lib/importers/index.js` | Importer registry (`{id, label, defaultRoot, setDefaultRoot, browse, resolveJob, convert, review, sheetThumbPath, importPackage}` — see the comment at the top for the contract), staging dir helpers, `cleanupStaleImports()` (run at server start; removes `data/staging/imports/*` older than a day). |
| `src/routes/imports.routes.js` | `/api/imports` — admin only. `GET /sources` (includes each source's `default_root`), `GET /sources/:source/browse?root=&path=` (`root` empty = default), `PUT /sources/:source/default-root {root}` (save; empty clears → `.env`), `POST /sources/:source/convert {root, path}` → `import_id` (queued on `lib/queue.js`), `GET /:importId` (status/progress; review data once ready), `GET /:importId/sheets/:key/thumb`, `POST /:importId/import {name, number}`, `DELETE /:importId` (cancel: kills a running conversion, deletes staging), `GET /` (unfinished imports to resume). |
| `public/import.html` + `js/import.js` | Browse → progress → review page. `?source=planswift[&root=…]` = browse, `?importId=…` = progress/review (so reload/come-back works). |
| `src/scripts/import-planswift.js` | CLI wrapper around `importPackage`: `npm run import-planswift -- "<package>" [--name] [--number] [--user] [--dry-run]`. |

## In-app flow

1. Dashboard → **New Project** → *Import from…* → source picker (only PlanSwift for now;
   sources come from the registry) → Continue.
2. `import.html?source=planswift` lists folders under the **jobs folder**. A folder is a
   **job** if its `Data.xml` has `Type=Job` (only the first 64 KB of each Data.xml is read);
   other folders can be browsed into. Below the chosen folder, paths are relative and anything
   resolving outside it is rejected (400).
   - **Jobs folder** = the default (saved in the app, else `.env`), shown with where it came
     from. **Change folder…** takes any absolute path the *server* can reach (UNC or drive;
     Explorer's quoted "Copy as path" works). "Make this the default jobs folder for everyone"
     saves it to `app_settings` (validated first); unchecked = this visit only (kept in the
     URL as `?root=`). **Back to default** / **Clear saved default** (falls back to `.env`).
   - Typing a single job's own folder shows "This folder is a PlanSwift job" with **Select**,
     for jobs stored outside the usual jobs folder.
   - With no default anywhere, the page opens straight to the folder form.
3. **Select** → server stages into `data/staging/imports/<importId>/` (`meta.json` +
   `package/`) and queues the converter; the page polls and shows `page n of m`. The admin can
   leave — unfinished imports are listed at the top of the browse page.
4. **Review**: editable project name/number (prefilled: number = leading digits of the
   PlanSwift job name, name = job Description, e.g. `5713 Bryden DD` / `Beachwood Bryden DD`),
   counts (sheets/scaled, items, instances, cutouts, shapes skipped — from a dry-run import so
   they match exactly), converter + importer warnings, sheet table with thumbnails.
   **Cancel** deletes the staging folder.
5. **Import** → one transaction → staging deleted → redirect to the new project.

Config: optional `PLANSWIFT_JOBS_DIR` in `.env` (e.g. `\\10.0.30.22\Public\PLANSWIFT\Jobs1`;
forward slashes also work) is the fallback default; admins can set or override it in the app
instead. Either way, the account the server runs as needs read access to the share. Admins
can browse any folder that account can read (folder names + Data.xml job info only).

## PlanSwift local-storage format (what we learned)

- A job is a folder tree; **every node is a folder with a `Data.xml`**:
  `<Item Class="..." Name="..." GUID="..."><Properties><Property Class Name ...>value</Property>...`
- Top level of a job: `Data.xml` (Type=Job, Description), `Pages/`, `Takeoff/`, `AutoLists/`, `Links/`, `RememberValues/`, `JobLock.xml`.
- **Pages**: `Item Class="Page"`, raster is `<ImageGUID>.tiff` in the same folder (ImageGUID = the `Image` property's GUID attr). Seen: 150 DPI, 16-level grayscale, PackBits. Page folders (`Class="Folder"`) group sheets (e.g. GMP / Late Site / Bulletin 02) — often the same sheet appears in several folders.
- **Scale**: page properties `ScaleX`/`ScaleY` = image **pixels per Scale Unit** (e.g. 150 DPI at 1"=30' → 5 px/ft), `Scale Units` (FT), `AutoScaled` label (`1" = 30' 0"`). HammGrid `scale_feet_per_inch = dpi / ScaleX` (FT). Unscaled pages have no ScaleX.
- **Geometry**: property `DigitizerData` = escaped XML `<Points><Point X Y PointType/>...` in **TIFF pixel coords** (origin top-left). Only `PointType="Normal"` seen so far. `(-1,-1)` points = placeholder for a shape never drawn → drop.
- **PageGUID** property on a shape says which page it's on. **Subtract Sections have no PageGUID** — inherit from the nearest ancestor that has one.
- **Take-off tree** (under `Takeoff/`): items are `Area`, `Linear`, `Count`, `Segment` (plus `Item` parts, e.g. earthwork contour rows with Cut/Fill values and no geometry — not imported). Drawn geometry lives in child nodes: `Area Section`, `Linear Section`, `Segment Section`, `Count Section`. `Area Subtract Section` (child of an Area Section) = a **cutout/hole**.
- A `*Section` node with **no DigitizerData** is an abandoned click → ignore (never an item).
- Colors are Delphi TColor ints (`0x00BBGGRR`); `536870911` = none.
- PlanSwift stores `Qty` as a **formula** (`[Takeoff]`), not a number → quantities are recomputed from geometry + page scale.
- Items can nest (e.g. Area parent with child items); importer flattens into a take-off folder named after the parent.
- Also present but not imported: `Dimension` items on pages (annotations), `Overlay` (PlanSwift revision-compare alignment points).

## Mapping to HammGrid

- Take-off instance geometry is stored in viewer render pixels: `px = pdf_pt * min(RENDER_SCALE 2.5, MAX_RENDER_PX 6000 / longestPt)` — **constants mirrored from `public/js/sheet.js`; keep in sync**. PDF points = TIFF px × 72 / dpi.
- Area → `type 'area'`, `geometry {points, holes?}`, quantity = net area (outer − holes), perimeter = outer only (same as `netAreaFeet` / `polygonPerimeterFeet`).
- Linear / Segment → `'linear'`. Count → `'count'`, shape `'circle'`, **one instance (quantity 1) per point**.
- Sheet number/title parsed from the PlanSwift page name (`HILLTOP - C200 - GEOMETRIC PLAN` → `C200` / `GEOMETRIC PLAN`, `A101-1 - FLOOR PLAN` → `A101-1`). Duplicates across page folders get `(<folder>)`, remaining dupes `#2…`. Discipline via `deriveDiscipline` + default map.
- Sheets are image-only PDFs (no text layer), so sheet-link scan / text index find nothing.

## Known limits / open questions

- Linear with Height, assemblies/parts formulas, cost data: numeric Depth/Height/Width/Thickness/Waste %/Multiplier copied to item `properties`; no formulas mapped.
- Only `Normal` point types seen (no arcs yet).
- Folder-per-revision mapping (GMP / Late Site → HammGrid revisions) intentionally NOT done: take-offs attach to sheets, not versions, so they'd float onto the newest version.
- Cancelling a conversion kills the converter process; a conversion interrupted by a server
  restart shows as failed (Cancel and start again). Staging left behind is removed after a day.
- The Import step copies files synchronously inside the transaction (better-sqlite3), so the
  server is busy for a few seconds on a big job. Fine for a rare admin action.
- Cancelling a conversion kills the converter process; a conversion interrupted by a server
  restart shows as failed (Cancel and start again). Staging left behind is removed after a day.
- The Import step copies files synchronously inside the transaction (better-sqlite3), so the
  server is busy for a few seconds on a big job. Fine for a rare admin action.
