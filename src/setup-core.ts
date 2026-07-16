import { randomUUID } from "node:crypto";
import { readFile, mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { commandDefinitions } from "./commands.js";
import { normalizeProjectName } from "./config.js";
import { defaultRuntimeStatePath } from "./runtime-paths.js";
import { persistScreenshotPolicy } from "./screenshot-approval.js";
import { SetupStore } from "./setup-store.js";
import { UserPreferenceStore } from "./user-preferences.js";
import { workspaceLauncherView } from "./workspace-ui.js";

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_REQUEST_TIMEOUT_MS = 12_000;
const DISCORD_MAX_ATTEMPTS = 3;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type SetupScreenshotPolicy = "allow" | "approval" | "deny";

export interface DiscordBotIdentity {
  applicationId: string;
  botId: string;
  username: string;
  avatarUrl?: string;
}

export interface DiscordGuildSummary {
  id: string;
  name: string;
}

export interface SetupFinishInput {
  token: string;
  guildId: string;
  repositoryName: string;
  repositoryPath: string;
  envFile?: string;
  envTemplateFile?: string;
  setupFile?: string;
  enableStudio?: boolean;
  screenshotPolicy?: SetupScreenshotPolicy;
  fetchImpl?: FetchLike;
}

export interface SetupFinishResult {
  applicationId: string;
  botId: string;
  botName: string;
  guildId: string;
  guildName: string;
  ownerId: string;
  channelId: string;
  channelUrl: string;
  repositoryName: string;
  repositoryPath: string;
  studioEnabled: boolean;
  screenshotPolicy: SetupScreenshotPolicy;
  launcherPosted: boolean;
  warnings: string[];
}

interface DiscordApplication {
  id: string;
}

interface DiscordUser {
  id: string;
  username: string;
  bot?: boolean;
  avatar?: string | null;
}

interface DiscordGuild {
  id: string;
  name: string;
  owner_id: string;
}

interface DiscordChannel {
  id: string;
  guild_id?: string;
  name?: string;
  type: number;
  permission_overwrites?: Array<{ id: string; type: number; allow: string; deny: string }>;
}

interface DiscordMessage {
  id: string;
}

export async function validateDiscordBotToken(tokenValue: string, fetchImpl: FetchLike = fetch): Promise<DiscordBotIdentity> {
  const token = normalizeToken(tokenValue);
  const [bot, application] = await Promise.all([
    discordJson<DiscordUser>(token, "/users/@me", undefined, fetchImpl),
    discordJson<DiscordApplication>(token, "/oauth2/applications/@me", undefined, fetchImpl)
  ]);
  if (!bot.bot) {
    throw new Error("That credential belongs to a Discord user, not a bot application.");
  }
  return {
    applicationId: application.id,
    botId: bot.id,
    username: bot.username,
    ...(bot.avatar ? { avatarUrl: `https://cdn.discordapp.com/avatars/${bot.id}/${bot.avatar}.png?size=128` } : {})
  };
}

export async function listDiscordBotGuilds(tokenValue: string, fetchImpl: FetchLike = fetch): Promise<DiscordGuildSummary[]> {
  const guilds = await discordJson<Array<{ id: string; name: string }>>(
    normalizeToken(tokenValue),
    "/users/@me/guilds",
    undefined,
    fetchImpl
  );
  return guilds.map(({ id, name }) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

export function buildDiscordInstallUrl(applicationId: string, guildId?: string): string {
  const permissions = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.SendMessagesInThreads,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.UseApplicationCommands,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageThreads,
    PermissionFlagsBits.CreatePrivateThreads
  ]).bitfield.toString();
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", applicationId);
  url.searchParams.set("scope", "bot applications.commands");
  url.searchParams.set("permissions", permissions);
  if (guildId) {
    url.searchParams.set("guild_id", guildId);
  }
  return url.toString();
}

export async function finishInitialSetup(input: SetupFinishInput): Promise<SetupFinishResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const token = normalizeToken(input.token);
  const repositoryPath = path.resolve(input.repositoryPath.trim());
  const repositoryStats = await stat(repositoryPath).catch(() => undefined);
  if (!repositoryStats?.isDirectory()) {
    throw new Error("The repository path does not exist or is not a directory on this machine.");
  }
  const repositoryName = normalizeProjectName(input.repositoryName || path.basename(repositoryPath));
  if (!repositoryName || !/[a-z0-9_]/.test(repositoryName)) {
    throw new Error("Give the repository a short name containing letters, numbers, underscores, or hyphens.");
  }
  const screenshotPolicy = normalizeScreenshotPolicy(input.screenshotPolicy);

  const identity = await validateDiscordBotToken(token, fetchImpl);
  const guilds = await listDiscordBotGuilds(token, fetchImpl);
  if (!guilds.some((guild) => guild.id === input.guildId)) {
    throw new Error("Devbot is not installed in that Discord server yet. Add it, then refresh the server list.");
  }

  const guild = await discordJson<DiscordGuild>(token, `/guilds/${input.guildId}`, undefined, fetchImpl);
  // Validate and persist local project policy before creating Discord resources,
  // so malformed metadata cannot leave behind a half-provisioned private room.
  await updateProjectScreenshotPolicy(repositoryPath, screenshotPolicy);

  const setupFile = path.resolve(input.setupFile ?? defaultRuntimeStatePath("setup.json"));
  const setupStore = new SetupStore(setupFile);
  const userPreferences = new UserPreferenceStore(path.join(path.dirname(setupFile), "preferences.json"));
  const channel = await ensurePrivateChannel({
    token,
    guild,
    identity,
    savedChannelId: setupStore.snapshot().privateChannelId,
    fetchImpl
  });

  await setupStore.setRepository(repositoryName, repositoryPath);
  await setupStore.setDefaultProject(repositoryName);
  await userPreferences.clearSelectedProject(guild.owner_id);
  await setupStore.setPrivateChannel(channel.id);
  await setupStore.setStudioEnabled(input.enableStudio === true);

  const envFile = path.resolve(input.envFile ?? ".env");
  const envTemplateFile = path.resolve(input.envTemplateFile ?? ".env.example");
  await updateEnvFile(
    envFile,
    {
      DISCORD_TOKEN: token,
      DISCORD_CLIENT_ID: identity.applicationId,
      DISCORD_GUILD_ID: guild.id,
      DEVBOT_OWNER_USER_ID: guild.owner_id,
      DEVBOT_AUTO_DEPLOY_COMMANDS: "true",
      DEVBOT_STUDIO_ENABLED: input.enableStudio ? "true" : "false"
    },
    envTemplateFile
  );

  await discordJson(
    token,
    `/applications/${identity.applicationId}/guilds/${guild.id}/commands`,
    {
      method: "PUT",
      body: JSON.stringify(commandDefinitions)
    },
    fetchImpl
  );

  const warnings: string[] = [];
  let launcherPosted = false;
  try {
    const workspace = workspaceLauncherView();
    const welcome = await discordJson<DiscordMessage>(
      token,
      `/channels/${channel.id}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          content: [
            `Devbot workspace configured for <@${guild.owner_id}>. It will respond after the local process signs in to Discord.`,
            "",
            workspace.content
          ].join("\n"),
          components: workspace.components.map((row) => row.toJSON()),
          allowed_mentions: { parse: [] }
        })
      },
      fetchImpl
    );
    await setupStore.setWorkspaceMessage(welcome.id);
    launcherPosted = true;
  } catch (error) {
    warnings.push(`The room was created, but the welcome message could not be posted: ${(error as Error).message}`);
  }

  return {
    applicationId: identity.applicationId,
    botId: identity.botId,
    botName: identity.username,
    guildId: guild.id,
    guildName: guild.name,
    ownerId: guild.owner_id,
    channelId: channel.id,
    channelUrl: `https://discord.com/channels/${guild.id}/${channel.id}`,
    repositoryName,
    repositoryPath,
    studioEnabled: input.enableStudio === true,
    screenshotPolicy,
    launcherPosted,
    warnings
  };
}

async function updateProjectScreenshotPolicy(
  repositoryPath: string,
  screenshotPolicy: SetupScreenshotPolicy
): Promise<void> {
  await persistScreenshotPolicy(repositoryPath, screenshotPolicy);
}

export async function updateEnvFile(
  envFile: string,
  updates: Record<string, string>,
  templateFile?: string
): Promise<void> {
  const existing = await readFile(envFile, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const template = existing === undefined && templateFile
    ? await readFile(templateFile, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      })
    : "";
  const source = existing ?? template;
  const remaining = new Map(Object.entries(updates));
  const lines = source.split(/\r?\n/).map((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (!match?.[1] || !remaining.has(match[1])) {
      return line;
    }
    const value = remaining.get(match[1])!;
    remaining.delete(match[1]);
    return `${match[1]}=${formatEnvValue(value)}`;
  });

  if (remaining.size > 0) {
    while (lines.length > 0 && lines.at(-1) === "") lines.pop();
    if (lines.length > 0) lines.push("");
    lines.push("# Added by the Devbot setup tool.");
    for (const [key, value] of remaining) {
      lines.push(`${key}=${formatEnvValue(value)}`);
    }
  }

  await mkdir(path.dirname(envFile), { recursive: true });
  const tempFile = `${envFile}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempFile, `${lines.join("\n").replace(/\n+$/, "")}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempFile, envFile);
}

async function ensurePrivateChannel(input: {
  token: string;
  guild: DiscordGuild;
  identity: DiscordBotIdentity;
  savedChannelId: string | undefined;
  fetchImpl: FetchLike;
}): Promise<DiscordChannel> {
  if (input.savedChannelId) {
    const saved = await discordJson<DiscordChannel>(
      input.token,
      `/channels/${input.savedChannelId}`,
      undefined,
      input.fetchImpl
    ).catch(() => undefined);
    if (saved && saved.type === 0 && saved.guild_id === input.guild.id && isPrivateChannel(saved, input.guild.id)) {
      await synchronizePrivateChannel(input.token, saved.id, input.guild.id, input.guild.owner_id, input.identity.botId, input.fetchImpl);
      return saved;
    }
  }

  return discordJson<DiscordChannel>(
    input.token,
    `/guilds/${input.guild.id}/channels`,
    {
      method: "POST",
      body: JSON.stringify({
        name: "devbot-private",
        type: 0,
        topic: "Private local Devbot workspace",
        permission_overwrites: privateRoomOverwrites(input.guild.id, input.guild.owner_id, input.identity.botId)
      })
    },
    input.fetchImpl
  );
}

async function synchronizePrivateChannel(
  token: string,
  channelId: string,
  everyoneId: string,
  ownerId: string,
  botId: string,
  fetchImpl: FetchLike
): Promise<void> {
  for (const overwrite of privateRoomOverwrites(everyoneId, ownerId, botId)) {
    await discordJson(
      token,
      `/channels/${channelId}/permissions/${overwrite.id}`,
      { method: "PUT", body: JSON.stringify({ type: overwrite.type, allow: overwrite.allow, deny: overwrite.deny }) },
      fetchImpl
    );
  }
}

function privateRoomOverwrites(everyoneId: string, ownerId: string, botId: string) {
  const ownerAllow = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.UseApplicationCommands,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks
  ]).bitfield.toString();
  const botAllow = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.UseApplicationCommands,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageThreads,
    PermissionFlagsBits.CreatePrivateThreads
  ]).bitfield.toString();
  return [
    { id: everyoneId, type: 0, allow: "0", deny: PermissionFlagsBits.ViewChannel.toString() },
    { id: ownerId, type: 1, allow: ownerAllow, deny: "0" },
    { id: botId, type: 1, allow: botAllow, deny: "0" }
  ];
}

function isPrivateChannel(channel: DiscordChannel, everyoneId: string): boolean {
  const everyone = channel.permission_overwrites?.find((overwrite) => overwrite.id === everyoneId && overwrite.type === 0);
  if (!everyone) return false;
  return (BigInt(everyone.deny || "0") & PermissionFlagsBits.ViewChannel) === PermissionFlagsBits.ViewChannel;
}

async function discordJson<T = unknown>(
  token: string,
  route: string,
  init: RequestInit | undefined,
  fetchImpl: FetchLike
): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const retryableMethod = method === "GET" || method === "PUT" || method === "DELETE";
  for (let attempt = 0; attempt < DISCORD_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Discord request timed out.")), DISCORD_REQUEST_TIMEOUT_MS);
    timeout.unref();
    const upstreamSignal = init?.signal;
    const forwardAbort = () => controller.abort(upstreamSignal?.reason);
    if (upstreamSignal?.aborted) {
      forwardAbort();
    } else {
      upstreamSignal?.addEventListener("abort", forwardAbort, { once: true });
    }

    let response: Response;
    try {
      response = await fetchImpl(`${DISCORD_API}${route}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "DevbotSetup (https://github.com/bernard-ks/devbot, 0.1.0)",
          ...(init?.headers ?? {})
        }
      });
    } catch (error) {
      if (retryableMethod && attempt + 1 < DISCORD_MAX_ATTEMPTS && !upstreamSignal?.aborted) {
        await wait(discordRetryDelayMs(undefined, "", attempt));
        continue;
      }
      if (controller.signal.aborted && !upstreamSignal?.aborted) {
        throw new Error("Discord did not respond in time. Check your connection and try again.");
      }
      throw new Error(`Unable to reach Discord: ${(error as Error).message}`);
    } finally {
      clearTimeout(timeout);
      upstreamSignal?.removeEventListener("abort", forwardAbort);
    }

    const detail = response.status === 204 ? "" : await response.text().catch(() => "");
    if (response.ok) {
      if (!detail) return undefined as T;
      try {
        return JSON.parse(detail) as T;
      } catch {
        throw new Error("Discord returned an invalid setup response. Try again.");
      }
    }

    const canRetry = response.status === 429 || (retryableMethod && response.status >= 500);
    if (canRetry && attempt + 1 < DISCORD_MAX_ATTEMPTS) {
      await wait(discordRetryDelayMs(response, detail, attempt));
      continue;
    }
    const safeDetail = detail.slice(0, 300).replace(/\s+/g, " ").trim();
    throw new Error(`Discord rejected the setup request (${response.status})${safeDetail ? `: ${safeDetail}` : "."}`);
  }
  throw new Error("Discord setup did not complete after several attempts.");
}

function discordRetryDelayMs(response: Response | undefined, detail: string, attempt: number): number {
  const header = response?.headers.get("Retry-After") ?? response?.headers.get("X-RateLimit-Reset-After");
  let seconds = header ? Number(header) : Number.NaN;
  if (!Number.isFinite(seconds) && detail) {
    try {
      const payload = JSON.parse(detail) as { retry_after?: unknown };
      seconds = typeof payload.retry_after === "number" ? payload.retry_after : Number.NaN;
    } catch {
      // Fall back to a short exponential retry when Discord does not provide a delay.
    }
  }
  const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : 250 * (2 ** attempt);
  return Math.min(Math.max(delay, 0), 5_000);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeToken(value: string): string {
  const token = value.trim().replace(/^Bot\s+/i, "");
  if (!token) {
    throw new Error("Paste the bot token from the Discord Developer Portal.");
  }
  return token;
}

function normalizeScreenshotPolicy(value: SetupScreenshotPolicy | undefined): SetupScreenshotPolicy {
  if (value === undefined) return "approval";
  if (value !== "allow" && value !== "approval" && value !== "deny") {
    throw new Error("Screenshot policy must be allow, approval, or deny.");
  }
  return value;
}

function formatEnvValue(value: string): string {
  return /^[A-Za-z0-9_./:@+-]*$/.test(value) ? value : JSON.stringify(value);
}
