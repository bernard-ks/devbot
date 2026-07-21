import "dotenv/config";

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { normalizeProjectName, resolveCodexBin } from "./config.js";
import { isRuntimeRunning, runtimeLockPath } from "./runtime-lock.js";
import { defaultRuntimeStatePath } from "./runtime-paths.js";
import { acquireRuntimeStateLease } from "./runtime-state.js";
import { minimalChildEnvironment, publicErrorMessage } from "./security.js";
import {
  buildDiscordInstallUrl,
  finishInitialSetup,
  listDiscordBotGuilds,
  validateDiscordBotToken,
  type DiscordBotIdentity,
  type SetupScreenshotPolicy
} from "./setup-core.js";
import { renderSetupPage } from "./setup-page.js";
import { SetupStore } from "./setup-store.js";

const host = "127.0.0.1";
const sessionExpiresAt = Date.now() + 30 * 60_000;
const pageCookieName = "devbot_setup";
const cwd = process.cwd();
const runtimeStateLease = acquireRuntimeStateLease({
  primaryLock: runtimeLockPath(process.env.DEVBOT_RUNTIME_LOCK)
});
const setupFile = path.resolve(process.env.DEVBOT_SETUP_STORE?.trim() || defaultRuntimeStatePath("setup.json"));
const setupStore = new SetupStore(setupFile);
const session: { token?: string; identity?: DiscordBotIdentity; botProcess?: ChildProcess } = {
  ...(process.env.DISCORD_TOKEN?.trim() ? { token: process.env.DISCORD_TOKEN.trim() } : {})
};
let baseUrl = "";
let pageClaim: string | undefined;

const setupErrorResponses = {
  "bot-not-installed": {
    status: 409,
    error: "Devbot is not installed in that Discord server yet. Add it, then refresh the server list."
  },
  "discord-session-required": {
    status: 409,
    error: "Connect and validate the Discord application first."
  },
  "discord-token-rejected": {
    status: 400,
    error: "Discord rejected that bot token. Check the token in the Discord Developer Portal and try again."
  },
  "discord-token-required": {
    status: 400,
    error: "Paste the bot token from the Discord Developer Portal."
  },
  "discord-unavailable": {
    status: 502,
    error: "Discord could not be reached to complete setup. Check your connection and try again."
  },
  "discord-user-credential": {
    status: 400,
    error: "That credential belongs to a Discord user, not a bot application."
  },
  "folder-selection-unavailable": {
    status: 400,
    error: "Folder selection was canceled or is unavailable. You can paste the path instead."
  },
  "guild-owner-confirmation-required": {
    status: 400,
    error: "Confirm that the selected Discord server owner should become Devbot's bootstrap owner."
  },
  "invalid-json": {
    status: 400,
    error: "Setup request is not valid JSON."
  },
  "invalid-repository-name": {
    status: 400,
    error: "Give the repository a short name containing letters, numbers, underscores, or hyphens."
  },
  "invalid-repository-path": {
    status: 400,
    error: "The repository path does not exist or is not a directory on this machine."
  },
  "invalid-screenshot-policy": {
    status: 400,
    error: "Screenshot policy must be allow, approval, or deny."
  },
  "missing-setup-value": {
    status: 400,
    error: "Complete all required setup fields before continuing."
  },
  "prerequisites-incomplete": {
    status: 409,
    error: "Finish the System check before completing setup. Devbot requires Node.js 22+ and a signed-in Codex CLI."
  },
  "request-too-large": {
    status: 413,
    error: "Setup request is too large."
  }
} as const;

type SetupRequestErrorCode = keyof typeof setupErrorResponses;

class SetupRequestError extends Error {
  constructor(readonly code: SetupRequestErrorCode, cause?: unknown) {
    super(setupErrorResponses[code].error, cause === undefined ? undefined : { cause });
    this.name = "SetupRequestError";
  }
}

const internalSetupErrorResponse = {
  status: 500,
  error: "Setup could not complete the request. Review the setup terminal for details and try again."
} as const;

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    const clientResponse = error instanceof SetupRequestError
      ? setupErrorResponses[error.code]
      : internalSetupErrorResponse;
    const diagnostic = error instanceof SetupRequestError && error.cause !== undefined ? error.cause : error;
    console.error(
      `Setup request failed (${requestLabel(request)}, HTTP ${clientResponse.status}): ${publicErrorMessage(diagnostic, 2_000)}`
    );
    sendJson(response, clientResponse.status, { error: clientResponse.error });
  });
});
const sessionExpiryTimer = setTimeout(() => {
  delete session.token;
  delete session.identity;
  server.close();
}, Math.max(0, sessionExpiresAt - Date.now()));
sessionExpiryTimer.unref();

server.listen(0, host, async () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine the local setup address.");
  }
  baseUrl = `http://${host}:${address.port}`;
  console.log("");
  console.log("Devbot setup is ready in your browser:");
  console.log(baseUrl);
  console.log("");
  console.log("The setup page is bound to this machine only. Press Ctrl+C to stop it.");
  if (process.env.DEVBOT_SETUP_NO_BROWSER !== "true") {
    openBrowser(baseUrl);
  }
});

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.once("exit", () => runtimeStateLease.release());

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const cspNonce = randomBytes(16).toString("base64");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'nonce-${cspNonce}'; style-src 'nonce-${cspNonce}'; img-src 'self' https://cdn.discordapp.com data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
  );

  const url = new URL(request.url ?? "/", baseUrl || `http://${host}`);
  const expectedHost = baseUrl ? new URL(baseUrl).host : undefined;
  if (!expectedHost || request.headers.host !== expectedHost) {
    sendJson(response, 403, { error: "This setup session only accepts its local address." });
    return;
  }
  if (Date.now() > sessionExpiresAt) {
    sendJson(response, 410, { error: "This setup session expired. Restart the setup command for a new link." });
    return;
  }
  if (request.method === "GET" && url.pathname === "/") {
    const presented = readCookie(request.headers.cookie, pageCookieName);
    if (pageClaim && !safeEqual(presented, pageClaim)) {
      sendJson(response, 403, {
        error: "This setup session was already opened in another window. Restart the setup command to try again."
      });
      return;
    }
    if (!pageClaim) {
      pageClaim = randomBytes(24).toString("base64url");
      response.setHeader("Set-Cookie", `${pageCookieName}=${pageClaim}; Path=/; HttpOnly; SameSite=Strict`);
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(renderSetupPage(cspNonce));
    return;
  }
  if (request.method === "GET" && url.pathname === "/favicon.ico") {
    response.statusCode = 204;
    response.end();
    return;
  }
  if (!url.pathname.startsWith("/api/") || !hasClaimedSession(request)) {
    sendJson(response, 404, { error: "Not found." });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/state") {
    await hydrateExistingIdentity();
    const { node, codex } = await checkPrerequisites();
    const guilds = session.token && session.identity ? await listDiscordBotGuilds(session.token).catch(() => []) : [];
    sendJson(response, 200, {
      node,
      codex,
      studioEnabled: setupStore.snapshot().studioEnabled ?? process.env.DEVBOT_STUDIO_ENABLED?.trim().toLowerCase() === "true",
      ...(session.identity
        ? { identity: session.identity, guilds, installUrl: buildDiscordInstallUrl(session.identity.applicationId) }
        : {})
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/connect") {
    const body = await readJsonBody(request);
    const token = typeof body.token === "string" ? body.token.trim().replace(/^Bot\s+/i, "") : "";
    if (!token) throw new SetupRequestError("discord-token-required");
    let identity: DiscordBotIdentity;
    let guilds: Awaited<ReturnType<typeof listDiscordBotGuilds>>;
    try {
      identity = await validateDiscordBotToken(token);
      guilds = await listDiscordBotGuilds(token);
    } catch (error) {
      throw classifyDiscordError(error);
    }
    session.token = token;
    session.identity = identity;
    sendJson(response, 200, { identity, guilds, installUrl: buildDiscordInstallUrl(identity.applicationId) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/guilds") {
    requireDiscordSession();
    let guilds: Awaited<ReturnType<typeof listDiscordBotGuilds>>;
    try {
      guilds = await listDiscordBotGuilds(session.token!);
    } catch (error) {
      throw classifyDiscordError(error);
    }
    sendJson(response, 200, { guilds });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/pick-folder") {
    const repositoryPath = await chooseRepositoryFolder();
    sendJson(response, 200, {
      repositoryPath,
      repositoryName: normalizeProjectName(path.basename(repositoryPath))
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/finish") {
    requireDiscordSession();
    const body = await readJsonBody(request);
    const { node, codex } = await checkPrerequisites();
    if (!node.ready || !codex.ready) {
      throw new SetupRequestError("prerequisites-incomplete");
    }
    if (body.confirmGuildOwner !== true) {
      throw new SetupRequestError("guild-owner-confirmation-required");
    }
    let result: Awaited<ReturnType<typeof finishInitialSetup>>;
    try {
      result = await finishInitialSetup({
        token: session.token!,
        guildId: stringField(body, "guildId"),
        repositoryName: stringField(body, "repositoryName"),
        repositoryPath: stringField(body, "repositoryPath"),
        enableStudio: body.enableStudio === true,
        screenshotPolicy: screenshotPolicyField(body),
        envFile: path.join(cwd, ".env"),
        envTemplateFile: path.join(cwd, ".env.example"),
        setupFile
      });
    } catch (error) {
      throw classifyFinishError(error);
    }
    process.env.DISCORD_TOKEN = session.token!;
    process.env.DISCORD_CLIENT_ID = result.applicationId;
    process.env.DISCORD_GUILD_ID = result.guildId;
    process.env.DEVBOT_OWNER_USER_ID = result.ownerId;
    process.env.DEVBOT_STUDIO_ENABLED = result.studioEnabled ? "true" : "false";
    runtimeStateLease.release();
    const alreadyRunning = isRuntimeRunning(runtimeLockPath(process.env.DEVBOT_RUNTIME_LOCK));
    let runtimeStatus: "already-running" | "starting" | "manual-start" | "start-failed";
    const warnings = [...result.warnings];
    if (alreadyRunning) {
      runtimeStatus = "already-running";
    } else if (process.env.DEVBOT_SETUP_NO_START === "true") {
      runtimeStatus = "manual-start";
    } else {
      const start = await startDevbot();
      runtimeStatus = start.started ? "starting" : "start-failed";
      if (start.warning) warnings.push(start.warning);
    }
    sendJson(response, 200, { ...result, warnings, alreadyRunning, runtimeStatus });
    delete session.token;
    delete session.identity;
    clearTimeout(sessionExpiryTimer);
    server.close();
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

async function hydrateExistingIdentity(): Promise<void> {
  if (!session.token || session.identity) return;
  try {
    session.identity = await validateDiscordBotToken(session.token);
  } catch {
    delete session.token;
  }
}

function requireDiscordSession(): void {
  if (!session.token || !session.identity) {
    throw new SetupRequestError("discord-session-required");
  }
}

async function checkNode(): Promise<{ ready: boolean; version: string }> {
  const major = Number(process.versions.node.split(".")[0] ?? 0);
  return { ready: major >= 22, version: `${process.version}${major >= 22 ? " ready" : " requires Node 22+"}` };
}

async function checkCodex(): Promise<{ ready: boolean; label: string }> {
  const bin = resolveCodexBin(process.env.CODEX_BIN);
  const version = await runCodexCheck(bin, ["--version"]);
  if (!version.ok) return { ready: false, label: "Codex CLI not found" };
  const login = await runCodexCheck(bin, ["login", "status"]);
  if (!login.ok) return { ready: false, label: "Codex CLI found; sign in with codex login" };
  const versionLabel = version.output.split(/\r?\n/)[0] || "Codex CLI";
  return { ready: true, label: `${versionLabel} · signed in` };
}

async function checkPrerequisites(): Promise<{
  node: { ready: boolean; version: string };
  codex: { ready: boolean; label: string };
}> {
  const [node, codex] = await Promise.all([checkNode(), checkCodex()]);
  return { node, codex };
}

function runCodexCheck(bin: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { env: minimalChildEnvironment(process.env, "codex"), timeout: 5_000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout}\n${stderr}`.trim() });
    });
  });
}

function startDevbot(): Promise<{ started: boolean; warning?: string }> {
  if (session.botProcess && session.botProcess.exitCode === null) return Promise.resolve({ started: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  console.log("");
  console.log("Setup saved. Starting Devbot; keep this terminal open while it signs in.");
  return new Promise((resolve) => {
    const child = spawn(npm, ["run", "dev"], {
      cwd,
      env: process.env,
      stdio: "inherit"
    });
    session.botProcess = child;
    let settled = false;
    let survivalTimer: NodeJS.Timeout | undefined;
    child.once("spawn", () => {
      survivalTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ started: true });
      }, 750);
    });
    child.once("error", (error) => {
      if (survivalTimer) clearTimeout(survivalTimer);
      const message = `Devbot could not be started automatically: ${publicErrorMessage(error)}. Run npm run dev in this repository.`;
      console.error(message);
      delete session.botProcess;
      if (!settled) {
        settled = true;
        resolve({ started: false, warning: message });
      }
    });
    child.once("exit", (code) => {
      console.log(`Devbot stopped${code === null ? "." : ` with exit code ${code}.`}`);
      if (!settled) {
        if (survivalTimer) clearTimeout(survivalTimer);
        settled = true;
        delete session.botProcess;
        resolve({
          started: false,
          warning: `Devbot exited before startup completed${code === null ? "." : ` (exit code ${code}).`} Run npm run dev and review the terminal output.`
        });
      }
    });
  });
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, env: setupUtilityEnvironment(), stdio: "ignore" });
  child.once("error", (error) => {
    console.warn(`Unable to open the setup browser automatically: ${publicErrorMessage(error)}. Open ${url} manually.`);
  });
  child.unref();
}

async function chooseRepositoryFolder(): Promise<string> {
  const command = process.platform === "darwin" ? "osascript" : process.platform === "win32" ? "powershell" : "zenity";
  const args = process.platform === "darwin"
    ? ["-e", 'POSIX path of (choose folder with prompt "Choose a repository for Devbot")']
    : process.platform === "win32"
      ? [
          "-NoProfile",
          "-Command",
          "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; " +
            "$dialog.Description = 'Choose a repository for Devbot'; if ($dialog.ShowDialog() -eq 'OK') { $dialog.SelectedPath } else { exit 1 }"
        ]
      : ["--file-selection", "--directory", "--title=Choose a repository for Devbot"];
  return new Promise((resolve, reject) => {
    execFile(command, args, { env: setupUtilityEnvironment(), timeout: 120_000 }, (error, stdout) => {
      const selected = stdout.trim().replace(/[\\/]+$/, "");
      if (error || !selected) {
        reject(new SetupRequestError("folder-selection-unavailable", error));
        return;
      }
      resolve(path.resolve(selected));
    });
  });
}

function setupUtilityEnvironment(): NodeJS.ProcessEnv {
  const environment = minimalChildEnvironment();
  for (const key of ["DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"]) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return environment;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64_000) {
      throw new SetupRequestError("request-too-large");
    }
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new SetupRequestError("invalid-json");
  }
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new SetupRequestError("missing-setup-value");
  }
  return value.trim();
}

function screenshotPolicyField(body: Record<string, unknown>): SetupScreenshotPolicy {
  const value = body.screenshotPolicy;
  if (value === undefined) return "approval";
  if (value !== "allow" && value !== "approval" && value !== "deny") {
    throw new SetupRequestError("invalid-screenshot-policy");
  }
  return value;
}

function hasClaimedSession(request: IncomingMessage): boolean {
  if (!pageClaim) return false;
  return safeEqual(readCookie(request.headers.cookie, pageCookieName), pageClaim);
}

function safeEqual(provided: string | string[] | undefined, expected: string): boolean {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function classifyDiscordError(error: unknown): SetupRequestError {
  const message = error instanceof Error ? error.message : "";
  if (message === "That credential belongs to a Discord user, not a bot application.") {
    return new SetupRequestError("discord-user-credential", error);
  }
  if (/^Discord rejected the setup request \((?:401|403)\)/.test(message)) {
    return new SetupRequestError("discord-token-rejected", error);
  }
  return new SetupRequestError("discord-unavailable", error);
}

function classifyFinishError(error: unknown): unknown {
  if (error instanceof SetupRequestError) return error;
  const message = error instanceof Error ? error.message : "";
  if (message === "The repository path does not exist or is not a directory on this machine.") {
    return new SetupRequestError("invalid-repository-path", error);
  }
  if (message === "Give the repository a short name containing letters, numbers, underscores, or hyphens.") {
    return new SetupRequestError("invalid-repository-name", error);
  }
  if (message === "Devbot is not installed in that Discord server yet. Add it, then refresh the server list.") {
    return new SetupRequestError("bot-not-installed", error);
  }
  if (
    message === "That credential belongs to a Discord user, not a bot application."
    || /^Discord rejected the setup request \((?:401|403)\)/.test(message)
    || message.startsWith("Unable to reach Discord:")
    || message.startsWith("Discord did not respond in time.")
    || message.startsWith("Discord setup did not complete after several attempts.")
  ) {
    return classifyDiscordError(error);
  }
  return error;
}

function requestLabel(request: IncomingMessage): string {
  const method = request.method ?? "UNKNOWN";
  try {
    const pathname = new URL(request.url ?? "/", `http://${host}`).pathname;
    return publicErrorMessage(`${method} ${pathname}`, 240);
  } catch {
    return method;
  }
}

function shutdown(): void {
  clearTimeout(sessionExpiryTimer);
  runtimeStateLease.release();
  if (session.botProcess && session.botProcess.exitCode === null) {
    session.botProcess.kill("SIGTERM");
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
}
