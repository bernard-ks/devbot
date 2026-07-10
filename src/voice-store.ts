import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const VOICE_ID_PATTERN = /^voice-[a-z0-9-]{1,64}$/i;

export interface VoiceNoteRecord {
  id: string;
  projectName: string;
  requesterId: string;
  requesterTag: string;
  transcript: string;
  createdAt: string;
}

export interface CreateVoiceNoteInput {
  projectName: string;
  requesterId: string;
  requesterTag: string;
  transcript: string;
}

interface VoiceStoreState {
  version: 1;
  notes: VoiceNoteRecord[];
}

export class VoiceStore {
  private state: VoiceStoreState | undefined;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly stateFile = path.resolve(".devbot", "voice-notes.json"),
    private readonly maxRecords = 200
  ) {}

  async create(input: CreateVoiceNoteInput): Promise<VoiceNoteRecord> {
    return this.mutate((state) => {
      const record: VoiceNoteRecord = {
        id: newVoiceId(),
        projectName: input.projectName,
        requesterId: input.requesterId,
        requesterTag: input.requesterTag,
        transcript: input.transcript,
        createdAt: new Date().toISOString()
      };
      state.notes.unshift(record);
      state.notes = state.notes.slice(0, this.maxRecords);
      return { ...record };
    });
  }

  async get(id: string): Promise<VoiceNoteRecord | undefined> {
    const state = await this.readState();
    const record = state.notes.find((note) => note.id === id);
    return record ? { ...record } : undefined;
  }

  async remove(id: string): Promise<void> {
    await this.mutate((state) => {
      state.notes = state.notes.filter((note) => note.id !== id);
    });
  }

  private async readState(): Promise<VoiceStoreState> {
    await this.mutationTail;
    return this.load();
  }

  private async mutate<T>(mutation: (state: VoiceStoreState) => T): Promise<T> {
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

  private async load(): Promise<VoiceStoreState> {
    if (this.state) {
      return this.state;
    }

    try {
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as VoiceStoreState;
      this.state = { version: 1, notes: Array.isArray(parsed.notes) ? parsed.notes : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Unable to read voice note state at ${this.stateFile}: ${(error as Error).message}`, { cause: error });
      }
      this.state = { version: 1, notes: [] };
    }

    return this.state;
  }

  private async save(): Promise<void> {
    if (!this.state) {
      return;
    }

    await mkdir(path.dirname(this.stateFile), { recursive: true });
    const tempFile = `${this.stateFile}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(tempFile, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(tempFile, this.stateFile);
  }
}

function newVoiceId(): string {
  return `voice-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export function isVoiceNoteId(value: string): boolean {
  return VOICE_ID_PATTERN.test(value);
}
