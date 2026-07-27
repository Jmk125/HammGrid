-- Core data model (see CLAUDE.md)

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  number TEXT,
  location TEXT,
  size TEXT,
  discipline_prefix_map TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source TEXT,
  date TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published')) DEFAULT 'draft',
  created_by INTEGER REFERENCES users(id),
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ocr_regions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  number_box TEXT NOT NULL,
  title_box TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sheets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sheet_number TEXT NOT NULL,
  discipline TEXT,
  current_version_id INTEGER REFERENCES sheet_versions(id),
  scale_feet_per_inch REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, sheet_number)
);

CREATE TABLE IF NOT EXISTS sheet_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  revision_id INTEGER NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  title TEXT,
  pdf_path TEXT NOT NULL,
  thumb_path TEXT,
  preview_path TEXT,
  overlay_path TEXT,
  ocr_confidence REAL,
  extraction_status TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Free-form file explorer for RFIs, submittals, progress photos, or
-- anything else - not a rigid category enum. Folders can nest.
CREATE TABLE IF NOT EXISTS document_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_folder_id INTEGER REFERENCES document_folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Stable entity (like sheets) - current_version_id points at whichever
-- document_versions row is the latest revision, but old revisions stay
-- reachable through document_versions directly.
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  folder_id INTEGER REFERENCES document_folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- ON DELETE SET NULL (unlike sheets.current_version_id, which has no
  -- explicit action) - deleting a folder cascades through documents to
  -- document_versions in one DELETE statement, and without this, SQLite's
  -- cascade processing order can try to delete a document_versions row
  -- while a documents row still points at it via current_version_id,
  -- which is a real FK deadlock (reproduced directly - the identical
  -- sheets/sheet_versions shape only avoids it because it happens to be
  -- triggered via a different path in practice, not because the pattern is
  -- inherently safe).
  current_version_id INTEGER REFERENCES document_versions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Each upload/revision (like sheet_versions) - revision_name/issue_date are
-- optional since the very first upload often doesn't have either yet.
CREATE TABLE IF NOT EXISTS document_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  revision_name TEXT,
  issue_date TEXT,
  pdf_path TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS markups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'published')) DEFAULT 'private',
  type TEXT NOT NULL CHECK (type IN ('line', 'arrow', 'cloud', 'text', 'rect', 'flag')),
  geometry TEXT NOT NULL,
  style TEXT NOT NULL DEFAULT '{}',
  -- ON DELETE SET NULL: deleting a linked document should just unlink it
  -- from any markups (with a warning shown client-side first), not block
  -- the delete outright.
  linked_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A take-off item is a named, colored, project-level running total (e.g. "2x4
-- top plate") built from multiple placed instances. type is locked per item
-- (not per instance) since an item has one unit of measure - mixing would
-- make the total unit-ambiguous.
-- Project-scoped organizational grouping for the Take-offs list page (By
-- Take-off view only - By Sheet already has its own structure). Unlike
-- templates, folders are tied to one project's own item list.
CREATE TABLE IF NOT EXISTS take_off_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS take_off_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('linear', 'perimeter', 'area', 'count')),
  -- Only meaningful (and required at the route level) when type = 'count' -
  -- the marker glyph drawn at each counted click.
  shape TEXT CHECK (shape IN ('square', 'circle', 'triangle', 'diamond')),
  color TEXT NOT NULL,
  -- Optional PlanSwift-style output formula: properties is a JSON array of
  -- {name, value} numeric constants (e.g. "Wall Height" = 8), formula is a
  -- text expression like "takeoff * Wall_Height" evaluated client-side only
  -- (see public/js/takeoffFormula.js) against the raw measured quantity plus
  -- these properties. NULL formula (the common case) means "just show the
  -- raw quantity" - unchanged from before this column existed.
  properties TEXT NOT NULL DEFAULT '[]',
  formula TEXT,
  output_label TEXT,
  -- NULL = "no folder" (the default) - deleting a folder unfiles its items
  -- rather than deleting them.
  folder_id INTEGER REFERENCES take_off_folders(id) ON DELETE SET NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Global (not project_id-scoped) organizational grouping for templates -
-- separate from take_off_folders, which is per-project, since templates
-- themselves are shared across every project (e.g. "Steel", "Masonry").
CREATE TABLE IF NOT EXISTS take_off_template_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Reusable item blueprints (name/type/shape/color/properties/formula) a user
-- can pick from instead of building the same structure from scratch every
-- time - global, not project_id-scoped, since these represent a firm's
-- standardized assemblies (e.g. "8in CMU Wall") reused across every job.
CREATE TABLE IF NOT EXISTS take_off_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('linear', 'perimeter', 'area', 'count')),
  shape TEXT CHECK (shape IN ('square', 'circle', 'triangle', 'diamond')),
  color TEXT NOT NULL,
  properties TEXT NOT NULL DEFAULT '[]',
  formula TEXT,
  output_label TEXT,
  folder_id INTEGER REFERENCES take_off_template_folders(id) ON DELETE SET NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A box take-off's 4 edges are geometrically unambiguous (2-click opposite
-- corners), so an assembly maps them - plus the box's own area - to real
-- take-off items: drawing one box creates one instance per linked slot, all
-- ordinary rows against ordinary items (this table and take_off_assemblies
-- below never appear in reports/exports, they're purely a sheet.js
-- authoring-time orchestrator). Global template - just the 5 slots' default
-- labels, never linked to real items; take_off_assemblies (project-scoped)
-- is what actually gets linked/armed/placed with.
CREATE TABLE IF NOT EXISTS take_off_assembly_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  area_label TEXT NOT NULL DEFAULT 'Area',
  top_label TEXT NOT NULL DEFAULT 'Head',
  bottom_label TEXT NOT NULL DEFAULT 'Sill',
  left_label TEXT NOT NULL DEFAULT 'Left Jamb',
  right_label TEXT NOT NULL DEFAULT 'Right Jamb',
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The live, project-scoped, linkable assembly - shows up in the sheet pane,
-- gets armed for box placement, and gets relinked over time. Flat *_item_id
-- columns rather than a slots child table since there are always exactly
-- these 5 named slots, never a variable number. ON DELETE SET NULL means
-- deleting a linked item just quietly unlinks that slot - no special
-- handling needed, self-healing like every other FK in this schema.
CREATE TABLE IF NOT EXISTS take_off_assemblies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  area_label TEXT NOT NULL DEFAULT 'Area',
  top_label TEXT NOT NULL DEFAULT 'Head',
  bottom_label TEXT NOT NULL DEFAULT 'Sill',
  left_label TEXT NOT NULL DEFAULT 'Left Jamb',
  right_label TEXT NOT NULL DEFAULT 'Right Jamb',
  area_item_id INTEGER REFERENCES take_off_items(id) ON DELETE SET NULL,
  top_item_id INTEGER REFERENCES take_off_items(id) ON DELETE SET NULL,
  bottom_item_id INTEGER REFERENCES take_off_items(id) ON DELETE SET NULL,
  left_item_id INTEGER REFERENCES take_off_items(id) ON DELETE SET NULL,
  right_item_id INTEGER REFERENCES take_off_items(id) ON DELETE SET NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- sheet_id (not sheet_version_id), same as markups above - carries forward
-- automatically across revisions with zero publish-route special-casing.
-- quantity is precomputed client-side at placement time (same math as the
-- measure tool) and never recomputed server-side.
CREATE TABLE IF NOT EXISTS take_off_instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES take_off_items(id) ON DELETE CASCADE,
  sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  geometry TEXT NOT NULL,
  quantity REAL NOT NULL,
  -- Outer-boundary perimeter in feet, area take-offs only (NULL for
  -- linear/perimeter/count) - same "precomputed client-side, never
  -- recomputed server-side" rule as quantity above. Lets a flooring take-off
  -- also answer "how much rubber base does this room need" without a second
  -- manual perimeter trace.
  perimeter REAL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A sheet's scale is normally the single scale_feet_per_inch column on
-- sheets, but a drawing with enlarged detail plans at a different scale can
-- define zones here to override that region - a rectangle (drawing-space,
-- same coordinate system as take_off_instances.geometry points, always
-- axis-aligned since it's drawn via the same 2-click opposite-corners flow
-- as take-off box mode) plus its own scale_feet_per_inch. Anything measured
-- or taken off outside every zone still falls back to the sheet's normal
-- scale.
CREATE TABLE IF NOT EXISTS scale_zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  scale_feet_per_inch REAL NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  width REAL NOT NULL,
  height REAL NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sheet_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  source_version_id INTEGER REFERENCES sheet_versions(id) ON DELETE SET NULL,
  target_sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  rect TEXT NOT NULL,
  label TEXT,
  link_type TEXT NOT NULL CHECK (link_type IN ('auto', 'manual')) DEFAULT 'auto',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Full-text index of each sheet's drawing content (plain text extracted from
-- the current published PDF), keyed by sheet_id as the explicit rowid so it
-- always reflects whichever version is currently published - no separate
-- version-scoping column needed, unlike sheet_links above.
CREATE VIRTUAL TABLE IF NOT EXISTS sheet_text_fts USING fts5(
  body,
  tokenize = 'unicode61 remove_diacritics 2 tokenchars ''./'''
);

CREATE TABLE IF NOT EXISTS shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  name TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('live', 'snapshot')),
  snapshot_revision_id INTEGER REFERENCES revisions(id),
  discipline_filter TEXT,
  expires_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  allow_personal_markups INTEGER NOT NULL DEFAULT 0,
  allow_documents INTEGER NOT NULL DEFAULT 0,
  document_folder_ids TEXT NOT NULL DEFAULT '[]',
  document_ids TEXT NOT NULL DEFAULT '[]',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS share_markups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  share_id INTEGER NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('line', 'arrow', 'cloud', 'text', 'rect')),
  geometry TEXT NOT NULL,
  style TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Infra: express-session store (not part of the domain model)
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL
);

-- Ingest staging: incoming sheets sit here between upload and publish, while
-- the user reviews/corrects OCR results and confirms sheet matching. Rows are
-- deleted once the revision is published (their data lands in sheets/sheet_versions).
CREATE TABLE IF NOT EXISTS staged_sheets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id INTEGER NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  upload_order INTEGER NOT NULL,
  pdf_path TEXT NOT NULL,
  thumb_path TEXT,
  preview_path TEXT,
  page_width_pt REAL,
  page_height_pt REAL,
  region_scope TEXT,
  ocr_number TEXT,
  ocr_number_confidence REAL,
  ocr_title TEXT,
  ocr_title_confidence REAL,
  corrected_number TEXT,
  corrected_title TEXT,
  discipline TEXT,
  match_status TEXT NOT NULL CHECK (match_status IN ('pending', 'new', 'replacement', 'suspicious', 'ignored')) DEFAULT 'pending',
  match_sheet_id INTEGER REFERENCES sheets(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_revisions_project ON revisions(project_id);
CREATE INDEX IF NOT EXISTS idx_ocr_regions_project ON ocr_regions(project_id);
CREATE INDEX IF NOT EXISTS idx_sheets_project ON sheets(project_id);
CREATE INDEX IF NOT EXISTS idx_sheet_versions_sheet ON sheet_versions(sheet_id);
CREATE INDEX IF NOT EXISTS idx_sheet_versions_revision ON sheet_versions(revision_id);
CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id);
CREATE INDEX IF NOT EXISTS idx_document_folders_project ON document_folders(project_id);
CREATE INDEX IF NOT EXISTS idx_document_folders_parent ON document_folders(parent_folder_id);
CREATE INDEX IF NOT EXISTS idx_document_versions_document ON document_versions(document_id);
-- idx_documents_folder is created in db/index.js instead, AFTER the
-- documents-table migration adds the folder_id column - on a pre-existing
-- DB that column doesn't exist yet at the point this file is exec'd.
CREATE INDEX IF NOT EXISTS idx_markups_sheet ON markups(sheet_id);
CREATE INDEX IF NOT EXISTS idx_scale_zones_sheet ON scale_zones(sheet_id);
CREATE INDEX IF NOT EXISTS idx_sheet_links_source ON sheet_links(source_sheet_id);
CREATE INDEX IF NOT EXISTS idx_sheet_links_project ON sheet_links(project_id);
CREATE INDEX IF NOT EXISTS idx_markups_linked_document ON markups(linked_document_id);
CREATE INDEX IF NOT EXISTS idx_shares_project ON shares(project_id);
CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(token);
CREATE INDEX IF NOT EXISTS idx_share_markups_share ON share_markups(share_id);
CREATE INDEX IF NOT EXISTS idx_share_markups_sheet ON share_markups(sheet_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_project ON activity_log(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
CREATE INDEX IF NOT EXISTS idx_staged_sheets_revision ON staged_sheets(revision_id);
CREATE INDEX IF NOT EXISTS idx_ocr_regions_scope ON ocr_regions(project_id, scope);
CREATE INDEX IF NOT EXISTS idx_take_off_items_project ON take_off_items(project_id);
CREATE INDEX IF NOT EXISTS idx_take_off_instances_item ON take_off_instances(item_id);
CREATE INDEX IF NOT EXISTS idx_take_off_instances_sheet ON take_off_instances(sheet_id);
