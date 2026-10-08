// Rasterize the editable SVG using the bundled desktop renderer, not an image service.
import { _electron as electron } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve(root,"../research/labs/grokbot-desktop/node_modules/.bin/electron"), args:[path.join(root,"scripts/render-brand-icon-main.cjs")], env });
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => document.querySelector("svg"));
  await page.screenshot({ path:path.join(root,"desktop/assets/icon-v2.png"),omitBackground:true,scale:"css" });
  console.log("Rendered desktop/assets/icon-v2.png (1024 × 1024)");
} finally { await app.close(); }
