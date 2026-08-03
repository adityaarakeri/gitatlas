# Hosted playground

`npm run site` starts a small server that maps any public GitHub repo on demand: visit `/gh/owner/repo` (or paste a URL into the landing page) and it shallow-clones the repo, runs the extractor in an isolated child process, and serves the generated map. Maps are cached by commit SHA and rebuilt only when the repo's HEAD moves.

```bash
npm run site                       # http://localhost:8130
# then open http://localhost:8130/gh/expressjs/express
```

This is for public repos and demo deployments. The local CLI remains the real product: the playground necessarily processes submitted code on the server, so never point people at it for private code.

## Configuration

Environment variables, all optional:

| Variable | Default | Range | Effect |
| --- | --- | --- | --- |
| `PORT` | 8130 | 1-65535 | Listen port |
| `GITATLAS_SITE_CACHE_DIR` | `.gitatlas-site` | | Cache location |
| `GITATLAS_SITE_MAX_REPO_MB` | 200 | 1-10240 | Stop clone workspaces that grow beyond this |
| `GITATLAS_SITE_CACHE_MB` | 2048 | 1-1048576 | Total cache cap, oldest maps evicted first |
| `GITATLAS_SITE_CONCURRENCY` | 1 | 1-64 | Parallel builds |
| `GITATLAS_SITE_MAX_ACTIVE_JOBS` | 8 | 1-1024 | Combined lookup, running, and queued work cap. Never lower than concurrency |
| `GITATLAS_SITE_REQUESTS_PER_MINUTE` | 30 | 1-100000 | Global new-map request limit |
| `GITATLAS_SITE_CLONE_TIMEOUT_S` | 120 | 1-86400 | Clone timeout |
| `GITATLAS_SITE_EXTRACT_TIMEOUT_S` | 300 | 1-86400 | Extract timeout |
| `GITATLAS_SITE_HEAD_TTL_S` | 300 | 1-86400 | How long a resolved HEAD SHA is trusted before ls-remote runs again |

The server needs `git` on PATH and outbound access to github.com. Nothing else: no database, no API keys, no GitHub token (existence checks and clones go through plain `git ls-remote` and `git clone`, which have no API rate limits).

## Deploying it cheaply

The repo ships three ready-made paths, cheapest first:

- **Render free tier, $0.** `render.yaml` is a one-click Blueprint: in the Render dashboard choose New, then Blueprint, and point it at your fork. The free instance sleeps after about 15 idle minutes (the next visitor waits out a cold start), and its disk is ephemeral, so the map cache rebuilds after restarts. Fine for a public demo. The blueprint lowers the repo cap to 50 MB to stay inside the 512 MB of RAM.
- **Fly.io scale-to-zero, roughly $2 to $3 a month.** `fly.toml` plus the `Dockerfile`: run `fly launch --copy-config`, then `fly deploy`. Machines stop when idle and wake in seconds rather than a minute. Create a small volume and uncomment the `[mounts]` block if you want maps to survive cold starts.
- **A small VPS, roughly $4 a month, or Oracle Cloud's Always Free VM, $0.** Anywhere Node 22 and git exist: `npm ci && npm run site` behind any reverse proxy, or `docker build -t gitatlas-site . && docker run -p 8130:8130 -v gitatlas-cache:/data gitatlas-site`. Always warm, persistent cache, no sleep. Oracle's free ARM VM (4 cores, 24 GB) is the most machine for zero dollars if you do not mind the setup.

Also $0: an always-on machine you already own plus a Cloudflare Tunnel.

Two free-tier notes: extraction is the memory-heavy step, so on 512 MB instances keep `GITATLAS_SITE_MAX_REPO_MB` at 50 or lower; and every build costs real CPU, so tune the active-job and request limits before promoting a playground URL widely.

The `Dockerfile` uses Node 22 (no wasm flag dance), installs git, runs as the unprivileged built-in `node` user, and points the cache at the writable `/data` volume. Named and anonymous volumes work without extra setup. Bind mounts must be writable by UID 1000. The cache is a cache: losing it costs a rebuild, never data.
