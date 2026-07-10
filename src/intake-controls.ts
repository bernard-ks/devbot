import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import { isIntakeRecordId } from "./intake-store.js";

export type IntakeControlAction = "accept" | "ask" | "dismiss";

const CONTROL_PREFIX = "devbot:intake-control:";
const MODAL_PREFIX = "devbot:intake-modal:accept:";

export function intakeControlRow(recordId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    button("accept", recordId, "Accept as task", ButtonStyle.Success),
    button("ask", recordId, "Ask reporter", ButtonStyle.Secondary),
    button("dismiss", recordId, "Dismiss", ButtonStyle.Danger)
  );
}

export function parseIntakeControl(customId: string): { action: IntakeControlAction; recordId: string } | undefined {
  if (!customId.startsWith(CONTROL_PREFIX)) {
    return undefined;
  }
  const rest = customId.slice(CONTROL_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator < 0) {
    return undefined;
  }
  const action = rest.slice(0, separator);
  const recordId = rest.slice(separator + 1);
  if (!isIntakeControlAction(action) || !isIntakeRecordId(recordId)) {
    return undefined;
  }
  return { action, recordId };
}

export function intakeAcceptModal(record: { id: string; text: string }): ModalBuilder {
  if (!isIntakeRecordId(record.id)) {
    throw new Error("Intake record ID cannot be encoded in a Discord modal.");
  }
  const input = new TextInputBuilder()
    .setCustomId("task")
    .setLabel("Task for /do")
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(2)
    .setMaxLength(4_000)
    .setRequired(true)
    .setValue(buildAcceptTaskDraft(record.text).slice(0, 4_000));
  return new ModalBuilder()
    .setCustomId(`${MODAL_PREFIX}${record.id}`)
    .setTitle("Accept as task")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

export function parseIntakeAcceptModal(customId: string): { recordId: string } | undefined {
  if (!customId.startsWith(MODAL_PREFIX)) {
    return undefined;
  }
  const recordId = customId.slice(MODAL_PREFIX.length);
  return isIntakeRecordId(recordId) ? { recordId } : undefined;
}

export function buildAcceptTaskDraft(reportText: string): string {
  return `Investigate and fix this community-reported bug:\n\n${reportText}`;
}

function isIntakeControlAction(value: string): value is IntakeControlAction {
  return value === "accept" || value === "ask" || value === "dismiss";
}

function button(action: IntakeControlAction, recordId: string, label: string, style: ButtonStyle): ButtonBuilder {
  if (!isIntakeRecordId(recordId)) {
    throw new Error("Intake record ID cannot be encoded in a Discord control.");
  }
  return new ButtonBuilder().setCustomId(`${CONTROL_PREFIX}${action}:${recordId}`).setLabel(label).setStyle(style);
}
