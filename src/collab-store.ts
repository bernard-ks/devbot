import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CollabArtifact, CollabIntent, CollabMode } from "./collab-protocol.js";
import { newCollabId } from "./collab-protocol.js";

export interface CollabConversation {
  id: string;
  intent: CollabIntent;
  projectName: string | undefined;
  title: string;
  requester: string;
  channelId?: string;
  threadId?: string;
  status: "open" | "closed";
  createdAt: string;
  updatedAt: string;
}

export interface CollabEvent {
  id: string;
  conversationId: string;
  type: "created" | "peer-request" | "peer-result" | "artifact" | "approval" | "decision" | "note";
  actor: string;
  summary: string;
  mode?: CollabMode;
  artifacts: CollabArtifact[];
  createdAt: string;
}

interface CollabStateFile {
  version: 1;
  conversations: CollabConversation[];
  events: CollabEvent[];
}

export class CollabStore {
  private state: CollabStateFile | undefined;

  constructor(
    private readonly stateFile = path.resolve(".devbot", "collab.json"),
    private readonly maxConversations = 200,
    private readonly maxEvents = 1_000
  ) {}

  async start(input: {
    intent: CollabIntent;
    projectName?: string;
    title: string;
    requester: string;
    channelId?: string;
    threadId?: string;
  }): Promise<CollabConversation> {
    const state = await this.load();
    const now = new Date().toISOString();
    const conversation: CollabConversation = {
      id: newCollabId("collab"),
      intent: input.intent,
      projectName: input.projectName,
      title: input.title,
      requester: input.requester,
      ...(input.channelId ? { channelId: input.channelId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      status: "open",
      createdAt: now,
      updatedAt: now
    };
    state.conversations.unshift(conversation);
    state.conversations = state.conversations.slice(0, this.maxConversations);
    state.events.unshift({
      id: newCollabId("event"),
      conversationId: conversation.id,
      type: "created",
      actor: input.requester,
      summary: input.title,
      artifacts: [],
      createdAt: now
    });
    state.events = state.events.slice(0, this.maxEvents);
    await this.save();
    return conversation;
  }

  async addEvent(input: {
    conversationId: string;
    type: CollabEvent["type"];
    actor: string;
    summary: string;
    mode?: CollabMode;
    artifacts?: CollabArtifact[];
  }): Promise<CollabEvent> {
    const state = await this.load();
    const now = new Date().toISOString();
    const event: CollabEvent = {
      id: newCollabId("event"),
      conversationId: input.conversationId,
      type: input.type,
      actor: input.actor,
      summary: input.summary,
      ...(input.mode ? { mode: input.mode } : {}),
      artifacts: input.artifacts ?? [],
      createdAt: now
    };
    state.events.unshift(event);
    state.events = state.events.slice(0, this.maxEvents);
    const conversation = state.conversations.find((item) => item.id === input.conversationId);
    if (conversation) {
      conversation.updatedAt = now;
    }
    await this.save();
    return event;
  }

  async recent(limit = 10): Promise<CollabConversation[]> {
    const state = await this.load();
    return state.conversations.slice(0, Math.max(1, Math.min(limit, 25)));
  }

  async events(conversationId: string, limit = 15): Promise<CollabEvent[]> {
    const state = await this.load();
    return state.events
      .filter((event) => event.conversationId === conversationId)
      .slice(0, Math.max(1, Math.min(limit, 50)));
  }

  async setThread(conversationId: string, threadId: string): Promise<CollabConversation | undefined> {
    const state = await this.load();
    const conversation = state.conversations.find((item) => item.id === conversationId);
    if (!conversation) {
      return undefined;
    }

    const now = new Date().toISOString();
    conversation.threadId = threadId;
    conversation.updatedAt = now;
    state.events.unshift({
      id: newCollabId("event"),
      conversationId,
      type: "note",
      actor: "devbot",
      summary: `Created Discord thread ${threadId}.`,
      artifacts: [],
      createdAt: now
    });
    state.events = state.events.slice(0, this.maxEvents);
    await this.save();
    return conversation;
  }

  private async load(): Promise<CollabStateFile> {
    if (this.state) {
      return this.state;
    }

    try {
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as CollabStateFile;
      this.state = {
        version: 1,
        conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
        events: Array.isArray(parsed.events) ? parsed.events : []
      };
    } catch {
      this.state = { version: 1, conversations: [], events: [] };
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

export function formatCollabRecent(conversations: CollabConversation[]): string {
  if (conversations.length === 0) {
    return "No collaboration lab sessions yet.";
  }

  return conversations
    .map((conversation) => {
      const project = conversation.projectName ? ` on \`${conversation.projectName}\`` : "";
      return `- \`${conversation.id}\` ${conversation.intent}${project}: ${conversation.title}`;
    })
    .join("\n");
}
