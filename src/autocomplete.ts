import { configuredCommandNames } from "./command-runner.js";
import type { MemoryEntry } from "./memory-store.js";
import type { PeerRecord } from "./peer.js";
import type { TaskRecord } from "./task-store.js";
import type { ProjectEntry } from "./types.js";

export interface AutocompleteChoice {
  name: string;
  value: string;
}

export function projectChoices(projects: ProjectEntry[], focused: string): AutocompleteChoice[] {
  const query = normalize(focused);
  return projects
    .filter((project) => project.name.includes(query) || project.metadata.aliases.some((alias) => alias.includes(query)))
    .slice(0, 25)
    .map((project) => ({ name: `${project.name}${project.isDefault ? " (default)" : ""}`, value: project.name }));
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
      name: `${task.id} | ${task.status} ${task.mode} ${task.projectName}`,
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
      name: `${entry.id} | ${entry.kind} ${truncateChoiceLabel(entry.text)}`,
      value: entry.id
    }));
}

function searchableTaskText(task: TaskRecord): string {
  return `${task.id} ${task.status} ${task.mode} ${task.projectName} ${task.source}`.toLowerCase();
}

function searchableMemoryText(entry: MemoryEntry): string {
  return `${entry.id} ${entry.kind} ${entry.source} ${entry.text} ${entry.tags.join(" ")}`.toLowerCase();
}

function truncateChoiceLabel(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const maxLength = 60;
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}...`;
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
