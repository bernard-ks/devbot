import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ScreenshotFixStore } from "./screenshot-fix-store.js";

test("screenshot-fix store creates, persists, and removes pending analyses", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-snapfix-store-"));
  const filePath = path.join(root, "screenshot-fixes.json");
  const store = new ScreenshotFixStore(filePath);

  const record = await store.create({
    projectName: "pullprice",
    requesterId: "user-1",
    transcription: "TypeError: x is not a function",
    location: "src/index.ts:10",
    approach: "Check that x is defined before calling it."
  });

  assert.ok(record.id.startsWith("snapfix-"));

  const reloaded = new ScreenshotFixStore(filePath);
  const fetched = await reloaded.get(record.id);
  assert.equal(fetched?.projectName, "pullprice");
  assert.equal(fetched?.requesterId, "user-1");
  assert.equal(fetched?.transcription, "TypeError: x is not a function");

  await reloaded.remove(record.id);
  assert.equal(await reloaded.get(record.id), undefined);
  assert.equal(await new ScreenshotFixStore(filePath).get(record.id), undefined);
});

test("screenshot-fix store hardens the state directory and file to owner-only permissions", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(path.join(tmpdir(), "devbot-snapfix-store-perms-"));
  const filePath = path.join(root, "nested", "screenshot-fixes.json");
  const store = new ScreenshotFixStore(filePath);

  await store.create({
    projectName: "pullprice",
    requesterId: "user-1",
    transcription: "error",
    location: "unknown",
    approach: "n/a"
  });

  const dirStats = await stat(path.dirname(filePath));
  const fileStats = await stat(filePath);
  assert.equal(dirStats.mode & 0o777, 0o700);
  assert.equal(fileStats.mode & 0o777, 0o600);
});

test("screenshot-fix store hardens a pre-existing state file left with loose permissions", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(path.join(tmpdir(), "devbot-snapfix-store-preexisting-"));
  const filePath = path.join(root, "screenshot-fixes.json");
  await writeFile(filePath, JSON.stringify({ version: 1, records: [] }), { mode: 0o644 });

  const store = new ScreenshotFixStore(filePath);
  await store.get("snapfix-any");

  const fileStats = await stat(filePath);
  assert.equal(fileStats.mode & 0o777, 0o600);
});

test("screenshot-fix store redacts secret-shaped text in transcription, location, and approach before persisting", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-snapfix-store-redact-"));
  const filePath = path.join(root, "screenshot-fixes.json");
  const store = new ScreenshotFixStore(filePath);

  const record = await store.create({
    projectName: "pullprice",
    requesterId: "user-1",
    transcription: "Error: AKIAABCDEFGHIJKLMNOP leaked in stack trace",
    location: "token=sk-abcdefghijklmnopqrstuvwx",
    approach: "n/a"
  });

  assert.doesNotMatch(record.transcription, /AKIAABCDEFGHIJKLMNOP/);
  assert.match(record.transcription, /\[REDACTED/);
  assert.doesNotMatch(record.location, /sk-abcdefghijklmnopqrstuvwx/);

  const raw = await new ScreenshotFixStore(filePath).get(record.id);
  assert.doesNotMatch(raw?.transcription ?? "", /AKIAABCDEFGHIJKLMNOP/);
});

test("screenshot-fix store rejects malformed lookups, fails loudly on malformed state, and rejects an unsupported version", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-snapfix-store-bad-"));
  const filePath = path.join(root, "screenshot-fixes.json");
  const store = new ScreenshotFixStore(filePath);
  assert.equal(await store.get("../../etc/passwd"), undefined);

  const badFile = path.join(root, "corrupt.json");
  await writeFile(badFile, "{ not json");
  const corrupted = new ScreenshotFixStore(badFile);
  await assert.rejects(corrupted.get("snapfix-abc"), /Unable to read screenshot-fix state/);

  const futureVersionFile = path.join(root, "future.json");
  await writeFile(futureVersionFile, JSON.stringify({ version: 2, records: [] }));
  const futureVersioned = new ScreenshotFixStore(futureVersionFile);
  await assert.rejects(futureVersioned.get("snapfix-abc"), /Unsupported screenshot-fix state version/);
});

test("screenshot-fix store drops malformed persisted records instead of trusting them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-snapfix-store-malformed-"));
  const filePath = path.join(root, "screenshot-fixes.json");
  await writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      records: [
        { id: "snapfix-good-1", projectName: "pullprice", requesterId: "user-1", transcription: "e", location: "l", approach: "a", createdAt: new Date().toISOString() },
        { id: "not-a-valid-id", projectName: "pullprice", requesterId: "user-1", transcription: "e", location: "l", approach: "a" },
        { id: "snapfix-missing-fields" }
      ]
    })
  );

  const store = new ScreenshotFixStore(filePath);
  assert.ok(await store.get("snapfix-good-1"));
  assert.equal(await store.get("not-a-valid-id"), undefined);
  assert.equal(await store.get("snapfix-missing-fields"), undefined);
});

test("screenshot-fix store serializes concurrent creates without losing records", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-snapfix-store-concurrent-"));
  const filePath = path.join(root, "screenshot-fixes.json");
  const store = new ScreenshotFixStore(filePath);

  const records = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      store.create({
        projectName: "pullprice",
        requesterId: `user-${index}`,
        transcription: `error ${index}`,
        location: "unknown",
        approach: "n/a"
      })
    )
  );

  const reloaded = new ScreenshotFixStore(filePath);
  for (const record of records) {
    const fetched = await reloaded.get(record.id);
    assert.equal(fetched?.requesterId, record.requesterId);
  }
});
