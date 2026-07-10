import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { ActiveTunnel, PendingExpireReason, PendingTunnel, ProjectRevisionInfo, TunnelExpireReason } from "./tunnel.js";

const TUNNEL_ID_PATTERN = /^[a-z0-9-]{1,64}$/i;
const DISCLOSURE = [
  "This is an **anonymous public Internet URL** (a Cloudflare Quick Tunnel), for testing only.",
  "Anyone with the link can reach the exact local origin below for as long as it is live — Devbot's owner/allowlist checks do not apply once it is shared."
].join(" ");

export function tunnelControlRow(id: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`devbot:preview-control:stop:${id}`)
      .setLabel("Stop now")
      .setStyle(ButtonStyle.Danger)
  );
}

export function tunnelConfirmRow(id: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`devbot:preview-confirm:start:${id}`)
      .setLabel("Confirm & start tunnel")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`devbot:preview-confirm:cancel:${id}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
  );
}

export function parseTunnelControl(customId: string): { action: "stop"; id: string } | undefined {
  const match = /^devbot:preview-control:(stop):(.+)$/i.exec(customId);
  if (!match?.[1] || !match[2] || !TUNNEL_ID_PATTERN.test(match[2])) {
    return undefined;
  }
  return { action: "stop", id: match[2] };
}

export function parsePreviewConfirmControl(customId: string): { action: "start" | "cancel"; id: string } | undefined {
  const match = /^devbot:preview-confirm:(start|cancel):(.+)$/i.exec(customId);
  const action = match?.[1];
  const id = match?.[2];
  if (!action || !id || !TUNNEL_ID_PATTERN.test(id) || (action !== "start" && action !== "cancel")) {
    return undefined;
  }
  return { action, id };
}

export function tunnelConfirmMessage(
  pending: PendingTunnel,
  revision: ProjectRevisionInfo
): { content: string; components: ActionRowBuilder<ButtonBuilder>[] } {
  const content = [
    `**Confirm public preview tunnel for \`${pending.projectName}\`.**`,
    `Local origin: \`${pending.origin}\``,
    `Branch: \`${revision.branch}\` @ \`${revision.revision}\``,
    `TTL: ${pending.ttlMinutes} minute${pending.ttlMinutes === 1 ? "" : "s"}, auto-stops after that.`,
    `Data path: your machine -> \`cloudflared\` -> Cloudflare's network -> anyone with the link.`,
    DISCLOSURE,
    `Requested by <@${pending.requestedBy}>. This request expires if not confirmed shortly.`
  ].join("\n");
  return { content, components: [tunnelConfirmRow(pending.id)] };
}

export function tunnelConfirmExpiredMessage(pending: PendingTunnel, reason: PendingExpireReason): string {
  return reason === "cancel"
    ? `Preview tunnel request for \`${pending.projectName}\` was cancelled. Nothing was started.`
    : `Preview tunnel confirmation for \`${pending.projectName}\` timed out and was cancelled. Nothing was started. Run \`/preview share\` again.`;
}

export function tunnelShareMessage(tunnel: ActiveTunnel): { content: string; components: ActionRowBuilder<ButtonBuilder>[] } {
  const expiresUnix = Math.floor(new Date(tunnel.expiresAt).getTime() / 1000);
  const content = [
    `Public preview tunnel for \`${tunnel.projectName}\`: ${tunnel.url}`,
    `Forwarding to local origin \`${tunnel.origin}\`. Expires <t:${expiresUnix}:R>.`,
    "**Anyone with this link can reach your local dev server** until it expires or is stopped.",
    `Started by <@${tunnel.startedBy}>.`
  ].join("\n");
  return { content, components: [tunnelControlRow(tunnel.id)] };
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
  if (reason === "disabled") return "the owner disabled preview tunnels";
  return "cloudflared exited";
}

export function tunnelDisabledMessage(): string {
  return [
    "Preview tunnels are turned off.",
    "The owner can enable them with `/setup preview action:enable` (default off, owner-only, auto-expiring)."
  ].join("\n");
}

export function tunnelProjectDisabledMessage(projectName: string): string {
  return [
    `Preview tunnels are not allowed for \`${projectName}\`.`,
    `The owner can allow it with \`/setup preview action:enable project:${projectName}\` (per-project, default deny, owner-controlled — not set via repo config).`
  ].join("\n");
}

export function tunnelWrongRoomMessage(boundProjectName: string): string {
  return `This room is bound to project \`${boundProjectName}\`. Run \`/preview\` in that project's room, or in a room without a project binding.`;
}

export function tunnelNoOwnerMessage(): string {
  return "Devbot has no configured owner. Set `DEVBOT_OWNER_USER_ID` locally, restart, then run `/setup wizard`.";
}

export function tunnelNotOwnerMessage(): string {
  return "Only the configured Devbot owner can use `/preview`.";
}

export function tunnelControlExpiredMessage(): string {
  return "This preview tunnel control has expired.";
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
      return `- \`${tunnel.projectName}\`: ${tunnel.url} -> ${tunnel.origin} (expires <t:${expiresUnix}:R>, started by <@${tunnel.startedBy}>)`;
    })
    .join("\n");
}
