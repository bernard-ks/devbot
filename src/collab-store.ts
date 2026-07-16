import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { CollabArtifact, CollabIntent, CollabMode } from "./collab-protocol.js";
import { newCollabId } from "./collab-protocol.js";
import {
  hardenPrivateDirectoryPermissions,
  hardenPrivateFilePermissions,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE
} from "./security.js";
import { defaultRuntimeStatePath } from "./runtime-paths.js";

export type WorkroomPhase = "collecting" | "deliberating" | "synthesized" | "decided" | "closed";
export type ParticipantState = "active" | "invited" | "contributed";
export type ContributionKind = "proposal" | "challenge" | "synthesis";

export interface CollabParticipant {
  id: string;
  kind: "human" | "bot";
  displayName: string;
  owner?: string;
  state: ParticipantState;
  requestId?: string;
  joinedAt: string;
  updatedAt: string;
}

export interface CollabContribution {
  id: string;
  conversationId: string;
  actorId: string;
  actorName: string;
  kind: ContributionKind;
  content: string;
  sealed: boolean;
  sourceRequestId?: string;
  artifacts: CollabArtifact[];
  createdAt: string;
  revealedAt?: string;
}

export interface CollabDecision {
  outcome: "approve" | "deny" | "read-only";
  actor: string;
  note?: string;
  createdAt: string;
}

export interface CollabConversation {
  id: string;
  intent: CollabIntent;
  projectName?: string;
  title: string;
  brief?: string;
  requester: string;
  requesterId?: string;
  channelId?: string;
  threadId?: string;
  controlMessageId?: string;
  controlChannelId?: string;
  controlEphemeral?: boolean;
  status: "open" | "closed";
  phase: WorkroomPhase;
  participants: CollabParticipant[];
  decision?: CollabDecision;
  createdAt: string;
  updatedAt: string;
}

export interface CollabEvent {
  id: string;
  conversationId: string;
  type: "created" | "peer-request" | "peer-result" | "artifact" | "approval" | "decision" | "contribution" | "phase" | "note";
  actor: string;
  summary: string;
  mode?: CollabMode;
  artifacts: CollabArtifact[];
  createdAt: string;
}

interface CollabStateFile {
  version: 2;
  conversations: CollabConversation[];
  events: CollabEvent[];
  contributions: CollabContribution[];
  processedDeliveries: string[];
}

export class CollabStore {
  private state: CollabStateFile | undefined;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly stateFile = defaultRuntimeStatePath("collab.json"),
    private readonly maxConversations = 200,
    private readonly maxEvents = 1_000,
    private readonly maxContributions = 1_000,
    private readonly maxProcessedDeliveries = 2_000
  ) {}

  async start(input: {
    intent: CollabIntent;
    projectName?: string;
    title: string;
    brief?: string;
    requester: string;
    requesterId?: string;
    channelId?: string;
    threadId?: string;
  }): Promise<CollabConversation> {
    return this.mutate((state) => {
      const openConversations = state.conversations.filter((conversation) => conversation.status === "open").length;
      if (openConversations >= this.maxConversations) {
        throw new Error("Devbot's open collaboration limit has been reached. Close existing workrooms before starting another.");
      }
      const now = new Date().toISOString();
      const requesterId = input.requesterId ?? input.requester;
      const conversation: CollabConversation = {
        id: newCollabId("collab"),
        intent: input.intent,
        ...(input.projectName ? { projectName: input.projectName } : {}),
        title: input.title,
        ...(input.brief ? { brief: input.brief } : {}),
        requester: input.requester,
        ...(input.requesterId ? { requesterId: input.requesterId } : {}),
        ...(input.channelId ? { channelId: input.channelId } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
        status: "open",
        phase: "collecting",
        participants: [
          {
            id: requesterId,
            kind: "human",
            displayName: input.requester,
            state: "active",
            joinedAt: now,
            updatedAt: now
          }
        ],
        createdAt: now,
        updatedAt: now
      };
      state.conversations.unshift(conversation);
      state.conversations = retainOpenConversations(state.conversations, this.maxConversations);
      pushEvent(state, this.maxEvents, {
        conversationId: conversation.id,
        type: "created",
        actor: input.requester,
        summary: input.title,
        artifacts: []
      });
      return cloneConversation(conversation);
    });
  }

  async addEvent(input: {
    conversationId: string;
    type: CollabEvent["type"];
    actor: string;
    summary: string;
    mode?: CollabMode;
    artifacts?: CollabArtifact[];
  }): Promise<CollabEvent> {
    return this.mutate((state) => cloneEvent(pushEvent(state, this.maxEvents, input)));
  }

  async get(conversationId: string): Promise<CollabConversation | undefined> {
    const state = await this.readState();
    const conversation = state.conversations.find((item) => item.id === conversationId);
    return conversation ? cloneConversation(conversation) : undefined;
  }

  async recent(limit = 10): Promise<CollabConversation[]> {
    const state = await this.readState();
    return state.conversations.slice(0, Math.max(1, Math.min(limit, 25))).map(cloneConversation);
  }

  async events(conversationId: string, limit = 15): Promise<CollabEvent[]> {
    const state = await this.readState();
    return state.events
      .filter((event) => event.conversationId === conversationId)
      .slice(0, Math.max(1, Math.min(limit, 50)))
      .map(cloneEvent);
  }

  async contributions(conversationId: string, options: { includeSealed?: boolean } = {}): Promise<CollabContribution[]> {
    const state = await this.readState();
    return state.contributions
      .filter((contribution) => contribution.conversationId === conversationId && (options.includeSealed || !contribution.sealed))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(cloneContribution);
  }

  async claimDelivery(deliveryKey: string): Promise<boolean> {
    return this.mutate((state) => {
      if (state.processedDeliveries.includes(deliveryKey)) {
        return false;
      }
      state.processedDeliveries.unshift(deliveryKey);
      state.processedDeliveries = state.processedDeliveries.slice(0, this.maxProcessedDeliveries);
      return true;
    });
  }

  async setThread(conversationId: string, threadId: string): Promise<CollabConversation | undefined> {
    return this.mutate((state) => {
      const conversation = findConversation(state, conversationId);
      if (!conversation) {
        return undefined;
      }

      const now = new Date().toISOString();
      conversation.threadId = threadId;
      conversation.updatedAt = now;
      pushEvent(state, this.maxEvents, {
        conversationId,
        type: "note",
        actor: "devbot",
        summary: `Created Discord thread ${threadId}.`,
        artifacts: []
      });
      return cloneConversation(conversation);
    });
  }

  async setControlMessage(
    conversationId: string,
    controlMessageId: string,
    controlChannelId?: string,
    controlEphemeral = false
  ): Promise<CollabConversation | undefined> {
    return this.mutate((state) => {
      const conversation = findConversation(state, conversationId);
      if (!conversation) {
        return undefined;
      }

      conversation.controlMessageId = controlMessageId;
      if (controlChannelId) {
        conversation.controlChannelId = controlChannelId;
      } else {
        delete conversation.controlChannelId;
      }
      conversation.controlEphemeral = controlEphemeral;
      conversation.updatedAt = new Date().toISOString();
      return cloneConversation(conversation);
    });
  }

  async inviteParticipant(input: {
    conversationId: string;
    id: string;
    displayName: string;
    owner?: string;
    requestId?: string;
  }): Promise<CollabParticipant | undefined> {
    return this.mutate((state) => {
      const conversation = findConversation(state, input.conversationId);
      if (!conversation || conversation.status === "closed") {
        return undefined;
      }

      const now = new Date().toISOString();
      const existing = conversation.participants.find((participant) => participant.id === input.id);
      if (existing) {
        existing.displayName = input.displayName;
        if (input.owner) {
          existing.owner = input.owner;
        } else {
          delete existing.owner;
        }
        existing.state = "invited";
        if (input.requestId) {
          existing.requestId = input.requestId;
        } else {
          delete existing.requestId;
        }
        existing.updatedAt = now;
        conversation.updatedAt = now;
        return cloneParticipant(existing);
      }

      const participant: CollabParticipant = {
        id: input.id,
        kind: "bot",
        displayName: input.displayName,
        ...(input.owner ? { owner: input.owner } : {}),
        state: "invited",
        ...(input.requestId ? { requestId: input.requestId } : {}),
        joinedAt: now,
        updatedAt: now
      };
      conversation.participants.push(participant);
      conversation.updatedAt = now;
      return cloneParticipant(participant);
    });
  }

  async addContribution(input: {
    conversationId: string;
    actorId: string;
    actorName: string;
    kind: ContributionKind;
    content: string;
    sealed?: boolean;
    sourceRequestId?: string;
    artifacts?: CollabArtifact[];
  }): Promise<CollabContribution | undefined> {
    return this.mutate((state) => addContribution(state, this.maxContributions, this.maxEvents, input));
  }

  async acceptPeerContribution(input: {
    conversationId: string;
    actorId: string;
    actorName: string;
    sourceRequestId: string;
    content: string;
    artifacts?: CollabArtifact[];
  }): Promise<CollabContribution | undefined> {
    return this.mutate((state) => {
      const conversation = findConversation(state, input.conversationId);
      const participant = conversation?.participants.find((item) => item.id === input.actorId);
      if (
        !conversation ||
        conversation.status === "closed" ||
        conversation.phase !== "collecting" ||
        !participant ||
        participant.kind !== "bot" ||
        participant.requestId !== input.sourceRequestId
      ) {
        return undefined;
      }

      return addContribution(state, this.maxContributions, this.maxEvents, {
        ...input,
        kind: "proposal",
        sealed: true
      });
    });
  }

  async revealContributions(conversationId: string, actor: string): Promise<CollabContribution[]> {
    return this.mutate((state) => {
      const conversation = findConversation(state, conversationId);
      if (!conversation || conversation.status === "closed") {
        return [];
      }

      const now = new Date().toISOString();
      const contributions = state.contributions.filter((item) => item.conversationId === conversationId);
      for (const contribution of contributions) {
        if (contribution.sealed) {
          contribution.sealed = false;
          contribution.revealedAt = now;
        }
      }
      if (conversation.phase === "collecting") {
        conversation.phase = "deliberating";
      }
      conversation.updatedAt = now;
      pushEvent(state, this.maxEvents, {
        conversationId,
        type: "phase",
        actor,
        summary: `Revealed ${contributions.length} independent contribution(s).`,
        mode: "think",
        artifacts: []
      });
      return contributions.sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map(cloneContribution);
    });
  }

  async addSynthesis(input: {
    conversationId: string;
    actorId: string;
    actorName: string;
    content: string;
    artifacts?: CollabArtifact[];
  }): Promise<CollabContribution | undefined> {
    return this.mutate((state) => {
      const conversation = findConversation(state, input.conversationId);
      if (!conversation || conversation.status === "closed" || conversation.phase === "synthesized" || conversation.phase === "decided") {
        return undefined;
      }

      const contribution = addContribution(state, this.maxContributions, this.maxEvents, {
        ...input,
        kind: "synthesis",
        sealed: false
      });
      conversation.phase = "synthesized";
      conversation.updatedAt = new Date().toISOString();
      pushEvent(state, this.maxEvents, {
        conversationId: input.conversationId,
        type: "phase",
        actor: input.actorName,
        summary: "Synthesized the council contributions.",
        mode: "think",
        artifacts: input.artifacts ?? []
      });
      return contribution;
    });
  }

  async decide(input: {
    conversationId: string;
    outcome: CollabDecision["outcome"];
    actor: string;
    note?: string;
  }): Promise<CollabConversation | undefined> {
    return this.mutate((state) => {
      const conversation = findConversation(state, input.conversationId);
      if (
        !conversation ||
        conversation.status === "closed" ||
        conversation.decision ||
        (conversation.intent === "council" && input.outcome === "approve" && conversation.phase !== "synthesized")
      ) {
        return undefined;
      }

      const now = new Date().toISOString();
      conversation.decision = {
        outcome: input.outcome,
        actor: input.actor,
        ...(input.note ? { note: input.note } : {}),
        createdAt: now
      };
      conversation.phase = "decided";
      conversation.updatedAt = now;
      pushEvent(state, this.maxEvents, {
        conversationId: input.conversationId,
        type: "decision",
        actor: input.actor,
        summary: `${input.outcome}${input.note ? `: ${input.note}` : ""}`,
        mode: input.outcome === "approve" ? "write" : "read",
        artifacts: []
      });
      return cloneConversation(conversation);
    });
  }

  async close(conversationId: string, actor: string): Promise<CollabConversation | undefined> {
    return this.mutate((state) => {
      const conversation = findConversation(state, conversationId);
      if (!conversation || conversation.status === "closed") {
        return undefined;
      }

      const now = new Date().toISOString();
      conversation.status = "closed";
      conversation.phase = "closed";
      conversation.updatedAt = now;
      pushEvent(state, this.maxEvents, {
        conversationId,
        type: "phase",
        actor,
        summary: "Closed the workroom.",
        mode: "read",
        artifacts: []
      });
      return cloneConversation(conversation);
    });
  }

  private async readState(): Promise<CollabStateFile> {
    await this.mutationTail;
    return this.load();
  }

  private async mutate<T>(mutation: (state: CollabStateFile) => T): Promise<T> {
    let result: T | undefined;
    const operation = this.mutationTail.then(async () => {
      const state = await this.load();
      const previous = structuredClone(state);
      result = mutation(state);
      try {
        await this.save();
      } catch (error) {
        this.state = previous;
        throw error;
      }
    });
    this.mutationTail = operation.catch(() => undefined);
    await operation;
    return result as T;
  }

  private async load(): Promise<CollabStateFile> {
    if (this.state) {
      return this.state;
    }

    try {
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as {
        version?: number;
        conversations?: Array<Partial<CollabConversation>>;
        events?: CollabEvent[];
        contributions?: CollabContribution[];
        processedDeliveries?: string[];
      };
      await hardenPrivateFilePermissions(this.stateFile);
      if (parsed.version !== undefined && parsed.version !== 1 && parsed.version !== 2) {
        throw new Error(`Unsupported collaboration state version: ${parsed.version}`);
      }
      this.state = {
        version: 2,
        conversations: Array.isArray(parsed.conversations) ? parsed.conversations.map(normalizeConversation) : [],
        events: Array.isArray(parsed.events) ? (parsed.events as CollabEvent[]) : [],
        contributions: Array.isArray(parsed.contributions) ? parsed.contributions : [],
        processedDeliveries: Array.isArray(parsed.processedDeliveries) ? parsed.processedDeliveries : []
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Unable to read collaboration state at ${this.stateFile}: ${(error as Error).message}`, { cause: error });
      }
      this.state = { version: 2, conversations: [], events: [], contributions: [], processedDeliveries: [] };
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

function findConversation(state: CollabStateFile, conversationId: string): CollabConversation | undefined {
  return state.conversations.find((item) => item.id === conversationId);
}

function addContribution(
  state: CollabStateFile,
  maxContributions: number,
  maxEvents: number,
  input: {
    conversationId: string;
    actorId: string;
    actorName: string;
    kind: ContributionKind;
    content: string;
    sealed?: boolean;
    sourceRequestId?: string;
    artifacts?: CollabArtifact[];
  }
): CollabContribution | undefined {
  const conversation = findConversation(state, input.conversationId);
  if (
    !conversation ||
    conversation.status === "closed" ||
    (conversation.intent === "council" && input.kind !== "synthesis" && conversation.phase !== "collecting")
  ) {
    return undefined;
  }

  if (input.sourceRequestId) {
    const duplicate = state.contributions.find(
      (item) => item.conversationId === input.conversationId && item.sourceRequestId === input.sourceRequestId
    );
    if (duplicate) {
      return cloneContribution(duplicate);
    }
  }

  const now = new Date().toISOString();
  const contribution: CollabContribution = {
    id: newCollabId("contribution"),
    conversationId: input.conversationId,
    actorId: input.actorId,
    actorName: input.actorName,
    kind: input.kind,
    content: input.content.slice(0, 12_000),
    sealed: input.sealed ?? true,
    ...(input.sourceRequestId ? { sourceRequestId: input.sourceRequestId } : {}),
    artifacts: input.artifacts ?? [],
    createdAt: now,
    ...((input.sealed ?? true) ? {} : { revealedAt: now })
  };
  state.contributions.unshift(contribution);
  state.contributions = retainOpenRoomItems(state, state.contributions, maxContributions);
  const participant = conversation.participants.find((item) => item.id === input.actorId);
  if (participant) {
    participant.state = "contributed";
    participant.updatedAt = now;
  } else {
    conversation.participants.push({
      id: input.actorId,
      kind: "bot",
      displayName: input.actorName,
      state: "contributed",
      joinedAt: now,
      updatedAt: now
    });
  }
  conversation.updatedAt = now;
  pushEvent(state, maxEvents, {
    conversationId: input.conversationId,
    type: "contribution",
    actor: input.actorName,
    summary: `${input.kind} contribution ${contribution.sealed ? "sealed" : "added"}.`,
    mode: "think",
    artifacts: contribution.artifacts
  });
  return cloneContribution(contribution);
}

function pushEvent(
  state: CollabStateFile,
  maxEvents: number,
  input: {
    conversationId: string;
    type: CollabEvent["type"];
    actor: string;
    summary: string;
    mode?: CollabMode;
    artifacts?: CollabArtifact[];
  }
): CollabEvent {
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
  state.events = retainOpenRoomItems(state, state.events, maxEvents);
  const conversation = findConversation(state, input.conversationId);
  if (conversation) {
    conversation.updatedAt = now;
  }
  return event;
}

function normalizeConversation(input: Partial<CollabConversation>): CollabConversation {
  const now = new Date().toISOString();
  const requester = input.requester ?? "unknown";
  const status = input.status === "closed" ? "closed" : "open";
  return {
    id: input.id ?? newCollabId("collab"),
    intent: input.intent ?? "roundtable",
    ...(input.projectName ? { projectName: input.projectName } : {}),
    title: input.title ?? "Recovered collaboration session",
    ...(input.brief ? { brief: input.brief } : {}),
    requester,
    ...(input.requesterId ? { requesterId: input.requesterId } : {}),
    ...(input.channelId ? { channelId: input.channelId } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.controlMessageId ? { controlMessageId: input.controlMessageId } : {}),
    ...(input.controlChannelId ? { controlChannelId: input.controlChannelId } : {}),
    ...(input.controlEphemeral ? { controlEphemeral: true } : {}),
    status,
    phase: status === "closed" ? "closed" : input.phase ?? "collecting",
    participants: Array.isArray(input.participants)
      ? input.participants
      : [
          {
            id: input.requesterId ?? requester,
            kind: "human",
            displayName: requester,
            state: "active",
            joinedAt: input.createdAt ?? now,
            updatedAt: input.updatedAt ?? now
          }
        ],
    ...(input.decision ? { decision: input.decision } : {}),
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now
  };
}

function retainOpenConversations(conversations: CollabConversation[], maxItems: number): CollabConversation[] {
  const openCount = conversations.filter((conversation) => conversation.status === "open").length;
  let closedBudget = Math.max(0, maxItems - openCount);
  return conversations.filter((conversation) => {
    if (conversation.status === "open") {
      return true;
    }
    if (closedBudget <= 0) {
      return false;
    }
    closedBudget -= 1;
    return true;
  });
}

function retainOpenRoomItems<T extends { conversationId: string }>(
  state: CollabStateFile,
  items: T[],
  maxItems: number
): T[] {
  const openIds = new Set(
    state.conversations.filter((conversation) => conversation.status === "open").map((conversation) => conversation.id)
  );
  const openItemCount = items.filter((item) => openIds.has(item.conversationId)).length;
  let closedBudget = Math.max(0, maxItems - openItemCount);
  return items.filter((item) => {
    if (openIds.has(item.conversationId)) {
      return true;
    }
    if (closedBudget <= 0) {
      return false;
    }
    closedBudget -= 1;
    return true;
  });
}

function cloneConversation(conversation: CollabConversation): CollabConversation {
  return {
    ...conversation,
    participants: conversation.participants.map(cloneParticipant),
    ...(conversation.decision ? { decision: { ...conversation.decision } } : {})
  };
}

function cloneParticipant(participant: CollabParticipant): CollabParticipant {
  return { ...participant };
}

function cloneContribution(contribution: CollabContribution): CollabContribution {
  return { ...contribution, artifacts: contribution.artifacts.map((artifact) => ({ ...artifact })) };
}

function cloneEvent(event: CollabEvent): CollabEvent {
  return { ...event, artifacts: event.artifacts.map((artifact) => ({ ...artifact })) };
}

export function formatCollabRecent(conversations: CollabConversation[]): string {
  if (conversations.length === 0) {
    return "No collaboration lab sessions yet.";
  }

  return conversations
    .map((conversation) => {
      const project = conversation.projectName ? ` on \`${conversation.projectName}\`` : "";
      return `- \`${conversation.id}\` ${conversation.intent}${project} [${conversation.phase}]: ${conversation.title}`;
    })
    .join("\n");
}
