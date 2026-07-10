import { loadProjectEntry } from "./config.js";
import type { SetupState } from "./setup-store.js";
import type { AppConfig, ProjectEntry } from "./types.js";

export interface BootstrapRuntimeConfig {
  allowedUserIds: Set<string>;
  peerBotIds: Set<string>;
  coordinationChannelId: string | undefined;
  projects: ProjectEntry[];
}

export function captureBootstrapConfig(config: AppConfig): BootstrapRuntimeConfig {
  return {
    allowedUserIds: new Set(config.allowedUserIds),
    peerBotIds: new Set(config.peerBotIds),
    coordinationChannelId: config.coordinationChannelId,
    projects: config.projects.map(cloneProject)
  };
}

export function applySetupState(config: AppConfig, bootstrap: BootstrapRuntimeConfig, setup: SetupState): void {
  config.allowedUserIds = new Set([
    ...bootstrap.allowedUserIds,
    ...setup.viewerUserIds,
    ...setup.controllerUserIds,
    ...(config.ownerUserId ? [config.ownerUserId] : [])
  ]);
  config.peerBotIds = new Set([...bootstrap.peerBotIds, ...setup.peerBotIds]);
  config.coordinationChannelId = setup.privateChannelId ?? bootstrap.coordinationChannelId;

  const projects = new Map(bootstrap.projects.map((project) => [project.name, cloneProject(project)]));
  for (const [name, root] of Object.entries(setup.repositories)) {
    projects.set(name, loadProjectEntry(name, root));
  }

  const values = [...projects.values()];
  const bootstrapDefault = bootstrap.projects.find((project) => project.isDefault)?.name;
  const requestedDefault = setup.defaultProjectName ?? bootstrapDefault;
  const selectedDefault = requestedDefault && projects.has(requestedDefault)
    ? requestedDefault
    : values.length === 1
      ? values[0]?.name
      : undefined;
  config.projects = values.map((project) => ({
    ...project,
    isDefault: project.name === selectedDefault
  }));
}

export function isSetupController(setup: SetupState, ownerUserId: string | undefined, userId: string): boolean {
  return userId === ownerUserId || setup.controllerUserIds.includes(userId);
}

function cloneProject(project: ProjectEntry): ProjectEntry {
  return {
    ...project,
    metadata: {
      ...project.metadata,
      aliases: [...project.metadata.aliases],
      commands: {
        ...project.metadata.commands,
        test: [...project.metadata.commands.test],
        build: [...project.metadata.commands.build],
        lint: [...project.metadata.commands.lint],
        verify: [...project.metadata.commands.verify],
        presets: { ...project.metadata.commands.presets }
      },
      policy: {
        ...project.metadata.policy,
        allowedUsers: [...project.metadata.policy.allowedUsers],
        allowedUsernames: [...project.metadata.policy.allowedUsernames],
        allowedRoles: [...project.metadata.policy.allowedRoles],
        allowedPeers: [...project.metadata.policy.allowedPeers],
        readOnlyCommands: [...project.metadata.policy.readOnlyCommands],
        approvalRequiredCommands: [...project.metadata.policy.approvalRequiredCommands]
      }
    }
  };
}
