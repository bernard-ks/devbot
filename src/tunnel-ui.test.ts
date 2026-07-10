import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTunnelStatusList,
  parseTunnelControl,
  tunnelExpiredMessage,
  tunnelShareMessage
} from "./tunnel-ui.js";
import type { ActiveTunnel } from "./tunnel.js";

test("tunnelShareMessage surfaces the URL, expiry, exposure warning, and a stop button", () => {
  const tunnel = fakeTunnel();
  const message = tunnelShareMessage(tunnel);
  assert.match(message.content, /https:\/\/random-words\.trycloudflare\.com/);
  assert.match(message.content, /<t:\d+:R>/);
  assert.match(message.content, /Anyone with this link/i);
  assert.equal(message.components.length, 1);
  const button = message.components[0]?.components[0]?.toJSON() as { custom_id?: string };
  assert.equal(button.custom_id, "devbot:preview-control:stop:web");
});

test("tunnelExpiredMessage dead-links the URL", () => {
  const tunnel = fakeTunnel();
  const message = tunnelExpiredMessage(tunnel, "ttl");
  assert.match(message, /~~https:\/\/random-words\.trycloudflare\.com~~/);
  assert.match(message, /TTL reached/);
});

test("parseTunnelControl accepts well-formed stop customIds and rejects malformed ones", () => {
  assert.deepEqual(parseTunnelControl("devbot:preview-control:stop:web-app"), { action: "stop", projectName: "web-app" });
  assert.equal(parseTunnelControl("devbot:preview-control:start:web-app"), undefined);
  assert.equal(parseTunnelControl("devbot:preview-control:stop:"), undefined);
  assert.equal(parseTunnelControl("devbot:task-control:stop:web-app"), undefined);
});

test("formatTunnelStatusList lists active tunnels or reports none", () => {
  assert.equal(formatTunnelStatusList([]), "No active preview tunnels.");
  const list = formatTunnelStatusList([fakeTunnel()]);
  assert.match(list, /web/);
  assert.match(list, /random-words\.trycloudflare\.com/);
});

function fakeTunnel(): ActiveTunnel {
  return {
    projectName: "web",
    url: "https://random-words.trycloudflare.com",
    port: 3000,
    ttlMinutes: 15,
    startedAt: "2026-07-09T00:00:00.000Z",
    expiresAt: "2026-07-09T00:15:00.000Z",
    startedBy: "owner-1",
    channelId: "chan-1"
  };
}
