import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { scoreTextMatches, tokenizeQuery } from "./relevance.js";
import { redactSensitiveText } from "./security.js";
import type { IndexedFile, PackedProjectContext, ProjectEntry, ScannerConfig } from "./types.js";

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

const IGNORED_FILENAMES = new Set([
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
  private readonly cache = new Map<string, IndexedFile[]>();

  constructor(private readonly scanner: ScannerConfig) {}

  async refresh(project: ProjectEntry): Promise<number> {
    const files = await this.indexProject(project);
    this.cache.set(cacheKey(project), files);
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
    const indexed = this.cache.get(cacheKey(project)) ?? (await this.indexAndCache(project));
    const filtered = includePatterns.length > 0 ? indexed.filter((file) => matchesAny(file.relativePath, includePatterns)) : indexed;
    const ranked = rankFiles(filtered, question).slice(0, this.scanner.maxRankedFiles);
    const files: IndexedFile[] = [];
    const chunks: string[] = [];
    let totalChars = 0;

    for (const file of ranked) {
      const snippet = file.text.slice(0, this.scanner.maxSnippetCharsPerFile);
      const chunk = `--- FILE: ${file.relativePath} (${file.sizeBytes} bytes) ---\n${snippet}\n`;
      if (totalChars + chunk.length > maxPackedContextChars) {
        break;
      }

      files.push({ ...file, text: snippet });
      chunks.push(chunk);
      totalChars += chunk.length;
    }

    return {
      project,
      files,
      packedText: chunks.join("\n")
    };
  }

  private async indexAndCache(project: ProjectEntry): Promise<IndexedFile[]> {
    const files = await this.indexProject(project);
    this.cache.set(cacheKey(project), files);
    return files;
  }

  private async indexProject(project: ProjectEntry): Promise<IndexedFile[]> {
    const files: IndexedFile[] = [];
    const canonicalRoot = await realpath(project.root).catch(() => path.resolve(project.root));
    await walk(project.root, project.root, canonicalRoot, this.scanner, files);
    return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }
}

async function walk(
  root: string,
  current: string,
  canonicalRoot: string,
  scanner: ScannerConfig,
  output: IndexedFile[]
): Promise<void> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    const relativePath = toRelative(root, absolutePath);

    if (shouldIgnore(relativePath, entry.name)) {
      continue;
    }

    if (entry.isDirectory()) {
      await walk(root, absolutePath, canonicalRoot, scanner, output);
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
        if (!stats.isFile() || stats.size > scanner.maxIndexedFileBytes) continue;
        const [resolvedPath, currentStats] = await Promise.all([realpath(absolutePath), lstat(absolutePath)]);
        if (
          !isWithinRoot(resolvedPath, canonicalRoot)
          || !currentStats.isFile()
          || currentStats.dev !== stats.dev
          || currentStats.ino !== stats.ino
        ) {
          continue;
        }
        const text = redactSecrets(await handle.readFile("utf8"));
        if (looksBinary(text)) continue;
        output.push({
          relativePath,
          absolutePath,
          sizeBytes: stats.size,
          text
        });
      } finally {
        await handle.close();
      }
    } catch {
      continue;
    }
  }
}

function shouldIgnore(relativePath: string, filename: string): boolean {
  if (IGNORED_FILENAMES.has(filename)) {
    return true;
  }

  const parts = relativePath.split(path.sep);
  return parts.some((part) => IGNORED_PATH_PARTS.has(part));
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

export function parseIncludePatterns(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
