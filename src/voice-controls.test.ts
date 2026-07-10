import assert from "node:assert/strict";
import test from "node:test";
import { parseVoiceActModal, parseVoiceControl, voiceActModal, voiceControlRow } from "./voice-controls.js";

test("voiceControlRow builds Ask, Make change, and Dismiss buttons with the voice ID encoded", () => {
  const row = voiceControlRow("voice-abc123-def456", { canControl: true, safeMode: false }).toJSON();
  const customIds = row.components.map((component) => ("custom_id" in component ? component.custom_id : undefined));
  assert.deepEqual(customIds, [
    "devbot:voice:ask:voice-abc123-def456",
    "devbot:voice:act:voice-abc123-def456",
    "devbot:voice:dismiss:voice-abc123-def456"
  ]);
});

test("voiceControlRow disables Make change for viewers and under safe mode", () => {
  const viewerRow = voiceControlRow("voice-abc123-def456", { canControl: false, safeMode: false }).toJSON();
  const actButtonViewer = viewerRow.components[1];
  assert.equal(actButtonViewer && "disabled" in actButtonViewer ? actButtonViewer.disabled : undefined, true);

  const safeModeRow = voiceControlRow("voice-abc123-def456", { canControl: true, safeMode: true }).toJSON();
  const actButtonSafeMode = safeModeRow.components[1];
  assert.equal(actButtonSafeMode && "disabled" in actButtonSafeMode ? actButtonSafeMode.disabled : undefined, true);

  const enabledRow = voiceControlRow("voice-abc123-def456", { canControl: true, safeMode: false }).toJSON();
  const actButtonEnabled = enabledRow.components[1];
  assert.equal(actButtonEnabled && "disabled" in actButtonEnabled ? actButtonEnabled.disabled : undefined, false);
});

test("voiceControlRow rejects an unsafe voice ID", () => {
  assert.throws(() => voiceControlRow("../etc/passwd", { canControl: true, safeMode: false }));
});

test("parseVoiceControl round-trips valid custom IDs and rejects everything else", () => {
  assert.deepEqual(parseVoiceControl("devbot:voice:ask:voice-abc123-def456"), { action: "ask", voiceId: "voice-abc123-def456" });
  assert.deepEqual(parseVoiceControl("devbot:voice:act:voice-abc123-def456"), { action: "act", voiceId: "voice-abc123-def456" });
  assert.deepEqual(parseVoiceControl("devbot:voice:dismiss:voice-abc123-def456"), { action: "dismiss", voiceId: "voice-abc123-def456" });
  assert.equal(parseVoiceControl("devbot:voice:ask:task-abc123"), undefined);
  assert.equal(parseVoiceControl("devbot:workspace:ask:webapp"), undefined);
  assert.equal(parseVoiceControl("devbot:voice:unknown:voice-abc123-def456"), undefined);
});

test("voiceActModal pre-fills the transcript and encodes the voice ID for confirmation", () => {
  const modal = voiceActModal("voice-abc123-def456", "fix the failing auth test").toJSON();
  assert.equal(modal.custom_id, "devbot:voice-modal:act:voice-abc123-def456");
  const input = modal.components.flatMap((row) => ("components" in row ? row.components : []))[0];
  assert.equal(input && "value" in input ? input.value : undefined, "fix the failing auth test");
});

test("voiceActModal rejects an unsafe voice ID", () => {
  assert.throws(() => voiceActModal("../etc/passwd", "text"));
});

test("parseVoiceActModal round-trips valid custom IDs and rejects everything else", () => {
  assert.deepEqual(parseVoiceActModal("devbot:voice-modal:act:voice-abc123-def456"), { voiceId: "voice-abc123-def456" });
  assert.equal(parseVoiceActModal("devbot:voice-modal:act:task-abc123"), undefined);
  assert.equal(parseVoiceActModal("devbot:workspace-modal:act:webapp"), undefined);
});
