import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseScreenshotApprovalControl,
  persistScreenshotPolicy,
  ScreenshotApprovalStore,
  screenshotApprovalRow
} from "./screenshot-approval.js";

test("screenshot approvals are opaque, bounded, expiring, and single-use", () => {
  let now = 1_000;
  const store = new ScreenshotApprovalStore(() => now, 100, 2);
  const first = store.create({ projectName: "demo", requesterId: "user", target: "/", viewport: "desktop" });
  assert.equal(store.peek(first.id)?.target, "/");
  assert.equal(store.consume(first.id)?.id, first.id);
  assert.equal(store.consume(first.id), undefined);
  const expiring = store.create({ projectName: "demo", requesterId: "user", target: "/x", viewport: "mobile" });
  now += 101;
  assert.equal(store.peek(expiring.id), undefined);
});

test("concurrent screenshot claims produce exactly one winner", async () => {
  const store = new ScreenshotApprovalStore();
  const pending = store.create({
    projectName: "demo",
    requesterId: "requester",
    target: "home",
    viewport: "desktop"
  });
  const claims = await Promise.all([
    Promise.resolve().then(() => store.consume(pending.id)),
    Promise.resolve().then(() => store.consume(pending.id)),
    Promise.resolve().then(() => store.consume(pending.id))
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
});

test("screenshot approval controls parse strictly", () => {
  const id = "0123456789abcdef";
  const ids = screenshotApprovalRow(id).components.map((component) => {
    const data = component.toJSON();
    return "custom_id" in data ? data.custom_id : undefined;
  });
  assert.deepEqual(ids.map((customId) => parseScreenshotApprovalControl(customId ?? "")?.action), ["once", "always", "deny"]);
  assert.equal(parseScreenshotApprovalControl(`devbot:screenshot:v1:once:${id}:extra`), undefined);
  assert.equal(parseScreenshotApprovalControl("devbot:screenshot:v1:once:../../bad"), undefined);
});

test("screenshot policy persistence preserves unrelated project metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-screenshot-policy-"));
  await mkdir(path.join(root, ".devbot"));
  await writeFile(path.join(root, ".devbot", "project.json"), JSON.stringify({ name: "Demo", policy: { visibility: "team" } }));
  await chmod(path.join(root, ".devbot", "project.json"), 0o644);
  await Promise.all([persistScreenshotPolicy(root, "allow"), persistScreenshotPolicy(root, "deny")]);
  const saved = JSON.parse(await readFile(path.join(root, ".devbot", "project.json"), "utf8"));
  assert.deepEqual(saved, { name: "Demo", policy: { visibility: "team", screenshotPolicy: "deny" } });
  if (process.platform !== "win32") {
    assert.equal((await stat(path.join(root, ".devbot", "project.json"))).mode & 0o777, 0o644);
  }
});

test("screenshot policy persistence refuses symlinked metadata", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-screenshot-symlink-"));
  const outside = path.join(root, "outside.json");
  await writeFile(outside, "{}\n");
  await mkdir(path.join(root, ".devbot"));
  await symlink(outside, path.join(root, ".devbot", "project.json"));
  await assert.rejects(() => persistScreenshotPolicy(root, "allow"), /symlinked project metadata/);
});

test("screenshot policy persistence refuses a symlinked metadata directory", { skip: process.platform === "win32" }, async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "devbot-screenshot-directory-symlink-"));
  const root = path.join(fixture, "repo");
  const outside = path.join(fixture, "outside");
  await mkdir(root);
  await mkdir(outside);
  await symlink(outside, path.join(root, ".devbot"));
  await assert.rejects(() => persistScreenshotPolicy(root, "allow"), /symlinked project metadata/);
  await assert.rejects(() => readFile(path.join(outside, "project.json"), "utf8"), /ENOENT/);
});
