import { chmod } from "node:fs/promises";

export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIRECTORY_MODE = 0o700;
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

const CORE_ENVIRONMENT_KEYS = new Set([
  "APPDATA",
  "CI",
  "COLORTERM",
  "COMSPEC",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LOCALAPPDATA",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "SHELL",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERPROFILE",
  "WINDIR",
  "__CF_USER_TEXT_ENCODING"
]);

const CODEX_ENVIRONMENT_KEYS = new Set([
  "ALL_PROXY",
  "CODEX_HOME",
  "CURL_CA_BUNDLE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME"
]);

const SENSITIVE_ENVIRONMENT_NAME = /(?:^|_)(?:ACCESS_KEY|API_KEY|AUTH|COOKIE|CREDENTIALS?|PASS(?:WORD|WD)?|PRIVATE_KEY|SECRET|SESSION|TOKEN)(?:_|$)/i;

/**
 * External tools must not inherit the bot token or arbitrary application
 * credentials. Codex receives a few additional non-secret runtime variables so
 * it can locate its auth store and use an operator-configured network proxy.
 */
export function minimalChildEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  purpose: "project" | "codex" = "project"
): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    const normalized = key.toUpperCase();
    const allowed = CORE_ENVIRONMENT_KEYS.has(normalized)
      || normalized.startsWith("LC_")
      || (purpose === "codex" && CODEX_ENVIRONMENT_KEYS.has(normalized));
    if (allowed && !SENSITIVE_ENVIRONMENT_NAME.test(normalized)) {
      output[key] = value;
    }
  }
  return output;
}

/**
 * Devbot secrets must never reach a third-party CLI even if a backend allow list
 * were misconfigured, so these prefixes are stripped unconditionally.
 */
const NEVER_FORWARD_PREFIXES = ["DISCORD", "DEVBOT"] as const;

/**
 * Builds a minimal child environment and then re-admits only exact, documented
 * authentication/config variable names a specific backend needs. Prefix
 * admission is deliberately unsupported: every forwarded key must be named, so
 * an unrelated secret that happens to share a provider prefix can never cross
 * the boundary. Devbot's own credentials can never be forwarded: the
 * sensitive-name filter still applies to core keys, and the Discord/Devbot
 * prefixes are always dropped even from the allow list.
 */
export function scopedChildEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  allowedExactKeys: readonly string[] = []
): NodeJS.ProcessEnv {
  const output = minimalChildEnvironment(environment, "project");
  const exact = new Set(allowedExactKeys.map((key) => key.toUpperCase()));
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    const normalized = key.toUpperCase();
    if (NEVER_FORWARD_PREFIXES.some((prefix) => normalized.startsWith(prefix))) continue;
    if (exact.has(normalized)) {
      output[key] = value;
    }
  }
  return output;
}

/**
 * Git must not inherit bot credentials or execute ambient user helpers. These
 * overrides keep repository inspection non-interactive and disable hooks,
 * filesystem monitors, signing programs, pagers, and external diff commands.
 */
export function hardenedGitEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...minimalChildEnvironment(environment),
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_EXTERNAL_DIFF: "",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0"
  };
}

export function hardenedGitArguments(cwd: string, args: readonly string[]): string[] {
  return [
    "-c", `core.hooksPath=${NULL_DEVICE}`,
    "-c", "core.fsmonitor=false",
    "-c", "commit.gpgSign=false",
    "-c", "tag.gpgSign=false",
    "-c", "diff.external=",
    "-c", "user.name=Devbot",
    "-c", "user.email=devbot@localhost",
    "-C", cwd,
    ...args
  ];
}

/** Redacts common credentials plus exact secret values already loaded locally. */
export function redactSensitiveText(value: string, environment: NodeJS.ProcessEnv = process.env): string {
  let redacted = value;
  const knownSecrets = Object.entries(environment)
    .filter(([key, entry]) => SENSITIVE_ENVIRONMENT_NAME.test(key) && typeof entry === "string" && entry.length >= 8)
    .map(([, entry]) => entry as string)
    .sort((left, right) => right.length - left.length);

  for (const secret of knownSecrets) {
    redacted = redacted.replaceAll(secret, "[REDACTED]");
  }

  return redacted
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:mfa\.)?[A-Za-z0-9_-]{23,30}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{25,}\b/g, "[REDACTED DISCORD TOKEN]")
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED API KEY]")
    .replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[oprsu]_[A-Za-z0-9]{20,})\b/g, "[REDACTED GITHUB TOKEN]")
    .replace(/\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{10,}\b/g, "[REDACTED SLACK TOKEN]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED AWS KEY]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED JWT]")
    .replace(/(https?:\/\/[^\s:/@]+:)[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/(\bAuthorization\s*:\s*(?:Basic|Bearer)\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(
      /(\b(?:(?:const|let|var)\s+)?(?:[A-Z0-9_]*(?:ACCESS_KEY|API_KEY|AUTH|COOKIE|CREDENTIALS?|PASS(?:WORD|WD)?|PRIVATE_KEY|SECRET|SESSION|TOKEN)[A-Z0-9_]*|api[-_ ]?key|client[-_ ]?secret|password|token|secret)\b\s*(?:=|:)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\r\n]+)/gi,
      "$1[REDACTED]"
    );
}

export interface DiscordOutputSanitizerOptions {
  environment?: NodeJS.ProcessEnv;
  privatePaths?: readonly string[];
}

/**
 * Sanitizes untrusted or tool-generated text immediately before it is exposed
 * in Discord. Deliberate operator surfaces should opt out so `/projects` and
 * setup diagnostics can continue to show the machine paths they manage.
 */
export function sanitizeDiscordOutput(value: string, options: DiscordOutputSanitizerOptions = {}): string {
  let sanitized = redactSensitiveText(value, options.environment ?? process.env).replace(/\0/g, "");
  const privatePaths = [...new Set((options.privatePaths ?? []).map((entry) => entry.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  for (const privatePath of privatePaths) {
    sanitized = sanitized.replaceAll(privatePath, "[local path]");
  }

  const posixRoot = "(?:Users|home|root|private|var|tmp|Volumes|Applications|Library|opt|etc|usr|mnt|srv|workspace|workspaces)";
  const boundary = String.raw`(^|[\s\x60\"'(=\[])`;
  const quotedPath = new RegExp(
    String.raw`([\x60\"'])(?:file:\/\/\/(?:[^\x60\"'\r\n]+)|\/(?:${posixRoot})(?:\/[^\x60\"'\r\n]*)?|~\/(?:[^\x60\"'\r\n]+)|[A-Za-z]:[\\/](?:[^\x60\"'\r\n]+)|\\\\(?:[^\x60\"'\r\n]+))\1`,
    "g"
  );
  sanitized = sanitized.replace(quotedPath, (_match, quote: string) => `${quote}[local path]${quote}`);
  sanitized = sanitized
    .replace(new RegExp(`${boundary}file:\/\/\/[^\\s\\x60\\\"')\\]}>;,]+`, "gim"), "$1[local path]")
    .replace(new RegExp(`${boundary}\/(?:${posixRoot})(?:\/[^\\s\\x60\\\"')\\]}>;,]*)?`, "gim"), "$1[local path]")
    .replace(new RegExp(`${boundary}~\/(?:[^\\s\\x60\\\"')\\]}>;,]+)`, "gim"), "$1[local path]")
    .replace(/(^|[\s`"'(=\[])(?:[A-Za-z]:[\\/]|\\\\)[^\s`"')\]}>;,]+/gim, "$1[local path]");
  return sanitized;
}

export function publicErrorMessage(error: unknown, maxLength = 800): string {
  const message = sanitizeDiscordOutput(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
  if (!message) return "The operation failed without a safe error message.";
  return message.length <= maxLength ? message : `${message.slice(0, maxLength - 3)}...`;
}

export async function hardenPrivateFilePermissions(filePath: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await chmod(filePath, PRIVATE_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function hardenPrivateDirectoryPermissions(directoryPath: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
