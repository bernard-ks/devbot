import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { isTaskId } from "./task-store.js";

const CONTROL_PREFIX = "devbot:duel-control:";
const COLLAB_ID_PATTERN = /^collab-[a-z0-9]+-[a-z0-9]+$/i;

export type DuelControlAction = "review" | "accept" | "prompt" | "dismiss";

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

/** Decision row: "Accept & fix" is only offered when the caller verified that the reviewed
 *  snapshot ref still resolves to the recorded state; otherwise the row stays read-only with a
 *  copyable follow-up prompt and dismissal. */
export function duelDecisionRow(conversationId: string, options: { acceptAndFix?: boolean } = {}): ActionRowBuilder<ButtonBuilder> {
  if (!isDuelConversationId(conversationId)) {
    throw new Error("Duel conversation ID cannot be encoded in a Discord control.");
  }
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (options.acceptAndFix) {
    row.addComponents(new ButtonBuilder().setCustomId(`${CONTROL_PREFIX}accept:${conversationId}`).setLabel("Accept & fix").setStyle(ButtonStyle.Success));
  }
  return row.addComponents(
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
  if ((action === "accept" || action === "prompt" || action === "dismiss") && isDuelConversationId(targetId)) {
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
