import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  captureChildIdentity,
  ExecutionLedger,
  interruptionNote,
  reconcileInterruptedTasks,
  terminateOrphanedChild,
  type InterruptedTaskNotice
} from "./task-recovery.js";
import { TaskStore } from "./task-store.js";
import { interruptedTaskNoticeRow, parseTaskControl, taskActionMatchesState } from "./task-controls.js";
import { createTaskWorktree, resumeTaskWorktree } from "./task-worktree.js";

const posixOnly = process.platform === "win32" ? { skip: "requires POSIX process identity" } : {};

test("execution ledger persists records privately and never stores raw secrets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-recovery-ledger-"));
  const stateFile = path.join(root, "state", "executions.json");
  const ledger = new ExecutionLedger(stateFile);
  await ledger.record({
    taskId: "task-abc123",
    projectName: "demo",
    mode: "action",
    requester: "tester sk-abcdefghijklmnopqrstuvwxyz123456",
    requesterId: "42",
    channelId: "chan-1",
    startedAt: new Date().toISOString()
  });
  await ledger.setPhase("task-abc123", "running-codex");
  await ledger.setWorkspace("task-abc123", {
    workspacePath: path.join(root, "worktree"),
    branchName: "devbot/task/task-abc123",
    baseBranch: "abc",
    isolated: true
  });

  const raw = await readFile(stateFile, "utf8");
  assert.equal(raw.includes("sk-abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.match(raw, /\[REDACTED API KEY\]/);
  if (process.platform !== "win32") {
    assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(stateFile))).mode & 0o777, 0o700);
  }

  const reloaded = new ExecutionLedger(stateFile);
  const records = await reloaded.listActive();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.taskId, "task-abc123");
  assert.equal(records[0]?.phase, "running-codex");
  assert.equal(records[0]?.workspaceIsolated, true);
  assert.equal(records[0]?.branchName, "devbot/task/task-abc123");

  await reloaded.clear("task-abc123");
  assert.deepEqual(await new ExecutionLedger(stateFile).listActive(), []);
});

test("restart reconciliation marks dead-pid work interrupted and announces it", posixOnly, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-recovery-dead-"));
  const taskFile = path.join(root, "tasks.json");
  const ledgerFile = path.join(root, "executions.json");

  const store = new TaskStore(taskFile);
  const task = await store.start({
    source: "test",
    mode: "action",
    projectName: "demo",
    requester: "tester",
    requesterId: "42",
    channelId: "chan-1",
    text: "long running change"
  });
  const ledger = new ExecutionLedger(ledgerFile);
  await ledger.record({
    taskId: task.id,
    projectName: "demo",
    mode: "action",
    requester: "tester",
    channelId: "chan-1",
    startedAt: task.startedAt
  });
  await ledger.setPhase(task.id, "running-codex");

  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  assert.ok(child.pid);
  const identity = await captureChildIdentity(child.pid!);
  assert.ok(identity);
  await ledger.setChild(task.id, identity!);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;

  const notices: InterruptedTaskNotice[] = [];
  const summary = await reconcileInterruptedTasks({
    ledger: new ExecutionLedger(ledgerFile),
    tasks: new TaskStore(taskFile),
    notify: async (notice) => {
      notices.push(notice);
    }
  });

  assert.equal(summary.interruptedTasks, 1);
  assert.equal(summary.orphansStopped, 0);
  const recovered = await new TaskStore(taskFile).get(task.id);
  assert.equal(recovered?.status, "interrupted");
  assert.match(recovered?.error ?? "", /restarted while this task was running/);
  assert.match(recovered?.error ?? "", /had already exited/);
  assert.match(recovered?.error ?? "", /not resumed/);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.childOutcome, "already-exited");
  assert.equal(notices[0]?.task.id, task.id);
  assert.deepEqual(await new ExecutionLedger(ledgerFile).listActive(), []);
});

test("restart reconciliation stops a live orphaned child with an observed exit", posixOnly, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-recovery-orphan-"));
  const taskFile = path.join(root, "tasks.json");
  const ledgerFile = path.join(root, "executions.json");

  const store = new TaskStore(taskFile);
  const task = await store.start({
    source: "test",
    mode: "action",
    projectName: "demo",
    requester: "tester",
    text: "still writing"
  });
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    detached: true
  });
  child.unref();
  assert.ok(child.pid);
  try {
    const identity = await captureChildIdentity(child.pid!);
    assert.ok(identity);
    const ledger = new ExecutionLedger(ledgerFile);
    await ledger.record({
      taskId: task.id,
      projectName: "demo",
      mode: "action",
      requester: "tester",
      startedAt: task.startedAt
    });
    await ledger.setChild(task.id, identity!);

    const notices: InterruptedTaskNotice[] = [];
    const summary = await reconcileInterruptedTasks({
      ledger: new ExecutionLedger(ledgerFile),
      tasks: new TaskStore(taskFile),
      notify: async (notice) => {
        notices.push(notice);
      }
    });

    assert.equal(summary.interruptedTasks, 1);
    assert.equal(summary.orphansStopped, 1);
    assert.equal(notices[0]?.childOutcome === "terminated" || notices[0]?.childOutcome === "killed", true);
    assert.throws(() => process.kill(child.pid!, 0));
    const recovered = await new TaskStore(taskFile).get(task.id);
    assert.equal(recovered?.status, "interrupted");
    assert.match(recovered?.error ?? "", /stopped with an observed exit/);
  } finally {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // Already stopped by the reconciler.
    }
  }
});

test("a recycled pid with a different spawn identity is never signaled", posixOnly, async () => {
  const identity = await captureChildIdentity(process.pid);
  assert.ok(identity);
  const outcome = await terminateOrphanedChild({
    pid: process.pid,
    command: identity!.command,
    startedAt: "Mon Jan  1 00:00:00 2001"
  });
  assert.equal(outcome, "not-ours");
  assert.doesNotThrow(() => process.kill(process.pid, 0));
  assert.match(interruptionNote(undefined, "not-ours"), /left untouched/);
});

test("corrupt and malformed execution state is quarantined without crashing recovery", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-recovery-corrupt-"));
  const corruptFile = path.join(root, "executions.json");
  await writeFile(corruptFile, "{ not json", "utf8");
  const corruptLedger = new ExecutionLedger(corruptFile);
  assert.deepEqual(await corruptLedger.listActive(), []);
  const issues = await corruptLedger.loadIssues();
  assert.ok(issues.quarantinedTo);
  const siblings = await readdir(root);
  assert.equal(siblings.some((name) => name.startsWith("executions.json.corrupt-")), true);

  const partialFile = path.join(root, "partial.json");
  await writeFile(
    partialFile,
    JSON.stringify({
      version: 1,
      executions: [
        {
          taskId: "task-good1",
          projectName: "demo",
          mode: "answer",
          phase: "routing",
          requester: "tester",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        { taskId: "../../etc/passwd", projectName: "demo" },
        { taskId: "task-nophase", projectName: "demo", mode: "answer", requester: "tester", phase: "bogus" },
        "garbage"
      ]
    }),
    "utf8"
  );
  const partialLedger = new ExecutionLedger(partialFile);
  const records = await partialLedger.listActive();
  assert.deepEqual(records.map((record) => record.taskId), ["task-good1"]);
  assert.equal((await partialLedger.loadIssues()).invalidRecordsDropped, 3);

  const summary = await reconcileInterruptedTasks({
    ledger: new ExecutionLedger(partialFile),
    tasks: new TaskStore(path.join(root, "tasks.json"))
  });
  assert.equal(summary.invalidRecordsDropped, 3);
  assert.equal(summary.staleRecordsCleared, 1);
});

test("interrupted tasks expose restart-stable retry and dismiss controls", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-recovery-controls-"));
  const store = new TaskStore(path.join(root, "tasks.json"));
  const task = await store.start({
    source: "test",
    mode: "action",
    projectName: "demo",
    requester: "tester",
    requesterId: "42",
    text: "change things"
  });
  const interrupted = await store.interrupt(task.id, "Devbot restarted while this task was running.");
  assert.ok(interrupted);
  assert.equal(interrupted?.attention, "blocked");
  assert.equal(taskActionMatchesState("retry", interrupted!), true);
  assert.equal(taskActionMatchesState("dismiss", interrupted!), true);
  assert.equal(taskActionMatchesState("cancel", interrupted!), false);

  const row = interruptedTaskNoticeRow(task.id, { mode: "action", safeMode: false });
  const customIds = row.components.map((component) => (component.toJSON() as { custom_id: string }).custom_id);
  const parsed = customIds.map((id) => parseTaskControl(id));
  assert.deepEqual(parsed.map((control) => control?.action), ["retry", "dismiss", "details"]);
  assert.equal(parsed.every((control) => control?.taskId === task.id), true);
  const safeModeRow = interruptedTaskNoticeRow(task.id, { mode: "action", safeMode: true });
  assert.equal((safeModeRow.components[0]?.toJSON() as { disabled?: boolean }).disabled, true);

  const reloaded = new TaskStore(path.join(root, "tasks.json"));
  assert.equal((await reloaded.get(task.id))?.status, "interrupted");
  const dismissed = await reloaded.dismiss(task.id, "tester");
  assert.equal(dismissed?.status, "canceled");
  assert.match(dismissed?.error ?? "", /dismissed by tester/i);
  assert.equal(await reloaded.dismiss(task.id, "tester"), undefined);
});

test("an interrupted isolated worktree can be resumed only while its identity still holds", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-recovery-worktree-"));
  const repo = path.join(root, "source");
  await git(root, ["init", "source"]);
  await git(repo, ["config", "user.name", "Devbot Test"]);
  await git(repo, ["config", "user.email", "devbot-test@example.invalid"]);
  await writeFile(path.join(repo, "tracked.txt"), "original\n");
  await git(repo, ["add", "tracked.txt"]);
  await git(repo, ["commit", "-m", "Initial commit"]);

  const created = await createTaskWorktree({
    sourcePath: repo,
    taskName: "task-resume1",
    worktreeRoot: path.join(root, "worktrees")
  });
  assert.equal(created.available, true);
  if (!created.available) return;
  await writeFile(path.join(created.worktree.path, "tracked.txt"), "partial work\n");

  const resumed = await resumeTaskWorktree({
    sourcePath: repo,
    worktreePath: created.worktree.path,
    branch: created.worktree.branch,
    baseRevision: created.worktree.baseRevision
  });
  assert.equal(resumed.available, true);
  if (!resumed.available) return;
  assert.equal(resumed.worktree.path, created.worktree.path);
  assert.equal(await readFile(path.join(resumed.worktree.path, "tracked.txt"), "utf8"), "partial work\n");

  const wrongBranch = await resumeTaskWorktree({
    sourcePath: repo,
    worktreePath: created.worktree.path,
    branch: "devbot/task/other-task",
    baseRevision: created.worktree.baseRevision
  });
  assert.equal(wrongBranch.available, false);
  if (wrongBranch.available) return;
  assert.equal(wrongBranch.reason, "not_an_isolated_worktree");

  const sourceAsWorktree = await resumeTaskWorktree({
    sourcePath: repo,
    worktreePath: repo,
    branch: created.worktree.branch,
    baseRevision: created.worktree.baseRevision
  });
  assert.equal(sourceAsWorktree.available, false);

  await git(repo, ["config", "filter.exfiltrate.process", "/tmp/not-allowed"]);
  const filtered = await resumeTaskWorktree({
    sourcePath: repo,
    worktreePath: created.worktree.path,
    branch: created.worktree.branch,
    baseRevision: created.worktree.baseRevision
  });
  assert.equal(filtered.available, false);
  if (filtered.available) return;
  assert.equal(filtered.reason, "unsafe_git_config");
});

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
