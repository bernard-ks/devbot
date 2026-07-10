import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  hardenPrivateDirectoryPermissions,
  hardenPrivateFilePermissions,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  redactSensitiveText
} from "./security.js";

export type WatchKind = "url" | "command";
export type WatchStatus = "unknown" | "up" | "down" | "idle";

const WATCH_KINDS: readonly WatchKind[] = ["url", "command"];
const WATCH_STATUSES: readonly WatchStatus[] = ["unknown", "up", "down", "idle"];

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
  expectedStatus?: string;
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
    return isAcceptableWatchUrl(trimmed) ? trimmed.replace(/\/+$/, "") : "";
  }
  const cleaned = trimmed.replace(/^\/+|\/+$/g, "");
  return `/${cleaned}`;
}

/**
 * Sentinel only ever polls a project's own dev server. A manually added watch
 * path that names a full URL must stay on loopback and carry no embedded
 * credentials, matching the SSRF-hardening convention project-screenshot.ts
 * applies to captured pages. This is a format-level floor: `resolveWatchTargets`
 * additionally restricts manual URLs to the project's currently approved
 * origins at check time, since "some loopback port" is not the same guarantee
 * as "this project's own dev server."
 */
function isAcceptableWatchUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }
    if (url.username || url.password) {
      return false;
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

const EXPECTED_STATUS_TOKEN = /^(\d{3})(?:-(\d{3}))?$/;

/**
 * Parses an expected-status spec such as "200-299", "200", or "200,301,304"
 * into a predicate. Returns undefined for an empty or malformed spec.
 */
export function parseExpectedStatusSpec(spec: string): ((statusCode: number) => boolean) | undefined {
  const tokens = spec
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    return undefined;
  }

  const ranges: Array<[number, number]> = [];
  for (const token of tokens) {
    const match = EXPECTED_STATUS_TOKEN.exec(token);
    if (!match) {
      return undefined;
    }
    const min = Number(match[1]);
    const max = match[2] !== undefined ? Number(match[2]) : min;
    if (min < 100 || max > 599 || min > max) {
      return undefined;
    }
    ranges.push([min, max]);
  }

  return (statusCode: number) => ranges.some(([min, max]) => statusCode >= min && statusCode <= max);
}

export function isValidExpectedStatusSpec(spec: string): boolean {
  return parseExpectedStatusSpec(spec) !== undefined;
}

/** Default health rule when no expected-status option is configured: 2xx/3xx pass, 4xx/5xx (incl. 404) fail. */
export function defaultExpectedStatus(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 400;
}

export function expectedStatusPredicate(spec: string | undefined): (statusCode: number) => boolean {
  if (!spec) {
    return defaultExpectedStatus;
  }
  return parseExpectedStatusSpec(spec) ?? defaultExpectedStatus;
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

  async setExpectedStatus(projectName: string, spec: string | undefined): Promise<SentinelProjectConfig> {
    return this.mutateProject(projectName, (record) => {
      const trimmed = spec?.trim();
      if (trimmed && isValidExpectedStatusSpec(trimmed)) {
        record.config.expectedStatus = trimmed;
      } else {
        delete record.config.expectedStatus;
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
      record.watches[watchId] = sanitizeWatchForPersistence(watch);
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
      const raw = await readFile(this.stateFile, "utf8");
      await hardenPrivateFilePermissions(this.stateFile);
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Sentinel state must be a JSON object.");
      }
      const root = parsed as { version?: unknown; projects?: unknown };
      if (root.version !== undefined && root.version !== 1) {
        throw new Error(`Unsupported sentinel state version: ${String(root.version)}.`);
      }
      this.state = { version: 1, projects: normalizeLoadedProjects(root.projects) };
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

    const directory = path.dirname(this.stateFile);
    await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await hardenPrivateDirectoryPermissions(directory);
    const tempFile = `${this.stateFile}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(tempFile, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: PRIVATE_FILE_MODE
    });
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

function sanitizeWatchForPersistence(watch: WatchState): WatchState {
  return {
    ...watch,
    target: redactSensitiveText(watch.target),
    ...(watch.lastError !== undefined ? { lastError: redactSensitiveText(watch.lastError) } : {})
  };
}

function normalizeLoadedProjects(value: unknown): Record<string, SentinelProjectRecord> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const projects: Record<string, SentinelProjectRecord> = {};
  for (const [projectName, recordValue] of Object.entries(value as Record<string, unknown>)) {
    if (!projectName.trim()) {
      continue;
    }
    const raw =
      recordValue && typeof recordValue === "object" && !Array.isArray(recordValue)
        ? (recordValue as { config?: unknown; watches?: unknown })
        : {};
    projects[projectName] = {
      config: normalizeLoadedConfig(raw.config),
      watches: normalizeLoadedWatches(raw.watches)
    };
  }
  return projects;
}

function normalizeLoadedConfig(value: unknown): SentinelProjectConfig {
  const raw =
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

  const manualPaths = Array.isArray(raw.manualPaths)
    ? [
        ...new Set(
          raw.manualPaths
            .filter((item): item is string => typeof item === "string")
            .map(normalizeManualPath)
            .filter(Boolean)
        )
      ]
    : [];
  const fastCommand = typeof raw.fastCommand === "string" && raw.fastCommand.trim() ? raw.fastCommand.trim() : undefined;
  const expectedStatus =
    typeof raw.expectedStatus === "string" && isValidExpectedStatusSpec(raw.expectedStatus.trim())
      ? raw.expectedStatus.trim()
      : undefined;

  return {
    enabled: raw.enabled === true,
    intervalSeconds: clampIntervalSeconds(typeof raw.intervalSeconds === "number" ? raw.intervalSeconds : DEFAULT_INTERVAL_SECONDS),
    manualPaths,
    ...(fastCommand ? { fastCommand } : {}),
    ...(expectedStatus ? { expectedStatus } : {})
  };
}

function normalizeLoadedWatches(value: unknown): Record<string, WatchState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const watches: Record<string, WatchState> = {};
  for (const [watchId, watchValue] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeLoadedWatch(watchId, watchValue);
    if (normalized) {
      watches[watchId] = normalized;
    }
  }
  return watches;
}

function normalizeLoadedWatch(id: string, value: unknown): WatchState | undefined {
  if (!id.trim() || !value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.target !== "string" || !raw.target.trim()) {
    return undefined;
  }
  if (typeof raw.kind !== "string" || !(WATCH_KINDS as string[]).includes(raw.kind)) {
    return undefined;
  }
  const kind = raw.kind as WatchKind;
  const status = typeof raw.status === "string" && (WATCH_STATUSES as string[]).includes(raw.status)
    ? (raw.status as WatchStatus)
    : "unknown";
  const consecutiveFailures =
    typeof raw.consecutiveFailures === "number" && Number.isInteger(raw.consecutiveFailures) && raw.consecutiveFailures >= 0
      ? raw.consecutiveFailures
      : 0;

  return {
    id,
    kind,
    target: redactSensitiveText(raw.target),
    status,
    consecutiveFailures,
    ...(validTimestamp(raw.lastCheckAt) ? { lastCheckAt: validTimestamp(raw.lastCheckAt)! } : {}),
    ...(validTimestamp(raw.lastOkAt) ? { lastOkAt: validTimestamp(raw.lastOkAt)! } : {}),
    ...(typeof raw.lastCode === "number" && Number.isInteger(raw.lastCode) ? { lastCode: raw.lastCode } : {}),
    ...(typeof raw.lastError === "string" && raw.lastError.trim() ? { lastError: redactSensitiveText(raw.lastError) } : {}),
    ...(typeof raw.alertMessageId === "string" && raw.alertMessageId.trim() ? { alertMessageId: raw.alertMessageId.trim() } : {}),
    ...(typeof raw.alertChannelId === "string" && raw.alertChannelId.trim() ? { alertChannelId: raw.alertChannelId.trim() } : {}),
    ...(validTimestamp(raw.mutedUntil) ? { mutedUntil: validTimestamp(raw.mutedUntil)! } : {})
  };
}

function validTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}
