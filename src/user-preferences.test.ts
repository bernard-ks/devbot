import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { UserPreferenceStore } from "./user-preferences.js";

test("user project preferences persist and serialize concurrent updates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-preferences-"));
  const filePath = path.join(root, "preferences.json");
  const store = new UserPreferenceStore(filePath);

  await Promise.all([
    store.setSelectedProject("user-1", "Pull Price"),
    store.setSelectedProject("user-2", "api"),
    store.setSelectedProject("user-3", "docs")
  ]);

  const reloaded = new UserPreferenceStore(filePath);
  assert.equal(reloaded.selectedProject("user-1"), "pull-price");
  assert.equal(reloaded.selectedProject("user-2"), "api");
  assert.equal(reloaded.selectedProject("user-3"), "docs");

  await reloaded.clearSelectedProject("user-2");
  assert.equal(new UserPreferenceStore(filePath).selectedProject("user-2"), undefined);
});

test("user project preferences fail loudly on malformed state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-preferences-bad-"));
  const filePath = path.join(root, "preferences.json");
  await writeFile(filePath, "{ definitely not json\n");
  assert.throws(() => new UserPreferenceStore(filePath), /not valid JSON/);
});
