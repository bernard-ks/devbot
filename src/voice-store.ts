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
        transcript: redactSensitiveText(input.transcript),
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
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as unknown;
      await hardenPrivateFilePermissions(this.stateFile);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Voice note state must be a JSON object.");
      }
      const raw = parsed as { version?: unknown; notes?: unknown };
      if (raw.version !== undefined && raw.version !== 1) {
        throw new Error(`Unsupported voice note state version: ${String(raw.version)}.`);
      }
      this.state = {
        version: 1,
        notes: Array.isArray(raw.notes)
          ? raw.notes.map(normalizeLoadedVoiceNote).filter((note): note is VoiceNoteRecord => note !== undefined)
          : []
      };
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

    const directory = path.dirname(this.stateFile);
    await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await hardenPrivateDirectoryPermissions(directory);
    const tempFile = `${this.stateFile}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(tempFile, `${JSON.stringify(this.state, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
    await rename(tempFile, this.stateFile);
  }
}

function newVoiceId(): string {
  return `voice-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export function isVoiceNoteId(value: string): boolean {
  return VOICE_ID_PATTERN.test(value);
}

function normalizeLoadedVoiceNote(value: unknown): VoiceNoteRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const note = value as Partial<VoiceNoteRecord>;
  if (
    typeof note.id !== "string" ||
    !isVoiceNoteId(note.id) ||
    typeof note.projectName !== "string" ||
    typeof note.requesterId !== "string" ||
    typeof note.requesterTag !== "string" ||
    typeof note.transcript !== "string"
  ) {
    return undefined;
  }
  const createdAt = typeof note.createdAt === "string" && Number.isFinite(Date.parse(note.createdAt))
    ? note.createdAt
    : new Date(0).toISOString();
  return {
    id: note.id,
    projectName: note.projectName,
    requesterId: note.requesterId,
    requesterTag: note.requesterTag,
    transcript: redactSensitiveText(note.transcript),
    createdAt
  };
}
