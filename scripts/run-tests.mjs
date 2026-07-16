import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const distDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
const testFiles = readdirSync(distDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
  .map((entry) => fileURLToPath(new URL(`../dist/${entry.name}`, import.meta.url)))
  .sort();

if (testFiles.length === 0) {
  console.error("No compiled test files were found in dist.");
  process.exit(1);
}

const result = spawnSync(process.execPath, [...process.argv.slice(2), "--test", ...testFiles], {
  stdio: "inherit"
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
