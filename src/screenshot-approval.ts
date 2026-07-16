import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

const CONTROL_PREFIX = "devbot:screenshot:v1:";
const SAFE_ID = /^[a-f0-9]{16}$/;
const policyMutationTails = new Map<string, Promise<void>>();

export type ScreenshotApprovalAction = "once" | "always" | "deny";
export type ScreenshotViewport = "desktop" | "tablet" | "mobile";

export interface PendingScreenshotApproval {
  id: string;
  projectName: string;
  requesterId: string;
  target: string;
  viewport: ScreenshotViewport;
  createdAt: number;
  expiresAt: number;
}

export class ScreenshotApprovalStore {
  private readonly pending = new Map<string, PendingScreenshotApproval>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 10 * 60_000,
    private readonly maxPending = 100
  ) {}

  create(input: Omit<PendingScreenshotApproval, "id" | "createdAt" | "expiresAt">): PendingScreenshotApproval {
    this.prune();
    while (this.pending.size >= this.maxPending) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pending.delete(oldest);
    }
    const createdAt = this.now();
    const record: PendingScreenshotApproval = {
      ...input,
      id: randomBytes(8).toString("hex"),
      createdAt,
      expiresAt: createdAt + this.ttlMs
    };
    this.pending.set(record.id, record);
    return { ...record };
  }

  peek(id: string): PendingScreenshotApproval | undefined {
    this.prune();
    const record = this.pending.get(id);
    return record ? { ...record } : undefined;
  }

  consume(id: string): PendingScreenshotApproval | undefined {
    const record = this.peek(id);
    if (record) this.pending.delete(id);
    return record;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, record] of this.pending) {
      if (record.expiresAt <= now) this.pending.delete(id);
    }
  }
}

export function screenshotApprovalRow(id: string): ActionRowBuilder<ButtonBuilder> {
  if (!SAFE_ID.test(id)) throw new Error("Invalid screenshot approval ID.");
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${CONTROL_PREFIX}once:${id}`).setLabel("Approve once").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${CONTROL_PREFIX}always:${id}`).setLabel("Always allow").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${CONTROL_PREFIX}deny:${id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
  );
}

export function parseScreenshotApprovalControl(customId: string): { action: ScreenshotApprovalAction; id: string } | undefined {
  if (!customId.startsWith(CONTROL_PREFIX)) return undefined;
  const [action, id, ...extra] = customId.slice(CONTROL_PREFIX.length).split(":");
  if (extra.length || !id || !SAFE_ID.test(id) || (action !== "once" && action !== "always" && action !== "deny")) {
    return undefined;
  }
  return { action, id };
}

/** Persist the authoritative repo policy without replacing unrelated metadata. */
export async function persistScreenshotPolicy(projectRoot: string, policy: "allow" | "approval" | "deny"): Promise<void> {
  const directory = path.join(path.resolve(projectRoot), ".devbot");
  const file = path.join(directory, "project.json");
  const previous = policyMutationTails.get(file) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(() => persistScreenshotPolicyOnce(directory, file, policy));
  policyMutationTails.set(file, operation);
  try {
    await operation;
  } finally {
    if (policyMutationTails.get(file) === operation) policyMutationTails.delete(file);
  }
}

async function persistScreenshotPolicyOnce(
  directory: string,
  file: string,
  policy: "allow" | "approval" | "deny"
): Promise<void> {
  rejectSymlink(directory);
  rejectSymlink(file);
  const current = existsSync(file) ? parseObject(readFileSync(file, "utf8"), file) : {};
  const currentPolicy = current.policy === undefined ? {} : objectValue(current.policy, "project policy");
  const next = { ...current, policy: { ...currentPolicy, screenshotPolicy: policy } };
  const mode = existsSync(file) ? lstatSync(file).mode & 0o777 : 0o644;
  await mkdir(directory, { recursive: true, mode: 0o755 });
  rejectSymlink(directory);
  rejectSymlink(file);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

function rejectSymlink(value: string): void {
  if (existsSync(value) && lstatSync(value).isSymbolicLink()) {
    throw new Error(`Refusing to update symlinked project metadata at ${value}.`);
  }
}

function parseObject(value: string, file: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Unable to update project metadata at ${file}: ${(error as Error).message}`);
  }
  return objectValue(parsed, "project metadata");
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}
