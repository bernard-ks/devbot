import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { CollabConversation } from "./collab-store.js";

export type WorkroomAction = "challenge" | "reveal" | "synthesize" | "approve" | "deny" | "close";

export function workroomActionRows(conversation: CollabConversation): ActionRowBuilder<ButtonBuilder>[] {
  const closed = conversation.status === "closed" || conversation.phase === "closed";
  const collecting = conversation.phase === "collecting";
  const canSynthesize = conversation.phase === "collecting" || conversation.phase === "deliberating";
  const canDecide = conversation.phase === "synthesized" && !conversation.decision;

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      workroomButton(conversation.id, "challenge", "Challenge", ButtonStyle.Secondary, closed || !collecting),
      workroomButton(conversation.id, "reveal", "Reveal", ButtonStyle.Primary, closed || !collecting),
      workroomButton(conversation.id, "synthesize", "Synthesize", ButtonStyle.Primary, closed || !canSynthesize)
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      workroomButton(conversation.id, "approve", "Approve", ButtonStyle.Success, closed || !canDecide),
      workroomButton(conversation.id, "deny", "Deny", ButtonStyle.Danger, closed || Boolean(conversation.decision)),
      workroomButton(conversation.id, "close", "Close", ButtonStyle.Secondary, closed)
    )
  ];
}

export function parseWorkroomButton(customId: string): { action: WorkroomAction; conversationId: string } | undefined {
  const match = /^devbot:workroom:(challenge|reveal|synthesize|approve|deny|close):(.+)$/.exec(customId);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  return { action: match[1] as WorkroomAction, conversationId: match[2] };
}

function workroomButton(
  conversationId: string,
  action: WorkroomAction,
  label: string,
  style: ButtonStyle,
  disabled: boolean
): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(`devbot:workroom:${action}:${conversationId}`)
    .setLabel(label)
    .setStyle(style)
    .setDisabled(disabled);
}
