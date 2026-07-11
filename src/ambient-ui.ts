import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  ModalBuilder,
  SectionBuilder,
  SeparatorBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";
import { sanitizeDiscordOutput } from "./security.js";

const CUSTOM_ID_PREFIX = "devbot:ambient:v1:";
const SAFE_ENTITY_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const AMBIENT_UI_LIMITS = {
  customId: 100,
  entityId: 64,
  inboxItems: 5,
  selectOptions: 25,
  textDisplay: 4_000
} as const;

export type AmbientRole = "builder" | "reviewer" | "verifier";
export type AmbientAction =
  | "proposal-confirm"
  | "proposal-edit"
  | "proposal-readonly"
  | "proposal-decline"
  | "progress-cancel"
  | "completion-proof"
  | "completion-reviewed"
  | "inbox-open"
  | "inbox-refresh"
  | "team-select";

export interface ParsedAmbientControl {
  action: AmbientAction;
  entityId: string;
}

export interface ParsedProposalEntity {
  taskId: string;
  revision: number;
}

export interface AmbientComponentsV2Payload {
  flags: MessageFlags.IsComponentsV2;
  components: [ContainerBuilder];
  allowedMentions: { parse: [] };
}

export interface ConfirmToActProposalInput {
  proposalId: string;
  project: string;
  title: string;
  proposal: string;
  rationale?: string;
  scope?: readonly string[];
  requestedBy?: string;
  selectedRoles?: readonly AmbientRole[];
  disabled?: boolean;
}

export interface ProgressCardInput {
  taskId: string;
  project: string;
  title: string;
  phase: string;
  detail: string;
  completed?: readonly string[];
  blocker?: string;
  nextUpdate?: string;
  roles?: readonly AmbientRole[];
  percent?: number;
  canCancel?: boolean;
}

export type ProofStatus = "passed" | "failed" | "info";

export interface CompletionProof {
  label: string;
  detail: string;
  status?: ProofStatus;
}

export interface ProofFirstCompletionInput {
  taskId: string;
  project: string;
  title: string;
  summary: string;
  proof: readonly CompletionProof[];
  changedFiles?: readonly string[];
  roles?: readonly AmbientRole[];
  showProofButton?: boolean;
}

export type NeedsMeUrgency = "normal" | "high";

export interface NeedsMeItem {
  id: string;
  project: string;
  title: string;
  reason: string;
  urgency?: NeedsMeUrgency;
  disabled?: boolean;
}

export interface NeedsMeInboxInput {
  inboxId: string;
  items: readonly NeedsMeItem[];
  selectedRoles?: readonly AmbientRole[];
  title?: string;
}

export interface TaskProgressCardInput {
  project: string;
  title: string;
  phase: string;
  detail: string;
  meta: string;
  percent?: number;
  blocker?: string;
  controlRows?: readonly ActionRowBuilder<ButtonBuilder>[];
}

export interface TaskCompletionCardInput {
  project: string;
  title: string;
  summary: string;
  proof: readonly CompletionProof[];
  meta?: string;
  changedFiles?: readonly string[];
  controlRows?: readonly ActionRowBuilder<ButtonBuilder>[];
}

export interface TaskDetailCardInput {
  taskId: string;
  project: string;
  status: string;
  detail: string;
  workroom?: string;
}

export interface ReviewPacketCardInput {
  project: string;
  branch: string;
  defaultBranch: string;
  lastCommit: string;
  repoUrl?: string;
  taskId?: string;
  taskStatus?: string;
  taskRequest?: string;
  changedFiles: string;
  diffStat: string;
  suggestedVerification: readonly string[];
}

export interface ReviewEvidenceCheck {
  name: string;
  command: string;
  ok: boolean;
  exitCode?: number;
  output: string;
}

export interface ReviewEvidenceCardInput {
  title: string;
  project: string;
  passed: boolean;
  summary?: readonly string[];
  checks: readonly ReviewEvidenceCheck[];
}

export function ambientCustomId(action: AmbientAction, entityId: string): string {
  if (!SAFE_ENTITY_ID.test(entityId)) {
    throw new RangeError(`Ambient entity IDs must match ${SAFE_ENTITY_ID} and be at most ${AMBIENT_UI_LIMITS.entityId} characters.`);
  }
  const customId = `${CUSTOM_ID_PREFIX}${action}:${entityId}`;
  if (customId.length > AMBIENT_UI_LIMITS.customId) {
    throw new RangeError(`Ambient custom IDs must be at most ${AMBIENT_UI_LIMITS.customId} characters.`);
  }
  return customId;
}

export function parseAmbientCustomId(customId: string): ParsedAmbientControl | undefined {
  if (customId.length > AMBIENT_UI_LIMITS.customId || !customId.startsWith(CUSTOM_ID_PREFIX)) {
    return undefined;
  }
  const [action, entityId, ...extra] = customId.slice(CUSTOM_ID_PREFIX.length).split(":");
  if (extra.length > 0 || !isAmbientAction(action) || !entityId || !SAFE_ENTITY_ID.test(entityId)) {
    return undefined;
  }
  return { action, entityId };
}

export function proposalEntityId(taskId: string, revision = 1): string {
  if (!/^task-[a-z0-9-]{1,52}$/i.test(taskId) || !Number.isSafeInteger(revision) || revision < 1) {
    throw new RangeError("Proposal controls require a bounded task ID and positive revision.");
  }
  return `${taskId}_r${revision}`;
}

export function parseProposalEntityId(entityId: string): ParsedProposalEntity | undefined {
  const match = /^(task-[a-z0-9-]{1,52})(?:_r([1-9][0-9]*))?$/i.exec(entityId);
  if (!match?.[1]) return undefined;
  const revision = match[2] ? Number(match[2]) : 1;
  return Number.isSafeInteger(revision) ? { taskId: match[1], revision } : undefined;
}

export function parseAmbientRole(value: string): AmbientRole | undefined {
  return isAmbientRole(value) ? value : undefined;
}

export function parseAmbientRoleSelection(values: readonly string[]): AmbientRole[] | undefined {
  if (values.length < 1 || values.length > 3) {
    return undefined;
  }
  const roles = values.map(parseAmbientRole);
  if (roles.some((role) => role === undefined)) {
    return undefined;
  }
  const unique = new Set(roles as AmbientRole[]);
  return unique.size === roles.length ? [...unique] : undefined;
}

export function roleTeamSelector(entityId: string, selectedRoles: readonly AmbientRole[] = []): StringSelectMenuBuilder {
  const selected = new Set(selectedRoles);
  return new StringSelectMenuBuilder()
    .setCustomId(ambientCustomId("team-select", entityId))
    .setPlaceholder("Builder / Reviewer / Verifier")
    .setMinValues(1)
    .setMaxValues(3)
    .addOptions(
      roleOption("builder", "Builder", "Implements the approved change", selected.has("builder")),
      roleOption("reviewer", "Reviewer", "Reviews scope and code quality", selected.has("reviewer")),
      roleOption("verifier", "Verifier", "Checks tests and completion proof", selected.has("verifier"))
    );
}

export function confirmToActProposalCard(input: ConfirmToActProposalInput): AmbientComponentsV2Payload {
  const heading = [
    "## Confirm to act",
    `**${inline(input.title, 140)}**`,
    `${inline(input.project, 80)}${input.requestedBy ? ` | Proposed by ${inline(input.requestedBy, 80)}` : ""}`
  ].join("\n");
  const body = [
    "**Proposed action**",
    block(input.proposal, 1_100),
    input.rationale ? `\n**Why now**\n${block(input.rationale, 550)}` : undefined,
    input.scope?.length ? `\n**Scope**\n${bullets(input.scope, 5, 150)}` : undefined
  ].filter(isDefined).join("\n");

  const container = new ContainerBuilder()
    .setAccentColor(0xd97706)
    .addTextDisplayComponents(text(heading))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(text(body))
    .addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(roleTeamSelector(input.proposalId, input.selectedRoles))
    )
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(ambientCustomId("proposal-confirm", input.proposalId))
          .setLabel("Approve and start")
          .setStyle(ButtonStyle.Success)
          .setDisabled(input.disabled ?? false),
        new ButtonBuilder()
          .setCustomId(ambientCustomId("proposal-edit", input.proposalId))
          .setLabel("Edit")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(input.disabled ?? false),
        new ButtonBuilder()
          .setCustomId(ambientCustomId("proposal-readonly", input.proposalId))
          .setLabel("Answer only")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(input.disabled ?? false),
        new ButtonBuilder()
          .setCustomId(ambientCustomId("proposal-decline", input.proposalId))
          .setLabel("Decline")
          .setStyle(ButtonStyle.Danger)
          .setDisabled(input.disabled ?? false)
      )
    );
  return componentsV2Payload(container);
}

export function proposalEditModal(proposalId: string, currentText: string): ModalBuilder {
  const request = new TextInputBuilder()
    .setCustomId("request")
    .setLabel("What should Devbot do?")
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(2)
    .setMaxLength(4_000)
    .setRequired(true)
    .setValue(currentText.slice(0, 4_000));
  return new ModalBuilder()
    .setCustomId(ambientCustomId("proposal-edit", proposalId))
    .setTitle("Edit proposed action")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(request));
}

export function progressCard(input: ProgressCardInput): AmbientComponentsV2Payload {
  const percent = input.percent === undefined ? undefined : Math.max(0, Math.min(100, Math.round(input.percent)));
  const heading = [
    "## In progress",
    `**${inline(input.title, 140)}**`,
    `${inline(input.project, 80)} | ${inline(input.phase, 80)}${percent === undefined ? "" : ` | ${percent}%`}`
  ].join("\n");
  const body = [
    block(input.detail, 850),
    input.roles?.length ? `\n**Team**\n${formatRoles(input.roles)}` : undefined,
    input.completed?.length ? `\n**Completed**\n${bullets(input.completed, 5, 140)}` : undefined,
    input.blocker ? `\n**Blocker**\n${block(input.blocker, 500)}` : undefined,
    input.nextUpdate ? `\n**Next update**\n${block(input.nextUpdate, 350)}` : undefined
  ].filter(isDefined).join("\n");
  const container = new ContainerBuilder()
    .setAccentColor(input.blocker ? 0xdc2626 : 0x2563eb)
    .addTextDisplayComponents(text(heading))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(text(body))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(ambientCustomId("progress-cancel", input.taskId))
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(input.canCancel === false)
      )
    );
  return componentsV2Payload(container);
}

export function proofFirstCompletionCard(input: ProofFirstCompletionInput): AmbientComponentsV2Payload {
  const heading = [
    "## Complete",
    `**${inline(input.title, 140)}**`,
    inline(input.project, 80)
  ].join("\n");
  const proof = input.proof.length === 0
    ? "No verification evidence was recorded."
    : input.proof.slice(0, 6).map((item) => {
      const status = item.status === "failed" ? "FAIL" : item.status === "info" ? "INFO" : "PASS";
      return `- **[${status}] ${inline(sanitizeDiscordOutput(item.label), 80)}:** ${block(sanitizeDiscordOutput(item.detail), 280)}`;
    }).join("\n");
  const result = [
    "**Result**",
    block(sanitizeDiscordOutput(input.summary), 650),
    input.roles?.length ? `\n**Team**\n${formatRoles(input.roles)}` : undefined,
    input.changedFiles?.length ? `\n**Changed files**\n${bullets(input.changedFiles, 5, 120, true)}` : undefined
  ].filter(isDefined).join("\n");
  const container = new ContainerBuilder()
    .setAccentColor(input.proof.some((item) => item.status === "failed") ? 0xdc2626 : 0x16a34a)
    .addTextDisplayComponents(text(heading))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(text(`**Proof**\n${proof}`))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(text(result));

  if (input.showProofButton !== false) {
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(ambientCustomId("completion-proof", input.taskId))
          .setLabel("Open proof")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(ambientCustomId("completion-reviewed", input.taskId))
          .setLabel("Mark reviewed")
          .setStyle(ButtonStyle.Success)
      )
    );
  }
  return componentsV2Payload(container);
}

export function needsMeInbox(input: NeedsMeInboxInput): AmbientComponentsV2Payload {
  const visibleItems = input.items.slice(0, AMBIENT_UI_LIMITS.inboxItems);
  const overflow = Math.max(0, input.items.length - visibleItems.length);
  const heading = [
    `## ${inline(input.title ?? "Needs Me", 120)}`,
    visibleItems.length === 0 ? "Nothing is waiting for your decision." : `${input.items.length} decision${input.items.length === 1 ? "" : "s"} waiting.`
  ].join("\n");
  const container = new ContainerBuilder().setAccentColor(visibleItems.some((item) => item.urgency === "high") ? 0xdc2626 : 0x7c3aed)
    .addTextDisplayComponents(text(heading));

  for (const item of visibleItems) {
    const urgency = item.urgency === "high" ? "HIGH | " : "";
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          text(`**${urgency}${inline(item.project, 60)} | ${inline(item.title, 100)}**\n${block(item.reason, 300)}`)
        )
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(ambientCustomId("inbox-open", item.id))
            .setLabel("Review")
            .setStyle(item.urgency === "high" ? ButtonStyle.Danger : ButtonStyle.Primary)
            .setDisabled(item.disabled ?? false)
        )
    );
  }

  if (overflow > 0) {
    container.addTextDisplayComponents(text(`_${overflow} more ${overflow === 1 ? "item" : "items"} not shown._`));
  }
  container
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(ambientCustomId("inbox-refresh", input.inboxId))
          .setLabel("Refresh")
          .setStyle(ButtonStyle.Secondary)
      )
    );
  return componentsV2Payload(container);
}

export function taskProgressCard(input: TaskProgressCardInput): AmbientComponentsV2Payload {
  const percent = input.percent === undefined ? undefined : Math.max(0, Math.min(100, Math.round(input.percent)));
  const heading = [
    `## ${input.blocker ? "Needs attention" : "In progress"}`,
    `**${inline(input.title, 140)}**`,
    `${inline(input.project, 80)} | ${inline(input.phase, 80)}${percent === undefined ? "" : ` | ${percent}%`}`
  ].join("\n");
  const body = [
    block(input.detail, 1_500),
    `\n_${inline(input.meta, 220)}_`,
    input.blocker ? `\n**Blocker**\n${block(sanitizeDiscordOutput(input.blocker), 650)}` : undefined
  ].filter(isDefined).join("\n");
  const container = new ContainerBuilder()
    .setAccentColor(input.blocker ? 0xdc2626 : 0x2563eb)
    .addTextDisplayComponents(text(heading))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(text(body));
  addControlRows(container, input.controlRows);
  return componentsV2Payload(container);
}

export function taskCompletionCard(input: TaskCompletionCardInput): AmbientComponentsV2Payload {
  const failed = input.proof.some((item) => item.status === "failed");
  const proof = formatProof(input.proof, 6, 160);
  const result = [
    "**Result**",
    block(sanitizeDiscordOutput(input.summary), 1_250),
    input.changedFiles?.length ? `\n**Changed files**\n${bullets(input.changedFiles, 5, 110, true)}` : undefined
  ].filter(isDefined).join("\n");
  const container = new ContainerBuilder()
    .setAccentColor(failed ? 0xdc2626 : 0x16a34a)
    .addTextDisplayComponents(text([
      failed ? "## Complete with attention needed" : "## Complete",
      `**${inline(input.title, 140)}**`,
      `${inline(input.project, 80)}${input.meta ? ` | ${inline(input.meta, 120)}` : ""}`
    ].join("\n")))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(text(`**Proof**\n${proof}`))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(text(result));
  addControlRows(container, input.controlRows);
  return componentsV2Payload(container);
}

export function taskDetailCard(input: TaskDetailCardInput): AmbientComponentsV2Payload {
  const heading = [
    "## Task detail",
    `**${inline(input.taskId, 80)}**`,
    `${inline(input.project, 80)} | ${inline(input.status, 60)}`
  ].join("\n");
  const body = [
    input.workroom ? `**Workroom**\n${block(input.workroom, 120)}\n` : undefined,
    block(sanitizeDiscordOutput(input.detail), 3_250)
  ].filter(isDefined).join("\n");
  const accent = input.status === "failed" || input.status === "interrupted" || input.status === "canceled"
    ? 0xdc2626
    : input.status === "awaiting-approval"
      ? 0xd97706
      : input.status === "succeeded"
        ? 0x16a34a
        : 0x2563eb;
  return componentsV2Payload(
    new ContainerBuilder()
      .setAccentColor(accent)
      .addTextDisplayComponents(text(heading))
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
      .addTextDisplayComponents(text(body))
  );
}

export function reviewPacketCard(input: ReviewPacketCardInput): AmbientComponentsV2Payload {
  const metadata = [
    `**Branch:** \`${inlineCode(input.branch, 160)}\` -> \`${inlineCode(input.defaultBranch, 120)}\``,
    `**Last commit:** \`${inlineCode(sanitizeDiscordOutput(input.lastCommit), 220)}\``,
    input.repoUrl ? `**Repository:** ${block(input.repoUrl, 300)}` : undefined,
    input.taskId ? `**Task:** \`${inlineCode(input.taskId, 80)}\`${input.taskStatus ? ` | ${inline(input.taskStatus, 60)}` : ""}` : undefined,
    input.taskRequest ? `**Request:** ${block(sanitizeDiscordOutput(input.taskRequest), 450)}` : undefined
  ].filter(isDefined).join("\n");
  const verification = input.suggestedVerification.length > 0
    ? bullets(input.suggestedVerification, 8, 100, true)
    : "- No project validation commands configured yet.";
  const container = new ContainerBuilder()
    .setAccentColor(input.changedFiles.trim() ? 0xd97706 : 0x16a34a)
    .addTextDisplayComponents(text(`## Review packet\n**${inline(input.project, 100)}**`))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(text(metadata))
    .addTextDisplayComponents(text(`**Changed files**\n${fenced(sanitizeDiscordOutput(input.changedFiles) || "(working tree clean)", 850)}`))
    .addTextDisplayComponents(text(`**Diff stat**\n${fenced(sanitizeDiscordOutput(input.diffStat) || "(no diff against HEAD)", 850)}`))
    .addTextDisplayComponents(text(`**Suggested verification**\n${verification}`));
  return componentsV2Payload(container);
}

export function reviewEvidenceCard(input: ReviewEvidenceCardInput): AmbientComponentsV2Payload {
  const heading = [
    `## ${inline(input.title, 120)}`,
    `**${inline(input.project, 100)} | ${input.passed ? "PASSED" : "BLOCKED"}**`,
    ...(input.summary ?? []).slice(0, 4).map((item) => `- ${block(sanitizeDiscordOutput(item), 180)}`)
  ].join("\n");
  const checks = input.checks.length === 0
    ? "No validation checks were recorded."
    : input.checks.slice(0, 4).map((check) => {
      const exit = check.exitCode === undefined ? "" : ` | exit ${check.exitCode}`;
      return [
        `**[${check.ok ? "PASS" : "FAIL"}] ${inline(check.name, 80)}${exit}**`,
        `Command: \`${inlineCode(sanitizeDiscordOutput(check.command), 180)}\``,
        fencedTail(sanitizeDiscordOutput(check.output) || "(no output)", 500)
      ].join("\n");
    }).concat(
      input.checks.length > 4 ? [`_${input.checks.length - 4} additional checks not shown._`] : []
    ).join("\n\n");
  return componentsV2Payload(
    new ContainerBuilder()
      .setAccentColor(input.passed ? 0x16a34a : 0xdc2626)
      .addTextDisplayComponents(text(heading))
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
      .addTextDisplayComponents(text(checks))
  );
}

function componentsV2Payload(container: ContainerBuilder): AmbientComponentsV2Payload {
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [] }
  };
}

function addControlRows(container: ContainerBuilder, rows: readonly ActionRowBuilder<ButtonBuilder>[] | undefined): void {
  for (const row of (rows ?? []).slice(0, 3)) {
    container.addActionRowComponents(row);
  }
}

function text(content: string): TextDisplayBuilder {
  return new TextDisplayBuilder().setContent(block(content, AMBIENT_UI_LIMITS.textDisplay));
}

function roleOption(value: AmbientRole, label: string, description: string, selected: boolean) {
  return { value, label, description, default: selected };
}

function formatRoles(roles: readonly AmbientRole[]): string {
  return [...new Set(roles)].map((role) => role[0]?.toUpperCase() + role.slice(1)).join(" / ");
}

function formatProof(proof: readonly CompletionProof[], maxItems: number, maxDetailLength: number): string {
  if (proof.length === 0) return "No verification evidence was recorded.";
  return proof.slice(0, maxItems).map((item) => {
    const status = item.status === "failed" ? "FAIL" : item.status === "info" ? "INFO" : "PASS";
    return `- **[${status}] ${inline(sanitizeDiscordOutput(item.label), 70)}:** ${block(sanitizeDiscordOutput(item.detail), maxDetailLength)}`;
  }).join("\n");
}

function fenced(value: string, maxLength: number): string {
  return `\`\`\`\n${block(value.replace(/```/g, "'''"), maxLength)}\n\`\`\``;
}

function fencedTail(value: string, maxLength: number): string {
  const normalized = value.replace(/```/g, "'''").replace(/\0/g, "").replace(/\r\n?/g, "\n").trim() || "Not provided";
  const bounded = normalized.length <= maxLength
    ? normalized
    : `[earlier output omitted]\n${normalized.slice(-(maxLength - 27))}`;
  return `\`\`\`\n${bounded}\n\`\`\``;
}

function bullets(values: readonly string[], maxItems: number, maxLength: number, code = false): string {
  return values.slice(0, maxItems).map((value) => {
    const item = code ? inlineCode(value, maxLength) : inline(value, maxLength);
    return code ? `- \`${item.replace(/`/g, "'")}\`` : `- ${item}`;
  }).join("\n");
}

function inline(value: string, maxLength: number): string {
  const normalized = value.replace(/[`\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  const safe = normalized
    .replace(/([\\_*~|>\[\]()<>])/g, "\\$1")
    .replace(/@/g, "@\u200b")
    .replace(/\bhttps?:\/\//gi, (url) => url.replace("://", "\u200b://"));
  return truncate(safe, maxLength, "Not provided");
}

function inlineCode(value: string, maxLength: number): string {
  return truncate(value.replace(/[`\r\n]+/g, " ").replace(/\s+/g, " ").trim(), maxLength, "Not provided");
}

function block(value: string, maxLength: number): string {
  return truncate(value.replace(/\0/g, "").replace(/\r\n?/g, "\n").trim(), maxLength, "Not provided");
}

function truncate(value: string, maxLength: number, fallback: string): string {
  const normalized = value || fallback;
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function isAmbientAction(value: string | undefined): value is AmbientAction {
  return value === "proposal-confirm"
    || value === "proposal-edit"
    || value === "proposal-readonly"
    || value === "proposal-decline"
    || value === "progress-cancel"
    || value === "completion-proof"
    || value === "completion-reviewed"
    || value === "inbox-open"
    || value === "inbox-refresh"
    || value === "team-select";
}

function isAmbientRole(value: string): value is AmbientRole {
  return value === "builder" || value === "reviewer" || value === "verifier";
}

function isDefined(value: string | undefined): value is string {
  return value !== undefined;
}
