import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildDiscordInstallUrl,
  finishInitialSetup,
  listDiscordBotGuilds,
  updateEnvFile,
  validateDiscordBotToken
} from "./setup-core.js";
import { renderSetupPage } from "./setup-page.js";

test("setup page uses the dark theme and exposes the guided controls", () => {
  const html = renderSetupPage("test-nonce");
  assert.match(html, /<meta name="color-scheme" content="dark">/);
  assert.match(html, /--canvas: #0d0f13/);
  assert.match(html, /id="choose-folder"/);
  assert.match(html, /id="enable-studio"/);
  assert.match(html, /id="screenshot-policy"/);
  assert.match(html, /id="confirm-owner"/);
  assert.match(html, /no public URL, tunnel, Activity, web server, or loopback listener/i);
  assert.match(html, /enableStudio: state\.studioEnabled/);
  assert.match(html, /screenshotPolicy: byId\("screenshot-policy"\)\.value/);
  assert.match(html, /confirmGuildOwner: byId\("confirm-owner"\)\.checked/);
  assert.match(html, /state\.systemReady && workspaceReady/);
  assert.match(html, /enable-studio"\)\.addEventListener/);
  assert.match(html, /Private room/);
  assert.match(html, /Make change/);
  assert.match(html, /result\.warnings/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-current="step"/);
  assert.match(html, /prefers-reduced-motion/);
  assert.doesNotMatch(html, /content="light"/);
  assert.match(html, /<style nonce="test-nonce">/);
  assert.match(html, /<script nonce="test-nonce">/);
});

test("setup page contains no API credential", () => {
  const html = renderSetupPage("test-nonce");
  assert.doesNotMatch(html, /X-Devbot-Setup/i);
  assert.doesNotMatch(html, /sessionToken/);
});

test("Discord install URL requests the bot command scope and private-room permissions", () => {
  const url = new URL(buildDiscordInstallUrl("app-1", "guild-1"));
  assert.equal(url.origin, "https://discord.com");
  assert.equal(url.pathname, "/oauth2/authorize");
  assert.equal(url.searchParams.get("client_id"), "app-1");
  assert.equal(url.searchParams.get("guild_id"), "guild-1");
  assert.deepEqual(new Set(url.searchParams.get("scope")?.split(" ")), new Set(["bot", "applications.commands"]));
  assert.ok(BigInt(url.searchParams.get("permissions") ?? "0") > 0n);
});

test("Discord token validation derives application and bot identity without exposing the token", async () => {
  const calls: string[] = [];
  const identity = await validateDiscordBotToken("secret-token", async (input) => {
    const url = String(input);
    calls.push(url);
    return jsonResponse(
      url.endsWith("/users/@me")
        ? { id: "bot-1", username: "devbot", bot: true, avatar: "avatar-hash" }
        : { id: "app-1" }
    );
  });

  assert.deepEqual(identity, {
    applicationId: "app-1",
    botId: "bot-1",
    username: "devbot",
    avatarUrl: "https://cdn.discordapp.com/avatars/bot-1/avatar-hash.png?size=128"
  });
  assert.equal(JSON.stringify(identity).includes("secret-token"), false);
  assert.equal(calls.length, 2);
});

test("Discord setup retries a rate-limited idempotent request", async () => {
  let attempts = 0;
  const guilds = await listDiscordBotGuilds("secret-token", async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response(JSON.stringify({ message: "rate limited", retry_after: 0 }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "0" }
      });
    }
    return jsonResponse([{ id: "guild-1", name: "Builders" }]);
  });

  assert.equal(attempts, 2);
  assert.deepEqual(guilds, [{ id: "guild-1", name: "Builders" }]);
});

test("environment updates preserve the template and write owner-only local config", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-env-"));
  const envFile = path.join(root, ".env");
  const templateFile = path.join(root, ".env.example");
  await writeFile(templateFile, "# Discord\nDISCORD_TOKEN=replace-me\nDISCORD_CLIENT_ID=replace-me\n\nKEEP_THIS=true\n");

  await updateEnvFile(envFile, { DISCORD_TOKEN: "new.token", DISCORD_CLIENT_ID: "123", EXTRA_VALUE: "with space" }, templateFile);

  const contents = await readFile(envFile, "utf8");
  assert.match(contents, /^# Discord/m);
  assert.match(contents, /^DISCORD_TOKEN=new.token$/m);
  assert.match(contents, /^DISCORD_CLIENT_ID=123$/m);
  assert.match(contents, /^KEEP_THIS=true$/m);
  assert.match(contents, /^EXTRA_VALUE="with space"$/m);
  assert.equal((await stat(envFile)).mode & 0o777, 0o600);
});

test("initial setup provisions a private room, local repo, commands, and welcome message", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-initial-setup-"));
  const repoRoot = path.join(root, "Sample App");
  const envFile = path.join(root, ".env");
  const envTemplateFile = path.join(root, ".env.example");
  const setupFile = path.join(root, ".devbot", "setup.json");
  const preferencesFile = path.join(root, ".devbot", "preferences.json");
  await mkdir(repoRoot);
  await mkdir(path.join(repoRoot, ".devbot"));
  await writeFile(
    path.join(repoRoot, ".devbot", "project.json"),
    `${JSON.stringify({ canonicalName: "sample", policy: { visibility: "team" } }, null, 2)}\n`
  );
  await mkdir(path.dirname(setupFile));
  await writeFile(preferencesFile, JSON.stringify({ version: 1, selectedProjects: { "owner-1": "old-project" } }));
  await writeFile(
    envTemplateFile,
    [
      "DISCORD_TOKEN=replace-me",
      "DISCORD_CLIENT_ID=replace-me",
      "DISCORD_GUILD_ID=replace-me",
      "DEVBOT_OWNER_USER_ID=replace-me",
      "DEVBOT_AUTO_DEPLOY_COMMANDS=true",
      "DEVBOT_STUDIO_ENABLED=false",
      ""
    ].join("\n")
  );

  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ url, method, ...(body === undefined ? {} : { body }) });
    if (url.endsWith("/users/@me")) return jsonResponse({ id: "bot-1", username: "devbot", bot: true, avatar: null });
    if (url.endsWith("/oauth2/applications/@me")) return jsonResponse({ id: "app-1" });
    if (url.endsWith("/users/@me/guilds")) return jsonResponse([{ id: "guild-1", name: "Builders" }]);
    if (url.endsWith("/guilds/guild-1") && method === "GET") {
      return jsonResponse({ id: "guild-1", name: "Builders", owner_id: "owner-1" });
    }
    if (url.endsWith("/guilds/guild-1/channels") && method === "POST") {
      return jsonResponse({ id: "channel-1", guild_id: "guild-1", name: "devbot-private", type: 0 });
    }
    if (url.endsWith("/applications/app-1/guilds/guild-1/commands") && method === "PUT") return jsonResponse([]);
    if (url.endsWith("/channels/channel-1/messages") && method === "POST") return jsonResponse({ id: "message-1" });
    return jsonResponse({ message: "unexpected route" }, 404);
  };

  const result = await finishInitialSetup({
    token: "bot.token.value",
    guildId: "guild-1",
    repositoryName: "Sample App",
    repositoryPath: repoRoot,
    envFile,
    envTemplateFile,
    setupFile,
    enableStudio: true,
    screenshotPolicy: "allow",
    fetchImpl
  });

  assert.equal(result.ownerId, "owner-1");
  assert.equal(result.channelUrl, "https://discord.com/channels/guild-1/channel-1");
  assert.equal(result.repositoryName, "sample-app");
  assert.equal(result.studioEnabled, true);
  assert.equal(result.screenshotPolicy, "allow");
  assert.equal(result.launcherPosted, true);
  assert.deepEqual(result.warnings, []);

  const setup = JSON.parse(await readFile(setupFile, "utf8")) as Record<string, unknown>;
  assert.equal(setup.privateChannelId, "channel-1");
  assert.equal(setup.workspaceMessageId, "message-1");
  assert.equal(setup.defaultProjectName, "sample-app");
  assert.equal(setup.studioEnabled, true);
  assert.deepEqual(setup.repositories, { "sample-app": repoRoot });
  const projectMetadata = JSON.parse(await readFile(path.join(repoRoot, ".devbot", "project.json"), "utf8")) as {
    canonicalName?: string;
    policy?: { visibility?: string; screenshotPolicy?: string };
  };
  assert.equal(projectMetadata.canonicalName, "sample");
  assert.deepEqual(projectMetadata.policy, { visibility: "team", screenshotPolicy: "allow" });
  const preferences = JSON.parse(await readFile(preferencesFile, "utf8")) as { selectedProjects: Record<string, string> };
  assert.deepEqual(preferences.selectedProjects, {});

  const env = await readFile(envFile, "utf8");
  assert.match(env, /^DISCORD_TOKEN=bot.token.value$/m);
  assert.match(env, /^DISCORD_CLIENT_ID=app-1$/m);
  assert.match(env, /^DISCORD_GUILD_ID=guild-1$/m);
  assert.match(env, /^DEVBOT_OWNER_USER_ID=owner-1$/m);
  assert.match(env, /^DEVBOT_STUDIO_ENABLED=true$/m);

  const channelCall = calls.find((call) => call.url.endsWith("/guilds/guild-1/channels"));
  const channelBody = channelCall?.body as { permission_overwrites?: Array<{ id: string; deny: string }> } | undefined;
  assert.ok(channelBody?.permission_overwrites?.some((overwrite) => overwrite.id === "guild-1" && BigInt(overwrite.deny) > 0n));
  const commandCall = calls.find((call) => call.url.endsWith("/commands"));
  assert.ok(Array.isArray(commandCall?.body));
  assert.ok((commandCall?.body as Array<{ name: string }>).some((command) => command.name === "do"));
  assert.ok(calls.some((call) => call.url.endsWith("/channels/channel-1/messages")));
  const welcomeCall = calls.find((call) => call.url.endsWith("/channels/channel-1/messages"));
  const welcomeBody = welcomeCall?.body as {
    content?: string;
    components?: Array<{ components?: Array<{ custom_id?: string }> }>;
  } | undefined;
  assert.equal(welcomeBody?.components?.[0]?.components?.[0]?.custom_id, "devbot:workspace:open");
  assert.match(welcomeBody?.content ?? "", /workspace configured/i);
  assert.doesNotMatch(welcomeBody?.content ?? "", /Devbot is ready/i);
});

test("initial setup reports a launcher warning without claiming it was posted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-initial-setup-warning-"));
  const repoRoot = path.join(root, "repo");
  await mkdir(repoRoot);
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/users/@me")) return jsonResponse({ id: "bot-1", username: "devbot", bot: true });
    if (url.endsWith("/oauth2/applications/@me")) return jsonResponse({ id: "app-1" });
    if (url.endsWith("/users/@me/guilds")) return jsonResponse([{ id: "guild-1", name: "Builders" }]);
    if (url.endsWith("/guilds/guild-1") && method === "GET") {
      return jsonResponse({ id: "guild-1", name: "Builders", owner_id: "owner-1" });
    }
    if (url.endsWith("/guilds/guild-1/channels") && method === "POST") {
      return jsonResponse({ id: "channel-1", guild_id: "guild-1", name: "devbot-private", type: 0 });
    }
    if (url.endsWith("/applications/app-1/guilds/guild-1/commands")) return jsonResponse([]);
    if (url.endsWith("/channels/channel-1/messages")) return jsonResponse({ message: "Missing Access" }, 403);
    return jsonResponse({ message: "unexpected route" }, 404);
  };

  const result = await finishInitialSetup({
    token: "bot.token.value",
    guildId: "guild-1",
    repositoryName: "repo",
    repositoryPath: repoRoot,
    envFile: path.join(root, ".env"),
    setupFile: path.join(root, ".state", "setup.json"),
    fetchImpl
  });

  assert.equal(result.launcherPosted, false);
  assert.equal(result.screenshotPolicy, "approval");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /welcome message could not be posted/i);
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}
