import type { ProjectEntry } from "./types.js";

export function findProjectReference(projects: readonly ProjectEntry[], name: string): ProjectEntry | undefined {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return undefined;

  const exactMatches = projects.filter((project) => project.name === normalized);
  if (exactMatches.length > 1) {
    throw new Error(`Ambiguous project reference: ${name}`);
  }
  if (exactMatches[0]) return exactMatches[0];

  const metadataMatches = projects.filter((project) =>
    project.metadata.aliases.includes(normalized) ||
    project.metadata.canonicalName?.trim().toLowerCase() === normalized
  );
  if (metadataMatches.length > 1) {
    throw new Error(`Ambiguous project reference: ${name}`);
  }
  return metadataMatches[0];
}

export function requireProjectReference(projects: readonly ProjectEntry[], name: string): ProjectEntry {
  const project = findProjectReference(projects, name);
  if (!project) {
    throw new Error(`Unknown project: ${name}`);
  }
  return project;
}

export function roomProjectConflict(
  requestedProject: ProjectEntry | undefined,
  roomProject: ProjectEntry | undefined
): boolean {
  return Boolean(requestedProject && roomProject && requestedProject.name !== roomProject.name);
}
