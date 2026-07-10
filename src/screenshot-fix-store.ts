import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isScreenshotFixId, newScreenshotFixId, type ScreenshotAnalysis } from "./screenshot-fix.js";

export interface ScreenshotFixRecord extends ScreenshotAnalysis {
  id: string;
  projectName: string;
  requesterId: string;
  requesterTag: string;
  createdAt: string;
}

export interface CreateScreenshotFixInput extends ScreenshotAnalysis {
  projectName: string;
  requesterId: string;
  requesterTag: string;
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
        requesterTag: input.requesterTag,
        transcription: input.transcription,
        location: input.location,
        approach: input.approach,
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
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as ScreenshotFixStateFile;
      this.state = { version: 1, records: Array.isArray(parsed.records) ? parsed.records : [] };
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

    await mkdir(path.dirname(this.stateFile), { recursive: true });
    const tempFile = `${this.stateFile}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(tempFile, `${JSON.stringify(this.state, null, 2)}\n`);
    await rename(tempFile, this.stateFile);
  }
}
