import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { commandDefinitionsHash, syncCommandsIfChanged } from "./command-sync.js";

test("command sync deploys once per schema hash", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-command-sync-"));
  const stateFile = path.join(root, "commands.sha256");
  const calls: unknown[][] = [];
  const setCommands = async (definitions: unknown[]): Promise<void> => {
    calls.push(definitions);
  };

  assert.equal(await syncCommandsIfChanged({ definitions: [{ name: "ask" }], guildId: "guild", stateFile, setCommands }), true);
  assert.equal(await syncCommandsIfChanged({ definitions: [{ name: "ask" }], guildId: "guild", stateFile, setCommands }), false);
  assert.equal(await syncCommandsIfChanged({ definitions: [{ name: "ask" }], guildId: "other-guild", stateFile, setCommands }), true);
  assert.equal(await syncCommandsIfChanged({ definitions: [{ name: "do" }], guildId: "guild", stateFile, setCommands }), true);
  assert.equal(calls.length, 3);
  assert.notEqual(commandDefinitionsHash([{ name: "ask" }]), commandDefinitionsHash([{ name: "do" }]));
  assert.notEqual(commandDefinitionsHash([{ name: "ask" }], "guild"), commandDefinitionsHash([{ name: "ask" }], "other-guild"));
});

test("command sync never records a failed deployment", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-command-sync-failure-"));
  const stateFile = path.join(root, "commands.sha256");
  const failing = () => Promise.reject(new Error("Discord unavailable"));

  await assert.rejects(syncCommandsIfChanged({ definitions: [{ name: "ask" }], guildId: "guild", stateFile, setCommands: failing }));
  let calls = 0;
  assert.equal(
    await syncCommandsIfChanged({
      definitions: [{ name: "ask" }],
      guildId: "guild",
      stateFile,
      setCommands: async () => { calls += 1; }
    }),
    true
  );
  assert.equal(calls, 1);
});
