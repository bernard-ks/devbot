import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  hardenPrivateDirectoryPermissions,
  hardenPrivateFilePermissions,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  redactSensitiveText
} from "./security.js";
import { isScreenshotFixId, newScreenshotFixId, type ScreenshotAnalysis } from "./screenshot-fix.js";

export interface ScreenshotFixRecord extends ScreenshotAnalysis {
  id: string;
  projectName: string;
  requesterId: string;
  createdAt: string;
}

export interface CreateScreenshotFixInput extends ScreenshotAnalysis {
  projectName: string;
  requesterId: string;
}

interface ScreenshotFixStateFile {
  version: 1;
  records: ScreenshotFixRecord[];
}

const MAX_RECORDS = 200;

export class ScreenshotFixStore {
  private state: ScreenshotFixStateFile | undefined;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly stateFile = path.resolve(".devbot", "screenshot-fixes.json")) {}

  async create(input: CreateScreenshotFixInput): Promise<ScreenshotFixRecord> {
    return this.mutate((state) => {
      const record: ScreenshotFixRecord = {
        id: newScreenshotFixId(),
        projectName: input.projectName,
        requesterId: input.requesterId,
        transcription: redactSensitiveText(input.transcription),
        location: redactSensitiveText(input.location),
        approach: redactSensitiveText(input.approach),
        createdAt: new Date().toISOString()
      };
      state.records.unshift(record);
      state.records = state.records.slice(0, MAX_RECORDS);
      return { ...record };
    });
  }

  async get(id: string): Promise<ScreenshotFixRecord | undefined> {
    if (!isScreenshotFixId(id)) {
      return undefined;
    }
    const state = await this.readState();
    const record = state.records.find((item) => item.id === id);
    return record ? { ...record } : undefined;
  }

  async remove(id: string): Promise<void> {
    await this.mutate((state) => {
      state.records = state.records.filter((item) => item.id !== id);
    });
  }

  private async readState(): Promise<ScreenshotFixStateFile> {
    await this.mutationTail;
    return this.load();
  }

  private async mutate<T>(mutation: (state: ScreenshotFixStateFile) => T): Promise<T> {
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

  private async load(): Promise<ScreenshotFixStateFile> {
    if (this.state) {
      return this.state;
    }

    try {
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as unknown;
      await hardenPrivateFilePermissions(this.stateFile);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Screenshot-fix state must be a JSON object.");
      }
      const raw = parsed as { version?: unknown; records?: unknown };
      if (raw.version !== undefined && raw.version !== 1) {
        throw new Error(`Unsupported screenshot-fix state version: ${String(raw.version)}.`);
      }
      this.state = {
        version: 1,
        records: Array.isArray(raw.records) ? raw.records.map(normalizeLoadedRecord).filter((record) => record !== undefined) : []
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Unable to read screenshot-fix state at ${this.stateFile}: ${(error as Error).message}`, { cause: error });
      }
      this.state = { version: 1, records: [] };
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

function normalizeLoadedRecord(value: unknown): ScreenshotFixRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<ScreenshotFixRecord>;
  if (
    typeof record.id !== "string" ||
    !isScreenshotFixId(record.id) ||
    typeof record.projectName !== "string" ||
    !record.projectName.trim() ||
    typeof record.requesterId !== "string" ||
    !record.requesterId.trim() ||
    typeof record.transcription !== "string" ||
    typeof record.location !== "string" ||
    typeof record.approach !== "string"
  ) {
    return undefined;
  }

  const createdAt = validTimestamp(record.createdAt) ?? new Date(0).toISOString();
  return {
    id: record.id,
    projectName: record.projectName,
    requesterId: record.requesterId,
    transcription: redactSensitiveText(record.transcription),
    location: redactSensitiveText(record.location),
    approach: redactSensitiveText(record.approach),
    createdAt
  };
}

function validTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}
