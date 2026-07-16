import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PeerStore, type PeerCapabilities } from "./peer.js";

function capabilities(name: string): PeerCapabilities {
  return {
    botName: name,
    owner: `owner-${name}`,
    projects: [`project-${name}`],
    commands: ["status", "review"],
    supportsScreenshots: true,
    safeMode: false
  };
}

test("PeerStore serializes concurrent mutations without losing peers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-peer-concurrency-"));
  const stateFile = path.join(root, "peers.json");
  const store = new PeerStore(stateFile);

  await Promise.all(Array.from({ length: 30 }, (_, index) =>
    store.upsert(`bot-${index}`, capabilities(String(index)))));

  const peers = await store.list();
  assert.equal(peers.length, 30);
  assert.equal(new Set(peers.map((peer) => peer.botId)).size, 30);
  const persisted = JSON.parse(await readFile(stateFile, "utf8")) as { version: number; peers: unknown[] };
  assert.equal(persisted.version, 1);
  assert.equal(persisted.peers.length, 30);
});

test("PeerStore does not expose mutable internal records or capability arrays", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-peer-clone-"));
  const store = new PeerStore(path.join(root, "peers.json"));
  const input = capabilities("alpha");
  const pendingUpsert = store.upsert("bot-alpha", input);
  input.projects.push("mutated-input");
  await pendingUpsert;
  const first = await store.list();
  first[0]!.botName = "mutated-result";
  first[0]!.projects.push("mutated-result");

  const second = await store.list();
  assert.equal(second[0]!.botName, "alpha");
  assert.deepEqual(second[0]!.projects, ["project-alpha"]);
});

test("PeerStore treats only a missing file as empty state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-peer-missing-"));
  const missingStore = new PeerStore(path.join(root, "missing.json"));
  assert.deepEqual(await missingStore.list(), []);

  const directoryPath = path.join(root, "not-a-file");
  await mkdir(directoryPath);
  const unreadableStore = new PeerStore(directoryPath);
  await assert.rejects(unreadableStore.list(), /Unable to read peer state/);
});

test("PeerStore reports corrupt state and leaves the original file recoverable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-peer-corrupt-"));
  const stateFile = path.join(root, "peers.json");
  const corrupt = "{ this is not valid JSON\n";
  await writeFile(stateFile, corrupt);
  const store = new PeerStore(stateFile);

  await assert.rejects(store.list(), /contains invalid JSON and was left unchanged/);
  await assert.rejects(store.upsert("bot-alpha", capabilities("alpha")), /contains invalid JSON and was left unchanged/);
  assert.equal(await readFile(stateFile, "utf8"), corrupt);

  await writeFile(stateFile, `${JSON.stringify({ version: 1, peers: [] })}\n`);
  await store.upsert("bot-alpha", capabilities("alpha"));
  assert.equal((await store.list())[0]?.botId, "bot-alpha");
});

test("PeerStore rejects invalid schemas rather than silently replacing them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-peer-schema-"));
  const stateFile = path.join(root, "peers.json");
  const unsupported = `${JSON.stringify({ version: 2, peers: [] })}\n`;
  await writeFile(stateFile, unsupported);
  const store = new PeerStore(stateFile);

  await assert.rejects(store.upsert("bot-alpha", capabilities("alpha")), /unsupported or invalid structure/);
  assert.equal(await readFile(stateFile, "utf8"), unsupported);
});
