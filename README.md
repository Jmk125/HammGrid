# HammGrid

Internal drawing management tool for a construction CMR firm (K-12 school
projects, Ohio). Sheets are first-class entities with full version history;
publishing a revision is atomic and the field always sees the current set by
default. Built as a single responsive web app (PWA) that serves both PC
(upload/admin workflows) and iPad (viewing/markup) from one codebase.

See [CLAUDE.md](CLAUDE.md) for the full product spec, data model, and
build-order rationale.

## Stack

- **Server:** Node.js / Express / SQLite (via `better-sqlite3`)
- **PDF processing:** Python sidecar scripts (`pyproc/`) using PyMuPDF +
  Tesseract OCR for bursting multi-page sets, generating thumbnails/previews,
  title-block OCR, and revision overlays
- **Client:** vanilla JS (ES modules, no build step), PDF.js for rendering,
  an SVG overlay layer for markups/take-offs

## Prerequisites

- **Node.js** (any current LTS)
- **Python 3** with the packages in `requirements.txt`:
  ```bash
  pip install -r requirements.txt
  ```
- **Tesseract OCR** installed as a system binary (not a pip package -
  `pytesseract` just calls out to it). On Windows, install it separately and
  either add it to `PATH` or point `TESSERACT_PATH` (below) at the `.exe`.
  On Debian/Ubuntu/Raspberry Pi OS: `apt install tesseract-ocr`.

Poppler is **not** required - PyMuPDF handles all PDF rasterization.

## Setup

1. Install Node dependencies:
   ```bash
   npm install
   ```
2. Install Python dependencies (see Prerequisites above).
3. Copy the env template and fill it in:
   ```bash
   cp .env.example .env
   ```
   - `SESSION_SECRET` - any random string (used to sign session cookies)
   - `DB_PATH` - where the SQLite file lives (default `./data/app.db`)
   - `STORAGE_DIR` - where uploaded PDFs/thumbnails/previews are stored
   - `PYTHON_PATH` / `TESSERACT_PATH` - just `python` / `tesseract` if both
     are already on `PATH`; otherwise a full path to each executable
4. Create the first admin user (the database and schema are created
   automatically on first run - there's no seed data otherwise):
   ```bash
   npm run create-admin -- <username> "<display name>" <password>
   ```
5. Start the server:
   ```bash
   npm start        # single run
   npm run dev       # auto-restarts on file changes (nodemon)
   ```
   The port comes from `.env`'s `PORT`. Log in with the admin account from
   step 4, then create a project from the dashboard.

## Notes

- `data/` (the SQLite DB and all uploaded files) and `.env` are gitignored -
  a fresh clone starts empty by design.
- The Pi deployment target is RAM-constrained; the ingest pipeline is
  sequential/queue-based rather than parallel. Heavy ingest jobs (large
  multi-hundred-sheet bursts) can be run from a Windows box instead if the
  Pi struggles.
- `src/scripts/` also has `set-password.js` (reset a user's password) and
  `fix-path-separators.js` (normalize stored file paths after moving the
  `data/` directory between OSes).
