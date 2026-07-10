import assert from "node:assert/strict";
import test from "node:test";
import { isAccessSubjectAllowed, type AccessAllowLists, type AccessSubject } from "./access.js";
import { applySetupState, captureBootstrapConfig } from "./runtime-setup.js";
import type { SetupState } from "./setup-store.js";
import type { AppConfig } from "./types.js";

function allowLists(overrides: Partial<AccessAllowLists> = {}): AccessAllowLists {
  return {
    ownerUserId: "owner",
    allowedUserIds: new Set<string>(),
    allowedUsernames: new Set<string>(),
    allowedRoleIds: new Set<string>(),
    ...overrides
  };
}

function subject(userId: string, overrides: Partial<AccessSubject> = {}): AccessSubject {
  return {
    userId,
    nameSource: { username: userId, tag: `${userId}#0` },
    ...overrides
  };
}

function setupState(overrides: Partial<SetupState> = {}): SetupState {
  return {
    version: 1,
    viewerUserIds: [],
    controllerUserIds: [],
    peerBotIds: [],
    repositories: {},
    projectRoomIds: {},
    previewTunnelsEnabled: false,
    previewEnabledProjects: [],
    ...overrides
  };
}

test("access is deny-by-default: unlisted users are refused even when every allowlist is empty", () => {
  const config = allowLists();
  assert.equal(isAccessSubjectAllowed(subject("stranger"), config), false);
  assert.equal(isAccessSubjectAllowed(subject("stranger", { roleIds: ["some-role"] }), config), false);
});

test("access is refused entirely when no owner is configured", () => {
  const config = allowLists({ ownerUserId: undefined, allowedUserIds: new Set(["listed-user"]) });
  assert.equal(isAccessSubjectAllowed(subject("listed-user"), config), false);
});

test("the owner is always allowed", () => {
  assert.equal(isAccessSubjectAllowed(subject("owner"), allowLists()), true);
});

test("setup-managed viewers and controllers are allowed through the folded runtime allowlist", () => {
  const config = {
    ownerUserId: "owner",
    allowedUserIds: new Set<string>(),
    allowedUsernames: new Set<string>(),
    allowedRoleIds: new Set<string>(),
    peerBotIds: new Set<string>(),
    coordinationChannelId: undefined,
    projects: []
  } as unknown as AppConfig;
  const bootstrap = captureBootstrapConfig(config);
  applySetupState(config, bootstrap, setupState({ viewerUserIds: ["viewer-1"], controllerUserIds: ["controller-1"] }));

  assert.equal(isAccessSubjectAllowed(subject("viewer-1"), config), true);
  assert.equal(isAccessSubjectAllowed(subject("controller-1"), config), true);
  assert.equal(isAccessSubjectAllowed(subject("owner"), config), true);
  assert.equal(isAccessSubjectAllowed(subject("stranger"), config), false);
});

test("explicit user id, username, and role allowlist entries each grant access", () => {
  const byId = allowLists({ allowedUserIds: new Set(["user-1"]) });
  assert.equal(isAccessSubjectAllowed(subject("user-1"), byId), true);
  assert.equal(isAccessSubjectAllowed(subject("user-2"), byId), false);

  const byName = allowLists({ allowedUsernames: new Set(["tester"]) });
  assert.equal(isAccessSubjectAllowed(subject("user-3", { nameSource: { username: "Tester", tag: "Tester#1" } }), byName), true);
  assert.equal(isAccessSubjectAllowed(subject("user-4", { nameSource: { username: "other" } }), byName), false);

  const byRole = allowLists({ allowedRoleIds: new Set(["role-1"]) });
  assert.equal(isAccessSubjectAllowed(subject("user-5", { roleIds: ["role-0", "role-1"] }), byRole), true);
  assert.equal(isAccessSubjectAllowed(subject("user-6", { roleIds: ["role-0"] }), byRole), false);
});

test("message authors without guild membership only pass via user or username entries", () => {
  const config = allowLists({ allowedRoleIds: new Set(["role-1"]) });
  assert.equal(isAccessSubjectAllowed(subject("dm-author", { roleIds: [] }), config), false);
  assert.equal(isAccessSubjectAllowed(subject("dm-author"), config), false);
  const named = allowLists({ allowedUsernames: new Set(["dm-author"]) });
  assert.equal(isAccessSubjectAllowed(subject("dm-author", { roleIds: [] }), named), true);
});

test("guild members outside the allowlists are excluded from workroom audiences", () => {
  const config = allowLists({ allowedUserIds: new Set(["member-1"]), allowedRoleIds: new Set(["role-1"]) });
  assert.equal(isAccessSubjectAllowed(subject("member-1", { roleIds: [] }), config), true);
  assert.equal(isAccessSubjectAllowed(subject("member-2", { roleIds: ["role-1"] }), config), true);
  assert.equal(isAccessSubjectAllowed(subject("member-3", { roleIds: ["role-2"] }), config), false);
});
