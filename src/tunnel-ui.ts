import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { ActiveTunnel, TunnelExpireReason } from "./tunnel.js";

const PROJECT_NAME_PATTERN = /^[a-z0-9_-]{1,64}$/i;

export function tunnelControlRow(projectName: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`devbot:preview-control:stop:${projectName}`)
      .setLabel("Stop now")
      .setStyle(ButtonStyle.Danger)
  );
}

export function parseTunnelControl(customId: string): { action: "stop"; projectName: string } | undefined {
  const match = /^devbot:preview-control:(stop):(.+)$/i.exec(customId);
  if (!match?.[1] || !match[2] || !PROJECT_NAME_PATTERN.test(match[2])) {
    return undefined;
  }
  return { action: "stop", projectName: match[2] };
}

export function tunnelShareMessage(tunnel: ActiveTunnel): { content: string; components: ActionRowBuilder<ButtonBuilder>[] } {
  const expiresUnix = Math.floor(new Date(tunnel.expiresAt).getTime() / 1000);
  const content = [
    `Public preview tunnel for \`${tunnel.projectName}\`: ${tunnel.url}`,
    `Expires <t:${expiresUnix}:R>.`,
    "**Anyone with this link can reach your local dev server** until it expires or is stopped.",
    `Started by <@${tunnel.startedBy}>.`
  ].join("\n");
  return { content, components: [tunnelControlRow(tunnel.projectName)] };
}

export function tunnelExpiredMessage(tunnel: ActiveTunnel, reason: TunnelExpireReason): string {
  return [
    `Preview tunnel for \`${tunnel.projectName}\` has expired (~~${tunnel.url}~~).`,
    `Reason: ${expireReasonText(reason)}.`
  ].join("\n");
}

function expireReasonText(reason: TunnelExpireReason): string {
  if (reason === "ttl") return "TTL reached";
  if (reason === "stop") return "stopped by the owner";
  if (reason === "shutdown") return "Devbot shut down";
  return "cloudflared exited";
}

export function tunnelDisabledMessage(): string {
  return [
    "Preview tunnels are turned off.",
    "The owner can enable them with `/setup preview action:enable` (default off, owner-only, auto-expiring)."
  ].join("\n");
}

export function tunnelNoOwnerMessage(): string {
  return "Devbot has no configured owner. Set `DEVBOT_OWNER_USER_ID` locally, restart, then run `/setup wizard`.";
}

export function tunnelNotOwnerMessage(): string {
  return "Only the configured Devbot owner can use `/preview`.";
}

export function tunnelNoServerMessage(projectName: string): string {
  return `No running local dev server was detected for \`${projectName}\`. Start it, then try again.`;
}

export function tunnelBinaryMissingMessage(): string {
  return "`cloudflared` was not found on PATH. Install it with `brew install cloudflared` and try again.";
}

export function formatTunnelStatusList(tunnels: ActiveTunnel[]): string {
  if (tunnels.length === 0) {
    return "No active preview tunnels.";
  }
  return tunnels
    .map((tunnel) => {
      const expiresUnix = Math.floor(new Date(tunnel.expiresAt).getTime() / 1000);
      return `- \`${tunnel.projectName}\`: ${tunnel.url} (expires <t:${expiresUnix}:R>, started by <@${tunnel.startedBy}>)`;
    })
    .join("\n");
}
