import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

export type TaskControlAction = "details" | "retry";

export function taskControlRow(taskId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`devbot:task-control:details:${taskId}`)
      .setLabel("Details")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`devbot:task-control:retry:${taskId}`)
      .setLabel("Retry")
      .setStyle(ButtonStyle.Secondary)
  );
}

export function parseTaskControl(customId: string): { action: TaskControlAction; taskId: string } | undefined {
  const match = /^devbot:task-control:(details|retry):(.+)$/.exec(customId);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  return { action: match[1] as TaskControlAction, taskId: match[2] };
}
