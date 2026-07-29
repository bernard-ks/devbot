import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubReviewProvider,
  githubRepositoryFromRemote,
  type ReviewProviderProcessRunner
} from "./review-provider.js";
import type { TaskRecord } from "./task-store.js";
import type { TaskWorktree } from "./task-worktree.js";
import type { ProjectEntry } from "./types.js";

const commitSha = "a".repeat(40);
const baseRevision = "b".repeat(40);
const branch = "devbot/task/review-bridge";
const worktree: TaskWorktree = {
  sourcePath: "/repo",
  path: "/worktree",
  branch,
  baseRevision
};

test("GitHub review publishing verifies and pushes the exact branch before creating a draft PR", async () => {
  const calls: ProcessCall[] = [];
  const runner = scriptedRunner(calls, ({ bin, args }) => {
    if (bin === "git" && args.includes("remote")) return ok("git@github.com:example/devbot.git\n");
    if (bin === "gh" && args[0] === "auth") return ok();
    if (bin === "gh" && args[0] === "pr" && args[1] === "list") return ok("[]");
    if (bin === "git" && args.includes("fetch")) return ok();
    if (bin === "git" && args.includes("merge-base")) return ok();
    if (bin === "git" && args.includes("push")) return ok();
    if (bin === "gh" && args[0] === "pr" && args[1] === "create") {
      return ok("https://github.com/example/devbot/pull/42\n");
    }
    if (bin === "gh" && args[0] === "pr" && args[1] === "view") return ok(JSON.stringify(pullRequest()));
    if (bin === "gh" && args[0] === "api") {
      return ok(JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [{ isResolved: false }, { isResolved: true }, { isResolved: false }]
              }
            }
          }
        }
      }));
    }
    return fail(`Unexpected command: ${bin} ${args.join(" ")}`);
  });
  const provider = new GitHubReviewProvider(runner, async () => ({
    available: true,
    worktree,
    headRevision: commitSha,
    changes: [],
    diff: { staged: "", unstaged: "", truncated: false }
  }));

  const review = await provider.publish({ project: project(), task: task(), worktree });

  assert.equal(review.repository, "example/devbot");
  assert.equal(review.number, 42);
  assert.equal(review.status, "draft");
  assert.equal(review.commitSha, commitSha);
  assert.deepEqual(review.checks, { total: 3, pending: 1, passed: 1, failed: 1 });
  assert.equal(review.unresolvedThreads, 2);

  const push = calls.find((call) => call.bin === "git" && call.args.includes("push"));
  assert.ok(push);
  assert.ok(push.args.includes(`refs/heads/${branch}:refs/heads/${branch}`));
  assert.equal(push.args.some((argument) => argument.includes("--force")), false);

  const create = calls.find((call) => call.bin === "gh" && call.args[0] === "pr" && call.args[1] === "create");
  assert.ok(create);
  assert.ok(create.args.includes("--draft"));
  assert.ok(create.args.includes("--body-file"));
  assert.equal(create.args.some((argument) => argument.includes("Implement Review Bridge")), false);
  assert.match(create.input ?? "", /Merge remains a separate human decision/);
  assert.match(create.input ?? "", new RegExp(commitSha));
});

test("publishing reuses an existing pull request at the recorded commit without pushing again", async () => {
  const calls: ProcessCall[] = [];
  const runner = scriptedRunner(calls, ({ bin, args }) => {
    if (bin === "git" && args.includes("remote")) return ok("https://github.com/example/devbot.git\n");
    if (bin === "gh" && args[0] === "auth") return ok();
    if (bin === "gh" && args[0] === "pr" && args[1] === "list") return ok(JSON.stringify([pullRequest()]));
    if (bin === "gh" && args[0] === "api") return ok(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }));
    return fail(`Unexpected command: ${bin} ${args.join(" ")}`);
  });
  const provider = new GitHubReviewProvider(runner, cleanInspection);

  const review = await provider.publish({ project: project(), task: task(), worktree });

  assert.equal(review.number, 42);
  assert.equal(calls.some((call) => call.bin === "git" && call.args.includes("push")), false);
  assert.equal(calls.some((call) => call.bin === "gh" && call.args[0] === "pr" && call.args[1] === "create"), false);
});

test("publishing fails closed on dirty, moved, or stale isolated worktrees", async () => {
  const dirtyProvider = new GitHubReviewProvider(async () => ok(), async () => ({
    available: true,
    worktree,
    headRevision: commitSha,
    changes: [{ path: "src/index.ts", indexStatus: " ", worktreeStatus: "M", kind: "tracked" }],
    diff: { staged: "", unstaged: "", truncated: false }
  }));
  await assert.rejects(
    dirtyProvider.publish({ project: project(), task: task(), worktree }),
    /uncommitted changes/
  );

  const movedProvider = new GitHubReviewProvider(async () => ok(), async () => ({
    available: true,
    worktree,
    headRevision: "c".repeat(40),
    changes: [],
    diff: { staged: "", unstaged: "", truncated: false }
  }));
  await assert.rejects(
    movedProvider.publish({ project: project(), task: task(), worktree }),
    /recorded commit is not the current/
  );

  const calls: ProcessCall[] = [];
  const staleProvider = new GitHubReviewProvider(scriptedRunner(calls, ({ bin, args }) => {
    if (bin === "git" && args.includes("remote")) return ok("git@github.com:example/devbot.git");
    if (bin === "gh" && args[0] === "auth") return ok();
    if (bin === "gh" && args[0] === "pr" && args[1] === "list") return ok("[]");
    if (bin === "git" && args.includes("fetch")) return ok();
    if (bin === "git" && args.includes("merge-base")) return fail("not an ancestor");
    return fail(`Unexpected command: ${bin} ${args.join(" ")}`);
  }), cleanInspection);
  await assert.rejects(
    staleProvider.publish({ project: project(), task: task(), worktree }),
    /stale against origin\/main/
  );
  assert.equal(calls.some((call) => call.bin === "git" && call.args.includes("push")), false);
});

test("GitHub repository parsing accepts standard remotes and rejects ambiguous hosts or paths", () => {
  assert.equal(githubRepositoryFromRemote("git@github.com:example/devbot.git"), "example/devbot");
  assert.equal(githubRepositoryFromRemote("https://github.com/example/devbot.git"), "example/devbot");
  assert.equal(githubRepositoryFromRemote("ssh://git@github.com/example/devbot.git"), "example/devbot");
  assert.equal(githubRepositoryFromRemote("https://git.example.com/example/devbot.git"), undefined);
  assert.equal(githubRepositoryFromRemote("https://github.com/example/devbot/extra"), undefined);
  assert.equal(githubRepositoryFromRemote("git@github.com:../devbot.git"), undefined);
});

interface ProcessCall {
  bin: string;
  args: string[];
  input?: string;
}

function scriptedRunner(
  calls: ProcessCall[],
  response: (call: ProcessCall) => ReturnType<typeof ok>
): ReviewProviderProcessRunner {
  return async (bin, args, options) => {
    const call = { bin, args: [...args], ...(options.input === undefined ? {} : { input: options.input }) };
    calls.push(call);
    return response(call);
  };
}

async function cleanInspection() {
  return {
    available: true as const,
    worktree,
    headRevision: commitSha,
    changes: [],
    diff: { staged: "", unstaged: "", truncated: false }
  };
}

function ok(stdout = "") {
  return { ok: true, stdout, stderr: "", exitCode: 0 };
}

function fail(stderr: string) {
  return { ok: false, stdout: "", stderr, exitCode: 1 };
}

function pullRequest() {
  return {
    number: 42,
    url: "https://github.com/example/devbot/pull/42",
    state: "OPEN",
    isDraft: true,
    headRefName: branch,
    headRefOid: commitSha,
    baseRefName: "main",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "REVIEW_REQUIRED",
    isCrossRepository: false,
    statusCheckRollup: [
      { status: "COMPLETED", conclusion: "SUCCESS" },
      { status: "IN_PROGRESS", conclusion: null },
      { status: "COMPLETED", conclusion: "FAILURE" }
    ]
  };
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "review-bridge",
    status: "succeeded",
    source: "test",
    mode: "action",
    projectName: "devbot",
    requester: "tester",
    text: "Implement Review Bridge",
    includePatterns: [],
    startedAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:01:00.000Z",
    workspacePath: worktree.path,
    workspaceIsolated: true,
    branchName: branch,
    baseBranch: baseRevision,
    commitSha,
    changedFiles: ["src/review-provider.ts"],
    verification: ["npm test passed"],
    ...overrides
  };
}

function project(): ProjectEntry {
  return {
    name: "devbot",
    root: "/repo",
    metadata: {
      canonicalName: "devbot",
      repoUrl: "https://github.com/example/devbot.git",
      defaultBranch: "main",
      frontendUrl: undefined,
      backendUrl: undefined,
      ownerBot: undefined,
      aliases: [],
      commands: { test: ["npm test"], build: [], lint: [], verify: [], presets: {} },
      policy: {
        visibility: "private",
        allowedUsers: [],
        allowedUsernames: [],
        allowedRoles: [],
        allowedPeers: [],
        screenshotPolicy: "allow",
        maxContextChars: undefined,
        readOnlyCommands: [],
        approvalRequiredCommands: []
      }
    }
  };
}
