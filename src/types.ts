export type ProjectMap = Record<string, string>;

export interface ProjectEntry {
  name: string;
  root: string;
}

export interface AppConfig {
  discordToken: string;
  discordClientId: string;
  discordGuildId: string;
  openaiApiKey: string;
  openaiModel: string;
  allowedUserIds: Set<string>;
  allowedRoleIds: Set<string>;
  projects: ProjectEntry[];
  scanner: ScannerConfig;
}

export interface ScannerConfig {
  maxIndexedFileBytes: number;
  maxSnippetCharsPerFile: number;
  maxPackedContextChars: number;
  maxRankedFiles: number;
}

export interface IndexedFile {
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  text: string;
}

export interface PackedProjectContext {
  project: ProjectEntry;
  files: IndexedFile[];
  packedText: string;
}
