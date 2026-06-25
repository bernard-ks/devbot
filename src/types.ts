export type ProjectMap = Record<string, string>;

export interface ProjectEntry {
  name: string;
  root: string;
  metadata: ProjectMetadata;
}

export interface AppConfig {
  discordToken: string;
  discordClientId: string;
  discordGuildId: string;
  codex: CodexConfig;
  allowedUserIds: Set<string>;
  allowedRoleIds: Set<string>;
  safeMode: boolean;
  botIdentity: BotIdentity;
  peerBotIds: Set<string>;
  coordinationChannelId: string | undefined;
  projects: ProjectEntry[];
  scanner: ScannerConfig;
}

export interface BotIdentity {
  owner: string;
  displayName: string;
}

export interface ProjectMetadata {
  canonicalName: string | undefined;
  repoUrl: string | undefined;
  defaultBranch: string | undefined;
  frontendUrl: string | undefined;
  backendUrl: string | undefined;
  ownerBot: string | undefined;
  aliases: string[];
  commands: ProjectCommands;
}

export interface ProjectCommands {
  test: string[];
  build: string[];
  lint: string[];
  verify: string[];
  presets: Record<string, string>;
}

export interface CodexConfig {
  bin: string;
  model: string | undefined;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  actionSandbox: "read-only" | "workspace-write" | "danger-full-access";
  timeoutMs: number;
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
