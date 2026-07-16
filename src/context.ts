import { constants } from "node:fs";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { scoreTextMatches, tokenizeQuery } from "./relevance.js";
import { redactSensitiveText } from "./security.js";
import type { IndexedFile, PackedProjectContext, ProjectEntry, ScannerConfig } from "./types.js";

const PRIVATE_RUNTIME_PATH_PARTS = new Set([
  ".codex",
  ".devbot"
]);

const IGNORED_PATH_PARTS = new Set([
  ".cache",
  ".git",
  ".hg",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".pnpm-store",
  ".svelte-kit",
  ".turbo",
  ".venv",
  ".yarn",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "tmp",
  "vendor"
]);

const PROTECTED_FILENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".envrc",
  ".git-credentials",
  ".gitconfig",
  ".gitcookies",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".yarnrc",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock"
]);

const PROJECT_CONTEXT_HEADER = serializeJsonLine({
  kind: "devbot.project-context",
  version: 1,
  encoding: "jsonl"
});

const TEXT_EXTENSIONS = new Set([
  "",
  ".c",
  ".cc",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".go",
  ".graphql",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".less",
  ".lua",
  ".md",
  ".mjs",
  ".php",
  ".properties",
  ".py",
  ".rb",
  ".rs",
  ".sass",
  ".scala",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml"
]);

export class ProjectContextService {
  private readonly cache = new Map<string, { files: IndexedFile[]; indexedAtMs: number }>();

  constructor(
    private readonly scanner: ScannerConfig,
    private readonly now: () => number = Date.now
  ) {}

  async refresh(project: ProjectEntry): Promise<number> {
    const files = await this.indexProject(project);
    this.cache.set(cacheKey(project), { files, indexedAtMs: this.now() });
    return files.length;
  }

  invalidate(projectName: string): void {
    const prefix = `${projectName}\0`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  async pack(
    project: ProjectEntry,
    question: string,
    includePatterns: string[] = [],
    maxPackedContextChars = this.scanner.maxPackedContextChars
  ): Promise<PackedProjectContext> {
    const indexed = await this.getFreshIndex(project);
    const filtered = includePatterns.length > 0 ? indexed.filter((file) => matchesAny(file.relativePath, includePatterns)) : indexed;
    const ranked = rankFiles(filtered, question).slice(0, this.scanner.maxRankedFiles);
    const files: IndexedFile[] = [];
    const records: string[] = [];
    let totalChars = PROJECT_CONTEXT_HEADER.length;

    for (const file of ranked) {
      const snippet = file.text.slice(0, this.scanner.maxSnippetCharsPerFile);
      const record = serializeJsonLine({
        kind: "file",
        path: file.relativePath.replaceAll("\\", "/"),
        sizeBytes: file.sizeBytes,
        truncated: snippet.length < file.text.length,
        content: snippet
      });
      const recordChars = 1 + record.length;
      if (totalChars + recordChars > maxPackedContextChars) {
        break;
      }

      files.push({ ...file, text: snippet });
      records.push(record);
      totalChars += recordChars;
    }

    return {
      project,
      files,
      packedText: records.length > 0 ? [PROJECT_CONTEXT_HEADER, ...records].join("\n") : ""
    };
  }

  private async getFreshIndex(project: ProjectEntry): Promise<IndexedFile[]> {
    const key = cacheKey(project);
    const cached = this.cache.get(key);
    const ageMs = cached ? this.now() - cached.indexedAtMs : Number.POSITIVE_INFINITY;
    if (cached && ageMs >= 0 && ageMs < this.scanner.cacheTtlMs) {
      return cached.files;
    }

    const files = await this.indexProject(project);
    this.cache.set(key, { files, indexedAtMs: this.now() });
    return files;
  }

  private async indexProject(project: ProjectEntry): Promise<IndexedFile[]> {
    const files: IndexedFile[] = [];
    const canonicalRoot = await realpath(project.root).catch(() => path.resolve(project.root));
    await walk(project.root, project.root, canonicalRoot, this.scanner, files, { totalBytes: 0 });
    return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }
}

async function walk(
  root: string,
  current: string,
  canonicalRoot: string,
  scanner: ScannerConfig,
  output: IndexedFile[],
  budget: { totalBytes: number }
): Promise<void> {
  if (indexIsFull(scanner, output, budget)) {
    return;
  }

  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((left, right) => {
    return traversalPriority(left.name) - traversalPriority(right.name) || left.name.localeCompare(right.name);
  });
  for (const entry of entries) {
    if (indexIsFull(scanner, output, budget)) {
      return;
    }

    const absolutePath = path.join(current, entry.name);
    const relativePath = toRelative(root, absolutePath);

    if (shouldIgnore(relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      await walk(root, absolutePath, canonicalRoot, scanner, output, budget);
      continue;
    }

    if (!entry.isFile() || !isLikelyTextFile(entry.name)) {
      continue;
    }

    try {
      const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
      const handle = await open(absolutePath, constants.O_RDONLY | noFollow);
      try {
        const stats = await handle.stat();
        const remainingBytes = scanner.maxIndexedTotalBytes - budget.totalBytes;
        const maxReadableBytes = Math.min(scanner.maxIndexedFileBytes, remainingBytes);
        if (!stats.isFile() || stats.size > maxReadableBytes) continue;
        const [resolvedPath, currentStats] = await Promise.all([realpath(absolutePath), lstat(absolutePath)]);
        if (
          !isWithinRoot(resolvedPath, canonicalRoot)
          || !currentStats.isFile()
          || currentStats.dev !== stats.dev
          || currentStats.ino !== stats.ino
        ) {
          continue;
        }
        const contents = await readFileBounded(handle, maxReadableBytes);
        if (!contents) continue;
        const text = redactSecrets(contents.toString("utf8"));
        if (looksBinary(text)) continue;
        output.push({
          relativePath,
          absolutePath,
          sizeBytes: contents.byteLength,
          text
        });
        budget.totalBytes += contents.byteLength;
      } finally {
        await handle.close();
      }
    } catch {
      continue;
    }
  }
}

function indexIsFull(scanner: ScannerConfig, output: IndexedFile[], budget: { totalBytes: number }): boolean {
  return output.length >= scanner.maxIndexedFiles || budget.totalBytes >= scanner.maxIndexedTotalBytes;
}

function traversalPriority(name: string): number {
  const normalized = name.toLowerCase();
  if (normalized === "readme.md") return 0;
  if (normalized === "package.json") return 1;
  if (normalized === "src" || normalized === "app") return 2;
  if (normalized === "lib") return 3;
  if (normalized === "test" || normalized === "tests") return 4;
  if (normalized === "docs") return 5;
  return 10;
}

async function readFileBounded(handle: FileHandle, maxBytes: number): Promise<Buffer | undefined> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }

  return offset > maxBytes ? undefined : buffer.subarray(0, offset);
}

function shouldIgnore(relativePath: string): boolean {
  if (isProtectedProjectContextPath(relativePath)) {
    return true;
  }

  const parts = normalizePathParts(relativePath);
  return parts.some((part) => IGNORED_PATH_PARTS.has(part));
}

export function isProtectedProjectContextPath(relativePath: string): boolean {
  const parts = normalizePathParts(relativePath);
  if (parts.some((part) => PRIVATE_RUNTIME_PATH_PARTS.has(part))) {
    return true;
  }

  const filename = parts.at(-1) ?? "";
  return PROTECTED_FILENAMES.has(filename) || filename === ".env" || filename.startsWith(".env.");
}

function normalizePathParts(relativePath: string): string[] {
  return relativePath
    .replaceAll("\\", "/")
    .split("/")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function isLikelyTextFile(filename: string): boolean {
  const normalized = filename.toLowerCase();
  if (/\.(?:key|kdbx|p12|pem|pfx)$/.test(normalized)) {
    return false;
  }

  return TEXT_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

function looksBinary(text: string): boolean {
  return text.includes("\u0000");
}

function redactSecrets(text: string): string {
  return redactSensitiveText(text);
}

function cacheKey(project: ProjectEntry): string {
  return `${project.name}\0${path.resolve(project.root)}`;
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function rankFiles(files: IndexedFile[], question: string): IndexedFile[] {
  const terms = tokenizeQuery(question);
  return [...files]
    .map((file) => ({ file, score: scoreFile(file, terms) }))
    .sort((a, b) => b.score - a.score || a.file.relativePath.localeCompare(b.file.relativePath))
    .map(({ file }) => file);
}

function scoreFile(file: IndexedFile, terms: string[]): number {
  const lowerPath = file.relativePath.toLowerCase();
  const lowerText = file.text.toLowerCase();
  let score = priorityPathScore(lowerPath);

  for (const term of terms) {
    if (lowerPath.includes(term)) {
      score += 12;
    }
  }

  return score + scoreTextMatches(lowerText, terms);
}

function priorityPathScore(relativePath: string): number {
  if (relativePath === "readme.md") {
    return 20;
  }

  if (relativePath === "package.json" || relativePath.endsWith("/package.json")) {
    return 16;
  }

  if (relativePath.includes("src/")) {
    return 8;
  }

  if (relativePath.includes("test") || relativePath.includes("spec")) {
    return 4;
  }

  return 0;
}

function matchesAny(relativePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => wildcardMatch(relativePath, pattern));
}

function wildcardMatch(value: string, pattern: string): boolean {
  const escaped = pattern
    .trim()
    .replaceAll("\\", "/")
    .split("*")
    .map(escapeRegex)
    .join(".*");
  const normalizedValue = value.replaceAll("\\", "/");
  return new RegExp(`^${escaped}$`, "i").test(normalizedValue) || normalizedValue.toLowerCase().includes(pattern.toLowerCase());
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function toRelative(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath) || ".";
}

function serializeJsonLine(value: Record<string, unknown>): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

export function parseIncludePatterns(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
