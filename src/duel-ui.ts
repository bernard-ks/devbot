import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import { isTaskId } from "./task-store.js";

const CONTROL_PREFIX = "devbot:duel-control:";
const FIX_MODAL_PREFIX = "devbot:duel-fix-modal:";
const COLLAB_ID_PATTERN = /^collab-[a-z0-9]+-[a-z0-9]+$/i;

export type DuelControlAction = "review" | "accept" | "dismiss";

export interface ParsedDuelControl {
  action: DuelControlAction;
  targetId: string;
}

export function isDuelConversationId(value: string): boolean {
  return COLLAB_ID_PATTERN.test(value);
}

export function duelReviewButton(taskId: string): ButtonBuilder {
  if (!isTaskId(taskId)) {
    throw new Error("Task ID cannot be encoded in a Discord control.");
  }
  return new ButtonBuilder().setCustomId(`${CONTROL_PREFIX}review:${taskId}`).setLabel("Duel review").setStyle(ButtonStyle.Secondary);
}

export function duelDecisionRow(conversationId: string): ActionRowBuilder<ButtonBuilder> {
  if (!isDuelConversationId(conversationId)) {
    throw new Error("Duel conversation ID cannot be encoded in a Discord control.");
  }
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${CONTROL_PREFIX}accept:${conversationId}`).setLabel("Accept & fix").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${CONTROL_PREFIX}dismiss:${conversationId}`).setLabel("Dismiss").setStyle(ButtonStyle.Secondary)
  );
}

export function parseDuelControl(customId: string): ParsedDuelControl | undefined {
  if (!customId.startsWith(CONTROL_PREFIX)) {
    return undefined;
  }
  const [action, targetId, ...extra] = customId.slice(CONTROL_PREFIX.length).split(":");
  if (extra.length > 0 || !action || !targetId) {
    return undefined;
  }
  if (action === "review" && isTaskId(targetId)) {
    return { action, targetId };
  }
  if ((action === "accept" || action === "dismiss") && isDuelConversationId(targetId)) {
    return { action, targetId };
  }
  return undefined;
}

export function duelFixModal(conversationId: string, prefill: string): ModalBuilder {
  if (!isDuelConversationId(conversationId)) {
    throw new Error("Duel conversation ID cannot be encoded in a Discord modal.");
  }
  const input = new TextInputBuilder()
    .setCustomId("task")
    .setLabel("Fix task for conceded issues")
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(2)
    .setMaxLength(4_000)
    .setValue(prefill.slice(0, 4_000))
    .setRequired(true);
  return new ModalBuilder()
    .setCustomId(`${FIX_MODAL_PREFIX}${conversationId}`)
    .setTitle("Accept & fix conceded issues")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

export function parseDuelFixModal(customId: string): string | undefined {
  if (!customId.startsWith(FIX_MODAL_PREFIX)) {
    return undefined;
  }
  const conversationId = customId.slice(FIX_MODAL_PREFIX.length);
  return isDuelConversationId(conversationId) ? conversationId : undefined;
}
