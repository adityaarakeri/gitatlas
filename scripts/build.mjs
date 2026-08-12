// Build the publishable dist/: compile packages/*/src to CommonJS, then copy
// the one non-TS runtime asset (the viewer template) into the same layout so
// the __dirname-relative lookup in extractor/src/cli.ts keeps resolving.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = path.join(root, "dist");

fs.rmSync(dist, { recursive: true, force: true });

// Invoke tsc's JS entry directly so the build works the same on Windows.
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
  cwd: root,
  stdio: "inherit",
});

const templateDst = path.join(dist, "packages", "viewer", "template.html");
fs.mkdirSync(path.dirname(templateDst), { recursive: true });
fs.copyFileSync(path.join(root, "packages", "viewer", "template.html"), templateDst);

// the UI catalogs the extractor bakes into every generated map
const localesSrc = path.join(root, "packages", "viewer", "locales");
const localesDst = path.join(dist, "packages", "viewer", "locales");
fs.cpSync(localesSrc, localesDst, { recursive: true });

// A missing file here degrades silently at runtime (the extractor only warns
// when the template is absent), so fail the build loudly instead.
const mustExist = [
  "packages/extractor/src/cli.js",
  "packages/brief/src/cli.js",
  "packages/mcp/src/cli.js",
  "packages/scoper/src/cli.js",
  "packages/site/src/start.js",
  "packages/viewer/template.html",
  "packages/viewer/locales/en.json",
];
const missing = mustExist.filter((rel) => !fs.existsSync(path.join(dist, rel)));
if (missing.length > 0) {
  console.error(`build error: dist/ is missing ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`dist/ built (${mustExist.length} entry points verified)`);
