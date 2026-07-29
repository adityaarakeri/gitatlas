/**
 * HTML for the playground's three pages: landing, building, error.
 * Pure string builders, no I/O. Shares the viewer's optical-instrument
 * identity: barrel (dark) and ground glass (light), etched type, index red.
 */
import { escapeHtml, BuildState } from "./service.js";

export interface RecentMap {
  owner: string;
  repo: string;
  extractedAt: string;
}

const SHELL_CSS = `
  :root[data-theme="dark"] {
    --canvas: #17181A; --plate: #1F2023;
    --etch: #EFEDE6; --etch-dim: #8E8C84; --etch-faint: #55534D;
    --index: #E2492F; --coating: #5BC0C9;
    --grid: rgba(239,237,230,0.045);
  }
  :root[data-theme="light"] {
    --canvas: #E7E9E6; --plate: #F4F5F3;
    --etch: #23241F; --etch-dim: #6E7069; --etch-faint: #B4B6B0;
    --index: #C53A22; --coating: #20868F;
    --grid: rgba(35,36,31,0.06);
  }
  :root {
    --mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --disp: "Archivo", system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--canvas); color: var(--etch); font-family: var(--mono);
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background-image: linear-gradient(var(--grid) 1px, transparent 1px),
      linear-gradient(90deg, var(--grid) 1px, transparent 1px);
    background-size: 28px 28px; padding: 24px;
  }
  main { width: 100%; max-width: 560px; background: var(--plate);
    border: 1px solid var(--etch-faint); padding: 32px; }
  h1 { font-family: var(--disp); font-size: 20px; font-weight: 700;
    letter-spacing: 0.02em; }
  h1 .dot { color: var(--index); }
  .tagline { color: var(--etch-dim); font-size: 12px; margin-top: 6px; line-height: 1.5; }
  .eyebrow { font-family: var(--disp); font-size: 10px; font-weight: 600;
    letter-spacing: 0.14em; text-transform: uppercase; color: var(--etch-dim);
    margin: 28px 0 10px; }
  form { display: flex; gap: 8px; margin-top: 18px; }
  input[type="text"] {
    flex: 1; background: var(--canvas); border: 1px solid var(--etch-faint);
    color: var(--etch); font-family: var(--mono); font-size: 13px; padding: 11px 12px;
    min-width: 0;
  }
  input[type="text"]::placeholder { color: var(--etch-faint); }
  button {
    background: var(--index); color: var(--plate); border: none;
    font-family: var(--disp); font-size: 12px; font-weight: 700;
    letter-spacing: 0.08em; text-transform: uppercase; padding: 11px 18px;
    cursor: pointer;
  }
  a { color: var(--coating); text-decoration: none; }
  a:hover { text-decoration: underline; }
  :focus-visible { outline: 2px solid var(--coating); outline-offset: 2px; }
  .hint { color: var(--etch-faint); font-size: 11px; margin-top: 10px; }
  .err { color: var(--index); font-size: 12px; margin-top: 10px; min-height: 1em; }
  ul.recent { list-style: none; }
  ul.recent li { border-top: 1px solid var(--grid); }
  ul.recent a { display: flex; justify-content: space-between; gap: 12px;
    padding: 9px 2px; font-size: 12px; color: var(--etch); }
  ul.recent a:hover { color: var(--coating); text-decoration: none; }
  ul.recent .when { color: var(--etch-faint); white-space: nowrap; }
  .status-line { display: flex; align-items: center; gap: 12px; margin-top: 22px;
    font-size: 13px; }
  .lens { width: 14px; height: 14px; border: 2px solid var(--coating);
    border-radius: 50%; border-top-color: transparent;
    animation: spin 1.1s linear infinite; flex: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .lens { animation: none; border-top-color: var(--coating); }
  }
  .detail { color: var(--etch-dim); font-size: 12px; margin-top: 12px; line-height: 1.6; }
  footer { margin-top: 28px; color: var(--etch-faint); font-size: 11px; line-height: 1.6; }
`;

function shell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<script>
  document.documentElement.setAttribute("data-theme",
    matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
</script>
<style>${SHELL_CSS}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

export function landingPage(recent: RecentMap[]): string {
  const rows = recent.map((r) => {
    const full = `${escapeHtml(r.owner)}/${escapeHtml(r.repo)}`;
    const when = escapeHtml(r.extractedAt.slice(0, 10));
    return `    <li><a href="/gh/${full}">${full}<span class="when">${when}</span></a></li>`;
  }).join("\n");
  const recentBlock = recent.length
    ? `<div class="eyebrow">Recent maps</div>\n  <ul class="recent">\n${rows}\n  </ul>`
    : "";
  return shell("gitatlas — map any public repo", `
  <h1>gitatlas<span class="dot">.</span></h1>
  <p class="tagline">Paste a public GitHub repo. Get a zoomable architecture map:
  repo, then modules, then every class and function, with real import and call edges.</p>
  <form id="f">
    <input type="text" id="q" placeholder="github.com/owner/repo" autofocus
      aria-label="GitHub repository" autocomplete="off" spellcheck="false">
    <button type="submit">Map it</button>
  </form>
  <p class="err" id="err" role="alert" aria-live="polite"></p>
  <p class="hint">Also accepts owner/repo or a full URL. Public repos only.</p>
  ${recentBlock}
  <footer>Maps are built on this server from a shallow clone, cached by commit,
  and rebuilt when the repo moves. For private repos, run gitatlas locally:
  your code never leaves your machine.</footer>
  <script>
  document.getElementById("f").addEventListener("submit", function (e) {
    e.preventDefault();
    var s = document.getElementById("q").value.trim();
    s = s.replace(/^git@github\\.com:/i, "").replace(/^[a-z]+:\\/\\//i, "")
         .replace(/^www\\./i, "").replace(/^github\\.com[\\/:]/i, "");
    var parts = s.split("/").filter(Boolean);
    var owner = parts[0] || "", repo = (parts[1] || "").replace(/\\.git$/i, "");
    if (/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)
        && /^[A-Za-z0-9._-]{1,100}$/.test(repo) && repo !== "." && repo !== "..") {
      location.href = "/gh/" + owner + "/" + repo;
    } else {
      document.getElementById("err").textContent =
        "That does not look like a GitHub repo. Try owner/repo.";
    }
  });
  </script>`);
}

export function buildingPage(owner: string, repo: string, state: BuildState, position: number): string {
  const full = `${escapeHtml(owner)}/${escapeHtml(repo)}`;
  const label = state === "queued"
    ? `queued${position > 0 ? ` (position ${position})` : ""}`
    : "extracting";
  return shell(`gitatlas — mapping ${owner}/${repo}`, `
  <h1>gitatlas<span class="dot">.</span></h1>
  <p class="tagline">Mapping <strong>${full}</strong></p>
  <div class="status-line"><span class="lens" aria-hidden="true"></span>
    <span id="state" role="status" aria-live="polite">${escapeHtml(label)}</span></div>
  <p class="detail">Shallow clone, one extraction pass, then the map opens by itself.
  Small repos take seconds; large ones a few minutes. Leave this tab open.</p>
  <footer><a href="/">&larr; map a different repo</a></footer>
  <script>
  (function poll() {
    fetch(location.pathname.replace(/\\/$/, "") + "/status")
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (s.state === "ready") { location.reload(); return; }
        if (s.state === "error") { location.reload(); return; }
        var label = s.state === "queued"
          ? "queued" + (s.position > 0 ? " (position " + s.position + ")" : "")
          : "extracting";
        document.getElementById("state").textContent = label;
        setTimeout(poll, 2500);
      })
      .catch(function () { setTimeout(poll, 5000); });
  })();
  </script>`);
}

export function errorPage(owner: string, repo: string, message: string): string {
  const full = `${escapeHtml(owner)}/${escapeHtml(repo)}`;
  return shell(`gitatlas — ${owner}/${repo}`, `
  <h1>gitatlas<span class="dot">.</span></h1>
  <p class="tagline">Could not map <strong>${full}</strong></p>
  <p class="err" role="alert">${escapeHtml(message)}</p>
  <p class="detail">If the repo is private, the playground cannot see it, and that is
  by design. Run gitatlas locally instead: one command, and your code stays on
  your machine.</p>
  <footer><a href="/">&larr; try another repo</a></footer>`);
}

export function badRequestPage(message: string): string {
  return shell("gitatlas — bad request", `
  <h1>gitatlas<span class="dot">.</span></h1>
  <p class="err" role="alert">${escapeHtml(message)}</p>
  <footer><a href="/">&larr; back</a></footer>`);
}
