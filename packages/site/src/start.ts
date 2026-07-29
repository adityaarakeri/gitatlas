import * as path from "node:path";
import { createPlayground } from "./server.js";
import { parseSiteConfig } from "./service.js";

const config = parseSiteConfig(process.env);
const cacheDir = path.resolve(config.cacheDir);
const server = createPlayground({ config });

server.listen(config.port, () => {
  console.log(`gitatlas playground on http://localhost:${config.port}`);
  console.log(`cache: ${cacheDir} (repo cap ${config.maxRepoMb} MB, cache cap ${config.maxCacheMb} MB, concurrency ${config.concurrency}, active job cap ${config.maxActiveJobs}, new requests/min ${config.maxRequestsPerMinute})`);
});
