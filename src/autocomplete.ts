import { configuredCommandNames } from "./command-runner.js";
import type { MemoryEntry } from "./memory-store.js";
import type { PeerRecord } from "./peer.js";
import type { TaskRecord } from "./task-store.js";
import type { ProjectEntry } from "./types.js";

export interface AutocompleteChoice {
  name: string;
  value: string;
}

export function projectChoices(projects: ProjectEntry[], focused: string, preferredName?: string): AutocompleteChoice[] {
  const query = normalize(focused);
  return projects
    .filter((project) => projectSearchText(project).includes(query))
    .sort((left, right) => projectChoiceRank(left, preferredName) - projectChoiceRank(right, preferredName))
    .slice(0, 25)
    .map((project) => {
      const current = project.name === preferredName;
      const suffix = current && project.isDefault ? " (current, default)" : current ? " (current)" : project.isDefault ? " (default)" : "";
      return { name: `${project.name}${suffix}`, value: project.name };
    });
}

function projectSearchText(project: ProjectEntry): string {
  return [project.name, project.metadata.canonicalName, ...project.metadata.aliases]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
}

function projectChoiceRank(project: ProjectEntry, preferredName: string | undefined): number {
  if (project.name === preferredName) return 0;
  if (project.isDefault) return 1;
  return 2;
}

export function commandChoices(project: ProjectEntry | undefined, focused: string): AutocompleteChoice[] {
  if (!project) {
    return [];
  }

  const query = normalize(lastCsvPart(focused));
  const prefix = csvPrefix(focused);
  return configuredCommandNames(project)
    .filter((command) => command.includes(query))
    .slice(0, 25)
    .map((command) => ({ name: command, value: `${prefix}${command}` }));
}

export function taskChoices(tasks: TaskRecord[], focused: string): AutocompleteChoice[] {
  const query = normalize(focused);
  return tasks
    .filter((task) => searchableTaskText(task).includes(query))
    .slice(0, 25)
    .map((task) => ({
      name: truncateChoiceLabel(`${taskStatusLabel(task.status)} | ${task.projectName} | ${task.text || task.id}`, MAX_CHOICE_NAME_LENGTH),
      value: task.id
    }));
}

export function peerChoices(peers: PeerRecord[], focused: string): AutocompleteChoice[] {
  const query = normalize(focused);
  return peers
    .filter((peer) => `${peer.botId} ${peer.botName} ${peer.owner}`.toLowerCase().includes(query))
    .slice(0, 25)
    .map((peer) => ({
      name: `${peer.botName} (${peer.owner})`,
      value: peer.botId
    }));
}

export function memoryChoices(entries: MemoryEntry[], focused: string): AutocompleteChoice[] {
  const query = normalize(focused);
  return entries
    .filter((entry) => searchableMemoryText(entry).includes(query))
    .slice(0, 25)
    .map((entry) => ({
      name: truncateChoiceLabel(`${entry.id} | ${entry.kind} ${entry.text}`, MAX_CHOICE_NAME_LENGTH),
      value: entry.id
    }));
}

function searchableTaskText(task: TaskRecord): string {
  return `${task.id} ${task.status} ${task.mode} ${task.projectName} ${task.source} ${task.text}`.toLowerCase();
}

function taskStatusLabel(status: TaskRecord["status"]): string {
  if (status === "awaiting-approval") return "Approval needed";
  if (status === "succeeded") return "Done";
  if (status === "failed") return "Needs attention";
  if (status === "canceled") return "Canceled";
  if (status === "interrupted") return "Interrupted";
  return "Working";
}

function searchableMemoryText(entry: MemoryEntry): string {
  return `${entry.id} ${entry.kind} ${entry.source} ${entry.text} ${entry.tags.join(" ")}`.toLowerCase();
}

/** Discord rejects autocomplete choice names longer than 100 characters. */
const MAX_CHOICE_NAME_LENGTH = 100;

function truncateChoiceLabel(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function lastCsvPart(value: string): string {
  return value.split(",").at(-1) ?? value;
}

function csvPrefix(value: string): string {
  const index = value.lastIndexOf(",");
  return index >= 0 ? `${value.slice(0, index + 1).trim()} ` : "";
}
