import assert from "node:assert/strict";
import test from "node:test";
import { findProjectReference, requireProjectReference, roomProjectConflict } from "./project-routing.js";
import type { ProjectEntry } from "./types.js";

test("project references prefer an exact name and reject ambiguous metadata matches", () => {
  const exact = project("devbot", { aliases: ["shared"] });
  const aliased = project("tools", { aliases: ["devbot", "shared"] });
  assert.equal(requireProjectReference([aliased, exact], "devbot").name, "devbot");
  assert.throws(() => requireProjectReference([exact, aliased], "shared"), /Ambiguous project reference: shared/);
  assert.equal(findProjectReference([project("api", { canonicalName: "Service API" })], "service api")?.name, "api");
  assert.throws(() => requireProjectReference([exact], "missing"), /Unknown project: missing/);
});

test("a requested slash project cannot conflict with a bound room project", () => {
  const devbot = project("devbot");
  const pullprice = project("pullprice");
  assert.equal(roomProjectConflict(devbot, devbot), false);
  assert.equal(roomProjectConflict(undefined, devbot), false);
  assert.equal(roomProjectConflict(pullprice, devbot), true);
});

function project(name: string, metadata: Partial<ProjectEntry["metadata"]> = {}): ProjectEntry {
  return {
    name,
    root: `/tmp/${name}`,
    metadata: {
      canonicalName: metadata.canonicalName,
      repoUrl: undefined,
      defaultBranch: "main",
      frontendUrl: undefined,
      backendUrl: undefined,
      ownerBot: undefined,
      aliases: metadata.aliases ?? [],
      commands: {
        test: [],
        build: [],
        lint: [],
        verify: [],
        presets: {}
      },
      policy: {
        visibility: "private",
        allowedUsers: [],
        allowedUsernames: [],
        allowedRoles: [],
        allowedPeers: [],
        screenshotPolicy: "allow",
        maxContextChars: undefined,
        readOnlyCommands: [],
        approvalRequiredCommands: []
      },
      ...metadata
    }
  };
}
