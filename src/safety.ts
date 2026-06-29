import type { CodexRequestMode } from "./codex-client.js";
import type { AppConfig } from "./types.js";

export function isWriteBlockedBySafeMode(appConfig: Pick<AppConfig, "safeMode">, mode: CodexRequestMode): boolean {
  return appConfig.safeMode && mode === "action";
}

export function safeModeActionMessage(surface: string): string {
  return [
    `Safe mode is on, so ${surface} cannot start write-capable Codex work.`,
    "Read-only commands still work: `/ask`, `/status`, `/snip`, `/task show`, `/task logs`, `/dashboard`, and peer read-only requests.",
    "Set `DEVBOT_SAFE_MODE=false` and restart devbot to allow write-capable actions."
  ].join("\n");
}
