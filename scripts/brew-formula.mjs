// Point the Homebrew formula at a published npm tarball: rewrite the `url` and
// `sha256` lines, leave every other line alone. The release workflow runs this
// against the tap checkout after `npm publish` succeeds; run it by hand to
// refresh the copy in this repo.
//
//   node scripts/brew-formula.mjs --version 0.11.0 --sha256 <hex>
//   node scripts/brew-formula.mjs --version 0.11.0 --sha256 <hex> --out tap/Formula/gitatlas.rb
//
// A formula carrying a new sha256 against an old url is an install that fails
// with a checksum mismatch, so every substitution here has to hit exactly once
// or the script refuses to write anything.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_FORMULA = path.join(root, "packaging", "homebrew", "gitatlas.rb");

const USAGE =
  "Usage: node scripts/brew-formula.mjs --version <x.y.z> --sha256 <hex> " +
  "[--formula <path>] [--out <path>]";

function fail(message) {
  console.error(`brew-formula error: ${message}`);
  console.error(USAGE);
  process.exit(1);
}

function flag(name) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return undefined;
  const value = process.argv[at + 1];
  if (value === undefined || value.startsWith("--")) fail(`--${name} needs a value`);
  return value;
}

const version = flag("version");
const sha256 = flag("sha256");
if (!version) fail("--version is required");
if (!sha256) fail("--sha256 is required");
// npm tarball names are the exact version string, so a malformed one here
// becomes a 404 at install time rather than an error now.
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail(`not a version: ${version}`);
if (!/^[0-9a-f]{64}$/.test(sha256)) fail(`not a hex sha256 digest: ${sha256}`);

const formulaPath = flag("formula") ?? DEFAULT_FORMULA;
const outPath = flag("out") ?? formulaPath;
if (!fs.existsSync(formulaPath)) fail(`no formula at ${formulaPath}`);

const source = fs.readFileSync(formulaPath, "utf8");

function replaceOnce(text, pattern, replacement, label) {
  const hits = text.match(pattern);
  if (hits === null) fail(`no ${label} line in ${formulaPath}`);
  if (hits.length > 1) fail(`${hits.length} ${label} lines in ${formulaPath}, expected 1`);
  return text.replace(pattern, replacement);
}

const url = `https://registry.npmjs.org/gitatlas/-/gitatlas-${version}.tgz`;
let rendered = replaceOnce(
  source,
  /^(\s*)url "https:\/\/registry\.npmjs\.org\/gitatlas\/-\/gitatlas-[^"]+\.tgz"$/gm,
  `$1url "${url}"`,
  "url",
);
rendered = replaceOnce(
  rendered,
  /^(\s*)sha256 "[0-9a-f]{64}"$/gm,
  `$1sha256 "${sha256}"`,
  "sha256",
);

if (!rendered.includes(`"${url}"`) || !rendered.includes(`"${sha256}"`)) {
  fail("substitution produced a formula without the new url and digest");
}

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, rendered);
console.log(`${outPath}: gitatlas ${version} (${sha256.slice(0, 12)}...)`);
