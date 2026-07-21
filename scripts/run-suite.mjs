import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

class CommandFailure extends Error {
  constructor(status) {
    super(`Command exited with status ${status}.`);
    this.status = status;
  }
}

const coverage = process.argv.includes("--coverage");
const suiteParent = path.resolve(".devbot");
await mkdir(suiteParent, { recursive: true, mode: 0o700 });
const suiteDirectory = await mkdtemp(path.join(suiteParent, "test-suite-"));
let failure;

try {
  run(process.execPath, [
    path.resolve("node_modules/typescript/bin/tsc"),
    "-p",
    "tsconfig.json",
    "--outDir",
    suiteDirectory
  ]);
  const coverageRoot = path.join(suiteDirectory, "**/*.js").split(path.sep).join("/");
  const coverageTests = path.join(suiteDirectory, "**/*.test.js").split(path.sep).join("/");
  run(process.execPath, [
    "scripts/run-tests.mjs",
    `--dist-directory=${suiteDirectory}`,
    ...(coverage
      ? [
          "--experimental-test-coverage",
          `--test-coverage-include=${coverageRoot}`,
          `--test-coverage-exclude=${coverageTests}`,
          "--test-coverage-lines=85",
          "--test-coverage-branches=75",
          "--test-coverage-functions=85"
        ]
      : [])
  ]);
} catch (error) {
  failure = error;
} finally {
  await rm(suiteDirectory, { recursive: true, force: true });
}

if (failure instanceof CommandFailure) {
  process.exitCode = failure.status;
} else if (failure) {
  throw failure;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: process.cwd(), env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new CommandFailure(result.status ?? 1);
}
