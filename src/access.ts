export interface DiscordNameSource {
  username?: string | null | undefined;
  globalName?: string | null | undefined;
  tag?: string | null | undefined;
  displayName?: string | null | undefined;
}

export function normalizeDiscordUsername(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

export function normalizeDiscordUsernames(values: Iterable<string>): string[] {
  return [...new Set([...values].map(normalizeDiscordUsername).filter(Boolean))];
}

export function discordUsernamesFor(source: DiscordNameSource): string[] {
  const names = [
    source.username,
    source.tag,
    source.tag?.split("#")[0]
  ];

  return normalizeDiscordUsernames(names.filter((name): name is string => Boolean(name?.trim())));
}

export function isApprovedDiscordUsername(source: DiscordNameSource, approvedUsernames: ReadonlySet<string> | readonly string[]): boolean {
  const approved = approvedUsernames instanceof Set ? approvedUsernames : new Set(approvedUsernames);
  if (approved.size === 0) {
    return false;
  }

  return discordUsernamesFor(source).some((name) => approved.has(name));
}

export interface RequesterIdentity extends DiscordNameSource {
  id: string;
  roleIds: readonly string[];
}

export interface GlobalAccessPolicy {
  ownerUserId?: string | undefined;
  allowedUserIds: ReadonlySet<string>;
  allowedUsernames: ReadonlySet<string>;
  allowedRoleIds: ReadonlySet<string>;
}

export interface ProjectAccessPolicy {
  allowedUsers: readonly string[];
  allowedUsernames: readonly string[];
  allowedRoles: readonly string[];
}

/**
 * Re-checks a requester against the current global/setup-managed allowlist at the
 * queue/schedule execution boundary. Delegates to `isAccessSubjectAllowed`, the live
 * deny-by-default authority: access requires a configured owner plus the owner or an
 * explicit id/name/role match, so an empty allowlist denies everyone but the owner rather
 * than allowing all. `identity` is undefined when the member can no longer be resolved
 * (left the server, fetch failed); in that case the subject carries no name/role, so
 * anything beyond an explicit id/owner match fails closed. `allowedUserIds` already folds in
 * setup-managed viewer/controller ids, so a user revoked through setup is denied here.
 */
export function requesterHasGlobalAccess(
  policy: GlobalAccessPolicy,
  requesterId: string,
  identity: RequesterIdentity | undefined
): boolean {
  if (!requesterId || requesterId === "unknown") {
    return false;
  }
  const subject: AccessSubject = {
    userId: requesterId,
    nameSource: identity ?? {},
    roleIds: identity?.roleIds ?? []
  };
  return isAccessSubjectAllowed(subject, {
    ownerUserId: policy.ownerUserId,
    allowedUserIds: policy.allowedUserIds,
    allowedUsernames: policy.allowedUsernames,
    allowedRoleIds: policy.allowedRoleIds
  });
}

/**
 * Re-checks a requester against a project's `.devbot` policy. Mirrors `isAllowedForProject`:
 * no project allowlist means allow-all, and an unresolved member fails closed unless it is
 * matched by an explicit user id in the policy.
 */
export function requesterHasProjectAccess(
  policy: ProjectAccessPolicy,
  requesterId: string,
  identity: RequesterIdentity | undefined
): boolean {
  if (!requesterId || requesterId === "unknown") {
    return false;
  }
  const hasAllowList = policy.allowedUsers.length > 0 || policy.allowedUsernames.length > 0 || policy.allowedRoles.length > 0;
  if (!hasAllowList) {
    return true;
  }
  if (policy.allowedUsers.includes(requesterId)) {
    return true;
  }
  if (!identity) {
    return false;
  }
  if (isApprovedDiscordUsername(identity, policy.allowedUsernames)) {
    return true;
  }
  return identity.roleIds.some((roleId) => policy.allowedRoles.includes(roleId));
}

export interface AccessSubject {
  userId: string;
  nameSource: DiscordNameSource;
  roleIds?: readonly string[];
}

export interface AccessAllowLists {
  ownerUserId: string | undefined;
  allowedUserIds: ReadonlySet<string>;
  allowedUsernames: ReadonlySet<string>;
  allowedRoleIds: ReadonlySet<string>;
}

export function isAccessSubjectAllowed(subject: AccessSubject, config: AccessAllowLists): boolean {
  if (!config.ownerUserId) {
    return false;
  }
  if (subject.userId === config.ownerUserId) {
    return true;
  }
  if (config.allowedUserIds.has(subject.userId)) {
    return true;
  }
  if (isApprovedDiscordUsername(subject.nameSource, config.allowedUsernames)) {
    return true;
  }
  return (subject.roleIds ?? []).some((roleId) => config.allowedRoleIds.has(roleId));
}
