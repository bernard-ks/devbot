export type CollabMode = "read" | "think" | "validate" | "write";

export type CollabCapability =
  | "status.read"
  | "screenshot.read"
  | "task.plan"
  | "task.execute"
  | "review.packet"
  | "review.validate"
  | "run.command"
  | "git.push"
  | "git.merge";

export type CollabIntent =
  | "roundtable"
  | "see"
  | "handoff"
  | "bossfight"
  | "jam"
  | "argue"
  | "fix-from-snip"
  | "campfire"
  | "roster"
  | "ritual"
  | "approval";

export interface CollabActor {
  botId: string;
  owner: string;
  botName?: string;
}

export interface CollabArtifact {
  id: string;
  kind: "screenshot" | "review-packet" | "validation" | "plan" | "log" | "task" | "approval";
  label: string;
  summary?: string;
  url?: string;
}

export interface CollabEnvelopeV2 {
  type: "devbot.peer.request" | "devbot.peer.result" | "devbot.peer.event" | "devbot.peer.approval";
  version: 2;
  id: string;
  conversationId: string;
  requestId: string;
  correlationId?: string;
  from: CollabActor;
  to?: {
    botId?: string;
    project?: string;
  };
  capability: CollabCapability;
  intent: CollabIntent;
  mode: CollabMode;
  requiresApproval: boolean;
  payload: Record<string, unknown>;
  artifacts: CollabArtifact[];
  createdAt: string;
}

export function createCollabEnvelope(
  input: Omit<CollabEnvelopeV2, "version" | "id" | "requestId" | "createdAt" | "artifacts" | "payload"> & {
    id?: string;
    requestId?: string;
    payload?: Record<string, unknown>;
    artifacts?: CollabArtifact[];
    createdAt?: string;
  }
): CollabEnvelopeV2 {
  const requestId = input.requestId ?? newCollabId("req");
  return {
    version: 2,
    id: input.id ?? newCollabId("msg"),
    requestId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    payload: input.payload ?? {},
    artifacts: input.artifacts ?? [],
    ...input
  };
}

export function formatCollabEnvelope(envelope: CollabEnvelopeV2): string {
  return `\`\`\`json\n${JSON.stringify(envelope, null, 2)}\n\`\`\``;
}

export function parseCollabEnvelope(content: string): CollabEnvelopeV2 | undefined {
  const raw = extractJson(content);
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as CollabEnvelopeV2;
    if (
      parsed.version !== 2 ||
      !parsed.type ||
      !parsed.id ||
      !parsed.conversationId ||
      !parsed.requestId ||
      !parsed.from?.botId ||
      !parsed.from.owner ||
      !parsed.capability ||
      !parsed.intent ||
      !parsed.mode
    ) {
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
}

export function newCollabId(prefix = "collab"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
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
