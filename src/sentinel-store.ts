import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type WatchKind = "url" | "command";
export type WatchStatus = "unknown" | "up" | "down" | "idle";

export interface WatchState {
  id: string;
  kind: WatchKind;
  target: string;
  status: WatchStatus;
  consecutiveFailures: number;
  lastCheckAt?: string;
  lastOkAt?: string;
  lastCode?: number;
  lastError?: string;
  alertMessageId?: string;
  alertChannelId?: string;
  mutedUntil?: string;
}

export interface SentinelProjectConfig {
  enabled: boolean;
  intervalSeconds: number;
  manualPaths: string[];
  fastCommand?: string;
}

interface SentinelProjectRecord {
  config: SentinelProjectConfig;
  watches: Record<string, WatchState>;
}

interface SentinelStateFile {
  version: 1;
  projects: Record<string, SentinelProjectRecord>;
}

export const DEFAULT_INTERVAL_SECONDS = 120;
export const MIN_INTERVAL_SECONDS = 30;
export const DEBOUNCE_THRESHOLD = 2;

const DEFAULT_PROJECT_CONFIG: SentinelProjectConfig = {
  enabled: false,
  intervalSeconds: DEFAULT_INTERVAL_SECONDS,
  manualPaths: []
};

export function clampIntervalSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) {
    return DEFAULT_INTERVAL_SECONDS;
  }
  return Math.max(MIN_INTERVAL_SECONDS, Math.round(seconds));
}

export function normalizeManualPath(value: string): string {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return isLoopbackWatchUrl(trimmed) ? trimmed.replace(/\/+$/, "") : "";
  }
  const cleaned = trimmed.replace(/^\/+|\/+$/g, "");
  return `/${cleaned}`;
}

/**
 * Sentinel only ever polls a project's own dev server. A manually added watch
 * path that names a full URL must stay on loopback, matching the same
 * SSRF-hardening convention project-screenshot.ts applies to captured pages.
 */
function isLoopbackWatchUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

export class SentinelStore {
  private state: SentinelStateFile | undefined;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly stateFile = path.resolve(".devbot", "sentinel.json")) {}

  async getProjectConfig(projectName: string): Promise<SentinelProjectConfig> {
    const state = await this.readState();
    const record = state.projects[projectName];
    return record ? cloneConfig(record.config) : cloneConfig(DEFAULT_PROJECT_CONFIG);
  }

  async setEnabled(projectName: string, enabled: boolean): Promise<SentinelProjectConfig> {
    return this.mutateProject(projectName, (record) => {
      record.config.enabled = enabled;
    });
  }

  async setIntervalSeconds(projectName: string, seconds: number): Promise<SentinelProjectConfig> {
    return this.mutateProject(projectName, (record) => {
      record.config.intervalSeconds = clampIntervalSeconds(seconds);
    });
  }

  async setFastCommand(projectName: string, commandName: string | undefined): Promise<SentinelProjectConfig> {
    return this.mutateProject(projectName, (record) => {
      if (commandName?.trim()) {
        record.config.fastCommand = commandName.trim();
      } else {
        delete record.config.fastCommand;
      }
    });
  }

  async addWatchPath(projectName: string, watchPath: string): Promise<SentinelProjectConfig> {
    return this.mutateProject(projectName, (record) => {
      const normalized = normalizeManualPath(watchPath);
      if (normalized && !record.config.manualPaths.includes(normalized)) {
        record.config.manualPaths.push(normalized);
      }
    });
  }

  async removeWatchPath(projectName: string, watchPath: string): Promise<SentinelProjectConfig> {
    return this.mutateProject(projectName, (record) => {
      const normalized = normalizeManualPath(watchPath);
      record.config.manualPaths = record.config.manualPaths.filter((item) => item !== normalized);
    });
  }

  async getWatchState(projectName: string, watchId: string): Promise<WatchState | undefined> {
    const state = await this.readState();
    const watch = state.projects[projectName]?.watches[watchId];
    return watch ? { ...watch } : undefined;
  }

  async saveWatchState(projectName: string, watchId: string, watch: WatchState): Promise<void> {
    await this.mutate((state) => {
      const record = ensureProjectRecord(state, projectName);
      record.watches[watchId] = { ...watch };
    });
  }

  async muteWatch(projectName: string, watchId: string, until: string): Promise<WatchState | undefined> {
    return this.mutate((state) => {
      const record = ensureProjectRecord(state, projectName);
      const watch = record.watches[watchId];
      if (!watch) {
        return undefined;
      }
      watch.mutedUntil = until;
      return { ...watch };
    });
  }

  async listProjectWatches(projectName: string): Promise<WatchState[]> {
    const state = await this.readState();
    const record = state.projects[projectName];
    return record ? Object.values(record.watches).map((watch) => ({ ...watch })) : [];
  }

  async listConfiguredProjectNames(): Promise<string[]> {
    const state = await this.readState();
    return Object.keys(state.projects);
  }

  private async mutateProject(
    projectName: string,
    apply: (record: SentinelProjectRecord) => void
  ): Promise<SentinelProjectConfig> {
    return this.mutate((state) => {
      const record = ensureProjectRecord(state, projectName);
      apply(record);
      return cloneConfig(record.config);
    });
  }

  private async readState(): Promise<SentinelStateFile> {
    await this.mutationTail;
    return this.load();
  }

  private async mutate<T>(mutation: (state: SentinelStateFile) => T): Promise<T> {
    let result: T | undefined;
    const operation = this.mutationTail.then(async () => {
      const state = await this.load();
      const previous = structuredClone(state);
      result = mutation(state);
      try {
        await this.save();
      } catch (error) {
        this.state = previous;
        throw error;
      }
    });
    this.mutationTail = operation.catch(() => undefined);
    await operation;
    return result as T;
  }

  private async load(): Promise<SentinelStateFile> {
    if (this.state) {
      return this.state;
    }

    try {
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as SentinelStateFile;
      this.state = {
        version: 1,
        projects: parsed.projects && typeof parsed.projects === "object" ? parsed.projects : {}
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Unable to read sentinel state at ${this.stateFile}: ${(error as Error).message}`, { cause: error });
      }
      this.state = { version: 1, projects: {} };
    }

    return this.state;
  }

  private async save(): Promise<void> {
    if (!this.state) {
      return;
    }

    await mkdir(path.dirname(this.stateFile), { recursive: true });
    const tempFile = `${this.stateFile}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(tempFile, `${JSON.stringify(this.state, null, 2)}\n`);
    await rename(tempFile, this.stateFile);
  }
}

function ensureProjectRecord(state: SentinelStateFile, projectName: string): SentinelProjectRecord {
  const existing = state.projects[projectName];
  if (existing) {
    return existing;
  }
  const created: SentinelProjectRecord = { config: cloneConfig(DEFAULT_PROJECT_CONFIG), watches: {} };
  state.projects[projectName] = created;
  return created;
}

function cloneConfig(config: SentinelProjectConfig): SentinelProjectConfig {
  return { ...config, manualPaths: [...config.manualPaths] };
}
