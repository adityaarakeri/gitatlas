# The Homebrew formula, kept here so it is reviewed alongside the code it
# installs. The tap (adityaarakeri/homebrew-gitatlas) serves the generated copy:
# the release workflow renders this file with the new `url` and `sha256` after a
# successful npm publish, so everything except those two lines is edited here.
#
# Refresh the values below after a release with:
#   node scripts/brew-formula.mjs --version <x.y.z> --sha256 <hex>
class Gitatlas < Formula
  desc "Multi-repo architecture maps you can zoom into"
  homepage "https://github.com/adityaarakeri/gitatlas"
  url "https://registry.npmjs.org/gitatlas/-/gitatlas-0.10.0.tgz"
  sha256 "3b8e20b1d19298d0be6775164ee38caa3bbec977631229ff8d9d80a136ca9a5b"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    # Repo discovery only looks for a .git marker, so an empty directory is
    # enough to make this look like a repository worth mapping.
    (testpath/"repo/.git").mkpath
    (testpath/"repo/src").mkpath
    (testpath/"repo/src/a.ts").write "export function hello() { return 1 }\n"

    system bin/"gitatlas", "extract", testpath/"repo", "--out", testpath/"map"
    assert_path_exists testpath/"map/group.json"
    assert_path_exists testpath/"map/index.html"

    # The viewer is only self-contained if the graph was baked into the HTML and
    # d3 was vendored instead of left as a CDN script tag. Both are resolved
    # relative to the installed package, which is exactly what a formula moves.
    html = (testpath/"map/index.html").read
    refute_match "/*__DATA__*/null", html
    refute_match "cdnjs.cloudflare.com", html

    # Freshness re-walks the source and compares fingerprints: exit 0 means the
    # map it just wrote agrees with the tree it read.
    system bin/"gitatlas", "check", testpath/"repo", "--out", testpath/"map"

    assert_match "Usage: gitatlas", shell_output("#{bin}/gitatlas --help")
  end
end
