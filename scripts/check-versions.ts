import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
const jsr = JSON.parse(readFileSync(join(root, "jsr.json"), "utf8")) as { version: string };

if (pkg.version !== jsr.version) {
  console.error(`Version mismatch: package.json=${pkg.version}, jsr.json=${jsr.version}`);
  process.exit(1);
}
console.log(`Versions match: ${pkg.version}`);
