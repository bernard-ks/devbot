import assert from "node:assert/strict";
import test from "node:test";
import { MessageFlags, type Interaction } from "discord.js";
import { createInteractionRouter, type InteractionRouterDependencies } from "./interaction-router.js";
import type { LogFields, LogLevel } from "./logger.js";
import type { AppConfig } from "./types.js";

test("unauthorized autocomplete returns no choices after checking the configured room", async () => {
  const harness = createHarness();
  harness.state.allowed = false;

  await harness.route(mockInteraction("autocomplete", harness, { commandName: "task" }));

  assert.deepEqual(harness.responses, [[]]);
  assert.deepEqual(harness.checks, ["configured-room", "allowed"]);
  assert.deepEqual(harness.handled, []);
});

test("unauthorized known buttons receive the existing denial without reaching room checks", async () => {
  const harness = createHarness();
  harness.state.allowed = false;

  await harness.route(mockInteraction("button", harness, { customId: "devbot:workroom:close:room-1" }));

  assert.deepEqual(harness.replies, [{
    content: "You are not allowed to use this bot.",
    flags: MessageFlags.Ephemeral
  }]);
  assert.deepEqual(harness.checks, ["allowed"]);
  assert.deepEqual(harness.handled, []);
});

test("setup commands remain owner-only and bypass ordinary access routing", async () => {
  const harness = createHarness();
  harness.state.owner = false;

  await harness.route(mockInteraction("chat", harness, { commandName: "setup", userId: "viewer" }));

  assert.deepEqual(harness.replies, [{
    content: "Only the configured Devbot owner can run `/setup`.",
    flags: MessageFlags.Ephemeral
  }]);
  assert.deepEqual(harness.checks, ["owner"]);
  assert.deepEqual(harness.handled, []);
});

test("ordinary chat commands stop at configured-room gating", async () => {
  const harness = createHarness();
  harness.state.configuredRoom = false;

  await harness.route(mockInteraction("chat", harness, { commandName: "status" }));

  assert.deepEqual(harness.checks, ["allowed", "configured-room-gate"]);
  assert.deepEqual(harness.handled, []);
});

test("unknown component controls are ignored without access checks or replies", async () => {
  const harness = createHarness();

  await harness.route(mockInteraction("button", harness, { customId: "devbot:unknown:control" }));

  assert.deepEqual(harness.checks, []);
  assert.deepEqual(harness.replies, []);
  assert.deepEqual(harness.handled, []);
});

test("ordinary chat commands dispatch after access and room checks with structured request logging", async () => {
  const harness = createHarness();

  await harness.route(mockInteraction("chat", harness, { commandName: "status" }));

  assert.deepEqual(harness.checks, ["allowed", "configured-room-gate"]);
  assert.deepEqual(harness.handled, ["command"]);
  assert.deepEqual(harness.events, [{
    level: "info",
    event: "discord.interaction.received",
    fields: { requestId: "interaction-1", kind: "chat-command", command: "status" }
  }]);
});

test("handler failures retain structured error logging and centralized error replies", async () => {
  const harness = createHarness();
  harness.state.failingHandler = "command";

  await harness.route(mockInteraction("chat", harness, { commandName: "status" }));

  assert.equal(harness.errors.length, 1);
  assert.equal(harness.errors[0]?.event, "discord.interaction.failed");
  assert.deepEqual(harness.errors[0]?.fields, {
    requestId: "interaction-1",
    kind: "chat-command",
    command: "status"
  });
  assert.deepEqual(harness.errorReplies, ["handler failed: command"]);
});

test("ambient team selects dispatch after access and room checks", async () => {
  const harness = createHarness();

  await harness.route(mockInteraction("string-select", harness, {
    customId: "devbot:ambient:v1:team-select:task-abc"
  }));

  assert.deepEqual(harness.checks, ["allowed", "configured-room-gate"]);
  assert.deepEqual(harness.handled, ["ambient-team-select"]);
});

test("Studio selects enforce controller access", async () => {
  const harness = createHarness();
  harness.state.controller = false;

  await harness.route(mockInteraction("string-select", harness, {
    customId: "devbot:studio:v1:project:all",
    userId: "viewer"
  }));

  assert.deepEqual(harness.checks, ["allowed", "configured-room-gate", "controller"]);
  assert.deepEqual(harness.replies, [{
    content: "Only the owner or an approved controller can use Devbot Studio.",
    flags: MessageFlags.Ephemeral
  }]);
  assert.deepEqual(harness.handled, []);
});

test("setup user selects remain owner-only", async () => {
  const harness = createHarness();
  harness.state.owner = false;

  await harness.route(mockInteraction("user-select", harness, {
    customId: "devbot:setup:viewer",
    userId: "viewer"
  }));

  assert.deepEqual(harness.checks, ["owner"]);
  assert.deepEqual(harness.replies, [{
    content: "Only the configured Devbot owner can use setup controls.",
    flags: MessageFlags.Ephemeral
  }]);
  assert.deepEqual(harness.handled, []);
});

test("task modals dispatch after access and room checks", async () => {
  const harness = createHarness();

  await harness.route(mockInteraction("modal", harness, {
    customId: "devbot:task-modal:followup:task-abc"
  }));

  assert.deepEqual(harness.checks, ["allowed", "configured-room-gate"]);
  assert.deepEqual(harness.handled, ["task-modal"]);
});

test("the workroom context command dispatches after access and room checks", async () => {
  const harness = createHarness();

  await harness.route(mockInteraction("message-command", harness, {
    commandName: "Start Devbot workroom"
  }));

  assert.deepEqual(harness.checks, ["allowed", "configured-room-gate"]);
  assert.deepEqual(harness.handled, ["ambient-context-menu"]);
});

type InteractionKind =
  | "autocomplete"
  | "button"
  | "chat"
  | "string-select"
  | "user-select"
  | "modal"
  | "message-command";

interface HarnessState {
  allowed: boolean;
  configuredRoom: boolean;
  owner: boolean;
  controller: boolean;
  failingHandler?: string;
}

interface Harness {
  route(interaction: Interaction): Promise<void>;
  state: HarnessState;
  checks: string[];
  handled: string[];
  replies: unknown[];
  responses: unknown[];
  events: Array<{ level: LogLevel; event: string; fields: LogFields | undefined }>;
  errors: Array<{ event: string; error: unknown; fields: LogFields | undefined }>;
  errorReplies: string[];
}

function createHarness(): Harness {
  const state: HarnessState = {
    allowed: true,
    configuredRoom: true,
    owner: true,
    controller: true
  };
  const checks: string[] = [];
  const handled: string[] = [];
  const replies: unknown[] = [];
  const responses: unknown[] = [];
  const events: Harness["events"] = [];
  const errors: Harness["errors"] = [];
  const errorReplies: string[] = [];
  const record = (name: string) => async (..._args: unknown[]): Promise<void> => {
    handled.push(name);
    if (state.failingHandler === name) {
      throw new Error(`handler failed: ${name}`);
    }
  };
  const dependencies: InteractionRouterDependencies = {
    isConfiguredRoomId: async () => {
      checks.push("configured-room");
      return state.configuredRoom;
    },
    isAllowed: () => {
      checks.push("allowed");
      return state.allowed;
    },
    ensureConfiguredRoom: async () => {
      checks.push("configured-room-gate");
      return state.configuredRoom;
    },
    isOwner: () => {
      checks.push("owner");
      return state.owner;
    },
    isControllerUser: () => {
      checks.push("controller");
      return state.controller;
    },
    handleAutocomplete: record("autocomplete"),
    handleScreenshotApprovalButton: record("screenshot-approval"),
    handleAmbientButton: record("ambient-button"),
    handleStudioButton: record("studio-button"),
    handleWorkspaceButton: record("workspace-button"),
    handleSetupWizardButton: record("setup-button"),
    handlePreviewControlButton: record("preview-button"),
    handleTaskControl: record("task-button"),
    handleScreenshotFixControl: record("screenshot-fix"),
    handleWorkroomButton: record("workroom-button"),
    handleAmbientTeamSelect: record("ambient-team-select"),
    handleStudioSelect: record("studio-select"),
    handleWorkspaceProjectSelect: record("workspace-project-select"),
    handleSetupUserSelect: record("setup-user-select"),
    handleSetupProjectSelect: record("setup-project-select"),
    handleAmbientProposalEdit: record("ambient-proposal-edit"),
    handleWorkspaceModal: record("workspace-modal"),
    handleTaskModal: record("task-modal"),
    handleSetupRepoModal: record("setup-repo-modal"),
    handleAmbientContextMenu: record("ambient-context-menu"),
    handleSetupCommand: record("setup-command"),
    handleCommand: record("command"),
    replyWithError: async (_interaction, error) => {
      errorReplies.push(error instanceof Error ? error.message : String(error));
    },
    logEvent: (level, event, fields) => events.push({ level, event, fields }),
    logError: (event, error, fields) => errors.push({ event, error, fields }),
    warn: () => undefined
  };
  const config = { ownerUserId: "owner" } as AppConfig;
  return {
    route: createInteractionRouter(config, dependencies),
    state,
    checks,
    handled,
    replies,
    responses,
    events,
    errors,
    errorReplies
  };
}

function mockInteraction(
  kind: InteractionKind,
  harness: Pick<Harness, "replies" | "responses">,
  options: { commandName?: string; customId?: string; userId?: string } = {}
): Interaction {
  const command = kind === "autocomplete" || kind === "chat" || kind === "message-command";
  return {
    id: "interaction-1",
    channelId: "room-1",
    commandName: options.commandName ?? "status",
    customId: options.customId ?? "",
    user: { id: options.userId ?? "owner" },
    isCommand: () => command,
    isAutocomplete: () => kind === "autocomplete",
    isButton: () => kind === "button",
    isUserSelectMenu: () => kind === "user-select",
    isStringSelectMenu: () => kind === "string-select",
    isModalSubmit: () => kind === "modal",
    isMessageContextMenuCommand: () => kind === "message-command",
    isChatInputCommand: () => kind === "chat",
    respond: async (payload: unknown) => {
      harness.responses.push(payload);
    },
    reply: async (payload: unknown) => {
      harness.replies.push(payload);
    }
  } as unknown as Interaction;
}
