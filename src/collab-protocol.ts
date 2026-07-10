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
  | "council"
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

const COLLAB_TYPES: CollabEnvelopeV2["type"][] = [
  "devbot.peer.request",
  "devbot.peer.result",
  "devbot.peer.event",
  "devbot.peer.approval"
];
const COLLAB_CAPABILITIES: CollabCapability[] = [
  "status.read",
  "screenshot.read",
  "task.plan",
  "task.execute",
  "review.packet",
  "review.validate",
  "run.command",
  "git.push",
  "git.merge"
];
const COLLAB_INTENTS: CollabIntent[] = [
  "council",
  "roundtable",
  "see",
  "handoff",
  "bossfight",
  "jam",
  "argue",
  "fix-from-snip",
  "campfire",
  "roster",
  "ritual",
  "approval"
];
const COLLAB_MODES: CollabMode[] = ["read", "think", "validate", "write"];

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

export function formatCollabEnvelope(envelope: CollabEnvelopeV2, maxLength = 1_950): string {
  const fitted = fitCollabEnvelopeToDiscord(envelope, maxLength);
  return `\`\`\`json\n${JSON.stringify(fitted)}\n\`\`\``;
}

export function fitCollabEnvelopeToDiscord(envelope: CollabEnvelopeV2, maxLength = 1_950): CollabEnvelopeV2 {
  const fitted = JSON.parse(JSON.stringify(envelope)) as CollabEnvelopeV2;
  if (formattedEnvelopeLength(fitted) <= maxLength) {
    return fitted;
  }

  fitted.payload.transportTruncated = true;
  const slots = collectStringSlots(fitted.payload);
  while (formattedEnvelopeLength(fitted) > maxLength) {
    const slot = slots.sort((left, right) => right.value().length - left.value().length)[0];
    if (!slot || slot.value().length <= 24) {
      fitted.artifacts = [];
      break;
    }
    const overflow = formattedEnvelopeLength(fitted) - maxLength;
    const value = slot.value();
    const nextLength = Math.max(21, value.length - overflow - 16);
    slot.set(`${value.slice(0, nextLength - 3)}...`);
  }

  if (formattedEnvelopeLength(fitted) > maxLength) {
    fitted.payload = { transportTruncated: true, message: "Payload exceeded the Discord transport limit." };
    fitted.artifacts = [];
  }
  return fitted;
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
      !COLLAB_TYPES.includes(parsed.type) ||
      !COLLAB_CAPABILITIES.includes(parsed.capability) ||
      !COLLAB_INTENTS.includes(parsed.intent) ||
      !COLLAB_MODES.includes(parsed.mode) ||
      typeof parsed.requiresApproval !== "boolean" ||
      !parsed.payload ||
      typeof parsed.payload !== "object" ||
      Array.isArray(parsed.payload) ||
      !Array.isArray(parsed.artifacts) ||
      typeof parsed.createdAt !== "string"
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

export function isFreshCollabEnvelope(envelope: CollabEnvelopeV2, now = Date.now()): boolean {
  const createdAt = Date.parse(envelope.createdAt);
  if (!Number.isFinite(createdAt)) {
    return false;
  }
  const ageMs = now - createdAt;
  return ageMs >= -60_000 && ageMs <= 30 * 60_000;
}

export function collabDeliveryKey(envelope: CollabEnvelopeV2, transportActorId: string): string {
  const logicalId = envelope.type === "devbot.peer.request" ? envelope.requestId : envelope.correlationId ?? envelope.requestId;
  return [envelope.type, transportActorId, envelope.conversationId, logicalId].join(":");
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

interface StringSlot {
  value: () => string;
  set: (value: string) => void;
}

function collectStringSlots(value: Record<string, unknown>): StringSlot[] {
  const slots: StringSlot[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      slots.push({
        value: () => String(value[key] ?? ""),
        set: (next) => {
          value[key] = next;
        }
      });
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      slots.push(...collectStringSlots(entry as Record<string, unknown>));
    }
  }
  return slots;
}

function formattedEnvelopeLength(envelope: CollabEnvelopeV2): number {
  return `\`\`\`json\n${JSON.stringify(envelope)}\n\`\`\``.length;
}
