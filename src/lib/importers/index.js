// Registry of "New project -> Import from..." sources. Each importer module
// owns its own steps; routes/imports.routes.js only drives them:
//
//   id, label            shown in the source picker
//   isConfigured()       false -> listed but disabled (e.g. its root folder env var is unset)
//   browse(relPath)      -> { path, parent, entries: [{ name, path, kind: 'job'|'folder', ... }] }
//   resolveJob(relPath)  -> { abs, rel, name, description }; throws (err.status 400) if not a job
//   convert({ jobDir, outDir, onProgress, signal })  -> Promise; writes a package into outDir;
//                        must stop (reject) when signal aborts
//   review(pkgDir, userId)  -> { job, defaults: { name, number }, sheets, stats, warnings }
//   sheetThumbPath(pkgDir, key)  -> file path or null
//   importPackage({ pkgDir, name, number, userId, dryRun })  -> { projectId, projectName, stats, warnings }
//
// To add a source: write src/lib/importers/<source>.js with that shape and
// list it here.
const fs = require('fs');
const path = require('path');
const config = require('../../config');

const importers = [require('./planswift')];

function getImporter(id) {
  return importers.find((i) => i.id === id) || null;
}

function listImporters() {
  return importers.map((i) => ({ id: i.id, label: i.label, configured: i.isConfigured() }));
}

// Conversions run into data/staging/imports/<importId>/ (meta.json +
// package/) and are deleted on import, on cancel, or - if the user just
// walked away - by cleanupStaleImports() at the next server start.
const IMPORTS_STAGING_DIR = path.join(config.storageDir, 'staging', 'imports');
const STALE_IMPORT_MS = 24 * 60 * 60 * 1000;

function importDir(importId) {
  // importIds are server-generated UUIDs; reject anything else so an id
  // can never be used to reach outside the staging folder.
  if (!/^[0-9a-f-]{36}$/i.test(String(importId))) return null;
  return path.join(IMPORTS_STAGING_DIR, importId);
}

function cleanupStaleImports(maxAgeMs = STALE_IMPORT_MS) {
  let names;
  try {
    names = fs.readdirSync(IMPORTS_STAGING_DIR);
  } catch (err) {
    return 0; // nothing staged yet
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const name of names) {
    const dir = path.join(IMPORTS_STAGING_DIR, name);
    try {
      if (fs.statSync(dir).mtimeMs < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    } catch (err) {
      console.error(`Could not clean up stale import ${dir}:`, err.message);
    }
  }
  return removed;
}

module.exports = { getImporter, listImporters, importDir, cleanupStaleImports, IMPORTS_STAGING_DIR };
