import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeProjectName } from "./config.js";

export type SetupUserPermission = "view" | "control";

export interface SetupState {
  version: 1;
  viewerUserIds: string[];
  controllerUserIds: string[];
  peerBotIds: string[];
  repositories: Record<string, string>;
  defaultProjectName?: string;
  privateChannelId?: string;
  workspaceMessageId?: string;
}

const EMPTY_SETUP: SetupState = {
  version: 1,
  viewerUserIds: [],
  controllerUserIds: [],
  peerBotIds: [],
  repositories: {}
};

export class SetupStore {
  private state: SetupState;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly filePath: string;

  constructor(filePath = ".devbot/setup.json") {
    this.filePath = path.resolve(filePath);
    this.state = loadSetupState(this.filePath);
  }

  snapshot(): SetupState {
    return cloneSetup(this.state);
  }

  setUser(userId: string, permission: SetupUserPermission, enabled: boolean): Promise<SetupState> {
    return this.mutate((state) => {
      if (permission === "control") {
        state.controllerUserIds = updateIdList(state.controllerUserIds, userId, enabled);
        state.viewerUserIds = updateIdList(state.viewerUserIds, userId, enabled || state.viewerUserIds.includes(userId));
      } else {
        state.viewerUserIds = updateIdList(state.viewerUserIds, userId, enabled);
        if (!enabled) {
          state.controllerUserIds = state.controllerUserIds.filter((id) => id !== userId);
        }
      }
      return cloneSetup(state);
    });
  }

  setPeer(botId: string, enabled: boolean): Promise<SetupState> {
    return this.mutate((state) => {
      state.peerBotIds = updateIdList(state.peerBotIds, botId, enabled);
      return cloneSetup(state);
    });
  }

  setRepository(name: string, root: string): Promise<SetupState> {
    return this.mutate((state) => {
      state.repositories[normalizeProjectName(name)] = path.resolve(root);
      return cloneSetup(state);
    });
  }

  removeRepository(name: string): Promise<SetupState> {
    return this.mutate((state) => {
      const normalized = normalizeProjectName(name);
      delete state.repositories[normalized];
      if (state.defaultProjectName === normalized) {
        delete state.defaultProjectName;
      }
      return cloneSetup(state);
    });
  }

  setDefaultProject(name: string): Promise<SetupState> {
    return this.mutate((state) => {
      state.defaultProjectName = normalizeProjectName(name);
      return cloneSetup(state);
    });
  }

  setPrivateChannel(channelId: string): Promise<SetupState> {
    return this.mutate((state) => {
      state.privateChannelId = channelId;
      return cloneSetup(state);
    });
  }

  setWorkspaceMessage(messageId: string): Promise<SetupState> {
    return this.mutate((state) => {
      state.workspaceMessageId = messageId;
      return cloneSetup(state);
    });
  }

  private mutate<T>(change: (draft: SetupState) => T): Promise<T> {
    const run = this.mutationQueue.then(async () => {
      const draft = cloneSetup(this.state);
      const result = change(draft);
      await persistSetup(this.filePath, draft);
      this.state = draft;
      return result;
    });
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}

function loadSetupState(filePath: string): SetupState {
  if (!existsSync(filePath)) {
    return cloneSetup(EMPTY_SETUP);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Setup state is not valid JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Setup state must be a JSON object.");
  }

  const raw = parsed as Partial<SetupState>;
  return {
    version: 1,
    viewerUserIds: stringList(raw.viewerUserIds),
    controllerUserIds: stringList(raw.controllerUserIds),
    peerBotIds: stringList(raw.peerBotIds),
    repositories: stringRecord(raw.repositories),
    ...(typeof raw.defaultProjectName === "string" && raw.defaultProjectName.trim()
      ? { defaultProjectName: normalizeProjectName(raw.defaultProjectName) }
      : {}),
    ...(typeof raw.privateChannelId === "string" && raw.privateChannelId.trim()
      ? { privateChannelId: raw.privateChannelId.trim() }
      : {}),
    ...(typeof raw.workspaceMessageId === "string" && raw.workspaceMessageId.trim()
      ? { workspaceMessageId: raw.workspaceMessageId.trim() }
      : {})
  };
}

async function persistSetup(filePath: string, state: SetupState): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, filePath);
}

function updateIdList(ids: string[], id: string, enabled: boolean): string[] {
  const updated = new Set(ids);
  if (enabled) {
    updated.add(id);
  } else {
    updated.delete(id);
  }
  return [...updated].sort();
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))].sort() : [];
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1].trim()))
      .map(([name, root]) => [normalizeProjectName(name), path.resolve(root)])
  );
}

function cloneSetup(state: SetupState): SetupState {
  return {
    version: 1,
    viewerUserIds: [...state.viewerUserIds],
    controllerUserIds: [...state.controllerUserIds],
    peerBotIds: [...state.peerBotIds],
    repositories: { ...state.repositories },
    ...(state.defaultProjectName ? { defaultProjectName: state.defaultProjectName } : {}),
    ...(state.privateChannelId ? { privateChannelId: state.privateChannelId } : {}),
    ...(state.workspaceMessageId ? { workspaceMessageId: state.workspaceMessageId } : {})
  };
}
