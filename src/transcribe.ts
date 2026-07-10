import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MAX_VOICE_SECONDS = 300;
export const MAX_FALLBACK_AUDIO_BYTES = 20 * 1024 * 1024;
export const FFMPEG_TIMEOUT_MS = 60_000;
export const WHISPER_TIMEOUT_MS = 120_000;

export const WHISPER_BINARY_NAMES = ["whisper-cli", "whisper-cpp", "main"];

const MODEL_FILE_PATTERN = /^ggml-.*\.bin$/i;

export interface AudioAttachmentLike {
  name: string;
  contentType: string | null;
  duration: number | null;
  size: number;
}

export function isSupportedAudioAttachment(attachment: AudioAttachmentLike): boolean {
  const name = attachment.name.toLowerCase();
  return /\.(ogg|opus|mp3|m4a|wav|webm)$/.test(name) || Boolean(attachment.contentType?.toLowerCase().startsWith("audio/"));
}

export function selectVoiceAttachment<T extends AudioAttachmentLike>(
  isVoiceMessage: boolean,
  attachments: T[]
): T | undefined {
  if (isVoiceMessage) {
    return attachments[0];
  }
  return attachments.find((attachment) => isSupportedAudioAttachment(attachment));
}

export function audioGateMessage(input: { durationSeconds: number | null; sizeBytes: number }): string | undefined {
  if (typeof input.durationSeconds === "number" && input.durationSeconds > MAX_VOICE_SECONDS) {
    return `That clip is about ${Math.ceil(input.durationSeconds)}s long, over the ${MAX_VOICE_SECONDS / 60}-minute limit. Send a shorter voice note.`;
  }
  if (input.durationSeconds == null && input.sizeBytes > MAX_FALLBACK_AUDIO_BYTES) {
    return `That audio file is too large to transcribe locally (${Math.round(MAX_FALLBACK_AUDIO_BYTES / (1024 * 1024))}MB limit). Send a shorter clip.`;
  }
  return undefined;
}

export function ffmpegArgs(inputPath: string, wavPath: string): string[] {
  return ["-y", "-hide_banner", "-loglevel", "error", "-i", inputPath, "-ar", "16000", "-ac", "1", "-f", "wav", wavPath];
}

export function whisperArgs(modelPath: string, wavPath: string, outputBase: string): string[] {
  return ["-m", modelPath, "-f", wavPath, "-otxt", "-of", outputBase, "-nt", "-l", "auto"];
}

export function findBinaryInDirs(
  names: string[],
  dirs: string[],
  fileExists: (candidate: string) => boolean = existsSync
): string | undefined {
  for (const dir of dirs) {
    if (!dir) {
      continue;
    }
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fileExists(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export function resolveFfmpegBinary(dirs: string[], fileExists: (candidate: string) => boolean = existsSync): string | undefined {
  return findBinaryInDirs(["ffmpeg"], dirs, fileExists);
}

export function resolveWhisperBinary(
  envOverride: string | undefined,
  dirs: string[],
  fileExists: (candidate: string) => boolean = existsSync
): string | undefined {
  const preferred = envOverride?.trim();
  if (preferred && (!path.isAbsolute(preferred) || fileExists(preferred))) {
    return preferred;
  }
  return findBinaryInDirs(WHISPER_BINARY_NAMES, dirs, fileExists);
}

export interface ModelCandidate {
  path: string;
  size: number;
}

export function listModelCandidates(
  dirs: string[],
  listDir: (dir: string) => string[] = (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  sizeOf: (filePath: string) => number | undefined = (filePath) => {
    try {
      return statSync(filePath).size;
    } catch {
      return undefined;
    }
  }
): ModelCandidate[] {
  const candidates: ModelCandidate[] = [];
  for (const dir of dirs) {
    if (!dir) {
      continue;
    }
    for (const name of listDir(dir)) {
      if (!MODEL_FILE_PATTERN.test(name)) {
        continue;
      }
      const full = path.join(dir, name);
      const size = sizeOf(full);
      if (size !== undefined) {
        candidates.push({ path: full, size });
      }
    }
  }
  return candidates;
}

export function smallestModelCandidate(candidates: ModelCandidate[]): ModelCandidate | undefined {
  return candidates.reduce<ModelCandidate | undefined>(
    (smallest, candidate) => (!smallest || candidate.size < smallest.size ? candidate : smallest),
    undefined
  );
}

export function resolveWhisperModel(
  envOverride: string | undefined,
  dirs: string[],
  listDir?: (dir: string) => string[],
  sizeOf?: (filePath: string) => number | undefined
): string | undefined {
  const preferred = envOverride?.trim();
  if (preferred) {
    return preferred;
  }
  return smallestModelCandidate(listModelCandidates(dirs, listDir, sizeOf))?.path;
}

export function truncateTranscriptForReply(
  transcript: string,
  maxLength = 1500
): { preview: string; truncated: boolean } {
  const normalized = transcript.trim();
  if (normalized.length <= maxLength) {
    return { preview: normalized, truncated: false };
  }
  return { preview: `${normalized.slice(0, maxLength - 1).trimEnd()}...`, truncated: true };
}

export function quoteTranscript(transcript: string): string {
  return transcript
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

export function defaultPathDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.PATH ?? "").split(path.delimiter).filter(Boolean);
}

export function defaultBinaryDirs(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  return [
    ...defaultPathDirs(env),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, "whisper.cpp"),
    path.join(home, "whisper.cpp", "build", "bin"),
    path.join(home, "whisper-cpp"),
    path.join(home, "whisper-cpp", "build", "bin")
  ];
}

export function defaultModelDirs(home: string = homedir()): string[] {
  return [
    path.join(home, "whisper-models"),
    path.join(home, "whisper.cpp", "models"),
    path.join(home, "whisper-cpp", "models"),
    "/opt/homebrew/share/whisper-models",
    "/usr/local/share/whisper-models"
  ];
}

export interface VoicePipelineDetection {
  ffmpegBin?: string;
  whisperBin?: string;
  modelPath?: string;
}

export interface DetectVoicePipelineOptions {
  env?: NodeJS.ProcessEnv;
  binaryDirs?: string[];
  modelDirs?: string[];
}

export function detectVoicePipeline(options: DetectVoicePipelineOptions = {}): VoicePipelineDetection {
  const env = options.env ?? process.env;
  const binDirs = options.binaryDirs ?? defaultBinaryDirs(env);
  const modelDirs = options.modelDirs ?? defaultModelDirs();
  const ffmpegBin = resolveFfmpegBinary(binDirs);
  const whisperBin = resolveWhisperBinary(env.DEVBOT_WHISPER_BIN, binDirs);
  const modelPath = resolveWhisperModel(env.DEVBOT_WHISPER_MODEL, modelDirs);
  return {
    ...(ffmpegBin ? { ffmpegBin } : {}),
    ...(whisperBin ? { whisperBin } : {}),
    ...(modelPath ? { modelPath } : {})
  };
}

export function voiceSetupInstructions(detection: VoicePipelineDetection): string {
  const missing: string[] = [];
  if (!detection.ffmpegBin) {
    missing.push("- Install `ffmpeg` and make sure it is on PATH (macOS: `brew install ffmpeg`).");
  }
  if (!detection.whisperBin) {
    missing.push(
      "- Install whisper.cpp and make sure `whisper-cli`, `whisper-cpp`, or `main` is on PATH, or set `DEVBOT_WHISPER_BIN` to its full path."
    );
  }
  if (!detection.modelPath) {
    missing.push(
      "- Download a whisper.cpp `ggml-*.bin` model into `~/whisper-models` (or `~/whisper.cpp/models`), or set `DEVBOT_WHISPER_MODEL` to its full path."
    );
  }
  return ["Voice transcription is not fully configured yet:", ...missing].join("\n");
}

export interface TranscribeAttachmentOptions {
  url: string;
  ffmpegBin: string;
  whisperBin: string;
  modelPath: string;
  sourceExtension?: string;
}

export async function transcribeAttachment(options: TranscribeAttachmentOptions): Promise<string> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "devbot-voice-"));
  try {
    const inputPath = path.join(tempDir, `input${options.sourceExtension ?? ".ogg"}`);
    const response = await fetch(options.url);
    if (!response.ok) {
      throw new Error(`Failed to download the audio attachment (HTTP ${response.status}).`);
    }
    await writeFile(inputPath, Buffer.from(await response.arrayBuffer()));

    const wavPath = path.join(tempDir, "audio.wav");
    await execFileAsync(options.ffmpegBin, ffmpegArgs(inputPath, wavPath), { timeout: FFMPEG_TIMEOUT_MS });

    const outputBase = path.join(tempDir, "transcript");
    await execFileAsync(options.whisperBin, whisperArgs(options.modelPath, wavPath, outputBase), {
      timeout: WHISPER_TIMEOUT_MS
    });

    const transcript = await readFile(`${outputBase}.txt`, "utf8");
    return transcript.trim();
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}
