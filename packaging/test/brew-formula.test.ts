/**
 * Packaging tests: the Homebrew formula and the renderer that bumps it.
 *
 * The renderer is the dangerous half. A formula carrying a new sha256 against
 * an old url is an install that dies on a checksum mismatch, and it would ship
 * to every brew user at once, so the substitutions have to be all-or-nothing.
 * The formula assertions are drift guards: they encode the Homebrew audit rules
 * and the two facts the install depends on (a pinned node, and std_npm_args,
 * which is what keeps the prepack build hook from firing on a tarball that does
 * not contain scripts/build.mjs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SCRIPT = path.join(ROOT, "scripts", "brew-formula.mjs");
const FORMULA = path.join(ROOT, "packaging", "homebrew", "gitatlas.rb");
const DIGEST = "0123456789abcdef".repeat(4);

function render(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });
}

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitatlas-brew-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const source = fs.readFileSync(FORMULA, "utf8");

test("brew-formula: a bump rewrites the url and the digest, and nothing else", () => {
  const { dir, cleanup } = tempDir();
  try {
    const out = path.join(dir, "gitatlas.rb");
    const r = render("--version", "9.9.9", "--sha256", DIGEST, "--out", out);
    assert.equal(r.status, 0, r.stderr);

    const rendered = fs.readFileSync(out, "utf8");
    assert.match(rendered, /^ *url "https:\/\/registry\.npmjs\.org\/gitatlas\/-\/gitatlas-9\.9\.9\.tgz"$/m);
    assert.match(rendered, new RegExp(`^ *sha256 "${DIGEST}"$`, "m"));

    // Line-for-line: a renderer that reflowed or dropped anything else would
    // still pass the two assertions above.
    const before = source.split("\n");
    const after = rendered.split("\n");
    assert.equal(after.length, before.length, "line count changed");
    const changed = before.map((line, i) => (line === after[i] ? -1 : i)).filter((i) => i !== -1);
    assert.equal(changed.length, 2, `expected 2 changed lines, got ${changed.length}`);

    assert.equal(fs.readFileSync(FORMULA, "utf8"), source, "--out must not touch the source");
  } finally {
    cleanup();
  }
});

test("brew-formula: --out is optional and the bump lands in place", () => {
  const { dir, cleanup } = tempDir();
  try {
    const copy = path.join(dir, "gitatlas.rb");
    fs.writeFileSync(copy, source);
    const r = render("--version", "1.2.3", "--sha256", DIGEST, "--formula", copy);
    assert.equal(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(copy, "utf8"), /gitatlas-1\.2\.3\.tgz/);
  } finally {
    cleanup();
  }
});

test("brew-formula: prerelease versions are versions", () => {
  const { dir, cleanup } = tempDir();
  try {
    const out = path.join(dir, "gitatlas.rb");
    const r = render("--version", "0.12.0-rc.1", "--sha256", DIGEST, "--out", out);
    assert.equal(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(out, "utf8"), /gitatlas-0\.12\.0-rc\.1\.tgz/);
  } finally {
    cleanup();
  }
});

test("brew-formula: bad arguments are refused before anything is written", () => {
  const { dir, cleanup } = tempDir();
  try {
    const out = path.join(dir, "gitatlas.rb");
    const cases: Array<[string[], RegExp]> = [
      // the npm tarball name is the exact version string, so a leading v is a 404
      [["--version", "v1.2.3", "--sha256", DIGEST], /not a version/],
      [["--version", "1.2", "--sha256", DIGEST], /not a version/],
      [["--version", "1.2.3", "--sha256", "deadbeef"], /not a hex sha256/],
      // Homebrew writes digests lowercase; an uppercase one would not match
      [["--version", "1.2.3", "--sha256", DIGEST.toUpperCase()], /not a hex sha256/],
      [["--version", "1.2.3"], /--sha256 is required/],
      [["--sha256", DIGEST], /--version is required/],
      [["--version", "--sha256", DIGEST], /--version needs a value/],
      [["--version", "1.2.3", "--sha256", DIGEST, "--formula", "nope.rb"], /no formula at/],
    ];
    for (const [args, message] of cases) {
      const r = render(...args, "--out", out);
      assert.equal(r.status, 1, `expected a refusal for ${args.join(" ")}`);
      assert.match(r.stderr, message);
      assert.equal(fs.existsSync(out), false, `${args.join(" ")} wrote a formula anyway`);
    }
  } finally {
    cleanup();
  }
});

test("brew-formula: a substitution that does not hit exactly once writes nothing", () => {
  const { dir, cleanup } = tempDir();
  try {
    const out = path.join(dir, "gitatlas.rb");
    const noUrl = path.join(dir, "no-url.rb");
    fs.writeFileSync(noUrl, source.replace(/^ *url .*$/m, "  # url went missing"));
    let r = render("--version", "1.2.3", "--sha256", DIGEST, "--formula", noUrl, "--out", out);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no url line/);
    assert.equal(fs.existsSync(out), false);

    const twoDigests = path.join(dir, "two-digests.rb");
    fs.writeFileSync(twoDigests, source.replace(/^( *)(sha256 ".*")$/m, "$1$2\n$1$2"));
    r = render("--version", "1.2.3", "--sha256", DIGEST, "--formula", twoDigests, "--out", out);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /2 sha256 lines/);
    assert.equal(fs.existsSync(out), false);
  } finally {
    cleanup();
  }
});

test("formula: satisfies the Homebrew audit rules it cannot be run against here", () => {
  assert.match(source, /^class Gitatlas < Formula$/m, "the class name has to match the file name");

  const desc = /^ *desc "(.+)"$/m.exec(source);
  assert.ok(desc, "no desc");
  assert.ok(desc[1].length <= 80, `desc is ${desc[1].length} chars, the cap is 80`);
  assert.doesNotMatch(desc[1], /^(A|An|The) /, "desc must not start with an article");
  assert.doesNotMatch(desc[1], /gitatlas/i, "desc must not repeat the formula name");

  // Homebrew will not use the reader's own node, and the install would be a
  // symlink into a version we never tested against if it did.
  assert.match(source, /^ *depends_on "node"$/m);

  // std_npm_args passes --ignore-scripts to its npm pack and npm install. A
  // hand-rolled npm install here would fire prepack, which runs a build script
  // the published tarball does not carry.
  assert.match(source, /system "npm", "install", \*std_npm_args/);
  assert.match(source, /bin\.install_symlink/);
});

test("formula: url, digest, and metadata agree with the package", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    license: string;
    repository: { url: string };
  };

  assert.equal((source.match(/^ *url ".*"$/gm) ?? []).length, 1);
  assert.equal((source.match(/^ *sha256 ".*"$/gm) ?? []).length, 1);

  // The tarball comes from the registry rather than a GitHub archive, which is
  // what lets brew install the same bytes npm users get, dist/ included.
  const url = /^ *url "(.+)"$/m.exec(source);
  assert.ok(url, "no url");
  assert.match(url[1], /^https:\/\/registry\.npmjs\.org\/gitatlas\/-\/gitatlas-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz$/);

  const sha = /^ *sha256 "(.+)"$/m.exec(source);
  assert.ok(sha, "no sha256");
  assert.match(sha[1], /^[0-9a-f]{64}$/);

  assert.match(source, new RegExp(`^ *license "${pkg.license}"$`, "m"));

  const homepage = pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
  assert.match(source, new RegExp(`^ *homepage "${homepage.replace(/[.]/g, "\\.")}"$`, "m"));
});
