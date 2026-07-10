import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
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
