import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const forwardedArgs = [];
let distDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
for (const argument of process.argv.slice(2)) {
  if (argument.startsWith("--dist-directory=")) {
    const configured = argument.slice("--dist-directory=".length);
    if (!configured) throw new Error("--dist-directory requires a path.");
    distDirectory = path.resolve(configured);
  } else {
    forwardedArgs.push(argument);
  }
}
const testFiles = readdirSync(distDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
  .map((entry) => path.join(distDirectory, entry.name))
  .sort();

if (testFiles.length === 0) {
  console.error(`No compiled test files were found in ${distDirectory}.`);
  process.exit(1);
}

const result = spawnSync(process.execPath, [...forwardedArgs, "--test", ...testFiles], {
  stdio: "inherit"
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
