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
import { applyIntakeRateLimit } from "./intake.js";

const INTAKE_RECORD_ID_PATTERN = /^intake-[a-z0-9-]{1,64}$/i;
const MAX_TEXT_LENGTH = 4_000;
const MAX_SIGNATURE_LENGTH = 200;
const MAX_EVIDENCE_ENTRIES = 10;
const MAX_EVIDENCE_LENGTH = 400;

export type IntakeStatus =
  | "incomplete"
  | "pending"
  | "confirmed"
  | "unconfirmed"
  | "needs-info"
  | "accepting"
  | "accepted"
  | "accept-failed"
  | "dismissed";

const INTAKE_STATUSES: readonly IntakeStatus[] = [
  "incomplete",
  "pending",
  "confirmed",
  "unconfirmed",
  "needs-info",
  "accepting",
  "accepted",
  "accept-failed",
  "dismissed"
];

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
  triageChannelId?: string;
  followupPromptMessageId?: string;
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
  followupPromptMessageId?: string;
}

export interface IntakeUpdate {
  status?: IntakeStatus;
  text?: string;
  signature?: string;
  evidence?: string[];
  screenshotUrl?: string;
  duplicateOfId?: string;
  triageMessageId?: string;
  triageChannelId?: string;
  followupPromptMessageId?: string;
  acceptedTaskId?: string;
  clearFollowupPrompt?: boolean;
}

export type IntakeTransitionResult =
  | { ok: true; record: IntakeRecord }
  | { ok: false; record: IntakeRecord };

export interface IntakeRateLimitBucket {
  userHits: Record<string, number[]>;
  channelHits: number[];
}

const EMPTY_RATE_LIMIT_BUCKET: IntakeRateLimitBucket = { userHits: {}, channelHits: [] };

interface IntakeStateFile {
  version: 1;
  channel?: IntakeChannelConfig;
  records: IntakeRecord[];
  rateLimits: Record<string, IntakeRateLimitBucket>;
}

const EMPTY_STATE: IntakeStateFile = { version: 1, records: [], rateLimits: {} };

export class IntakeStore {
  private state: IntakeStateFile | undefined;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly stateFile = path.resolve(".devbot", "intake.json"),
    private readonly maxRecords = 500
  ) {}

  /**
   * Binds `channelId` to `projectName` as the intake channel. Reassigning a
   * channel to a different project also closes every still-open follow-up in
   * that channel that belongs to another project: those prompts were issued
   * for the old project, so a later reply to one of them must not be able to
   * resume against the newly-bound project. They are dismissed and their
   * follow-up prompt is cleared inside the same serialized mutation as the
   * rebind, so no reply can race the reassignment and slip through.
   */
  async setChannel(channelId: string, projectName: string): Promise<IntakeStateFile> {
    return this.mutate((state) => {
      state.channel = { channelId, projectName };
      const now = new Date().toISOString();
      for (const record of state.records) {
        if (
          record.status === "incomplete" &&
          record.channelId === channelId &&
          record.projectName !== projectName &&
          record.followupPromptMessageId !== undefined
        ) {
          record.status = "dismissed";
          delete record.followupPromptMessageId;
          record.updatedAt = now;
        }
      }
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
        text: boundText(input.text),
        signature: boundSignature(input.signature),
        status: input.status,
        evidence: boundEvidenceList(input.evidence ?? []),
        ...(input.screenshotUrl ? { screenshotUrl: input.screenshotUrl } : {}),
        ...(input.duplicateOfId ? { duplicateOfId: input.duplicateOfId } : {}),
        ...(input.followupPromptMessageId ? { followupPromptMessageId: input.followupPromptMessageId } : {}),
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
      applyIntakeUpdate(record, patch);
      return cloneRecord(record);
    });
  }

  /**
   * Compare-and-set status transition: only applies when the record's
   * current status is one of `allowedFrom`. This is what makes concurrent
   * button/modal handlers safe — the check and the write happen inside the
   * same serialized mutation, so two racing "Accept" clicks cannot both win.
   */
  async transitionStatus(
    id: string,
    allowedFrom: readonly IntakeStatus[],
    to: IntakeStatus,
    patch: Omit<IntakeUpdate, "status"> = {}
  ): Promise<IntakeTransitionResult | undefined> {
    return this.mutate((state) => {
      const record = state.records.find((item) => item.id === id);
      if (!record) {
        return undefined;
      }
      if (!allowedFrom.includes(record.status)) {
        return { ok: false, record: cloneRecord(record) };
      }
      applyIntakeUpdate(record, { ...patch, status: to });
      return { ok: true, record: cloneRecord(record) };
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

  /**
   * Finds the open "incomplete" record whose follow-up prompt is
   * `promptMessageId`, but only when the reply comes from the same reporter in
   * the same channel that opened the report AND that record still belongs to
   * the project the channel is currently bound to. Binding to reporter +
   * channel + prompt stops another user from answering a victim's prompt to
   * bypass quota or overwrite the report under the victim's identity; binding
   * to `projectName` stops a reply from consuming a prompt that was opened while
   * the channel pointed at a *different* project (an `/intake set` rebind), which
   * would otherwise pack, screenshot, and deliver the newly-bound project's
   * context onto the old project's record and into the old project's room.
   */
  async findByFollowupPrompt(
    promptMessageId: string,
    binding: { authorId: string; channelId: string; projectName: string }
  ): Promise<IntakeRecord | undefined> {
    const state = await this.readState();
    const match = state.records.find(
      (item) =>
        item.status === "incomplete" &&
        item.followupPromptMessageId === promptMessageId &&
        item.authorId === binding.authorId &&
        item.channelId === binding.channelId &&
        item.projectName === binding.projectName
    );
    return match ? cloneRecord(match) : undefined;
  }

  /** Records in one of `statuses` whose triage card never reached a delivery room, newest first, for safe redelivery. */
  async listUndelivered(statuses: readonly IntakeStatus[], limit = 10): Promise<IntakeRecord[]> {
    const state = await this.readState();
    return state.records
      .filter((record) => !record.triageMessageId && statuses.includes(record.status))
      .slice(0, Math.max(1, limit))
      .map(cloneRecord);
  }

  async listRecent(limit = 10): Promise<IntakeRecord[]> {
    const state = await this.readState();
    return state.records.slice(0, Math.max(1, Math.min(limit, this.maxRecords))).map(cloneRecord);
  }

  async getRateLimitState(channelId: string): Promise<IntakeRateLimitBucket> {
    const state = await this.readState();
    const bucket = state.rateLimits[channelId];
    return bucket ? { userHits: { ...bucket.userHits }, channelHits: [...bucket.channelHits] } : { ...EMPTY_RATE_LIMIT_BUCKET };
  }

  async setRateLimitState(channelId: string, bucket: IntakeRateLimitBucket): Promise<void> {
    await this.mutate((state) => {
      state.rateLimits[channelId] = { userHits: { ...bucket.userHits }, channelHits: [...bucket.channelHits] };
      return undefined;
    });
  }

  /**
   * Atomically reserves one rate-limit slot: the check and the increment happen
   * inside a single serialized mutation, so two concurrent reports cannot both
   * read the same bucket, both pass, and then have one write clobber the other.
   * The hit is persisted only when the attempt is allowed; a blocked attempt
   * leaves the bucket untouched so a lockout never extends itself.
   */
  async reserveRateLimitSlot(
    channelId: string,
    userId: string,
    now = Date.now()
  ): Promise<{ limited: boolean; scope?: "user" | "channel" }> {
    return this.mutate((state) => {
      const bucket = state.rateLimits[channelId] ?? { userHits: {}, channelHits: [] };
      const result = applyIntakeRateLimit(bucket, userId, now);
      if (!result.limited) {
        state.rateLimits[channelId] = {
          userHits: { ...result.state.userHits },
          channelHits: [...result.state.channelHits]
        };
      }
      return result.scope ? { limited: result.limited, scope: result.scope } : { limited: result.limited };
    });
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
      const raw = await readFile(this.stateFile, "utf8");
      await hardenPrivateFilePermissions(this.stateFile);
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Intake state must be a JSON object.");
      }
      const candidate = parsed as Partial<IntakeStateFile>;
      if (candidate.version !== undefined && candidate.version !== 1) {
        throw new Error(`Unsupported intake state version: ${String(candidate.version)}.`);
      }
      this.state = {
        version: 1,
        ...(isValidChannelConfig(candidate.channel) ? { channel: candidate.channel } : {}),
        records: Array.isArray(candidate.records)
          ? candidate.records.map(normalizeLoadedIntakeRecord).filter((record): record is IntakeRecord => record !== undefined)
          : [],
        rateLimits: normalizeLoadedRateLimits(candidate.rateLimits)
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
    await hardenPrivateFilePermissions(this.stateFile);
  }
}

function applyIntakeUpdate(record: IntakeRecord, patch: IntakeUpdate): void {
  if (patch.status !== undefined) record.status = patch.status;
  if (patch.text !== undefined) record.text = boundText(patch.text);
  if (patch.signature !== undefined) record.signature = boundSignature(patch.signature);
  if (patch.evidence !== undefined) record.evidence = boundEvidenceList(patch.evidence);
  if (patch.screenshotUrl !== undefined) record.screenshotUrl = patch.screenshotUrl;
  if (patch.duplicateOfId !== undefined) record.duplicateOfId = patch.duplicateOfId;
  if (patch.triageMessageId !== undefined) record.triageMessageId = patch.triageMessageId;
  if (patch.triageChannelId !== undefined) record.triageChannelId = patch.triageChannelId;
  if (patch.followupPromptMessageId !== undefined) record.followupPromptMessageId = patch.followupPromptMessageId;
  if (patch.clearFollowupPrompt) delete record.followupPromptMessageId;
  if (patch.acceptedTaskId !== undefined) record.acceptedTaskId = patch.acceptedTaskId;
  record.updatedAt = new Date().toISOString();
}

function boundText(value: string): string {
  return redactSensitiveText(value).slice(0, MAX_TEXT_LENGTH);
}

/**
 * Signatures are hashed by `normalizeReportSignature` before they reach the
 * store, but this is the persistence-layer backstop: any signature — including
 * a legacy or directly-supplied one — is redacted and length-capped so no
 * secret-shaped input can survive raw in the JSON state file.
 */
function boundSignature(value: string): string {
  return redactSensitiveText(value).replace(/\s+/g, " ").trim().slice(0, MAX_SIGNATURE_LENGTH);
}

function boundEvidenceList(evidence: string[]): string[] {
  return evidence
    .map((line) => redactSensitiveText(line).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, MAX_EVIDENCE_ENTRIES)
    .map((line) => (line.length > MAX_EVIDENCE_LENGTH ? `${line.slice(0, MAX_EVIDENCE_LENGTH - 1)}…` : line));
}

function newIntakeRecordId(): string {
  return `intake-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export function isIntakeRecordId(value: string): boolean {
  return INTAKE_RECORD_ID_PATTERN.test(value);
}

function isValidChannelConfig(value: unknown): value is IntakeChannelConfig {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<IntakeChannelConfig>;
  return typeof candidate.channelId === "string" && Boolean(candidate.channelId) && typeof candidate.projectName === "string" && Boolean(candidate.projectName);
}

function normalizeLoadedIntakeRecord(value: unknown): IntakeRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<IntakeRecord>;
  if (
    typeof record.id !== "string" ||
    !isIntakeRecordId(record.id) ||
    typeof record.channelId !== "string" ||
    typeof record.messageId !== "string" ||
    typeof record.authorId !== "string" ||
    typeof record.authorTag !== "string" ||
    typeof record.projectName !== "string" ||
    typeof record.text !== "string" ||
    typeof record.signature !== "string"
  ) {
    return undefined;
  }

  const status = INTAKE_STATUSES.includes(record.status as IntakeStatus) ? (record.status as IntakeStatus) : "dismissed";
  const createdAt = validTimestamp(record.createdAt) ?? new Date(0).toISOString();
  const updatedAt = validTimestamp(record.updatedAt) ?? createdAt;

  return {
    id: record.id,
    channelId: record.channelId,
    messageId: record.messageId,
    authorId: record.authorId,
    authorTag: record.authorTag,
    projectName: record.projectName,
    text: boundText(record.text),
    signature: boundSignature(record.signature),
    status,
    evidence: Array.isArray(record.evidence) ? boundEvidenceList(record.evidence.filter((line): line is string => typeof line === "string")) : [],
    ...(stringValue(record.screenshotUrl) ? { screenshotUrl: stringValue(record.screenshotUrl)! } : {}),
    ...(stringValue(record.duplicateOfId) ? { duplicateOfId: stringValue(record.duplicateOfId)! } : {}),
    ...(stringValue(record.triageMessageId) ? { triageMessageId: stringValue(record.triageMessageId)! } : {}),
    ...(stringValue(record.triageChannelId) ? { triageChannelId: stringValue(record.triageChannelId)! } : {}),
    ...(stringValue(record.followupPromptMessageId) ? { followupPromptMessageId: stringValue(record.followupPromptMessageId)! } : {}),
    ...(stringValue(record.acceptedTaskId) ? { acceptedTaskId: stringValue(record.acceptedTaskId)! } : {}),
    createdAt,
    updatedAt
  };
}

function normalizeLoadedRateLimits(value: unknown): Record<string, IntakeRateLimitBucket> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, IntakeRateLimitBucket> = {};
  for (const [channelId, bucket] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeLoadedRateLimitBucket(bucket);
    if (normalized) {
      result[channelId] = normalized;
    }
  }
  return result;
}

function normalizeLoadedRateLimitBucket(value: unknown): IntakeRateLimitBucket | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<IntakeRateLimitBucket>;
  const channelHits = Array.isArray(candidate.channelHits) ? candidate.channelHits.filter((entry): entry is number => typeof entry === "number") : [];
  const userHits: Record<string, number[]> = {};
  if (candidate.userHits && typeof candidate.userHits === "object" && !Array.isArray(candidate.userHits)) {
    for (const [userId, timestamps] of Object.entries(candidate.userHits)) {
      if (Array.isArray(timestamps)) {
        userHits[userId] = timestamps.filter((entry): entry is number => typeof entry === "number");
      }
    }
  }
  return { userHits, channelHits };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function validTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

function cloneState(state: IntakeStateFile): IntakeStateFile {
  return {
    version: 1,
    ...(state.channel ? { channel: { ...state.channel } } : {}),
    records: state.records.map(cloneRecord),
    rateLimits: Object.fromEntries(
      Object.entries(state.rateLimits).map(([channelId, bucket]) => [
        channelId,
        { userHits: { ...bucket.userHits }, channelHits: [...bucket.channelHits] }
      ])
    )
  };
}

function cloneRecord(record: IntakeRecord): IntakeRecord {
  return { ...record, evidence: [...record.evidence] };
}
