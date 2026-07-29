# gitatlas playground server. Build: docker build -t gitatlas-site .
# Run:   docker run -p 8130:8130 -v gitatlas-cache:/data gitatlas-site
# Node 22 on purpose: no --liftoff-only dance needed (bin/gitatlas.js would
# handle it anyway). git is the only system dependency.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# /data is the map cache: mount a volume there to keep maps across restarts,
# or don't, and the cache simply rebuilds. It is a cache, not state.
ENV PORT=8130 \
    GITATLAS_SITE_CACHE_DIR=/data

RUN install -d -o node -g node /data
VOLUME ["/data"]

USER node
EXPOSE 8130
CMD ["node", "bin/gitatlas.js", "site"]
