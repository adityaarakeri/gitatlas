// Run the suite in one process. Node's default 'process' isolation spawns a
// child per test file, and those children compile the tree-sitter grammars
// without --liftoff-only, so they die on Node 24 (nodejs/node#63421).
//
// The flag that turns isolation off was spelled --experimental-test-isolation
// in Node 22 and --test-isolation in Node 24. Passing the spelling the running
// node does not know is a hard startup error ("node: bad option"), which took
// the whole suite down on the Node 22 CI leg, so ask node which one it accepts
// instead of hardcoding either.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const TEST_GLOBS = [
  "packages/scoper/test/*.test.ts",
  "packages/extractor/test/*.test.ts",
  "packages/analysis/test/*.test.ts",
  "packages/site/test/*.test.ts",
  "packages/brief/test/*.test.ts",
  "packages/mcp/test/*.test.ts",
  "packaging/test/*.test.ts",
];

const accepts = (flag) =>
  spawnSync(process.execPath, [flag, "-e", ""], { stdio: "ignore" }).status === 0;

const isolation = ["--test-isolation=none", "--experimental-test-isolation=none"].find(accepts);
if (!isolation) {
  console.error(
    `test error: node ${process.version} has no test-isolation flag; the suite needs Node 22.8 or newer`,
  );
  process.exit(1);
}

const flags = [];
// Same guard as bin/gitatlas.js: only Node 24+ needs the V8 workaround.
if (parseInt(process.versions.node, 10) >= 24) flags.push("--liftoff-only");
flags.push("--test", isolation, "--import", "tsx");

// `npm test -- packages/brief/test/brief.test.ts` runs just that file.
const patterns = process.argv.slice(2);
const run = spawnSync(process.execPath, [...flags, ...(patterns.length > 0 ? patterns : TEST_GLOBS)], {
  cwd: root,
  stdio: "inherit",
});
if (run.error) throw run.error;
process.exit(run.status ?? 1);
