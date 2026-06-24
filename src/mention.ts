import { parseIncludePatterns } from "./context.js";
import type { CodexRequestMode } from "./codex-client.js";
import type { ProjectEntry } from "./types.js";

export interface ParsedMentionRequest {
  project: ProjectEntry;
  text: string;
  includePatterns: string[];
  mode: CodexRequestMode;
}

export interface ParsedStatusRequest {
  isStatus: boolean;
  question: string | undefined;
  wantsImage: boolean;
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
  const project = projectMatch ? mustFindProject(projects, projectMatch[1] ?? "") : defaultProject(projects);
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

  const mode = modeMatch ? parseMentionMode(modeMatch[1] ?? "") : inferMentionMode(text);
  return { project, text, includePatterns, mode };
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
  const question = isSimpleStatusRequest(normalized) ? undefined : text.trim();
  return { isStatus: true, question, wantsImage };
}

function isSimpleStatusRequest(normalized: string): boolean {
  return (
    normalized === "status" ||
    normalized === "wip" ||
    normalized === "what are you working on" ||
    normalized === "what is currently in progress" ||
    normalized === "whats currently in progress" ||
    normalized === "what's currently in progress" ||
    normalized === "current dev work"
  );
}

function wantsStatusImage(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    /\b(snip|screenshot|screen shot|image|picture|pic)\b/.test(normalized) ||
    /\b(send|attach|include|show)\b.*\b(output|snip|screenshot|image|picture|pic)\b/.test(normalized)
  );
}

function mustFindProject(projects: ProjectEntry[], name: string): ProjectEntry {
  const normalized = name.trim().toLowerCase();
  const project = projects.find((entry) => entry.name === normalized);
  if (!project) {
    throw new Error(`Unknown project: ${name}`);
  }

  return project;
}

function defaultProject(projects: ProjectEntry[]): ProjectEntry {
  if (projects.length === 1 && projects[0]) {
    return projects[0];
  }

  throw new Error("Multiple projects are configured. Add `project:<name>` to the message.");
}

function parseMentionMode(value: string): CodexRequestMode {
  return value.toLowerCase() === "act" || value.toLowerCase() === "action" ? "action" : "answer";
}

function inferMentionMode(text: string): CodexRequestMode {
  const normalized = text.trim().toLowerCase();
  if (/^(what|whats|what's|why|how|where|when|who|which|summarize|explain|describe|show|tell me|status|state)\b/.test(normalized)) {
    return "answer";
  }

  if (/\b(current state|state of|status of|summary of|overview of)\b/.test(normalized)) {
    return "answer";
  }

  if (/^(fix|add|update|change|create|delete|remove|rename|refactor|implement|run|test|build|install|commit|push)\b/.test(normalized)) {
    return "action";
  }

  return "answer";
}
