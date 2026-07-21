import { publicErrorMessage, redactSensitiveText } from "./security.js";

export type LogLevel = "info" | "warn" | "error";
export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Readonly<Record<string, LogValue>>;

interface LogSink {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const RESERVED_FIELDS = new Set(["timestamp", "level", "event"]);

export function logEvent(
  level: LogLevel,
  event: string,
  fields: LogFields = {},
  sink: LogSink = console
): void {
  const record: Record<string, string | number | boolean | null> = {
    timestamp: new Date().toISOString(),
    level,
    event: safeLogText(event, 120)
  };
  for (const key of Object.keys(fields).sort()) {
    if (RESERVED_FIELDS.has(key)) continue;
    const value = fields[key];
    if (value === undefined) continue;
    record[safeFieldName(key)] = typeof value === "string" ? safeLogText(value, 800) : value;
  }
  sink[level](JSON.stringify(record));
}

export function logError(event: string, error: unknown, fields: LogFields = {}, sink: LogSink = console): void {
  logEvent("error", event, { ...fields, error: publicErrorMessage(error) }, sink);
}

function safeFieldName(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
  return normalized || "field";
}

function safeLogText(value: string, maxLength: number): string {
  const sanitized = redactSensitiveText(value).replace(/[\r\n\t]+/g, " ").trim();
  if (!sanitized) return "unknown";
  return sanitized.length <= maxLength ? sanitized : `${sanitized.slice(0, maxLength - 3)}...`;
}
