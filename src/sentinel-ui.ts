import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { SentinelProjectConfig, WatchState } from "./sentinel-store.js";

export type SentinelButtonAction = "fix" | "mute";

const PROJECT_NAME_PATTERN = /^[a-z0-9_-]{1,64}$/i;
const WATCH_ID_PATTERN = /^[a-z0-9-]{1,48}$/i;

export function sentinelAlertRow(projectName: string, watchId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    sentinelButton("fix", projectName, watchId, "Fix it", ButtonStyle.Danger),
    sentinelButton("mute", projectName, watchId, "Mute 1h", ButtonStyle.Secondary)
  );
}

export function parseSentinelControl(
  customId: string
): { action: SentinelButtonAction; projectName: string; watchId: string } | undefined {
  const match = /^devbot:sentinel:(fix|mute):([^:]+):([^:]+)$/i.exec(customId);
  const action = match?.[1];
  const projectName = match?.[2];
  const watchId = match?.[3];
  if (
    !action ||
    !projectName ||
    !watchId ||
    !isSentinelButtonAction(action) ||
    !PROJECT_NAME_PATTERN.test(projectName) ||
    !WATCH_ID_PATTERN.test(watchId)
  ) {
    return undefined;
  }
  return { action, projectName, watchId };
}

export interface SentinelAlertInput {
  projectName: string;
  watch: WatchState;
  recentCommits: string[];
  consoleErrors?: string[];
}

export function sentinelAlertContent(input: SentinelAlertInput): string {
  const { watch } = input;
  const headline =
    watch.kind === "url"
      ? `\`${watch.target}\` is returning ${watch.lastCode !== undefined ? `status ${watch.lastCode}` : "errors"}.`
      : `Command \`${watch.target}\` is failing${watch.lastCode !== undefined ? ` (exit ${watch.lastCode})` : ""}.`;

  return [
    `**Sentinel alert: ${input.projectName}**`,
    headline,
    watch.lastError ? `Detail: ${truncate(watch.lastError, 300)}` : undefined,
    `Last OK: ${watch.lastOkAt ? formatSentinelTime(watch.lastOkAt) : "never observed"}`,
    "",
    "Recent commits:",
    input.recentCommits.length > 0 ? input.recentCommits.map((commit) => `- ${commit}`).join("\n") : "(no recent commits)",
    input.consoleErrors && input.consoleErrors.length > 0
      ? ["", "Console errors:", ...input.consoleErrors.slice(0, 3).map((line) => `- ${truncate(line, 200)}`)].join("\n")
      : undefined
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

export function sentinelRecoveryNote(recoveredAt: string, watch: WatchState): string {
  const detail = watch.kind === "url" ? `\`${watch.target}\`` : `Command \`${watch.target}\``;
  return `**Recovered** at ${formatSentinelTime(recoveredAt)}. ${detail} is healthy again.`;
}

export function sentinelFixTaskPrompt(watch: WatchState): string {
  const detail =
    watch.kind === "url"
      ? `The dev server at ${watch.target} returns ${watch.lastCode !== undefined ? `status ${watch.lastCode}` : "an error"}.`
      : `The command \`${watch.target}\` is failing${watch.lastCode !== undefined ? ` (exit ${watch.lastCode})` : ""}.`;
  const errorDetail = watch.lastError ? ` The first error observed: ${truncate(watch.lastError, 400)}` : "";
  return `${detail}${errorDetail} Investigate and fix.`;
}

export function formatSentinelStatus(
  projectName: string,
  config: SentinelProjectConfig,
  watches: WatchState[]
): string {
  const lines = [
    `**Sentinel for \`${projectName}\`**`,
    `Enabled: ${config.enabled ? "yes" : "no"} | Interval: ${config.intervalSeconds}s`,
    `Extra watch paths: ${config.manualPaths.length > 0 ? config.manualPaths.join(", ") : "(none)"}`,
    `Fast command: ${config.fastCommand ?? "(none configured)"}`,
    ""
  ];

  if (watches.length === 0) {
    lines.push("No checks have run yet.");
    return lines.join("\n");
  }

  lines.push("Watches:");
  for (const watch of watches) {
    const target = watch.kind === "url" ? watch.target : `command:${watch.target}`;
    const muted = watch.mutedUntil && watch.mutedUntil > new Date().toISOString() ? ` (muted until ${formatSentinelTime(watch.mutedUntil)})` : "";
    lines.push(`- \`${target}\`: ${watch.status}${muted}, last checked ${watch.lastCheckAt ? formatSentinelTime(watch.lastCheckAt) : "never"}`);
  }

  return lines.join("\n");
}

export function formatSentinelTime(value: string): string {
  return new Date(value).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" });
}

function sentinelButton(
  action: SentinelButtonAction,
  projectName: string,
  watchId: string,
  label: string,
  style: ButtonStyle
): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(`devbot:sentinel:${action}:${projectName}:${watchId}`)
    .setLabel(label)
    .setStyle(style);
}

function isSentinelButtonAction(value: string): value is SentinelButtonAction {
  return value === "fix" || value === "mute";
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}
