import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  hardenPrivateDirectoryPermissions,
  hardenPrivateFilePermissions,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE
} from "./security.js";
import type { AppConfig, ProjectEntry } from "./types.js";

export type PeerAction = "capabilities" | "status" | "snip" | "plan" | "review" | "validate";

export interface PeerEnvelope {
  type: "devbot.peer.request" | "devbot.peer.result" | "devbot.peer.announce";
  version: 1;
  requestId: string;
  from: string;
  owner: string;
  action?: PeerAction;
  project?: string;
  target?: string;
  prompt?: string;
  task?: string;
  commands?: string;
  ok?: boolean;
  message?: string;
  capabilities?: PeerCapabilities;
}

export interface PeerCapabilities {
  botName: string;
  owner: string;
  projects: string[];
  commands: string[];
  supportsScreenshots: boolean;
  safeMode: boolean;
}

export interface PeerRecord {
  botId: string;
  owner: string;
  botName: string;
  projects: string[];
  commands: string[];
  supportsScreenshots: boolean;
  safeMode: boolean;
  lastSeenAt: string;
}

interface PeerStateFile {
  version: 1;
  peers: PeerRecord[];
}

const DISCORD_SAFE_CONTENT_LENGTH = 1_900;
const DISCORD_PEER_ENVELOPE_LENGTH = 1_950;

export class PeerStore {
  private state: PeerStateFile | undefined;

  constructor(private readonly stateFile = path.resolve(".devbot", "peers.json")) {}

  async upsert(botId: string, capabilities: PeerCapabilities): Promise<void> {
    const state = await this.load();
    const existing = state.peers.find((peer) => peer.botId === botId);
    const record: PeerRecord = {
      botId,
      owner: capabilities.owner,
      botName: capabilities.botName,
      projects: capabilities.projects,
      commands: capabilities.commands,
      supportsScreenshots: capabilities.supportsScreenshots,
      safeMode: capabilities.safeMode,
      lastSeenAt: new Date().toISOString()
    };

    if (existing) {
      Object.assign(existing, record);
    } else {
      state.peers.unshift(record);
    }
    await this.save();
  }

  async list(): Promise<PeerRecord[]> {
    return (await this.load()).peers;
  }

  private async load(): Promise<PeerStateFile> {
    if (this.state) {
      return this.state;
    }

    try {
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as PeerStateFile;
      await hardenPrivateFilePermissions(this.stateFile);
      this.state = { version: 1, peers: Array.isArray(parsed.peers) ? parsed.peers : [] };
    } catch {
      this.state = { version: 1, peers: [] };
    }
    return this.state;
  }

  private async save(): Promise<void> {
    if (!this.state) {
      return;
    }

    const directory = path.dirname(this.stateFile);
    await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await hardenPrivateDirectoryPermissions(directory);
    const tempFile = `${this.stateFile}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(tempFile, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: PRIVATE_FILE_MODE
    });
    await rename(tempFile, this.stateFile);
  }
}

export function buildCapabilities(appConfig: AppConfig, botUserId: string | undefined): PeerCapabilities {
  return {
    botName: appConfig.botIdentity.displayName || botUserId || "devbot",
    owner: appConfig.botIdentity.owner,
    projects: appConfig.projects.map((project) => project.name),
    commands: ["projects", "status", "snip", "task", "dashboard", "run", "review", "devbot", "peer", "lab"],
    supportsScreenshots: true,
    safeMode: appConfig.safeMode
  };
}

export function createPeerEnvelope(input: Omit<PeerEnvelope, "version" | "requestId"> & { requestId?: string }): PeerEnvelope {
  return {
    version: 1,
    requestId: input.requestId ?? newRequestId(),
    ...input
  };
}

export function parsePeerEnvelope(content: string): PeerEnvelope | undefined {
  const raw = extractJson(content);
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as PeerEnvelope;
    if (parsed.version !== 1 || !parsed.type || !parsed.requestId || !parsed.from || !parsed.owner) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function formatPeerEnvelope(envelope: PeerEnvelope, maxLength = DISCORD_PEER_ENVELOPE_LENGTH): string {
  const fitted = fitPeerEnvelopeToDiscord(envelope, maxLength);
  return `\`\`\`json\n${JSON.stringify(fitted)}\n\`\`\``;
}

export function fitPeerEnvelopeToDiscord(envelope: PeerEnvelope, maxLength = DISCORD_PEER_ENVELOPE_LENGTH): PeerEnvelope {
  const fitted = JSON.parse(JSON.stringify(envelope)) as PeerEnvelope;
  if (formattedPeerEnvelopeLength(fitted) <= maxLength) return fitted;

  const slots = peerEnvelopeStringSlots(fitted);
  while (formattedPeerEnvelopeLength(fitted) > maxLength) {
    const slot = slots.sort((left, right) => right.value().length - left.value().length)[0];
    if (!slot || slot.value().length <= 24) break;
    const overflow = formattedPeerEnvelopeLength(fitted) - maxLength;
    const value = slot.value();
    const nextLength = Math.max(21, value.length - overflow - 12);
    slot.set(`${value.slice(0, nextLength - 3)}...`);
  }

  if (formattedPeerEnvelopeLength(fitted) > maxLength) {
    delete fitted.capabilities;
    delete fitted.prompt;
    delete fitted.target;
    delete fitted.task;
    delete fitted.commands;
    fitted.message = "Peer payload exceeded the Discord transport limit.";
  }
  return fitted;
}

export function formatCapabilities(capabilities: PeerCapabilities, maxLength = DISCORD_SAFE_CONTENT_LENGTH): string {
  return truncateDiscordContent([
    `Devbot capabilities for \`${capabilities.botName}\``,
    `Owner: ${capabilities.owner}`,
    `Safe mode: ${capabilities.safeMode ? "on" : "off"}`,
    `Projects: ${capabilities.projects.map((project) => `\`${project}\``).join(", ") || "(none)"}`,
    `Commands: ${capabilities.commands.map((command) => `\`/${command}\``).join(", ")}`,
    `Screenshots: ${capabilities.supportsScreenshots ? "yes" : "no"}`
  ].join("\n"), maxLength);
}

export function formatPeerList(peers: PeerRecord[], maxLength = DISCORD_SAFE_CONTENT_LENGTH): string {
  if (peers.length === 0) {
    return "No peer devbots have announced themselves yet.";
  }

  return truncateDiscordContent(peers
    .map((peer) => {
      if (Date.parse(peer.lastSeenAt) <= 0) {
        return `- <@${peer.botId}> is allow-listed, but has not announced its capabilities yet.`;
      }
      return `- <@${peer.botId}> \`${peer.botName}\` owned by ${peer.owner}, projects: ${
        peer.projects.map((project) => `\`${project}\``).join(", ") || "(none)"
      }, last seen ${new Date(peer.lastSeenAt).toLocaleString()}`;
    })
    .join("\n"), maxLength);
}

export function projectNames(projects: ProjectEntry[]): string[] {
  return projects.map((project) => project.name);
}

function extractJson(content: string): string | undefined {
  const fenced = content.match(/```json\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    return fenced.trim();
  }

  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return content.slice(start, end + 1);
  }

  return undefined;
}

interface PeerStringSlot {
  value: () => string;
  set: (value: string) => void;
}

function peerEnvelopeStringSlots(envelope: PeerEnvelope): PeerStringSlot[] {
  const slots: PeerStringSlot[] = [];
  for (const key of ["message", "prompt", "target", "task", "commands", "project", "owner"] as const) {
    if (typeof envelope[key] !== "string") continue;
    slots.push({
      value: () => String(envelope[key] ?? ""),
      set: (value) => {
        envelope[key] = value;
      }
    });
  }
  const capabilities = envelope.capabilities;
  if (capabilities) {
    for (const key of ["botName", "owner"] as const) {
      slots.push({
        value: () => capabilities[key],
        set: (value) => {
          capabilities[key] = value;
        }
      });
    }
    for (const values of [capabilities.projects, capabilities.commands]) {
      for (let index = 0; index < values.length; index += 1) {
        slots.push({
          value: () => values[index] ?? "",
          set: (value) => {
            values[index] = value;
          }
        });
      }
    }
  }
  return slots;
}

function formattedPeerEnvelopeLength(envelope: PeerEnvelope): number {
  return `\`\`\`json\n${JSON.stringify(envelope)}\n\`\`\``.length;
}

function truncateDiscordContent(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 20)).trimEnd()}\n[output truncated]`;
}

function newRequestId(): string {
  return `peer-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}
