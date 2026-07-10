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
  settleExecutionRecord,
  terminateOrphanedChild,
  type InterruptedTaskNotice,
  type OrphanTerminationOutcome
} from "./task-recovery.js";
import { TaskStore } from "./task-store.js";
import { interruptedTaskNoticeRow, parseTaskControl, taskActionMatchesState, taskActionRows } from "./task-controls.js";
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

test("execution ledger rejects critical updates when the durable task record is missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-recovery-missing-record-"));
  const ledger = new ExecutionLedger(path.join(root, "executions.json"));

  await assert.rejects(
    ledger.setPhase("task-missing", "running-codex"),
    /No durable execution record exists for task task-missing/
  );
  await assert.rejects(
    ledger.setWorkspace("task-missing", {
      workspacePath: path.join(root, "worktree"),
      branchName: "devbot/task/task-missing",
      baseBranch: "abc",
      isolated: true
    }),
    /No durable execution record exists for task task-missing/
  );
  await assert.rejects(
    ledger.setChild("task-missing", {
      pid: 12345,
      startedAt: "Mon Jan  1 00:00:00 2001",
      command: "codex"
    }),
    /No durable execution record exists for task task-missing/
  );
  assert.deepEqual(await ledger.listActive(), []);
});

test("worker identity and work-started phase are committed atomically before stdin may be sent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-recovery-start-child-"));
  const ledger = new ExecutionLedger(path.join(root, "executions.json"));
  await ledger.record({
    taskId: "task-atomic-child",
    projectName: "demo",
    mode: "action",
    requester: "tester",
    startedAt: new Date().toISOString()
  });
  await ledger.setPhase("task-atomic-child", "spawning-worker");
  await ledger.startChild("task-atomic-child", {
    pid: 12345,
    groupId: 12345,
    startedAt: "Mon Jan  1 00:00:00 2001",
    command: "codex"
  });

  const record = await new ExecutionLedger(path.join(root, "executions.json")).get("task-atomic-child");
  assert.equal(record?.phase, "running-codex");
  assert.deepEqual(record?.child, {
    pid: 12345,
    groupId: 12345,
    startedAt: "Mon Jan  1 00:00:00 2001",
    command: "codex"
  });
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

test("an unconfirmed hard kill keeps the execution record and reports unverified cleanup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-recovery-unconfirmed-"));
  const taskFile = path.join(root, "tasks.json");
  const ledgerFile = path.join(root, "executions.json");

  const store = new TaskStore(taskFile);
  const task = await store.start({
    source: "test",
    mode: "action",
    projectName: "demo",
    requester: "tester",
    requesterId: "42",
    text: "still writing"
  });
  const ledger = new ExecutionLedger(ledgerFile);
  await ledger.record({
    taskId: task.id,
    projectName: "demo",
    mode: "action",
    requester: "tester",
    startedAt: task.startedAt
  });
  await ledger.setChild(task.id, { pid: 987654, startedAt: "Mon Jan  1 00:00:00 2001", command: "node" });

  const notices: InterruptedTaskNotice[] = [];
  const summary = await reconcileInterruptedTasks({
    ledger: new ExecutionLedger(ledgerFile),
    tasks: new TaskStore(taskFile),
    terminate: async () => "kill-unconfirmed",
    notify: async (notice) => {
      notices.push(notice);
    }
  });

  assert.equal(summary.interruptedTasks, 1);
  assert.equal(summary.orphansStopped, 0);
  assert.equal(summary.staleRecordsCleared, 0);
  assert.equal(notices[0]?.childOutcome, "kill-unconfirmed");
  const retained = await new ExecutionLedger(ledgerFile).listActive();
  assert.equal(retained.length, 1);
  assert.equal(retained[0]?.taskId, task.id);
  const recovered = await new TaskStore(taskFile).get(task.id);
  assert.equal(recovered?.status, "interrupted");
  assert.match(recovered?.error ?? "", /exit could not be confirmed/);
  assert.equal(/stopped with an observed exit/.test(recovered?.error ?? ""), false);
});

test("a durable record whose hard kill stays unconfirmed is reconciled again on the next restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-recovery-tworestart-"));
  const taskFile = path.join(root, "tasks.json");
  const ledgerFile = path.join(root, "executions.json");

  const store = new TaskStore(taskFile);
  const task = await store.start({
    source: "test",
    mode: "action",
    projectName: "demo",
    requester: "tester",
    requesterId: "42",
    text: "still writing"
  });
  const ledger = new ExecutionLedger(ledgerFile);
  await ledger.record({
    taskId: task.id,
    projectName: "demo",
    mode: "action",
    requester: "tester",
    startedAt: task.startedAt
  });
  await ledger.setChild(task.id, { pid: 987654, startedAt: "Mon Jan  1 00:00:00 2001", command: "node" });

  const outcomes: OrphanTerminationOutcome[] = ["kill-unconfirmed", "already-exited"];
  let terminateCalls = 0;
  const terminate = async (): Promise<OrphanTerminationOutcome> => {
    const outcome = outcomes[terminateCalls] ?? "already-exited";
    terminateCalls += 1;
    return outcome;
  };

  // First restart: the worker's exit is unconfirmed, so the record survives and
  // the task is held with cleanup pending rather than cleared as stale.
  const first = await reconcileInterruptedTasks({
    ledger: new ExecutionLedger(ledgerFile),
    tasks: new TaskStore(taskFile),
    terminate
  });
  assert.equal(terminateCalls, 1);
  assert.equal(first.interruptedTasks, 1);
  assert.equal(first.orphansStopped, 0);
  assert.equal(first.staleRecordsCleared, 0);
  const afterFirst = await new ExecutionLedger(ledgerFile).listActive();
  assert.equal(afterFirst.length, 1);
  assert.equal(afterFirst[0]?.taskId, task.id);
  const heldTask = await new TaskStore(taskFile).get(task.id);
  assert.equal(heldTask?.status, "interrupted");
  assert.equal(heldTask?.cleanupPending, true);

  // Second restart: the task is no longer running, but the retained record must
  // still be reconciled and termination retried until the exit is observed.
  const second = await reconcileInterruptedTasks({
    ledger: new ExecutionLedger(ledgerFile),
    tasks: new TaskStore(taskFile),
    terminate
  });
  assert.equal(terminateCalls, 2);
  assert.equal(second.interruptedTasks, 0);
  const afterSecond = await new ExecutionLedger(ledgerFile).listActive();
  assert.equal(afterSecond.length, 0);
  const clearedTask = await new TaskStore(taskFile).get(task.id);
  assert.equal(clearedTask?.status, "interrupted");
  assert.notEqual(clearedTask?.cleanupPending, true);
});

test("retry is refused while an interrupted task's worker cleanup is unconfirmed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-recovery-orphanretry-"));
  const taskFile = path.join(root, "tasks.json");
  const ledgerFile = path.join(root, "executions.json");

  const store = new TaskStore(taskFile);
  const task = await store.start({
    source: "test",
    mode: "action",
    projectName: "demo",
    requester: "tester",
    requesterId: "42",
    text: "still writing"
  });
  const ledger = new ExecutionLedger(ledgerFile);
  await ledger.record({
    taskId: task.id,
    projectName: "demo",
    mode: "action",
    requester: "tester",
    startedAt: task.startedAt
  });
  await ledger.setChild(task.id, { pid: 987654, startedAt: "Mon Jan  1 00:00:00 2001", command: "node" });

  await reconcileInterruptedTasks({
    ledger: new ExecutionLedger(ledgerFile),
    tasks: new TaskStore(taskFile),
    terminate: async () => "kill-unconfirmed"
  });

  const pending = await new TaskStore(taskFile).get(task.id);
  assert.ok(pending);
  assert.equal(pending?.status, "interrupted");
  assert.equal(pending?.cleanupPending, true);

  // The orphaned worker may still be alive, so retry/resume must be refused
  // while dismiss stays available.
  assert.equal(taskActionMatchesState("retry", pending!), false);
  assert.equal(taskActionMatchesState("dismiss", pending!), true);

  const controlButtons = taskActionRows(pending!, {
    canControl: true,
    safeMode: false,
    hasChecks: false,
    canRecover: true
  })
    .flatMap((row) => row.components)
    .map((component) => component.toJSON() as { custom_id: string; disabled?: boolean });
  const retryControl = controlButtons.find((component) => component.custom_id.includes(":retry:"));
  assert.ok(retryControl, "the retry control should be present but refused, not silently missing");
  assert.equal(retryControl?.disabled, true);

  const noticeRetry = interruptedTaskNoticeRow(task.id, { mode: "action", safeMode: false, cleanupPending: true }).components
    .map((component) => component.toJSON() as { custom_id: string; disabled?: boolean })
    .find((component) => component.custom_id.includes(":retry:"));
  assert.equal(noticeRetry?.disabled, true);

  // Once cleanup is confirmed on a later restart the record clears and retry is
  // authorized again.
  await reconcileInterruptedTasks({
    ledger: new ExecutionLedger(ledgerFile),
    tasks: new TaskStore(taskFile),
    terminate: async () => "already-exited"
  });
  const confirmed = await new TaskStore(taskFile).get(task.id);
  assert.notEqual(confirmed?.cleanupPending, true);
  assert.equal(taskActionMatchesState("retry", confirmed!), true);
});

test("a child that survives the post-SIGKILL wait is reported unconfirmed, not killed", posixOnly, async () => {
  const child = spawn("/bin/sh", ["-c", 'trap "" TERM; while true; do sleep 1; done'], {
    stdio: "ignore",
    detached: true
  });
  child.unref();
  assert.ok(child.pid);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    const identity = await captureChildIdentity(child.pid!);
    assert.ok(identity);
    const outcome = await terminateOrphanedChild(identity!, { gracePeriodMs: 150, killWaitMs: 0, pollIntervalMs: 25 });
    assert.equal(outcome, "kill-unconfirmed");
    assert.match(interruptionNote(undefined, "kill-unconfirmed"), /could not be confirmed/);
  } finally {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // Already stopped.
    }
    try {
      process.kill(child.pid!, "SIGKILL");
    } catch {
      // Already stopped.
    }
    await exited;
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

test("dismissing an interrupted task cannot wash away the ledger-derived retry gate, and a restart re-derives it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-recovery-dismissretry-"));
  const taskFile = path.join(root, "tasks.json");
  const ledgerFile = path.join(root, "executions.json");

  const store = new TaskStore(taskFile);
  const task = await store.start({
    source: "test",
    mode: "action",
    projectName: "demo",
    requester: "tester",
    requesterId: "42",
    text: "still writing"
  });
  const ledger = new ExecutionLedger(ledgerFile);
  await ledger.record({
    taskId: task.id,
    projectName: "demo",
    mode: "action",
    requester: "tester",
    startedAt: task.startedAt
  });
  await ledger.setPhase(task.id, "running-codex");
  await ledger.setChild(task.id, { pid: 987654, startedAt: "Mon Jan  1 00:00:00 2001", command: "node" });

  // Restart: the worker's exit stays unconfirmed, so the task is held with
  // cleanup pending and the durable record is retained.
  await reconcileInterruptedTasks({
    ledger: new ExecutionLedger(ledgerFile),
    tasks: new TaskStore(taskFile),
    terminate: async () => "kill-unconfirmed"
  });
  assert.equal(await new ExecutionLedger(ledgerFile).hasUnresolvedWorker(task.id), true);
  assert.equal((await new TaskStore(taskFile).get(task.id))?.cleanupPending, true);

  // Dismiss converts the interrupted task to canceled and drops cleanupPending.
  const dismissStore = new TaskStore(taskFile);
  const dismissed = await dismissStore.dismiss(task.id, "tester");
  assert.equal(dismissed?.status, "canceled");
  assert.notEqual(dismissed?.cleanupPending, true);

  // The retry gate is derived from the durable ledger, not the task status, so
  // it still refuses retry even though the task is now canceled.
  assert.equal(await new ExecutionLedger(ledgerFile).hasUnresolvedWorker(task.id), true);

  // A later restart re-derives the same gate: the record is still retained and
  // the worker stays unresolved. Dismissal did not clear the ledger.
  const afterRestart = await reconcileInterruptedTasks({
    ledger: new ExecutionLedger(ledgerFile),
    tasks: new TaskStore(taskFile),
    terminate: async () => "kill-unconfirmed"
  });
  assert.equal(afterRestart.staleRecordsCleared, 0);
  assert.equal((await new ExecutionLedger(ledgerFile).listActive()).length, 1);
  assert.equal(await new ExecutionLedger(ledgerFile).hasUnresolvedWorker(task.id), true);

  // Only once cleanup is positively confirmed does the gate lift.
  await reconcileInterruptedTasks({
    ledger: new ExecutionLedger(ledgerFile),
    tasks: new TaskStore(taskFile),
    terminate: async () => "already-exited"
  });
  assert.equal((await new ExecutionLedger(ledgerFile).listActive()).length, 0);
  assert.equal(await new ExecutionLedger(ledgerFile).hasUnresolvedWorker(task.id), false);
});

test("a worker spawned but never recorded (crash at spawn) keeps retry blocked and is not cleared as stale", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-recovery-crashspawn-"));
  const taskFile = path.join(root, "tasks.json");
  const ledgerFile = path.join(root, "executions.json");

  const store = new TaskStore(taskFile);
  const task = await store.start({
    source: "test",
    mode: "action",
    projectName: "demo",
    requester: "tester",
    requesterId: "42",
    text: "still writing"
  });
  // The runtime crashed after the worker was spawned but before its identity was
  // written: the record reached running-codex with no captured child.
  const ledger = new ExecutionLedger(ledgerFile);
  await ledger.record({
    taskId: task.id,
    projectName: "demo",
    mode: "action",
    requester: "tester",
    startedAt: task.startedAt
  });
  await ledger.setPhase(task.id, "running-codex");

  let terminateCalls = 0;
  const summary = await reconcileInterruptedTasks({
    ledger: new ExecutionLedger(ledgerFile),
    tasks: new TaskStore(taskFile),
    terminate: async () => {
      terminateCalls += 1;
      return "already-exited";
    }
  });

  // No child identity to signal, but the possibly-untracked worker must not be
  // cleared as stale, and the task stays retry-blocked.
  assert.equal(terminateCalls, 0);
  assert.equal(summary.interruptedTasks, 1);
  assert.equal(summary.staleRecordsCleared, 0);
  const held = await new TaskStore(taskFile).get(task.id);
  assert.equal(held?.status, "interrupted");
  assert.equal(held?.cleanupPending, true);
  assert.equal(taskActionMatchesState("dismiss", held!), true);
  assert.equal(await new ExecutionLedger(ledgerFile).hasUnresolvedWorker(task.id), true);
  assert.equal((await new ExecutionLedger(ledgerFile).listActive()).length, 1);

  // A record that never reached the worker-spawn phase started no worker, so it
  // is cleared as stale and does not block retry.
  const noWorkerLedger = new ExecutionLedger(ledgerFile);
  await noWorkerLedger.record({
    taskId: "task-noworker",
    projectName: "demo",
    mode: "action",
    requester: "tester",
    startedAt: new Date().toISOString()
  });
  await noWorkerLedger.setPhase("task-noworker", "gathering-context");
  assert.equal(await new ExecutionLedger(ledgerFile).hasUnresolvedWorker("task-noworker"), false);
});

test("terminal settlement retains an unconfirmed worker and clears it only after group cleanup is observed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-recovery-settle-"));
  const ledgerFile = path.join(root, "executions.json");
  const ledger = new ExecutionLedger(ledgerFile);
  await ledger.record({
    taskId: "task-settle",
    projectName: "demo",
    mode: "action",
    requester: "tester",
    startedAt: new Date().toISOString()
  });
  await ledger.startChild("task-settle", {
    pid: 987654,
    groupId: 987654,
    startedAt: "Mon Jan  1 00:00:00 2001",
    command: "codex"
  });
  const cleanupStates: boolean[] = [];
  const tasks = {
    setCleanupPending: async (_taskId: string, pending: boolean) => {
      cleanupStates.push(pending);
      return undefined;
    }
  };

  const first = await settleExecutionRecord({
    ledger,
    tasks,
    taskId: "task-settle",
    terminate: async () => "kill-unconfirmed"
  });
  assert.equal(first, "kill-unconfirmed");
  assert.equal((await new ExecutionLedger(ledgerFile).listActive()).length, 1);
  assert.deepEqual(cleanupStates, [true]);

  const second = await settleExecutionRecord({
    ledger,
    tasks,
    taskId: "task-settle",
    terminate: async () => "killed"
  });
  assert.equal(second, "killed");
  assert.equal((await new ExecutionLedger(ledgerFile).listActive()).length, 0);
  assert.deepEqual(cleanupStates, [true, false]);
});

test("a crash in spawning-worker before identity persistence is safe to clear because stdin was withheld", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-recovery-spawning-"));
  const ledgerFile = path.join(root, "executions.json");
  const ledger = new ExecutionLedger(ledgerFile);
  await ledger.record({
    taskId: "task-spawning",
    projectName: "demo",
    mode: "action",
    requester: "tester",
    startedAt: new Date().toISOString()
  });
  await ledger.setPhase("task-spawning", "spawning-worker");

  const outcome = await settleExecutionRecord({
    ledger,
    tasks: { setCleanupPending: async () => undefined },
    taskId: "task-spawning"
  });
  assert.equal(outcome, "no-child");
  assert.equal((await new ExecutionLedger(ledgerFile).listActive()).length, 0);
});

test("orphan cleanup reaps same-group descendants after the recorded leader exits", posixOnly, async () => {
  const leader = spawn("/bin/sh", ["-c", "sleep 60 & sleep 0.5"], {
    detached: true,
    stdio: "ignore"
  });
  assert.ok(leader.pid);
  const groupId = leader.pid!;
  const leaderClosed = new Promise<void>((resolve) => leader.once("close", () => resolve()));
  try {
    let identity;
    for (let attempt = 0; attempt < 20 && !identity; attempt += 1) {
      identity = await captureChildIdentity(leader.pid!);
      if (!identity) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(identity);
    assert.equal(identity!.groupId, groupId);
    await leaderClosed;

    // The shell leader is gone, but its background sleep still owns the group.
    assert.throws(() => process.kill(leader.pid!, 0));
    assert.doesNotThrow(() => process.kill(-groupId, 0));

    const outcome = await terminateOrphanedChild(identity!, {
      gracePeriodMs: 500,
      killWaitMs: 500,
      pollIntervalMs: 25
    });
    assert.equal(outcome === "terminated" || outcome === "killed", true);
    assert.throws(() => process.kill(-groupId, 0));
  } finally {
    try {
      process.kill(-groupId, "SIGKILL");
    } catch {
      // Group was already reaped.
    }
  }
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
