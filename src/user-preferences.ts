import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeProjectName } from "./config.js";
import { hardenPrivateDirectoryPermissions, PRIVATE_DIRECTORY_MODE } from "./security.js";
import { defaultRuntimeStatePath } from "./runtime-paths.js";

interface UserPreferenceState {
  version: 1;
  selectedProjects: Record<string, string>;
}

const EMPTY_STATE: UserPreferenceState = {
  version: 1,
  selectedProjects: {}
};

export class UserPreferenceStore {
  private state: UserPreferenceState;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly filePath: string;

  constructor(filePath = defaultRuntimeStatePath("preferences.json")) {
    this.filePath = path.resolve(filePath);
    this.state = loadState(this.filePath);
  }

  selectedProject(userId: string): string | undefined {
    return this.state.selectedProjects[userId];
  }

  async setSelectedProject(userId: string, projectName: string): Promise<void> {
    const normalizedUserId = userId.trim();
    const normalizedProject = normalizeProjectName(projectName);
    if (!normalizedUserId || !normalizedProject) {
      throw new Error("User and project are required for a workspace preference.");
    }

    await this.mutate((state) => {
      state.selectedProjects[normalizedUserId] = normalizedProject;
    });
  }

  async clearSelectedProject(userId: string): Promise<void> {
    await this.mutate((state) => {
      delete state.selectedProjects[userId.trim()];
    });
  }

  private async mutate(change: (state: UserPreferenceState) => void): Promise<void> {
    const run = this.mutationQueue.then(async () => {
      const draft = cloneState(this.state);
      change(draft);
      await persistState(this.filePath, draft);
      this.state = draft;
    });
    this.mutationQueue = run.then(() => undefined, () => undefined);
    await run;
  }
}

function loadState(filePath: string): UserPreferenceState {
  if (!existsSync(filePath)) {
    return cloneState(EMPTY_STATE);
  }
  if (process.platform !== "win32") chmodSync(filePath, 0o600);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`User preference state is not valid JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("User preference state must be a JSON object.");
  }

  const raw = parsed as Partial<UserPreferenceState>;
  return {
    version: 1,
    selectedProjects: stringRecord(raw.selectedProjects)
  };
}

async function persistState(filePath: string, state: UserPreferenceState): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await hardenPrivateDirectoryPermissions(directory);
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, filePath);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => Boolean(entry[0].trim()) && typeof entry[1] === "string" && Boolean(entry[1].trim()))
      .map(([userId, projectName]) => [userId.trim(), normalizeProjectName(projectName)])
  );
}

function cloneState(state: UserPreferenceState): UserPreferenceState {
  return {
    version: 1,
    selectedProjects: { ...state.selectedProjects }
  };
}
