import type { CodexRequestMode } from "./codex-client.js";

export interface ActiveWork {
  id: string;
  mode: CodexRequestMode;
  projectName: string;
  requester: string;
  text: string;
  startedAt: Date;
}

export interface StartWorkInput {
  mode: CodexRequestMode;
  projectName: string;
  requester: string;
  text: string;
}

export class WorkTracker {
  private nextId = 1;
  private readonly active = new Map<string, ActiveWork>();

  start(input: StartWorkInput): ActiveWork {
    const work: ActiveWork = {
      id: String(this.nextId++),
      ...input,
      startedAt: new Date()
    };
    this.active.set(work.id, work);
    return work;
  }

  finish(id: string): void {
    this.active.delete(id);
  }

  snapshot(): ActiveWork[] {
    return [...this.active.values()].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  }
}

export function formatWorkStatus(activeWork: ActiveWork[], now = new Date()): string {
  if (activeWork.length === 0) {
    return "No Codex dev work is currently in progress.";
  }

  const lines = activeWork.map((work) => {
    const elapsed = formatElapsed(now.getTime() - work.startedAt.getTime());
    return `- \`${work.projectName}\` ${work.mode} for ${work.requester}, running ${elapsed}: ${truncate(work.text, 120)}`;
  });

  return [`Codex dev work currently in progress: ${activeWork.length}`, ...lines].join("\n");
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes === 0) {
    return `${remainingSeconds}s`;
  }

  return `${minutes}m ${remainingSeconds}s`;
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}...`;
}
