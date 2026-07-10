import "dotenv/config";

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { normalizeProjectName, resolveCodexBin } from "./config.js";
import { isRuntimeRunning, runtimeLockPath } from "./runtime-lock.js";
import { minimalChildEnvironment, publicErrorMessage } from "./security.js";
import {
  buildDiscordInstallUrl,
  finishInitialSetup,
  listDiscordBotGuilds,
  validateDiscordBotToken,
  type DiscordBotIdentity
} from "./setup-core.js";
import { renderSetupPage } from "./setup-page.js";

const host = "127.0.0.1";
const sessionToken = randomBytes(24).toString("base64url");
const sessionExpiresAt = Date.now() + 10 * 60_000;
const pageCookieName = "devbot_setup";
const cwd = process.cwd();
const session: { token?: string; identity?: DiscordBotIdentity; botProcess?: ChildProcess } = {
  ...(process.env.DISCORD_TOKEN?.trim() ? { token: process.env.DISCORD_TOKEN.trim() } : {})
};
let baseUrl = "";
let pageClaim: string | undefined;

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    console.error(`Setup request failed: ${publicErrorMessage(error)}`);
    sendJson(response, 500, { error: friendlyError(error) });
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
      pageClaim = randomBytes(18).toString("base64url");
      response.setHeader("Set-Cookie", `${pageCookieName}=${pageClaim}; Path=/; HttpOnly; SameSite=Strict`);
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(renderSetupPage(sessionToken, cspNonce));
    return;
  }
  if (request.method === "GET" && url.pathname === "/favicon.ico") {
    response.statusCode = 204;
    response.end();
    return;
  }
  if (
    !url.pathname.startsWith("/api/") ||
    !safeEqual(request.headers["x-devbot-setup"], sessionToken)
  ) {
    sendJson(response, 404, { error: "Not found." });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/state") {
    await hydrateExistingIdentity();
    const [node, codex] = await Promise.all([checkNode(), checkCodex()]);
    const guilds = session.token && session.identity ? await listDiscordBotGuilds(session.token).catch(() => []) : [];
    sendJson(response, 200, {
      node,
      codex,
      ...(session.identity
        ? { identity: session.identity, guilds, installUrl: buildDiscordInstallUrl(session.identity.applicationId) }
        : {})
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/connect") {
    const body = await readJsonBody(request);
    const token = typeof body.token === "string" ? body.token : "";
    const identity = await validateDiscordBotToken(token);
    session.token = token.trim().replace(/^Bot\s+/i, "");
    session.identity = identity;
    const guilds = await listDiscordBotGuilds(session.token);
    sendJson(response, 200, { identity, guilds, installUrl: buildDiscordInstallUrl(identity.applicationId) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/guilds") {
    requireDiscordSession();
    sendJson(response, 200, { guilds: await listDiscordBotGuilds(session.token!) });
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
    const result = await finishInitialSetup({
      token: session.token!,
      guildId: stringField(body, "guildId"),
      repositoryName: stringField(body, "repositoryName"),
      repositoryPath: stringField(body, "repositoryPath"),
      envFile: path.join(cwd, ".env"),
      envTemplateFile: path.join(cwd, ".env.example"),
      setupFile: path.resolve(process.env.DEVBOT_SETUP_STORE?.trim() || path.join(cwd, ".devbot/setup.json"))
    });
    process.env.DISCORD_TOKEN = session.token!;
    process.env.DISCORD_CLIENT_ID = result.applicationId;
    process.env.DISCORD_GUILD_ID = result.guildId;
    process.env.DEVBOT_OWNER_USER_ID = result.ownerId;
    const alreadyRunning = isRuntimeRunning(runtimeLockPath(process.env.DEVBOT_RUNTIME_LOCK));
    sendJson(response, 200, { ...result, alreadyRunning });
    delete session.token;
    delete session.identity;
    clearTimeout(sessionExpiryTimer);
    server.close();
    if (!alreadyRunning && process.env.DEVBOT_SETUP_NO_START !== "true") {
      setTimeout(startDevbot, 500);
    }
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
    throw new Error("Connect and validate the Discord application first.");
  }
}

async function checkNode(): Promise<{ ready: boolean; version: string }> {
  const major = Number(process.versions.node.split(".")[0] ?? 0);
  return { ready: major >= 20, version: `${process.version}${major >= 20 ? " ready" : " requires Node 20+"}` };
}

async function checkCodex(): Promise<{ ready: boolean; label: string }> {
  const bin = resolveCodexBin(process.env.CODEX_BIN);
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { env: minimalChildEnvironment(process.env, "codex"), timeout: 5_000 }, (error, stdout) => {
      if (error) {
        resolve({ ready: false, label: "Codex CLI not found" });
        return;
      }
      resolve({ ready: true, label: stdout.trim().split(/\r?\n/)[0] || "Codex ready" });
    });
  });
}

function startDevbot(): void {
  if (session.botProcess && session.botProcess.exitCode === null) return;
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  console.log("");
  console.log("Setup complete. Starting Devbot; keep this terminal open.");
  session.botProcess = spawn(npm, ["run", "dev"], {
    cwd,
    env: process.env,
    stdio: "inherit"
  });
  session.botProcess.once("exit", (code) => {
    console.log(`Devbot stopped${code === null ? "." : ` with exit code ${code}.`}`);
  });
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, env: setupUtilityEnvironment(), stdio: "ignore" });
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
        reject(new Error("Folder selection was canceled or is unavailable. You can paste the path instead."));
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
      throw new Error("Setup request is too large.");
    }
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("Setup request is not valid JSON.");
  }
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing setup value: ${name}.`);
  }
  return value.trim();
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

function friendlyError(error: unknown): string {
  return publicErrorMessage(error);
}

function shutdown(): void {
  clearTimeout(sessionExpiryTimer);
  if (session.botProcess && session.botProcess.exitCode === null) {
    session.botProcess.kill("SIGTERM");
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
}
