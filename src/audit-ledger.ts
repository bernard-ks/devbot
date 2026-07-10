import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  hardenPrivateDirectoryPermissions,
  hardenPrivateFilePermissions,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  publicErrorMessage,
  redactSensitiveText
} from "./security.js";

export const AUDIT_EVENT_TYPES = [
  "task.proposed",
  "task.approved",
  "task.started",
  "task.completed",
  "task.failed",
  "task.canceled",
  "approval.denied",
  "command.executed",
  "setup.changed",
  "collab.decided"
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export interface AuditEventInput {
  type: AuditEventType;
  actor: string;
  subject: string;
  project?: string;
  summary: string;
}

export interface AuditRecord {
  version: 1;
  seq: number;
  timestamp: string;
  type: AuditEventType;
  actor: string;
  subject: string;
  project: string;
  summary: string;
  prevHash: string;
  hash: string;
}

export interface AuditRecorder {
  record(event: AuditEventInput): Promise<void>;
}

export type AuditAnchorStatus = "match" | "behind" | "missing" | "divergent" | "empty";

export interface AuditVerification {
  ok: boolean;
  records: number;
  files: number;
  firstSeq: number;
  lastSeq: number;
  prunedPrefix: boolean;
  anchor: AuditAnchorStatus;
  anchorDetail?: string;
  failure?: { file: string; line: number; seq?: number; reason: string };
}

export interface AuditLedgerHealth {
  ok: boolean;
  detail: string;
}

const GENESIS_HASH = "0".repeat(64);
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const LEDGER_FILE_PATTERN = /^ledger-(\d{6})\.jsonl$/;
const MAX_ACTOR_LENGTH = 120;
const MAX_SUBJECT_LENGTH = 120;
const MAX_PROJECT_LENGTH = 80;
const MAX_SUMMARY_LENGTH = 300;
const RECORD_KEYS = ["version", "seq", "timestamp", "type", "actor", "subject", "project", "summary", "prevHash", "hash"] as const;

interface LedgerTail {
  seq: number;
  hash: string;
  fileIndex: number;
  fileBytes: number;
}

interface AnchorState {
  seq: number;
  hash: string;
}

export class AuditLedger implements AuditRecorder {
  private readonly directory: string;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private tail: LedgerTail | undefined;
  private mutationTail: Promise<void> = Promise.resolve();
  private lastAppendError: string | undefined;

  constructor(directory = path.resolve(".devbot", "audit"), options: { maxFileBytes?: number; maxFiles?: number } = {}) {
    this.directory = path.resolve(directory);
    this.maxFileBytes = Math.max(1, options.maxFileBytes ?? 256 * 1024);
    this.maxFiles = Math.max(1, options.maxFiles ?? 12);
  }

  async record(event: AuditEventInput): Promise<void> {
    const operation = this.mutationTail.then(() => this.append(event));
    this.mutationTail = operation.catch(() => undefined);
    try {
      await operation;
      this.lastAppendError = undefined;
    } catch (error) {
      this.lastAppendError = publicErrorMessage(error);
      throw error;
    }
  }

  async recordSafely(event: AuditEventInput): Promise<void> {
    try {
      await this.record(event);
    } catch (error) {
      console.warn(`Audit ledger append failed for ${event.type}: ${publicErrorMessage(error)}`);
    }
  }

  async records(): Promise<AuditRecord[]> {
    await this.mutationTail;
    const verification = await this.walk();
    if (verification.failure) {
      throw new Error(
        `The audit ledger failed integrity checks at ${verification.failure.file} line ${verification.failure.line}: ${verification.failure.reason} Run /audit verify for details.`
      );
    }
    const anchor = await this.computeAnchorStatus(verification.records);
    if (anchor.status === "divergent") {
      throw new Error(
        `The audit ledger head anchor diverges from the chain: ${anchor.detail ?? "the head anchor does not match the chain head."} Run /audit verify for details.`
      );
    }
    return verification.records;
  }

  async recent(options: { limit?: number; project?: string } = {}): Promise<AuditRecord[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
    const all = await this.records();
    return all
      .filter((record) => !options.project || record.project === options.project)
      .slice(-limit)
      .reverse();
  }

  async show(seq: number): Promise<AuditRecord | undefined> {
    const all = await this.records();
    return all.find((record) => record.seq === seq);
  }

  async verify(): Promise<AuditVerification> {
    await this.mutationTail;
    const walk = await this.walk();
    const records = walk.records;
    const firstSeq = records[0]?.seq ?? 0;
    const lastSeq = records.at(-1)?.seq ?? 0;
    const { status: anchorStatus, detail: anchorDetail } = await this.computeAnchorStatus(records);

    return {
      ok: !walk.failure && anchorStatus !== "divergent",
      records: records.length,
      files: walk.files,
      firstSeq,
      lastSeq,
      prunedPrefix: firstSeq > 1,
      anchor: anchorStatus,
      ...(anchorDetail ? { anchorDetail } : {}),
      ...(walk.failure ? { failure: walk.failure } : {})
    };
  }

  private async computeAnchorStatus(records: AuditRecord[]): Promise<{ status: AuditAnchorStatus; detail?: string }> {
    const firstSeq = records[0]?.seq ?? 0;
    const lastSeq = records.at(-1)?.seq ?? 0;
    const anchor = await this.readAnchor();
    if (anchor === "missing") {
      return { status: records.length === 0 ? "empty" : "missing" };
    }
    if (anchor === "unreadable") {
      return { status: "divergent", detail: "The head anchor file exists but is unreadable or malformed." };
    }
    if (records.length === 0) {
      return {
        status: "divergent",
        detail: `The head anchor records seq ${anchor.seq}, but the ledger has no records (possible deletion or rollback).`
      };
    }
    if (anchor.seq === lastSeq) {
      const head = records.at(-1)!;
      return head.hash === anchor.hash
        ? { status: "match" }
        : { status: "divergent", detail: `The head anchor hash does not match the chain head at seq ${lastSeq}.` };
    }
    if (anchor.seq > lastSeq) {
      return {
        status: "divergent",
        detail: `The head anchor records seq ${anchor.seq}, but the ledger ends at seq ${lastSeq} (possible truncation or rollback).`
      };
    }
    if (anchor.seq < firstSeq) {
      // The anchor predates the first retained record, so it cannot be checked
      // against a record still on disk. The retained chain nonetheless carries
      // an authenticated retention checkpoint: records[0].prevHash is the hash
      // of the record that used to sit at firstSeq - 1, cryptographically bound
      // into the verified chain. An anchor pinned exactly at that pruned
      // boundary with the matching hash is a genuine interrupted anchor update
      // that retention has since passed, so it is authenticated and behind.
      // Anything deeper, or a hash that does not match the checkpoint, cannot be
      // authenticated against the retained records: fail closed rather than
      // trusting it (and, in loadTail, rather than rewriting head.json over it).
      const boundarySeq = firstSeq - 1;
      const boundaryHash = records[0]!.prevHash;
      if (anchor.seq === boundarySeq && anchor.hash === boundaryHash) {
        return {
          status: "behind",
          detail: `The head anchor at seq ${anchor.seq} is the pruned retention boundary and is authenticated by the retained chain (an interrupted anchor update).`
        };
      }
      return {
        status: "divergent",
        detail: `The head anchor at seq ${anchor.seq} predates the retained records and cannot be authenticated against them (retention boundary at seq ${boundarySeq}).`
      };
    }
    const anchored = records.find((record) => record.seq === anchor.seq);
    if (anchored && anchored.hash === anchor.hash) {
      return {
        status: "behind",
        detail: `The head anchor is ${lastSeq - anchor.seq} append(s) behind the chain head (an interrupted anchor update).`
      };
    }
    return { status: "divergent", detail: `The head anchor hash does not match the chain at seq ${anchor.seq}.` };
  }

  async health(): Promise<AuditLedgerHealth> {
    if (this.lastAppendError) {
      return { ok: false, detail: `The last audit append failed: ${this.lastAppendError}` };
    }
    try {
      const verification = await this.verify();
      if (verification.ok) {
        return { ok: true, detail: `${verification.records} record(s) verified across ${verification.files} file(s).` };
      }
      if (verification.failure) {
        return {
          ok: false,
          detail: `Chain divergence at seq ${verification.failure.seq ?? "unknown"} (${verification.failure.file} line ${verification.failure.line}).`
        };
      }
      return { ok: false, detail: verification.anchorDetail ?? "The head anchor diverges from the chain." };
    } catch (error) {
      return { ok: false, detail: publicErrorMessage(error) };
    }
  }

  private async append(event: AuditEventInput): Promise<void> {
    const tail = await this.loadTail();
    const record = buildRecord(event, tail.seq + 1, tail.hash);
    const line = `${JSON.stringify(serializeRecord(record))}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    let fileIndex = tail.fileIndex;
    let fileBytes = tail.fileBytes;
    if (fileIndex === 0 || (fileBytes > 0 && fileBytes + lineBytes > this.maxFileBytes)) {
      fileIndex += 1;
      fileBytes = 0;
    }

    await mkdir(this.directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await hardenPrivateDirectoryPermissions(this.directory);
    const filePath = this.ledgerFilePath(fileIndex);
    const handle = await open(filePath, "a", PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(line, "utf8");
      await handle.datasync();
    } catch (error) {
      // The line may be partially written; the cached tail can no longer be
      // trusted. Drop it so the next append reloads the real head from disk
      // rather than reusing a sequence/hash that may already be persisted.
      this.tail = undefined;
      throw error;
    } finally {
      await handle.close();
    }
    // The record is now durably on disk, so it is the authoritative head.
    // Advance the cached tail before the anchor and pruning steps: those are
    // secondary bookkeeping, and if either fails the sequence/hash must never
    // be reused by a later append.
    this.tail = { seq: record.seq, hash: record.hash, fileIndex, fileBytes: fileBytes + lineBytes };
    try {
      await hardenPrivateFilePermissions(filePath);
      await this.writeAnchor({ seq: record.seq, hash: record.hash });
      if (fileIndex !== tail.fileIndex) {
        await this.pruneOldFiles();
      }
    } catch (error) {
      // The record is durable but the anchor update or pruning did not
      // complete. Invalidate the cached tail so the next append reloads from
      // disk: loadTail then either reconciles an interrupted (behind) anchor
      // update by re-reading the true head, or refuses further appends if the
      // on-disk state is genuinely divergent.
      this.tail = undefined;
      throw error;
    }
  }

  private async loadTail(): Promise<LedgerTail> {
    if (this.tail) {
      return this.tail;
    }

    const indices = await this.ledgerFileIndices();
    let tail: LedgerTail = { seq: 0, hash: GENESIS_HASH, fileIndex: indices.at(-1) ?? 0, fileBytes: 0 };
    for (let position = indices.length - 1; position >= 0; position -= 1) {
      const fileIndex = indices[position]!;
      const filePath = this.ledgerFilePath(fileIndex);
      const content = await readFile(filePath, "utf8");
      const lines = content.split("\n").filter((value) => value.length > 0);
      if (lines.length === 0) {
        continue;
      }
      const parsed = parseRecordLine(lines.at(-1)!);
      if ("error" in parsed) {
        throw new Error(`The audit ledger tail in ${path.basename(filePath)} is unreadable: ${parsed.error} Appends are refused; run /audit verify.`);
      }
      if (parsed.record.hash !== hashRecord(parsed.record)) {
        throw new Error(
          `The audit ledger tail in ${path.basename(filePath)} failed its hash check. Appends are refused until the divergence is investigated; run /audit verify.`
        );
      }
      tail = {
        seq: parsed.record.seq,
        hash: parsed.record.hash,
        fileIndex: indices.at(-1)!,
        fileBytes: indices.at(-1) === fileIndex ? Buffer.byteLength(content, "utf8") : (await stat(this.ledgerFilePath(indices.at(-1)!))).size
      };
      break;
    }

    // Fail closed on a cold load: walk the entire retained chain before trusting
    // it as the base for new appends. A tail-only check cannot see an interior
    // tamper, so without this a forged middle record could be silently extended
    // by the next append.
    const walk = await this.walk();
    if (walk.failure) {
      throw new Error(
        `The audit ledger failed integrity checks at ${walk.failure.file} line ${walk.failure.line}: ${walk.failure.reason} Appends are refused; run /audit verify.`
      );
    }

    // Cross-check the head anchor against the walked chain before trusting the
    // tail. This is the same reconciliation verify() and records() apply, so an
    // append can never be looser than a read. A behind anchor is reconciled only
    // when its hash matches the retained record at that sequence (an interrupted
    // anchor update). An unreadable, hash-divergent, or same/ahead-sequence
    // mismatch is refused WITHOUT rewriting head.json, and a missing anchor on a
    // nonempty ledger fails closed: append must never silently repair the
    // evidence of divergence.
    const { status: anchorStatus, detail: anchorDetail } = await this.computeAnchorStatus(walk.records);
    if (anchorStatus === "missing") {
      throw new Error(
        `The audit ledger head anchor is missing but the ledger holds ${walk.records.length} record(s). Appends are refused until the anchor is restored; run /audit verify.`
      );
    }
    if (anchorStatus === "divergent") {
      throw new Error(
        `The audit ledger head diverges from its anchor: ${anchorDetail ?? "the head anchor does not match the retained chain."} Appends are refused until the divergence is investigated; run /audit verify.`
      );
    }

    this.tail = tail;
    return tail;
  }

  private async walk(): Promise<{ records: AuditRecord[]; files: number; failure?: AuditVerification["failure"] }> {
    const indices = await this.ledgerFileIndices();
    const records: AuditRecord[] = [];
    let previous: AuditRecord | undefined;
    for (const fileIndex of indices) {
      const fileName = `ledger-${String(fileIndex).padStart(6, "0")}.jsonl`;
      let content: string;
      try {
        content = await readFile(this.ledgerFilePath(fileIndex), "utf8");
      } catch (error) {
        return { records, files: indices.length, failure: { file: fileName, line: 0, reason: `The file could not be read: ${publicErrorMessage(error)}.` } };
      }
      const lines = content.split("\n");
      for (let lineNumber = 1; lineNumber <= lines.length; lineNumber += 1) {
        const raw = lines[lineNumber - 1]!;
        if (raw.length === 0) {
          continue;
        }
        const parsed = parseRecordLine(raw);
        if ("error" in parsed) {
          return { records, files: indices.length, failure: { file: fileName, line: lineNumber, ...(previous ? { seq: previous.seq + 1 } : {}), reason: parsed.error } };
        }
        const record = parsed.record;
        const expectedHash = hashRecord(record);
        if (record.hash !== expectedHash) {
          return {
            records,
            files: indices.length,
            failure: { file: fileName, line: lineNumber, seq: record.seq, reason: "The stored hash does not match the record contents." }
          };
        }
        if (previous) {
          if (record.seq !== previous.seq + 1) {
            return {
              records,
              files: indices.length,
              failure: { file: fileName, line: lineNumber, seq: record.seq, reason: `Sequence jumps from ${previous.seq} to ${record.seq}.` }
            };
          }
          if (record.prevHash !== previous.hash) {
            return {
              records,
              files: indices.length,
              failure: { file: fileName, line: lineNumber, seq: record.seq, reason: "The record's prevHash does not match the preceding record's hash." }
            };
          }
        } else if (record.seq === 1 && record.prevHash !== GENESIS_HASH) {
          return {
            records,
            files: indices.length,
            failure: { file: fileName, line: lineNumber, seq: record.seq, reason: "The first record does not chain from the genesis hash." }
          };
        }
        records.push(record);
        previous = record;
      }
    }
    return { records, files: indices.length };
  }

  private async ledgerFileIndices(): Promise<number[]> {
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    return entries
      .map((entry) => LEDGER_FILE_PATTERN.exec(entry)?.[1])
      .filter((match): match is string => match !== undefined)
      .map((match) => Number.parseInt(match, 10))
      .sort((left, right) => left - right);
  }

  private ledgerFilePath(fileIndex: number): string {
    return path.join(this.directory, `ledger-${String(fileIndex).padStart(6, "0")}.jsonl`);
  }

  private get anchorPath(): string {
    return path.join(this.directory, "head.json");
  }

  private async readAnchor(): Promise<AnchorState | "missing" | "unreadable"> {
    let content: string;
    try {
      content = await readFile(this.anchorPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "missing";
      }
      return "unreadable";
    }
    try {
      const parsed = JSON.parse(content) as { version?: unknown; seq?: unknown; hash?: unknown };
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.version === 1 &&
        typeof parsed.seq === "number" &&
        Number.isSafeInteger(parsed.seq) &&
        parsed.seq >= 1 &&
        typeof parsed.hash === "string" &&
        HASH_PATTERN.test(parsed.hash)
      ) {
        return { seq: parsed.seq, hash: parsed.hash };
      }
    } catch {
      return "unreadable";
    }
    return "unreadable";
  }

  private async writeAnchor(anchor: AnchorState): Promise<void> {
    const tempPath = `${this.anchorPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tempPath, `${JSON.stringify({ version: 1, seq: anchor.seq, hash: anchor.hash, updatedAt: new Date().toISOString() }, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: PRIVATE_FILE_MODE
    });
    await rename(tempPath, this.anchorPath);
  }

  private async pruneOldFiles(): Promise<void> {
    const indices = await this.ledgerFileIndices();
    const excess = indices.length - this.maxFiles;
    for (let position = 0; position < excess; position += 1) {
      await rm(this.ledgerFilePath(indices[position]!), { force: true });
    }
  }
}

export function isAuditRecordVisible(
  record: AuditRecord,
  access: { ownerView: boolean; visibleProjects: ReadonlySet<string>; projectFilter?: string }
): boolean {
  if (access.projectFilter) {
    return record.project === access.projectFilter && (access.ownerView || access.visibleProjects.has(record.project));
  }
  if (access.ownerView) {
    return true;
  }
  return record.project === "" || access.visibleProjects.has(record.project);
}

export function formatAuditRecords(records: AuditRecord[]): string {
  if (records.length === 0) {
    return "No matching audit records found.";
  }
  return records
    .map((record) => {
      const project = record.project ? ` on \`${record.project}\`` : "";
      const summary = record.summary ? `: ${record.summary}` : "";
      return `- #${record.seq} ${record.timestamp} ${record.type} \`${record.subject}\`${project} by ${record.actor}${summary}`;
    })
    .join("\n");
}

export function formatAuditVerification(result: AuditVerification): string {
  const lines: string[] = [];
  if (result.records === 0 && !result.failure && result.anchor !== "divergent") {
    return "Audit ledger OK: no records yet.";
  }
  if (result.ok) {
    lines.push(`Audit ledger OK: ${result.records} record(s) across ${result.files} file(s), seq ${result.firstSeq}-${result.lastSeq}.`);
  } else if (result.failure) {
    lines.push(
      `Audit ledger FAILED verification. First divergence: ${result.failure.file} line ${result.failure.line}` +
        `${result.failure.seq !== undefined ? ` (seq ${result.failure.seq})` : ""}. ${result.failure.reason}`
    );
    lines.push(`${result.records} record(s) before the divergence verified cleanly.`);
  } else {
    lines.push("Audit ledger FAILED verification: the hash chain is internally consistent, but the head anchor diverges.");
  }
  if (result.prunedPrefix && result.records > 0) {
    lines.push(`Records before seq ${result.firstSeq} were pruned by retention; verification is anchored at seq ${result.firstSeq}.`);
  }
  if (result.anchorDetail) {
    lines.push(`Anchor: ${result.anchorDetail}`);
  } else if (result.anchor === "match") {
    lines.push("Anchor: the head anchor matches the chain head.");
  } else if (result.anchor === "missing") {
    lines.push("Anchor: no head anchor file was found.");
  }
  return lines.join("\n");
}

function buildRecord(event: AuditEventInput, seq: number, prevHash: string): AuditRecord {
  const base: Omit<AuditRecord, "hash"> = {
    version: 1,
    seq,
    timestamp: new Date().toISOString(),
    type: event.type,
    actor: normalizeField(event.actor, MAX_ACTOR_LENGTH) || "unknown",
    subject: normalizeField(event.subject, MAX_SUBJECT_LENGTH) || "unknown",
    project: normalizeField(event.project ?? "", MAX_PROJECT_LENGTH),
    summary: normalizeField(event.summary, MAX_SUMMARY_LENGTH),
    prevHash
  };
  return { ...base, hash: hashRecord(base) };
}

function normalizeField(value: string, maxLength: number): string {
  const normalized = redactSensitiveText(value).replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function hashRecord(record: Omit<AuditRecord, "hash">): string {
  return createHash("sha256").update(canonicalPayload(record), "utf8").digest("hex");
}

function canonicalPayload(record: Omit<AuditRecord, "hash">): string {
  return JSON.stringify({
    version: record.version,
    seq: record.seq,
    timestamp: record.timestamp,
    type: record.type,
    actor: record.actor,
    subject: record.subject,
    project: record.project,
    summary: record.summary,
    prevHash: record.prevHash
  });
}

function serializeRecord(record: AuditRecord): Record<string, unknown> {
  return {
    version: record.version,
    seq: record.seq,
    timestamp: record.timestamp,
    type: record.type,
    actor: record.actor,
    subject: record.subject,
    project: record.project,
    summary: record.summary,
    prevHash: record.prevHash,
    hash: record.hash
  };
}

function parseRecordLine(line: string): { record: AuditRecord } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { error: "The line is not valid JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "The record is not a JSON object." };
  }
  const raw = parsed as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length !== RECORD_KEYS.length || RECORD_KEYS.some((key) => !(key in raw))) {
    return { error: "The record does not have exactly the expected fields." };
  }
  if (raw.version !== 1) {
    return { error: `Unsupported audit record version: ${String(raw.version)}.` };
  }
  if (typeof raw.seq !== "number" || !Number.isSafeInteger(raw.seq) || raw.seq < 1) {
    return { error: "The record sequence number is invalid." };
  }
  if (typeof raw.timestamp !== "string" || !Number.isFinite(Date.parse(raw.timestamp))) {
    return { error: "The record timestamp is invalid." };
  }
  if (typeof raw.type !== "string" || !AUDIT_EVENT_TYPES.includes(raw.type as AuditEventType)) {
    return { error: `Unknown audit event type: ${String(raw.type)}.` };
  }
  if (typeof raw.actor !== "string" || raw.actor.length === 0 || raw.actor.length > MAX_ACTOR_LENGTH) {
    return { error: "The record actor is invalid." };
  }
  if (typeof raw.subject !== "string" || raw.subject.length === 0 || raw.subject.length > MAX_SUBJECT_LENGTH) {
    return { error: "The record subject is invalid." };
  }
  if (typeof raw.project !== "string" || raw.project.length > MAX_PROJECT_LENGTH) {
    return { error: "The record project is invalid." };
  }
  if (typeof raw.summary !== "string" || raw.summary.length > MAX_SUMMARY_LENGTH) {
    return { error: "The record summary is invalid." };
  }
  if (typeof raw.prevHash !== "string" || (raw.prevHash !== GENESIS_HASH && !HASH_PATTERN.test(raw.prevHash))) {
    return { error: "The record prevHash is invalid." };
  }
  if (typeof raw.hash !== "string" || !HASH_PATTERN.test(raw.hash)) {
    return { error: "The record hash is invalid." };
  }
  return {
    record: {
      version: 1,
      seq: raw.seq,
      timestamp: raw.timestamp,
      type: raw.type as AuditEventType,
      actor: raw.actor,
      subject: raw.subject,
      project: raw.project,
      summary: raw.summary,
      prevHash: raw.prevHash,
      hash: raw.hash
    }
  };
}
