import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isVoiceNoteId, VoiceStore } from "./voice-store.js";

test("voice store persists a transcript and reloads it from disk", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-voice-store-"));
  const filePath = path.join(root, "voice-notes.json");
  const store = new VoiceStore(filePath);

  const record = await store.create({
    projectName: "webapp",
    requesterId: "user-1",
    requesterTag: "user#0001",
    transcript: "fix the failing test"
  });

  assert.equal(isVoiceNoteId(record.id), true);
  assert.equal(record.projectName, "webapp");

  const reloaded = new VoiceStore(filePath);
  const fetched = await reloaded.get(record.id);
  assert.equal(fetched?.transcript, "fix the failing test");
  assert.equal(fetched?.requesterTag, "user#0001");
});

test("voice store removes a note and reports it missing afterward", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-voice-store-remove-"));
  const store = new VoiceStore(path.join(root, "voice-notes.json"));
  const record = await store.create({
    projectName: "webapp",
    requesterId: "user-1",
    requesterTag: "user#0001",
    transcript: "add a health check endpoint"
  });

  await store.remove(record.id);
  assert.equal(await store.get(record.id), undefined);
  assert.equal(await store.get("voice-does-not-exist"), undefined);
});

test("voice store trims history beyond its retention limit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-voice-store-trim-"));
  const store = new VoiceStore(path.join(root, "voice-notes.json"), 2);
  const first = await store.create({ projectName: "a", requesterId: "u", requesterTag: "u#1", transcript: "one" });
  await store.create({ projectName: "a", requesterId: "u", requesterTag: "u#1", transcript: "two" });
  await store.create({ projectName: "a", requesterId: "u", requesterTag: "u#1", transcript: "three" });

  assert.equal(await store.get(first.id), undefined);
});

test("isVoiceNoteId rejects malformed and unsafe identifiers", () => {
  assert.equal(isVoiceNoteId("voice-abc123-def"), true);
  assert.equal(isVoiceNoteId("task-abc123"), false);
  assert.equal(isVoiceNoteId("voice-../../etc/passwd"), false);
  assert.equal(isVoiceNoteId(""), false);
});

test("voice store hardens the state file and its containing directory to owner-only permissions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-voice-store-perms-"));
  const filePath = path.join(root, "nested", "voice-notes.json");
  const store = new VoiceStore(filePath);
  await store.create({ projectName: "webapp", requesterId: "user-1", requesterTag: "user#0001", transcript: "hello" });

  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(filePath))).mode & 0o777, 0o700);
});

test("voice store redacts secret-shaped text before persisting and rejects a corrupt state file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-voice-store-redact-"));
  const filePath = path.join(root, "voice-notes.json");
  const store = new VoiceStore(filePath);
  const record = await store.create({
    projectName: "webapp",
    requesterId: "user-1",
    requesterTag: "user#0001",
    transcript: "use api_key=sk-abcdefghijklmnopqrstuvwxyz1234567890 to call the service"
  });

  assert.doesNotMatch(record.transcript, /sk-abcdefghijklmnopqrstuvwxyz1234567890/);
  const persisted = JSON.parse(await readFile(filePath, "utf8")) as { notes: Array<{ transcript: string }> };
  assert.doesNotMatch(persisted.notes[0]?.transcript ?? "", /sk-abcdefghijklmnopqrstuvwxyz1234567890/);

  await writeFile(path.join(root, "corrupt.json"), JSON.stringify([1, 2, 3]));
  const corrupt = new VoiceStore(path.join(root, "corrupt.json"));
  await assert.rejects(corrupt.get("voice-anything"));
});

test("voice store drops malformed or unsafe entries when loading legacy state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-voice-store-malformed-"));
  const filePath = path.join(root, "voice-notes.json");
  await writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      notes: [
        { id: "voice-good-1", projectName: "webapp", requesterId: "user-1", requesterTag: "user#0001", transcript: "ok", createdAt: "not-a-date" },
        { id: "../../etc/passwd", projectName: "webapp", requesterId: "user-1", requesterTag: "user#0001", transcript: "bad id" },
        { id: "voice-missing-fields" },
        "not even an object"
      ]
    })
  );

  const store = new VoiceStore(filePath);
  const good = await store.get("voice-good-1");
  assert.equal(good?.transcript, "ok");
  assert.equal(await store.get("../../etc/passwd"), undefined);
});
