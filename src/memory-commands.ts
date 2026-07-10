import { formatMemoryList, type MemoryAccessContext, type MemoryKind, type MemoryStore } from "./memory-store.js";
import type { ProjectEntry } from "./types.js";

export const MAX_MEMORY_QUERY_LENGTH = 200;

export interface MemoryCommandActor {
  access: MemoryAccessContext;
  owner: boolean;
}

export type MemoryCommandRequest =
  | { subcommand: "list"; kind?: MemoryKind; limit?: number }
  | { subcommand: "search"; query: string }
  | { subcommand: "promote"; id: string }
  | { subcommand: "forget"; id: string }
  | { subcommand: "purge"; confirm?: string };

/**
 * Executes a `/memory` subcommand and returns the reply content. Every branch
 * re-checks authorization here (fail closed) even though the Discord handler
 * verifies project access first, so handler-level tests can exercise the exact
 * rules a real interaction is subject to.
 */
export async function executeMemoryCommand(
  store: MemoryStore,
  project: Pick<ProjectEntry, "root" | "name">,
  actor: MemoryCommandActor,
  request: MemoryCommandRequest
): Promise<string> {
  if (!actor.access.projectAllowed) {
    return `You are not allowed to use project \`${project.name}\` under its .devbot policy.`;
  }

  switch (request.subcommand) {
    case "list": {
      const entries = await store.list(project, {
        access: actor.access,
        ...(request.kind ? { kind: request.kind } : {}),
        limit: request.limit ?? 10
      });
      return formatMemoryList(entries, project.name);
    }
    case "search": {
      const query = request.query.slice(0, MAX_MEMORY_QUERY_LENGTH);
      const entries = await store.search(project, query, actor.access);
      return formatMemoryList(entries, project.name, query);
    }
    case "promote": {
      if (!actor.access.controller) {
        return "Only the owner or an approved controller can promote memory entries.";
      }
      const existing = await store.get(project, request.id, actor.access);
      if (!existing) {
        return `No memory entry \`${request.id}\` found for \`${project.name}\`.`;
      }
      await store.promote(project, request.id);
      return `Promoted \`${request.id}\` to active/trusted for \`${project.name}\`. It is now eligible for automatic recall.`;
    }
    case "forget": {
      if (!actor.owner) {
        return "Only the configured Devbot owner can forget memory entries.";
      }
      const removed = await store.forget(project, request.id);
      return removed
        ? `Forgot memory entry \`${request.id}\` for \`${project.name}\`. This removes it from Devbot's project memory only; it does not alter git history, Discord messages, task records, or backups.`
        : `No memory entry \`${request.id}\` found for \`${project.name}\`.`;
    }
    case "purge": {
      if (!actor.owner) {
        return "Only the configured Devbot owner can purge project memory.";
      }
      if (request.confirm !== project.name) {
        return `Confirmation mismatch. Re-run \`/memory purge\` with confirm set to \`${project.name}\` to permanently delete every memory entry for this project.`;
      }
      const count = await store.count(project);
      await store.purgeProject(project);
      return `Purged ${count} memory ${count === 1 ? "entry" : "entries"} for \`${project.name}\`. This deletes Devbot's project memory only; git history, Discord messages, task records, and backups are unaffected.`;
    }
  }
}
