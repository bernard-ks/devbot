import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { isTaskId } from "./task-store.js";

const CONTROL_PREFIX = "devbot:duel-control:";
const COLLAB_ID_PATTERN = /^collab-[a-z0-9]+-[a-z0-9]+$/i;

export type DuelControlAction = "review" | "prompt" | "dismiss";

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

/** Read-only decision row: this stage of the duel feature never creates write tasks, so the only
 *  controls are copying a follow-up prompt and dismissing the findings. */
export function duelDecisionRow(conversationId: string): ActionRowBuilder<ButtonBuilder> {
  if (!isDuelConversationId(conversationId)) {
    throw new Error("Duel conversation ID cannot be encoded in a Discord control.");
  }
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${CONTROL_PREFIX}prompt:${conversationId}`).setLabel("Copy fix prompt").setStyle(ButtonStyle.Primary),
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
  if ((action === "prompt" || action === "dismiss") && isDuelConversationId(targetId)) {
    return { action, targetId };
  }
  return undefined;
}

export interface DuelControlBinding {
  channelId?: string;
  threadId?: string;
  controlMessageId?: string;
  controlChannelId?: string;
}

/** Requires the decision buttons to be operated from the exact message and channel the duel
 *  posted them in, mirroring the workroom control-panel binding pattern used elsewhere. */
export function isBoundDuelControl(binding: DuelControlBinding, messageId: string | undefined, channelId: string | null): boolean {
  const expectedChannelId = binding.controlChannelId ?? binding.threadId ?? binding.channelId;
  return Boolean(binding.controlMessageId && messageId === binding.controlMessageId && (!expectedChannelId || channelId === expectedChannelId));
}
