import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFixTaskPrompt,
  parseDuelRebuttal,
  parseDuelVerdict,
  resolveIssueStatuses,
  reviewerTierFor,
  runDuelReview,
  tierLabel,
  truncateDiffForDuel,
  type DuelIssue,
  type RunDuelInput
} from "./duel.js";

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
  assert.equal(result.text, "(no working tree changes against HEAD)");
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

test("verdict parsing degrades gracefully on malformed input without inventing issues", () => {
  const verdict = parseDuelVerdict("The diff looks fine to me, nothing stands out as a real problem.");
  assert.equal(verdict.overall, "approve");
  assert.equal(verdict.issues.length, 0);
  assert.ok(verdict.warnings.some((warning) => warning.includes("VERDICT")));
});

test("verdict parsing handles an empty response", () => {
  const verdict = parseDuelVerdict("");
  assert.equal(verdict.overall, "approve");
  assert.equal(verdict.issues.length, 0);
  assert.ok(verdict.warnings.some((warning) => warning.includes("empty")));
});

test("verdict parsing tolerates an approve verdict with stray issue-shaped text ignored", () => {
  const verdict = parseDuelVerdict("VERDICT: approve\nNo substantive issues found in this change.");
  assert.equal(verdict.overall, "approve");
  assert.equal(verdict.issues.length, 0);
});

test("rebuttal parsing extracts stances and reasoning, flagging unresolved issues", () => {
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

test("rebuttal parsing handles an empty response", () => {
  const rebuttal = parseDuelRebuttal("", ["I1"]);
  assert.equal(rebuttal.responses.size, 0);
  assert.ok(rebuttal.warnings.some((warning) => warning.includes("empty")));
});

test("issue status resolution matrix maps stances and missing responses to final status", () => {
  const issues: DuelIssue[] = [
    { id: "I1", severity: "high", claim: "real bug" },
    { id: "I2", severity: "medium", claim: "disagreement" },
    { id: "I3", severity: "low", claim: "moot point" },
    { id: "I4", severity: "low", claim: "never addressed" }
  ];
  const rebuttal = parseDuelRebuttal(
    [
      "RESPONSE id=I1 stance=concede reasoning=Yes, real bug.",
      "RESPONSE id=I2 stance=rebut reasoning=Intentional design choice.",
      "RESPONSE id=I3 stance=withdraw reasoning=Reviewer misread the diff."
    ].join("\n"),
    ["I1", "I2", "I3", "I4"]
  );
  const resolved = resolveIssueStatuses(issues, rebuttal);
  assert.deepEqual(
    resolved.map((issue) => issue.status),
    ["conceded", "disputed", "withdrawn", "disputed"]
  );
  assert.match(resolved[3]?.authorNote ?? "", /No rebuttal was recorded/);
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

function duelInput(overrides: Partial<RunDuelInput>): RunDuelInput {
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
    task: { id: "task-abc", text: "Add the export button", projectName: "webapp", modelTier: "standard" },
    projectName: "webapp",
    projectRoot: "/tmp/webapp",
    diff: truncateDiffForDuel("diff --git a/src/x.ts b/src/x.ts\n+changed"),
    codex: {
      bin: "codex",
      model: "gpt-5.6-sol",
      sandbox: "read-only",
      actionSandbox: "workspace-write",
      timeoutMs: 180_000
    },
    ...overrides
  };
}
