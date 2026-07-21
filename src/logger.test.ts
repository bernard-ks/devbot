import assert from "node:assert/strict";
import test from "node:test";
import { logError, logEvent } from "./logger.js";

test("structured logs carry stable request fields without multiline output", () => {
  const messages: string[] = [];
  logEvent(
    "info",
    "interaction.received",
    { requestId: "request-123", taskId: "task-456", detail: "first\nsecond" },
    sink(messages)
  );

  assert.equal(messages.length, 1);
  const record = JSON.parse(messages[0]!) as Record<string, unknown>;
  assert.equal(record.level, "info");
  assert.equal(record.event, "interaction.received");
  assert.equal(record.requestId, "request-123");
  assert.equal(record.taskId, "task-456");
  assert.equal(record.detail, "first second");
  assert.match(String(record.timestamp), /^\d{4}-\d{2}-\d{2}T/);
});

test("structured error logs redact credentials and never serialize a stack", () => {
  const messages: string[] = [];
  const error = new Error("DISCORD_TOKEN=super-secret-value");
  error.stack = "private stack that must not appear";
  logError("interaction.failed", error, { requestId: "request-123" }, sink(messages));

  const serialized = messages[0]!;
  assert.doesNotMatch(serialized, /super-secret-value/);
  assert.doesNotMatch(serialized, /private stack/);
  const record = JSON.parse(serialized) as Record<string, unknown>;
  assert.equal(record.event, "interaction.failed");
  assert.equal(record.requestId, "request-123");
});

test("structured log fields cannot overwrite reserved record metadata", () => {
  const messages: string[] = [];
  logEvent(
    "info",
    "interaction.received",
    { timestamp: "forged", level: "error", event: "forged", requestId: "request-123" },
    sink(messages)
  );

  const record = JSON.parse(messages[0]!) as Record<string, unknown>;
  assert.match(String(record.timestamp), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(record.level, "info");
  assert.equal(record.event, "interaction.received");
  assert.equal(record.requestId, "request-123");
});

function sink(messages: string[]) {
  return {
    info: (message: string) => messages.push(message),
    warn: (message: string) => messages.push(message),
    error: (message: string) => messages.push(message)
  };
}
