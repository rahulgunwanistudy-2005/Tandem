// Bundle the functions with @tandem/core inlined, so the deployed package needs only
// firebase-admin and firebase-functions (no workspace protocol in Cloud Build).
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "lib/index.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external: ["firebase-admin", "firebase-functions"],
  alias: { "@tandem/core": fileURLToPath(new URL("../packages/core/src/index.ts", import.meta.url)) },
  logLevel: "info",
});
