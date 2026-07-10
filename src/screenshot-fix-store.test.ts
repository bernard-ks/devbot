import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
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
    requesterTag: "tester#0001",
    transcription: "TypeError: x is not a function",
    location: "src/index.ts:10",
    approach: "Check that x is defined before calling it."
  });

  assert.ok(record.id.startsWith("snapfix-"));

  const reloaded = new ScreenshotFixStore(filePath);
  const fetched = await reloaded.get(record.id);
  assert.equal(fetched?.projectName, "pullprice");
  assert.equal(fetched?.requesterTag, "tester#0001");
  assert.equal(fetched?.transcription, "TypeError: x is not a function");

  await reloaded.remove(record.id);
  assert.equal(await reloaded.get(record.id), undefined);
  assert.equal(await new ScreenshotFixStore(filePath).get(record.id), undefined);
});

test("screenshot-fix store rejects malformed lookups and fails loudly on malformed state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-snapfix-store-bad-"));
  const filePath = path.join(root, "screenshot-fixes.json");
  const store = new ScreenshotFixStore(filePath);
  assert.equal(await store.get("../../etc/passwd"), undefined);

  const badFile = path.join(root, "corrupt.json");
  await writeFile(badFile, "{ not json");
  const corrupted = new ScreenshotFixStore(badFile);
  await assert.rejects(corrupted.get("snapfix-abc"), /Unable to read screenshot-fix state/);
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
        requesterTag: `tester${index}#0001`,
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
