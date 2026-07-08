import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
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

    await mkdir(path.dirname(this.stateFile), { recursive: true });
    const tempFile = `${this.stateFile}.${process.pid}.tmp`;
    await writeFile(tempFile, `${JSON.stringify(this.state, null, 2)}\n`);
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

export function formatPeerEnvelope(envelope: PeerEnvelope): string {
  return `\`\`\`json\n${JSON.stringify(envelope, null, 2)}\n\`\`\``;
}

export function formatCapabilities(capabilities: PeerCapabilities): string {
  return [
    `Devbot capabilities for \`${capabilities.botName}\``,
    `Owner: ${capabilities.owner}`,
    `Safe mode: ${capabilities.safeMode ? "on" : "off"}`,
    `Projects: ${capabilities.projects.map((project) => `\`${project}\``).join(", ") || "(none)"}`,
    `Commands: ${capabilities.commands.map((command) => `\`/${command}\``).join(", ")}`,
    `Screenshots: ${capabilities.supportsScreenshots ? "yes" : "no"}`
  ].join("\n");
}

export function formatPeerList(peers: PeerRecord[]): string {
  if (peers.length === 0) {
    return "No peer devbots have announced themselves yet.";
  }

  return peers
    .map(
      (peer) =>
        `- <@${peer.botId}> \`${peer.botName}\` owned by ${peer.owner}, projects: ${
          peer.projects.map((project) => `\`${project}\``).join(", ") || "(none)"
        }, last seen ${new Date(peer.lastSeenAt).toLocaleString()}`
    )
    .join("\n");
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

function newRequestId(): string {
  return `peer-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}
