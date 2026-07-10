import assert from "node:assert/strict";
import test from "node:test";
import {
  isAccessSubjectAllowed,
  requesterHasGlobalAccess,
  requesterHasProjectAccess,
  type AccessAllowLists,
  type AccessSubject,
  type GlobalAccessPolicy,
  type ProjectAccessPolicy,
  type RequesterIdentity
} from "./access.js";
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

function globalPolicy(overrides: Partial<GlobalAccessPolicy> = {}): GlobalAccessPolicy {
  return {
    ownerUserId: "owner",
    allowedUserIds: new Set<string>(),
    allowedUsernames: new Set<string>(),
    allowedRoleIds: new Set<string>(),
    ...overrides
  };
}

function identity(id: string, overrides: Partial<RequesterIdentity> = {}): RequesterIdentity {
  return {
    id,
    username: id,
    tag: `${id}#0`,
    roleIds: [],
    ...overrides
  };
}

test("global re-auth denies non-owners when the allowlist is empty (deny-by-default)", () => {
  // Corrected from the prior allow-all policy. Live access is deny-by-default
  // (isAccessSubjectAllowed): empty allowlists no longer reauthorize everyone. Only the
  // configured owner passes; anyone else is refused.
  const policy = globalPolicy();
  assert.equal(requesterHasGlobalAccess(policy, "owner", identity("owner")), true);
  assert.equal(requesterHasGlobalAccess(policy, "anyone", identity("anyone")), false);
});

test("global re-auth refuses persisted work when the final allowlist entry is cleared", () => {
  // Bernard's exact reproduction: removing the last allowlist entry must not reauthorize a
  // revoked user's queued/scheduled work.
  const withEntry = globalPolicy({ allowedUserIds: new Set(["revoked"]) });
  assert.equal(requesterHasGlobalAccess(withEntry, "revoked", identity("revoked")), true);
  const cleared = globalPolicy();
  assert.equal(requesterHasGlobalAccess(cleared, "revoked", identity("revoked")), false);
});

test("global re-auth refuses execution when no owner is configured", () => {
  // A missing configured owner is deny-all, even for an id that is otherwise on the allowlist.
  const policy = globalPolicy({ ownerUserId: undefined, allowedUserIds: new Set(["listed"]) });
  assert.equal(requesterHasGlobalAccess(policy, "listed", identity("listed")), false);
  assert.equal(requesterHasGlobalAccess(policy, "anyone", identity("anyone")), false);
});

test("global re-auth denies a user revoked from the allowlist even on the unrestricted path", () => {
  // The exact blocker: a global allowlist exists but the requester is no longer on it. Previously
  // an unrestricted project short-circuited to allow; now global access is rechecked first.
  const policy = globalPolicy({ allowedUserIds: new Set(["still-allowed"]) });
  assert.equal(requesterHasGlobalAccess(policy, "still-allowed", identity("still-allowed")), true);
  assert.equal(requesterHasGlobalAccess(policy, "revoked", identity("revoked")), false);
});

test("global re-auth honors username and role membership, and always allows the owner", () => {
  assert.equal(requesterHasGlobalAccess(globalPolicy({ allowedUsernames: new Set(["tester"]) }), "u1", identity("u1", { username: "Tester", tag: "Tester#1" })), true);
  assert.equal(requesterHasGlobalAccess(globalPolicy({ allowedRoleIds: new Set(["role-1"]) }), "u2", identity("u2", { roleIds: ["role-0", "role-1"] })), true);
  assert.equal(requesterHasGlobalAccess(globalPolicy({ allowedUserIds: new Set(["someone"]) }), "owner", identity("owner")), true);
});

test("global re-auth fails closed for unknown/unresolved requesters", () => {
  const policy = globalPolicy({ allowedUsernames: new Set(["ghost"]) });
  assert.equal(requesterHasGlobalAccess(policy, "unknown", undefined), false);
  assert.equal(requesterHasGlobalAccess(policy, "", identity("")), false);
  // Member left the server (identity undefined): a username/role-only match can no longer be
  // proven, so access is denied even though the name would have matched.
  assert.equal(requesterHasGlobalAccess(policy, "ghost", undefined), false);
});

function projectPolicy(overrides: Partial<ProjectAccessPolicy> = {}): ProjectAccessPolicy {
  return { allowedUsers: [], allowedUsernames: [], allowedRoles: [], ...overrides };
}

test("project re-auth allows all on an unrestricted project but re-checks a restricted one", () => {
  assert.equal(requesterHasProjectAccess(projectPolicy(), "anyone", identity("anyone")), true);
  const restricted = projectPolicy({ allowedUsers: ["member-1"] });
  assert.equal(requesterHasProjectAccess(restricted, "member-1", identity("member-1")), true);
  assert.equal(requesterHasProjectAccess(restricted, "member-2", identity("member-2")), false);
});

test("project re-auth fails closed when a role-scoped member can no longer be resolved", () => {
  const restricted = projectPolicy({ allowedRoles: ["role-1"] });
  assert.equal(requesterHasProjectAccess(restricted, "member-1", identity("member-1", { roleIds: ["role-1"] })), true);
  assert.equal(requesterHasProjectAccess(restricted, "member-1", undefined), false);
});
