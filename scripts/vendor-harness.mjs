import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdk = resolve(root, "../agent-deck-harness-core");
const target = resolve(root, "desktop/harness-core");
// Explicit build input, never a runtime dependency on a neighboring checkout.
await mkdir(target, { recursive: true });
for (const name of ["portable", "harness", "context", "store", "model-adapters"]) {
  await cp(resolve(sdk, `dist/${name}.js`), resolve(target, `${name}.js`));
}
await cp(resolve(sdk, "LICENSE"), resolve(target, "LICENSE"));
const pkg = JSON.parse(await readFile(resolve(sdk, "package.json"), "utf8"));
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sdk, encoding: "utf8" }).trim();
await writeFile(resolve(target, "package.json"), JSON.stringify({ type: "module", version: pkg.version, source: pkg.repository.url, sourceRevision: revision, license: pkg.license }, null, 2) + "\n");
