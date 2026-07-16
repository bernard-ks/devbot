import { parseIncludePatterns } from "./context.js";
import type { CodexRequestMode } from "./codex-client.js";
import { requireProjectReference } from "./project-routing.js";
import type { ProjectEntry } from "./types.js";

export interface ParsedMentionRequest {
  project: ProjectEntry;
  projectWasExplicit: boolean;
  text: string;
  includePatterns: string[];
  mode: CodexRequestMode;
}

export interface ParsedStatusRequest {
  isStatus: boolean;
  question: string | undefined;
  wantsImage: boolean;
}

export interface ParsedProjectReference {
  project: ProjectEntry | undefined;
  text: string;
}

const DETAILED_STATUS_SIGNAL = /\b(why|error|errors|failed|failing|failure|broken|stuck|blocking|root cause|diff|changed|changes|remaining|ready|merge|pull request)\b/;

export function parseOptionalProjectReference(text: string, projects: ProjectEntry[]): ParsedProjectReference {
  const explicitMatch = text.match(/\bproject:([a-z0-9_-]+)\b/i);
  if (explicitMatch) {
    return {
      project: requireProjectReference(projects, explicitMatch[1] ?? ""),
      text: text.replace(explicitMatch[0], "").trim()
    };
  }

  const naturalMatch = [
    /^\s*(?:please\s+)?(?:(?:what(?:'s| is)|show(?: me)?|give me|can you (?:show|give me))\s+(?:the\s+)?)?(?:status|state|progress|wip)\s+(?:on|of|for|about)\s+(?:the\s+)?([a-z0-9_-]+)(?=\s*(?:[?!.]*$|please\s*[?!.]*$|and\s+(?:why|what|where|when|how|is|are|was|were|did|does|do|has|have|can|could|should|would)\b))/i,
    /^\s*(?:please\s+)?(?:what(?:'s| is)|show|give me)\s+(?:the\s+)?([a-z0-9_-]+)\s+(?:status|state|progress)\s*[?!.]*$/i,
    /^\s*(?:please\s+)?how\s+is\s+([a-z0-9_-]+)\s+doing\s*[?!.]*$/i
  ].map((pattern) => text.match(pattern)).find(Boolean);
  if (!naturalMatch) {
    return { project: undefined, text };
  }
  return { project: requireProjectReference(projects, naturalMatch[1] ?? ""), text };
}

export function parseMentionRequest(
  content: string,
  botUserId: string,
  projects: ProjectEntry[],
  botRoleIds: string[] = []
): ParsedMentionRequest {
  let text = stripBotMention(content, botUserId, botRoleIds);
  const projectMatch = text.match(/\bproject:([a-z0-9_-]+)\b/i);
  const includeMatch = text.match(/\binclude:([^\s]+)/i);
  const modeMatch = text.match(/\bmode:(ask|answer|act|action)\b/i);
  const project = projectMatch ? requireProjectReference(projects, projectMatch[1] ?? "") : defaultProject(projects);
  const includePatterns = includeMatch ? parseIncludePatterns(includeMatch[1] ?? "") : [];

  if (projectMatch) {
    text = text.replace(projectMatch[0], "").trim();
  }

  if (includeMatch) {
    text = text.replace(includeMatch[0], "").trim();
  }

  if (modeMatch) {
    text = text.replace(modeMatch[0], "").trim();
  }

  const mode = modeMatch ? parseMentionMode(modeMatch[1] ?? "") : "answer";
  return { project, projectWasExplicit: Boolean(projectMatch), text, includePatterns, mode };
}

export function stripBotMention(content: string, botUserId: string, botRoleIds: string[] = []): string {
  let text = content.replace(new RegExp(`<@!?${botUserId}>`, "g"), "");
  for (const roleId of botRoleIds) {
    text = text.replace(new RegExp(`<@&${roleId}>`, "g"), "");
  }

  return text.trim();
}

export function isWorkStatusQuestion(text: string): boolean {
  return parseStatusRequest(text).isStatus;
}

export function parseStatusRequest(text: string): ParsedStatusRequest {
  const normalized = text.toLowerCase().replace(/[?!.]/g, "").replace(/\s+/g, " ").trim();
  const isStatus =
    normalized === "status" ||
    normalized === "wip" ||
    /\b(work in progress|in progress|currently working|working on|current work|dev work|codex work|what are you working on)\b/.test(normalized) ||
    /\b(status|state)\s+(on|of|for|about)\b/.test(normalized);

  if (!isStatus) {
    return { isStatus: false, question: undefined, wantsImage: false };
  }

  const wantsImage = wantsStatusImage(text);
  const question = statusDetailQuestion(text);
  return { isStatus: true, question, wantsImage };
}

/**
 * Handles looser status phrasing without treating ordinary questions containing
 * words such as "work" or "output" as status/screenshot requests.
 */
export function parseFallbackStatusRequest(text: string): ParsedStatusRequest {
  const normalized = text.toLowerCase().replace(/[?!.]/g, "").replace(/\s+/g, " ").trim();
  const visualRequest = /\b(snip|screenshot|screen shot)\b/.test(normalized);
  const statusSignal = /\b(status|state|progress|wip)\b/.test(normalized);
  const statusShaped = statusSignal && (
    /^(status|state|progress|wip)\b/.test(normalized)
    || /\b(any|current|latest|check|show|give|send|tell|whats|what is|hows|how is)\b.{0,60}\b(status|state|progress|wip)\b/.test(normalized)
    || /\b(project|repo|repository|build|task|branch)\b.{0,40}\b(status|state|progress|wip)\b/.test(normalized)
    || /\b(status|state|progress|wip)\b.{0,40}\b(project|repo|repository|build|task|branch|on|for|of)\b/.test(normalized)
  );
  if (!visualRequest && !statusShaped) {
    return { isStatus: false, question: undefined, wantsImage: false };
  }
  return {
    isStatus: true,
    question: statusDetailQuestion(text),
    wantsImage: visualRequest || wantsStatusImage(text)
  };
}

export function statusDetailQuestion(text: string): string | undefined {
  const normalized = text.toLowerCase().replace(/[?!.]/g, "").replace(/\s+/g, " ").trim();
  return DETAILED_STATUS_SIGNAL.test(normalized) ? text.trim() : undefined;
}

function wantsStatusImage(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    /\b(snip|screenshot|screen shot|image|picture|pic)\b/.test(normalized) ||
    /\b(send|attach|include|show)\b.*\b(output|snip|screenshot|image|picture|pic)\b/.test(normalized)
  );
}

function defaultProject(projects: ProjectEntry[]): ProjectEntry {
  const selected = projects.find((project) => project.isDefault);
  if (selected) {
    return selected;
  }
  if (projects.length === 1 && projects[0]) {
    return projects[0];
  }

  if (projects.length === 0) {
    throw new Error("No projects are configured. Ask the owner to run `/setup repo`.");
  }
  throw new Error("Multiple projects are configured. Add `project:<name>` or ask the owner to select a default with `/setup repo`.");
}

function parseMentionMode(value: string): CodexRequestMode {
  return value.toLowerCase() === "act" || value.toLowerCase() === "action" ? "action" : "answer";
}
