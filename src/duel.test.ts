import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createTaskWorktree } from "./task-worktree.js";
import {
  buildFixTaskPrompt,
  gatherDuelChangeEvidence,
  parseDuelRebuttal,
  parseDuelVerdict,
  resolveDuelFixWorkspace,
  resolveIssueStatuses,
  reviewerIndependenceFor,
  reviewerTierFor,
  runDuelReview,
  tierLabel,
  truncateDiffForDuel,
  type DuelChangeEvidence,
  type DuelIssue,
  type RunDuelInput
} from "./duel.js";
import type { ProjectEntry } from "./types.js";

test("diff truncation keeps small diffs intact and reports no truncation", () => {
  const diff = "diff --git a/src/a.ts b/src/a.ts\n+line one\n+line two\n";
  const result = truncateDiffForDuel(diff, { maxTotalBytes: 10_000, maxFileBytes: 10_000 });
  assert.equal(result.truncated, false);
  assert.equal(result.fileCount, 1);
  assert.equal(result.includedFileCount, 1);
  assert.match(result.text, /line one/);
});

test("diff truncation reports a clean empty-diff message", () => {
  const result = truncateDiffForDuel("   \n  ");
  assert.equal(result.text, "(no working tree changes against the recorded base revision)");
  assert.equal(result.fileCount, 0);
  assert.equal(result.truncated, false);
});

test("diff truncation caps an oversized single file", () => {
  const bigFile = `diff --git a/src/big.ts b/src/big.ts\n${"x".repeat(500)}`;
  const result = truncateDiffForDuel(bigFile, { maxTotalBytes: 10_000, maxFileBytes: 100 });
  assert.equal(result.truncated, true);
  assert.match(result.text, /truncated, this file exceeds the per-file review budget/);
  assert.ok(result.text.length < bigFile.length);
});

test("diff truncation drops later files once the total budget is exhausted", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts\n+a".repeat(1),
    "diff --git a/src/b.ts b/src/b.ts\n+b".repeat(1),
    "diff --git a/src/c.ts b/src/c.ts\n+c".repeat(1)
  ].join("\n");
  const result = truncateDiffForDuel(diff, { maxTotalBytes: 40, maxFileBytes: 40 });
  assert.equal(result.fileCount, 3);
  assert.ok(result.includedFileCount < 3);
  assert.equal(result.truncated, true);
  assert.match(result.text, /additional changed file section\(s\) omitted/);
});

test("diff truncation budgets by UTF-8 byte length, not JS string length", () => {
  // Each of these characters is 3 bytes in UTF-8 but 1 UTF-16 code unit in JS string length.
  const multiByteLine = "€".repeat(20);
  const diff = `diff --git a/src/a.ts b/src/a.ts\n+${multiByteLine}`;
  const result = truncateDiffForDuel(diff, { maxTotalBytes: 10_000, maxFileBytes: 30 });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text, "utf8") < Buffer.byteLength(diff, "utf8"));
});

test("verdict parsing handles a well-formed reviewer response", () => {
  const response = [
    "VERDICT: request-changes",
    "ISSUE severity=high file=src/foo.ts line=42 claim=Off-by-one error skips the last element.",
    'ISSUE severity=medium file=src/bar.ts line=- claim=Missing null check before dereference.'
  ].join("\n");
  const verdict = parseDuelVerdict(response);
  assert.equal(verdict.overall, "request-changes");
  assert.equal(verdict.issues.length, 2);
  assert.deepEqual(verdict.issues[0], { id: "I1", severity: "high", file: "src/foo.ts", line: 42, claim: "Off-by-one error skips the last element." });
  assert.equal(verdict.issues[1]?.file, "src/bar.ts");
  assert.equal(verdict.issues[1]?.line, undefined);
  assert.equal(verdict.warnings.length, 0);
});

test("verdict parsing degrades to indeterminate on malformed input without inventing issues", () => {
  const verdict = parseDuelVerdict("The diff looks fine to me, nothing stands out as a real problem.");
  assert.equal(verdict.overall, "indeterminate");
  assert.equal(verdict.issues.length, 0);
  assert.ok(verdict.warnings.some((warning) => warning.includes("VERDICT")));
});

test("verdict parsing treats an empty response as indeterminate, never approve", () => {
  const verdict = parseDuelVerdict("");
  assert.equal(verdict.overall, "indeterminate");
  assert.equal(verdict.issues.length, 0);
  assert.ok(verdict.warnings.some((warning) => warning.includes("empty")));
});

test("verdict parsing tolerates an approve verdict with stray issue-shaped text ignored", () => {
  const verdict = parseDuelVerdict("VERDICT: approve\nNo substantive issues found in this change.");
  assert.equal(verdict.overall, "approve");
  assert.equal(verdict.issues.length, 0);
});

test("verdict parsing treats a contradictory approve-with-issues as indeterminate, not approve", () => {
  const verdict = parseDuelVerdict("VERDICT: approve\nISSUE severity=high file=src/x.ts line=1 claim=This actually breaks things.");
  assert.equal(verdict.overall, "indeterminate");
  assert.equal(verdict.issues.length, 1);
  assert.ok(verdict.warnings.some((warning) => warning.includes("indeterminate")));
});

test("verdict parsing treats request-changes with zero parsable issues as indeterminate, not clean", () => {
  const verdict = parseDuelVerdict("VERDICT: request-changes\nSomething is wrong but I won't say what.");
  assert.equal(verdict.overall, "indeterminate");
  assert.equal(verdict.issues.length, 0);
});

test("rebuttal parsing extracts concede/rebut stances and reasoning, flagging unresolved issues", () => {
  const rebuttal = parseDuelRebuttal(
    [
      "RESPONSE id=I1 stance=concede reasoning=Good catch, will fix the bounds check.",
      "RESPONSE id=I2 stance=rebut reasoning=This is intentional per the spec.",
      "RESPONSE id=I9 stance=concede reasoning=Unknown issue id, should be ignored."
    ].join("\n"),
    ["I1", "I2", "I3"]
  );
  assert.equal(rebuttal.responses.get("I1")?.stance, "concede");
  assert.equal(rebuttal.responses.get("I2")?.stance, "rebut");
  assert.equal(rebuttal.responses.has("I9"), false);
  assert.equal(rebuttal.responses.has("I3"), false);
  assert.ok(rebuttal.warnings.some((warning) => warning.includes("I3")));
});

test("rebuttal parsing no longer accepts a unilateral withdraw stance", () => {
  const rebuttal = parseDuelRebuttal("RESPONSE id=I1 stance=withdraw reasoning=Reviewer misread the diff.", ["I1"]);
  assert.equal(rebuttal.responses.has("I1"), false);
  assert.ok(rebuttal.warnings.some((warning) => warning.includes("stance")));
});

test("rebuttal parsing handles an empty response", () => {
  const rebuttal = parseDuelRebuttal("", ["I1"]);
  assert.equal(rebuttal.responses.size, 0);
  assert.ok(rebuttal.warnings.some((warning) => warning.includes("empty")));
});

test("issue status resolution matrix maps stances and missing responses to conceded/disputed only", () => {
  const issues: DuelIssue[] = [
    { id: "I1", severity: "high", claim: "real bug" },
    { id: "I2", severity: "medium", claim: "disagreement" },
    { id: "I3", severity: "low", claim: "never addressed" }
  ];
  const rebuttal = parseDuelRebuttal(
    [
      "RESPONSE id=I1 stance=concede reasoning=Yes, real bug.",
      "RESPONSE id=I2 stance=rebut reasoning=Intentional design choice."
    ].join("\n"),
    ["I1", "I2", "I3"]
  );
  const resolved = resolveIssueStatuses(issues, rebuttal);
  assert.deepEqual(
    resolved.map((issue) => issue.status),
    ["conceded", "disputed", "disputed"]
  );
  assert.match(resolved[2]?.authorNote ?? "", /No rebuttal was recorded/);
});

test("reviewer tier is always different from and at least as strong as the author's default", () => {
  assert.equal(reviewerTierFor("fast"), "deep");
  assert.equal(reviewerTierFor("standard"), "deep");
  assert.equal(reviewerTierFor("deep"), "standard");
});

test("tier labels match the Luna/Terra/Sol naming used elsewhere in devbot", () => {
  assert.equal(tierLabel("fast"), "Luna");
  assert.equal(tierLabel("standard"), "Terra");
  assert.equal(tierLabel("deep"), "Sol");
});

test("reviewer independence compares actual recorded models, not just tier labels", () => {
  assert.equal(reviewerIndependenceFor("gpt-5.6-terra", "gpt-5.6-sol"), "independent");
  assert.equal(reviewerIndependenceFor("gpt-5.6-sol", "gpt-5.6-sol"), "same-model");
  assert.equal(reviewerIndependenceFor(undefined, "gpt-5.6-sol"), "unknown");
  assert.equal(reviewerIndependenceFor("gpt-5.6-sol", undefined), "unknown");
});

test("fix task prompt construction includes only conceded issues with location and note", () => {
  const resolved = resolveIssueStatuses(
    [
      { id: "I1", severity: "high", file: "src/a.ts", line: 10, claim: "Null pointer on empty input." },
      { id: "I2", severity: "low", claim: "Style nit." }
    ],
    parseDuelRebuttal("RESPONSE id=I1 stance=concede reasoning=Confirmed, will add a guard.", ["I1", "I2"])
  );
  const prompt = buildFixTaskPrompt("Add the export button", resolved);
  assert.match(prompt, /Original task: Add the export button/);
  assert.match(prompt, /src\/a\.ts:10 - Null pointer on empty input\./);
  assert.match(prompt, /Confirmed, will add a guard\./);
  assert.doesNotMatch(prompt, /Style nit\./);
});

test("clean diffs produce an honest approve and skip the rebuttal round entirely", async () => {
  const input = duelInput({ complete: async () => "VERDICT: approve" });
  const result = await runDuelReview(input);
  assert.equal(result.skippedRebuttal, true);
  assert.equal(result.reviewerVerdict.overall, "approve");
  assert.equal(result.issues.length, 0);
  assert.equal(result.rebuttalRaw, undefined);
});

test("a request-changes verdict runs the rebuttal round and resolves each issue", async () => {
  let calls = 0;
  const input = duelInput({
    complete: async () => {
      calls += 1;
      if (calls === 1) {
        return "VERDICT: request-changes\nISSUE severity=high file=src/x.ts line=5 claim=Off-by-one.";
      }
      return "RESPONSE id=I1 stance=concede reasoning=Good catch.";
    }
  });
  const result = await runDuelReview(input);
  assert.equal(calls, 2);
  assert.equal(result.skippedRebuttal, false);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]?.status, "conceded");
  assert.equal(result.reviewerTier, "deep");
});

test("a garbled reviewer response never silently resolves to a clean approve", async () => {
  const input = duelInput({ complete: async () => "uh, looks ok I guess" });
  const result = await runDuelReview(input);
  assert.equal(result.reviewerVerdict.overall, "indeterminate");
  assert.equal(result.skippedRebuttal, true);
});

test("reviewer independence is flagged when the reviewer resolves to the same model as the author", async () => {
  const input = duelInput({
    complete: async () => "VERDICT: approve",
    task: { id: "task-abc", text: "Add the export button", projectName: "webapp", modelTier: "standard", model: "gpt-5.6-sol" }
  });
  const result = await runDuelReview(input);
  assert.equal(result.reviewerIndependence, "same-model");
});

// The following two tests share one real git fixture each (rather than one per assertion) to keep
// the suite's total child-process/subprocess load down, since each fixture + isolated worktree
// costs a couple dozen real `git` spawns.

test("gathers byte-pinned diff evidence covering committed, staged, unstaged, and untracked changes, excludes sensitive paths, and is patch-hash stable/sensitive", async () => {
  // Deliberately does not create an isolated task worktree: gatherDuelChangeEvidence only needs a
  // git working directory and a base revision, and skipping worktree creation here keeps this
  // test's real-subprocess footprint down (isolation is exercised by the Accept & fix test below).
  const fixture = await createGitFixture();
  const baseRevision = await git(fixture.repo, ["rev-parse", "HEAD"]);
  const project: ProjectEntry = fakeProject(fixture.repo);
  const task = { workspaceIsolated: true, baseBranch: baseRevision };

  const beforeAny = await gatherDuelChangeEvidence(project, task);
  const beforeAnyAgain = await gatherDuelChangeEvidence(project, task);
  assert.equal(beforeAny.patchHash, beforeAnyAgain.patchHash, "patch hash must be stable when nothing changed");

  await writeFile(path.join(fixture.repo, "tracked.txt"), "committed change\n");
  await git(fixture.repo, ["add", "tracked.txt"]);
  await git(fixture.repo, ["commit", "-m", "Committed change"]);
  await writeFile(path.join(fixture.repo, "staged.txt"), "staged\n");
  await git(fixture.repo, ["add", "staged.txt"]);
  await writeFile(path.join(fixture.repo, "tracked.txt"), "committed change\nplus unstaged\n");
  await writeFile(path.join(fixture.repo, "new-file.txt"), "brand new untracked file\n");
  await writeFile(path.join(fixture.repo, ".env"), "SECRET=do-not-leak\n");

  const evidence = await gatherDuelChangeEvidence(project, task);

  assert.equal(evidence.baseRevision, baseRevision);
  assert.ok(evidence.headRevision);
  assert.match(evidence.text, /committed change/);
  assert.match(evidence.text, /staged/);
  assert.match(evidence.text, /plus unstaged/);
  assert.match(evidence.text, /brand new untracked file/);
  assert.doesNotMatch(evidence.text, /do-not-leak/);
  assert.match(evidence.patchHash, /^[a-f0-9]{64}$/);
  assert.notEqual(evidence.patchHash, beforeAny.patchHash, "patch hash must change once real content changed");
});

test("Accept & fix resolves the exact reviewed workspace (surviving an untracked file) and refuses once the workspace drifts", async () => {
  const fixture = await createGitFixture();
  const isolated = await createTaskWorktree({ sourcePath: fixture.repo, taskName: "duel-fix", worktreeRoot: fixture.worktreeRoot });
  assert.equal(isolated.available, true);
  if (!isolated.available) return;

  await writeFile(path.join(isolated.worktree.path, "new-file.txt"), "reviewed content that must survive\n");
  const registeredProject = fakeProject(fixture.repo);
  const task = {
    id: "task-fix",
    workspaceIsolated: true,
    workspacePath: isolated.worktree.path,
    branchName: isolated.worktree.branch,
    baseBranch: isolated.worktree.baseRevision
  };
  const evidence = await gatherDuelChangeEvidence(fakeProject(isolated.worktree.path), task);

  const resolved = await resolveDuelFixWorkspace({ project: registeredProject, task, expectedPatchHash: evidence.patchHash });
  assert.equal(resolved.available, true);
  if (resolved.available) {
    assert.equal(resolved.root, isolated.worktree.path);
    assert.equal(await readFile(path.join(resolved.root, "new-file.txt"), "utf8"), "reviewed content that must survive\n");
    // The source checkout must never be touched.
    assert.equal(await git(fixture.repo, ["status", "--porcelain"]), "");
  }

  await writeFile(path.join(isolated.worktree.path, "tracked.txt"), "changed after the duel ran\n");
  const afterDrift = await resolveDuelFixWorkspace({ project: registeredProject, task, expectedPatchHash: evidence.patchHash });
  assert.equal(afterDrift.available, false);
  if (!afterDrift.available) {
    assert.match(afterDrift.reason, /changed since the duel review ran/);
  }
});

test("refuses Accept & fix when the task has no isolated workspace to reproduce", async () => {
  const resolved = await resolveDuelFixWorkspace({
    project: fakeProject("/tmp/does-not-matter"),
    task: { id: "task-no-isolation", workspaceIsolated: false },
    expectedPatchHash: "anything"
  });
  assert.equal(resolved.available, false);
});

function fakeProject(root: string): ProjectEntry {
  return {
    name: "webapp",
    root,
    metadata: {
      canonicalName: undefined,
      repoUrl: undefined,
      defaultBranch: "main",
      frontendUrl: undefined,
      backendUrl: undefined,
      ownerBot: undefined,
      aliases: [],
      commands: { test: [], build: [], lint: [], verify: [], presets: {} },
      policy: {
        visibility: "private",
        allowedUsers: [],
        allowedUsernames: [],
        allowedRoles: [],
        allowedPeers: [],
        screenshotPolicy: "deny",
        maxContextChars: undefined,
        readOnlyCommands: [],
        approvalRequiredCommands: []
      }
    }
  };
}

async function createGitFixture(): Promise<{ repo: string; worktreeRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-duel-"));
  const repo = path.join(root, "source");
  await git(root, ["init", "source"]);
  await git(repo, ["config", "user.name", "Devbot Test"]);
  await git(repo, ["config", "user.email", "devbot-test@example.invalid"]);
  await writeFile(path.join(repo, "tracked.txt"), "original\n");
  await git(repo, ["add", "tracked.txt"]);
  await git(repo, ["commit", "-m", "Initial commit"]);
  return { repo, worktreeRoot: path.join(root, "worktrees") };
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function duelInput(overrides: Partial<RunDuelInput> & { task?: Partial<RunDuelInput["task"]> }): RunDuelInput {
  const evidence: DuelChangeEvidence = { ...truncateDiffForDuel("diff --git a/src/x.ts b/src/x.ts\n+changed"), patchHash: "test-hash" };
  const defaultTask: RunDuelInput["task"] = { id: "task-abc", text: "Add the export button", projectName: "webapp", modelTier: "standard" };
  return {
    routing: {
      enabled: true,
      routerModel: "gpt-5.6-luna",
      routerReasoningEffort: "low",
      routerTimeoutMs: 30_000,
      fastModel: "gpt-5.6-luna",
      fastReasoningEffort: "low",
      standardModel: "gpt-5.6-terra",
      standardReasoningEffort: "medium",
      deepModel: "gpt-5.6-sol",
      deepReasoningEffort: "ultra",
      focusedContextChars: 24_000
    },
    task: defaultTask,
    projectName: "webapp",
    projectRoot: "/tmp/webapp",
    diff: evidence,
    codex: {
      bin: "codex",
      model: "gpt-5.6-sol",
      sandbox: "read-only",
      actionSandbox: "workspace-write",
      timeoutMs: 180_000
    },
    ...overrides,
    ...(overrides.task ? { task: { ...defaultTask, ...overrides.task } } : {})
  };
}
