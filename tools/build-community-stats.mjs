import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: ["src/lib/server/community-stats.worker.ts"],
  outfile: "dist-server/community-stats.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["highs"],
});
