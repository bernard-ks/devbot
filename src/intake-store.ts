import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const INTAKE_RECORD_ID_PATTERN = /^intake-[a-z0-9-]{1,64}$/i;

export type IntakeStatus = "pending" | "confirmed" | "unconfirmed" | "needs-info" | "accepted" | "dismissed";

export interface IntakeChannelConfig {
  channelId: string;
  projectName: string;
}

export interface IntakeRecord {
  id: string;
  channelId: string;
  messageId: string;
  authorId: string;
  authorTag: string;
  projectName: string;
  text: string;
  signature: string;
  status: IntakeStatus;
  evidence: string[];
  screenshotUrl?: string;
  duplicateOfId?: string;
  triageMessageId?: string;
  acceptedTaskId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AddIntakeRecordInput {
  channelId: string;
  messageId: string;
  authorId: string;
  authorTag: string;
  projectName: string;
  text: string;
  signature: string;
  status: IntakeStatus;
  evidence?: string[];
  screenshotUrl?: string;
  duplicateOfId?: string;
}

export interface IntakeUpdate {
  status?: IntakeStatus;
  triageMessageId?: string;
  acceptedTaskId?: string;
}

interface IntakeStateFile {
  version: 1;
  channel?: IntakeChannelConfig;
  records: IntakeRecord[];
}

const EMPTY_STATE: IntakeStateFile = { version: 1, records: [] };

export class IntakeStore {
  private state: IntakeStateFile | undefined;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly stateFile = path.resolve(".devbot", "intake.json"),
    private readonly maxRecords = 500
  ) {}

  async setChannel(channelId: string, projectName: string): Promise<IntakeStateFile> {
    return this.mutate((state) => {
      state.channel = { channelId, projectName };
      return cloneState(state);
    });
  }

  async disable(): Promise<IntakeStateFile> {
    return this.mutate((state) => {
      delete state.channel;
      return cloneState(state);
    });
  }

  async snapshot(): Promise<IntakeStateFile> {
    return cloneState(await this.readState());
  }

  async addRecord(input: AddIntakeRecordInput): Promise<IntakeRecord> {
    return this.mutate((state) => {
      const now = new Date().toISOString();
      const record: IntakeRecord = {
        id: newIntakeRecordId(),
        channelId: input.channelId,
        messageId: input.messageId,
        authorId: input.authorId,
        authorTag: input.authorTag,
        projectName: input.projectName,
        text: input.text,
        signature: input.signature,
        status: input.status,
        evidence: input.evidence ?? [],
        ...(input.screenshotUrl ? { screenshotUrl: input.screenshotUrl } : {}),
        ...(input.duplicateOfId ? { duplicateOfId: input.duplicateOfId } : {}),
        createdAt: now,
        updatedAt: now
      };
      state.records.unshift(record);
      state.records = state.records.slice(0, this.maxRecords);
      return cloneRecord(record);
    });
  }

  async updateRecord(id: string, patch: IntakeUpdate): Promise<IntakeRecord | undefined> {
    return this.mutate((state) => {
      const record = state.records.find((item) => item.id === id);
      if (!record) {
        return undefined;
      }
      if (patch.status !== undefined) record.status = patch.status;
      if (patch.triageMessageId !== undefined) record.triageMessageId = patch.triageMessageId;
      if (patch.acceptedTaskId !== undefined) record.acceptedTaskId = patch.acceptedTaskId;
      record.updatedAt = new Date().toISOString();
      return cloneRecord(record);
    });
  }

  async get(id: string): Promise<IntakeRecord | undefined> {
    const state = await this.readState();
    const record = state.records.find((item) => item.id === id);
    return record ? cloneRecord(record) : undefined;
  }

  async findRecentBySignature(signature: string, excludeId?: string): Promise<IntakeRecord | undefined> {
    const state = await this.readState();
    const match = state.records.find(
      (item) => item.id !== excludeId && item.signature === signature && item.status !== "dismissed"
    );
    return match ? cloneRecord(match) : undefined;
  }

  async listRecent(limit = 10): Promise<IntakeRecord[]> {
    const state = await this.readState();
    return state.records.slice(0, Math.max(1, Math.min(limit, this.maxRecords))).map(cloneRecord);
  }

  private async mutate<T>(mutation: (state: IntakeStateFile) => T): Promise<T> {
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

  private async readState(): Promise<IntakeStateFile> {
    await this.mutationTail;
    return this.load();
  }

  private async load(): Promise<IntakeStateFile> {
    if (this.state) {
      return this.state;
    }

    try {
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as Partial<IntakeStateFile>;
      this.state = {
        version: 1,
        ...(parsed.channel && typeof parsed.channel.channelId === "string" && typeof parsed.channel.projectName === "string"
          ? { channel: { channelId: parsed.channel.channelId, projectName: parsed.channel.projectName } }
          : {}),
        records: Array.isArray(parsed.records) ? parsed.records : []
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Unable to read intake state at ${this.stateFile}: ${(error as Error).message}`, { cause: error });
      }
      this.state = cloneState(EMPTY_STATE);
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

function newIntakeRecordId(): string {
  return `intake-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export function isIntakeRecordId(value: string): boolean {
  return INTAKE_RECORD_ID_PATTERN.test(value);
}

function cloneState(state: IntakeStateFile): IntakeStateFile {
  return {
    version: 1,
    ...(state.channel ? { channel: { ...state.channel } } : {}),
    records: state.records.map(cloneRecord)
  };
}

function cloneRecord(record: IntakeRecord): IntakeRecord {
  return { ...record, evidence: [...record.evidence] };
}
