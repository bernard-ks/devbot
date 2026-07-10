import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTunnelStatusList,
  parsePreviewConfirmControl,
  parseTunnelControl,
  tunnelConfirmExpiredMessage,
  tunnelConfirmMessage,
  tunnelExpiredMessage,
  tunnelProjectDisabledMessage,
  tunnelShareMessage,
  tunnelWrongRoomMessage
} from "./tunnel-ui.js";
import type { ActiveTunnel, PendingTunnel, ProjectRevisionInfo } from "./tunnel.js";

test("tunnelConfirmMessage discloses the exact origin, project, branch/revision, TTL, and the anonymous-public warning before anything spawns", () => {
  const pending = fakePending();
  const revision: ProjectRevisionInfo = { branch: "claude/preview-tunnels", revision: "abc1234" };
  const message = tunnelConfirmMessage(pending, revision);
  assert.match(message.content, /web/);
  assert.match(message.content, /http:\/\/127\.0\.0\.1:3000/);
  assert.match(message.content, /claude\/preview-tunnels/);
  assert.match(message.content, /abc1234/);
  assert.match(message.content, /15 minute/);
  assert.match(message.content, /anonymous public Internet URL/i);
  assert.match(message.content, /every path, API route, websocket, and debug endpoint/i);
  assert.match(message.content, /Cloudflare/);
  assert.equal(message.components.length, 1);
  const [confirmButton, cancelButton] = message.components[0]?.components.map((component) => component.toJSON()) as Array<{
    custom_id?: string;
  }>;
  assert.equal(confirmButton?.custom_id, `devbot:preview-confirm:start:${pending.id}`);
  assert.equal(cancelButton?.custom_id, `devbot:preview-confirm:cancel:${pending.id}`);
});

test("tunnelConfirmExpiredMessage distinguishes cancellation from a confirmation timeout", () => {
  const pending = fakePending();
  assert.match(tunnelConfirmExpiredMessage(pending, "cancel"), /cancelled/i);
  assert.match(tunnelConfirmExpiredMessage(pending, "confirm-timeout"), /timed out/i);
});

test("tunnelShareMessage surfaces the URL embed-suppressed, forwarding origin, expiry, exposure warning, and an id-bound stop button", () => {
  const tunnel = fakeTunnel();
  const message = tunnelShareMessage(tunnel);
  assert.match(message.content, /<https:\/\/random-words\.trycloudflare\.com>/);
  assert.match(message.content, /http:\/\/127\.0\.0\.1:3000/);
  assert.match(message.content, /<t:\d+:R>/);
  assert.match(message.content, /Anyone with this link/i);
  assert.equal(message.components.length, 1);
  const button = message.components[0]?.components[0]?.toJSON() as { custom_id?: string };
  assert.equal(button.custom_id, `devbot:preview-control:stop:${tunnel.id}`);
});

test("tunnelExpiredMessage dead-links the URL and reports every expiry reason", () => {
  const tunnel = fakeTunnel();
  assert.match(tunnelExpiredMessage(tunnel, "ttl"), /~~<https:\/\/random-words\.trycloudflare\.com>~~/);
  assert.match(tunnelExpiredMessage(tunnel, "ttl"), /TTL reached/);
  assert.match(tunnelExpiredMessage(tunnel, "stop"), /stopped by the owner/);
  assert.match(tunnelExpiredMessage(tunnel, "shutdown"), /Devbot shut down/);
  assert.match(tunnelExpiredMessage(tunnel, "disabled"), /disabled preview tunnels/);
  assert.match(tunnelExpiredMessage(tunnel, "process-exit"), /cloudflared exited/);
});

test("parseTunnelControl accepts well-formed stop customIds keyed by tunnel id and rejects malformed ones", () => {
  assert.deepEqual(parseTunnelControl("devbot:preview-control:stop:9f1c9b6e-1111-4a2b-8c3d-000000000000"), {
    action: "stop",
    id: "9f1c9b6e-1111-4a2b-8c3d-000000000000"
  });
  assert.equal(parseTunnelControl("devbot:preview-control:start:web-app"), undefined);
  assert.equal(parseTunnelControl("devbot:preview-control:stop:"), undefined);
  assert.equal(parseTunnelControl("devbot:task-control:stop:web-app"), undefined);
});

test("parsePreviewConfirmControl accepts start/cancel customIds keyed by tunnel id and rejects malformed ones", () => {
  assert.deepEqual(parsePreviewConfirmControl("devbot:preview-confirm:start:abc-123"), { action: "start", id: "abc-123" });
  assert.deepEqual(parsePreviewConfirmControl("devbot:preview-confirm:cancel:abc-123"), { action: "cancel", id: "abc-123" });
  assert.equal(parsePreviewConfirmControl("devbot:preview-confirm:stop:abc-123"), undefined);
  assert.equal(parsePreviewConfirmControl("devbot:preview-confirm:start:"), undefined);
  assert.equal(parsePreviewConfirmControl("devbot:preview-control:stop:abc-123"), undefined);
});

test("formatTunnelStatusList lists the tunnel URL and forwarding origin, or reports none", () => {
  assert.equal(formatTunnelStatusList([]), "No active preview tunnels.");
  const list = formatTunnelStatusList([fakeTunnel()]);
  assert.match(list, /web/);
  assert.match(list, /<https:\/\/random-words\.trycloudflare\.com>/);
  assert.match(list, /127\.0\.0\.1:3000/);
});

test("tunnelProjectDisabledMessage and tunnelWrongRoomMessage explain the owner-controlled per-project gate", () => {
  assert.match(tunnelProjectDisabledMessage("web"), /not allowed for `web`/);
  assert.match(tunnelProjectDisabledMessage("web"), /not set via repo config/);
  assert.match(tunnelWrongRoomMessage("api"), /bound to project `api`/);
});

function fakePending(): PendingTunnel {
  return {
    id: "9f1c9b6e-1111-4a2b-8c3d-000000000000",
    projectName: "web",
    origin: "http://127.0.0.1:3000",
    port: 3000,
    ttlMinutes: 15,
    requestedBy: "owner-1",
    channelId: "chan-1",
    createdAt: "2026-07-09T00:00:00.000Z"
  };
}

function fakeTunnel(): ActiveTunnel {
  return {
    id: "9f1c9b6e-1111-4a2b-8c3d-000000000000",
    projectName: "web",
    url: "https://random-words.trycloudflare.com",
    origin: "http://127.0.0.1:3000",
    port: 3000,
    ttlMinutes: 15,
    startedAt: "2026-07-09T00:00:00.000Z",
    expiresAt: "2026-07-09T00:15:00.000Z",
    startedBy: "owner-1",
    channelId: "chan-1"
  };
}
