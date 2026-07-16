import type { CodexRequestMode } from "./codex-client.js";
import type { AppConfig, ProjectEntry } from "./types.js";

export function isWriteBlockedBySafeMode(appConfig: Pick<AppConfig, "safeMode">, mode: CodexRequestMode): boolean {
  return appConfig.safeMode && mode === "action";
}

export function safeModeActionMessage(surface: string): string {
  return [
    `Safe mode is on, so ${surface} cannot start write-capable Codex work.`,
    "Read-only commands still work: mentions, `/ask`, `/status`, `/snip`, `/task show`, `/task logs`, `/dashboard`, and peer read-only requests.",
    "Set `DEVBOT_SAFE_MODE=false` and restart devbot to allow write-capable actions."
  ].join("\n");
}

export function isPeerAllowedForProject(project: ProjectEntry, peerBotId: string): boolean {
  return project.metadata.policy.allowedPeers.length === 0 || project.metadata.policy.allowedPeers.includes(peerBotId);
}

export function screenshotRequiresApproval(project: ProjectEntry): boolean {
  return project.metadata.policy.screenshotPolicy === "approval";
}

export function isScreenshotBlocked(project: ProjectEntry): boolean {
  return project.metadata.policy.screenshotPolicy === "deny";
}

export function commandRequiresApproval(project: ProjectEntry, commandName: string): boolean {
  const normalized = commandName.trim().toLowerCase();
  if (project.metadata.policy.approvalRequiredCommands.includes(normalized)) {
    return true;
  }

  return !project.metadata.policy.readOnlyCommands.includes(normalized);
}

/** A role inherits project access only when the project is wholly unrestricted or names that role explicitly. */
export function isRoleAllowedForProject(project: ProjectEntry, roleId: string): boolean {
  const policy = project.metadata.policy;
  const projectRestricted = policy.allowedUsers.length > 0
    || policy.allowedUsernames.length > 0
    || policy.allowedRoles.length > 0;
  return !projectRestricted || policy.allowedRoles.includes(roleId);
}
