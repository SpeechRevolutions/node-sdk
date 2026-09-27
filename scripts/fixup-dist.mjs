import { chmodSync, writeFileSync } from "node:fs";

writeFileSync("dist/esm/package.json", JSON.stringify({ type: "module" }) + "\n");
writeFileSync("dist/cjs/package.json", JSON.stringify({ type: "commonjs" }) + "\n");

// The CLI must be executable once npm links it. tsc preserves the shebang but not the mode.
chmodSync("dist/esm/bin.js", 0o755);
chmodSync("dist/cjs/bin.js", 0o755);
