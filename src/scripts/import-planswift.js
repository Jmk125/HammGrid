// Import a PlanSwift job (converted by pyproc/planswift2hammgrid.py) as a brand-new
// HammGrid project. The import itself lives in src/lib/importers/planswift.js
// (shared with the in-app New project -> Import from PlanSwift flow); this is
// just the command-line wrapper.
//
// Usage (from the drawing-app folder; server may keep running - WAL mode):
//   npm run import-planswift -- "<package folder>" [--name "Project Name"]
//        [--number 1234] [--user jkillion] [--dry-run]
//
// The package folder is the *_hammgrid output of planswift2hammgrid.py
// (hammgrid-import.json + sheets/*.pdf|_thumb.webp|_preview.webp).
const db = require('../db');
const { importPackage } = require('../lib/importers/planswift');

function parseArgs(argv) {
  const args = { pkg: null, name: null, number: null, user: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const needValue = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value after it (use quotes if it has spaces)`);
      return v;
    };
    if (a === '--name') args.name = needValue();
    else if (a === '--number') args.number = needValue();
    else if (a === '--user') args.user = needValue();
    else if (a === '--dry-run') args.dryRun = true;
    else if (!args.pkg) args.pkg = a;
    else throw new Error(`Unexpected argument: ${a}`);
  }
  if (!args.pkg) {
    throw new Error('Usage: npm run import-planswift -- "<package folder>" [--name "Project"] [--number N] [--user username] [--dry-run]');
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const user = args.user
    ? db.prepare('SELECT id, name FROM users WHERE username = ?').get(args.user)
    : db.prepare("SELECT id, name FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  if (!user) throw new Error(args.user ? `No user "${args.user}"` : 'No admin user found (run create-admin first)');

  const { projectId, projectName, stats, warnings } = importPackage({
    pkgDir: args.pkg,
    name: args.name,
    number: args.number,
    userId: user.id,
    dryRun: args.dryRun,
  });

  if (args.dryRun) console.log('DRY RUN - nothing was written.');
  for (const w of warnings) console.log(`  warning: ${w}`);
  console.log(
    `${args.dryRun ? 'Would import' : 'Imported'} "${projectName}"${args.dryRun ? '' : ` as project ${projectId}`}: ` +
      `${stats.sheets} sheets (${stats.scaled} scaled), ${stats.items} take-off items, ${stats.instances} instances, ` +
      `${stats.folders} folders, ${stats.cutouts} cutouts${stats.skippedShapes ? `, ${stats.skippedShapes} shapes skipped` : ''}.`
  );
}

try {
  main();
} catch (err) {
  console.error(`Import failed: ${err.message}`);
  process.exit(1);
}
