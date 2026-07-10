import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { minimalChildEnvironment } from "./security.js";

const execFileAsync = promisify(execFile);

export const MAX_VOICE_SECONDS = 300;
// Applies to every attachment (not just ones with no reported duration) and doubles as the
// streaming download cap in downloadBoundedAttachment.
export const MAX_FALLBACK_AUDIO_BYTES = 20 * 1024 * 1024;
export const FFMPEG_TIMEOUT_MS = 60_000;
export const WHISPER_TIMEOUT_MS = 120_000;
export const ATTACHMENT_FETCH_TIMEOUT_MS = 30_000;
export const MAX_ATTACHMENT_REDIRECTS = 3;
export const MAX_CONCURRENT_TRANSCRIPTIONS = 2;
let activeTranscriptions = 0;

export const WHISPER_BINARY_NAMES = ["whisper-cli", "whisper-cpp", "main"];

const MODEL_FILE_PATTERN = /^ggml-.*\.bin$/i;

export const ALLOWED_ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

const AUDIO_MAGIC_CHECKS: ReadonlyArray<(head: Buffer) => boolean> = [
  (head) => head.subarray(0, 4).toString("latin1") === "OggS",
  (head) => head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WAVE",
  (head) => (head[0] ?? 0) === 0x49 && (head[1] ?? 0) === 0x44 && (head[2] ?? 0) === 0x33,
  (head) => (head[0] ?? 0) === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0,
  (head) => head.subarray(4, 8).toString("latin1") === "ftyp",
  (head) => (head[0] ?? 0) === 0x1a && (head[1] ?? 0) === 0x45 && (head[2] ?? 0) === 0xdf && (head[3] ?? 0) === 0xa3
];

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
  // Enforced regardless of whether a duration was reported: a reported duration under the
  // cap does not guarantee the underlying attachment is actually that short.
  if (input.sizeBytes > MAX_FALLBACK_AUDIO_BYTES) {
    return `That audio file is too large to transcribe locally (${Math.round(MAX_FALLBACK_AUDIO_BYTES / (1024 * 1024))}MB limit). Send a shorter clip.`;
  }
  return undefined;
}

export function isAllowedAttachmentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      ALLOWED_ATTACHMENT_HOSTS.has(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

export function looksLikeAudioBuffer(buffer: Buffer): boolean {
  if (buffer.length < 12) {
    return false;
  }
  const head = buffer.subarray(0, 12);
  return AUDIO_MAGIC_CHECKS.some((check) => check(head));
}

export interface DownloadBoundedAttachmentOptions {
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Downloads a Discord attachment while enforcing an origin allowlist on every hop (including
 * redirects), a byte cap enforced while streaming (not just via the `content-length` header),
 * and a bounded number of redirects.
 */
export async function downloadBoundedAttachment(url: string, options: DownloadBoundedAttachmentOptions = {}): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? MAX_FALLBACK_AUDIO_BYTES;
  const maxRedirects = options.maxRedirects ?? MAX_ATTACHMENT_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? ATTACHMENT_FETCH_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  let currentUrl = url;
  for (let redirects = 0; ; redirects++) {
    if (!isAllowedAttachmentUrl(currentUrl)) {
      throw new Error("The attachment URL is not from an allowed Discord media host.");
    }

    // A single abort deadline stays armed for the whole exchange with this hop: it bounds the
    // header fetch AND the body stream. Clearing it after headers arrived would leave the streamed
    // download without a deadline, so a stalled CDN body could hang forever and hold a slot.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(currentUrl, { redirect: "manual", signal: controller.signal });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new Error("The attachment redirected without a location header.");
        }
        if (redirects >= maxRedirects) {
          throw new Error("The attachment redirected too many times.");
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (!response.ok) {
        throw new Error(`Failed to download the audio attachment (HTTP ${response.status}).`);
      }

      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new Error(`Attachment exceeds the ${Math.round(maxBytes / (1024 * 1024))}MB limit.`);
      }

      if (!response.body) {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength > maxBytes) {
          throw new Error(`Attachment exceeds the ${Math.round(maxBytes / (1024 * 1024))}MB limit.`);
        }
        return buffer;
      }

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new Error(`Attachment exceeds the ${Math.round(maxBytes / (1024 * 1024))}MB limit.`);
          }
          chunks.push(value);
        }
      }
      return Buffer.concat(chunks);
    } finally {
      clearTimeout(timeout);
    }
  }
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

// Discord only delivers message content (including attachments) for guild messages when the
// privileged Message Content Intent is enabled. The documented exceptions are DMs, messages that
// @mention the bot, the bot's own messages, and context-menu targets. An ordinary native voice
// note in the project room is none of these, so without the intent it arrives with no attachment
// and the voice path silently sees nothing. Enabling it requires both the Developer Portal toggle
// and the local env flag below.
export function messageContentIntentSetupInstructions(): string {
  return [
    "Voice notes need Discord's Message Content Intent, which is privileged and off by default.",
    "Without it, an ordinary voice message in the project room reaches Devbot with no attachment, so there is nothing to transcribe.",
    "Enable it in both places, then restart Devbot:",
    "1. Discord Developer Portal: your application -> Bot -> Privileged Gateway Intents -> enable MESSAGE CONTENT INTENT.",
    "2. Set DEVBOT_MESSAGE_CONTENT_INTENT=true in Devbot's environment.",
    "Discord still delivers content without this intent only for DMs, messages that @mention the bot, the bot's own messages, and context-menu targets, none of which covers a native voice note in the room."
  ].join("\n");
}

export interface VoiceIntakeInput {
  isVoiceMessage: boolean;
  hasAudioAttachment: boolean;
  messageContentIntent: boolean;
}

// The ordered gate the voice handler applies to an incoming message. Extracted as a pure decision so
// the ordering the maintainer flagged is directly testable:
//  - "ignore-not-candidate": neither a native voice message nor an audio attachment; not ours.
//  - "refuse-intent": a voice-intake candidate arrived, but the Message Content Intent is off. This
//    is checked BEFORE the attachment, because without the intent Discord strips the attachment from
//    an ordinary room voice note (the IsVoiceMessage flag survives), so a native voice note reaches
//    us with no attachment. Returning the refusal here — rather than bailing on the empty attachment
//    first — is what makes the actionable message reachable for the exact case it exists for.
//  - "ignore-empty": the intent is on but no transcribable audio arrived; nothing to do.
//  - "transcribe": proceed to download/transcription.
export type VoiceIntakeDecision = "ignore-not-candidate" | "refuse-intent" | "ignore-empty" | "transcribe";

export function resolveVoiceIntake(input: VoiceIntakeInput): VoiceIntakeDecision {
  if (!input.isVoiceMessage && !input.hasAudioAttachment) {
    return "ignore-not-candidate";
  }
  if (!input.messageContentIntent) {
    return "refuse-intent";
  }
  if (!input.hasAudioAttachment) {
    return "ignore-empty";
  }
  return "transcribe";
}

export interface VoiceEnablementInput {
  enabled: boolean;
  messageContentIntent: boolean;
}

// Returns a setup message when voice is enabled but its gateway prerequisite is missing, otherwise
// undefined. Voice enablement is refused (with an actionable message) unless the Message Content
// Intent is also on.
export function voiceEnablementSetupResult(input: VoiceEnablementInput): string | undefined {
  if (input.enabled && !input.messageContentIntent) {
    return messageContentIntentSetupInstructions();
  }
  return undefined;
}

export interface VoiceDoctorInput extends VoiceEnablementInput {
  detection: VoicePipelineDetection;
}

export function formatVoiceDoctorSection(input: VoiceDoctorInput): string {
  if (!input.enabled) {
    return ["Voice notes", "DISABLED  Set DEVBOT_VOICE_ENABLED=true to allow voice-note transcription."].join("\n");
  }
  const detection = input.detection;
  const lines = [
    input.messageContentIntent
      ? "READY  Message Content Intent: DEVBOT_MESSAGE_CONTENT_INTENT=true"
      : "FIX  Message Content Intent - enable MESSAGE CONTENT INTENT in the Discord Developer Portal and set DEVBOT_MESSAGE_CONTENT_INTENT=true, or native voice notes arrive with no attachment.",
    detection.ffmpegBin ? `READY  ffmpeg: \`${detection.ffmpegBin}\`` : "FIX  ffmpeg - install ffmpeg and add it to PATH.",
    detection.whisperBin
      ? `READY  whisper.cpp: \`${detection.whisperBin}\``
      : "FIX  whisper.cpp - install whisper-cli/whisper-cpp/main or set DEVBOT_WHISPER_BIN.",
    detection.modelPath
      ? `READY  Model: \`${detection.modelPath}\``
      : "FIX  Model - add a ggml-*.bin model under ~/whisper-models or set DEVBOT_WHISPER_MODEL."
  ];
  return ["Voice notes", ...lines].join("\n");
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
  // Injectable seams so capacity-leak behavior (stalled download, temp-dir failure) can be
  // exercised deterministically; every one defaults to the real implementation.
  fetchImpl?: typeof fetch;
  downloadTimeoutMs?: number;
  mkdtempImpl?: (prefix: string) => Promise<string>;
}

/** Current number of held transcription slots. Exposed so leak tests can assert capacity recovers. */
export function activeTranscriptionCount(): number {
  return activeTranscriptions;
}

export async function transcribeAttachment(options: TranscribeAttachmentOptions): Promise<string> {
  if (activeTranscriptions >= MAX_CONCURRENT_TRANSCRIPTIONS) {
    throw new Error("Devbot is at its voice transcription limit. Try again after an active transcription finishes.");
  }
  // The slot is acquired here; everything after this point runs inside the try/finally so that any
  // failure (including the mkdtemp calls below) still releases the slot and cleans up temp dirs.
  activeTranscriptions += 1;
  const makeTempDir = options.mkdtempImpl ?? ((prefix: string) => mkdtemp(prefix));
  let tempDir: string | undefined;
  let runtimeHome: string | undefined;
  try {
    tempDir = await makeTempDir(path.join(tmpdir(), "devbot-voice-"));
    runtimeHome = await makeTempDir(path.join(tmpdir(), "devbot-voice-home-"));

    const inputPath = path.join(tempDir, `input${options.sourceExtension ?? ".ogg"}`);
    const audioBuffer = await downloadBoundedAttachment(options.url, {
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.downloadTimeoutMs !== undefined ? { timeoutMs: options.downloadTimeoutMs } : {})
    });
    if (!looksLikeAudioBuffer(audioBuffer)) {
      throw new Error("The downloaded attachment does not look like a supported audio file.");
    }
    await writeFile(inputPath, audioBuffer);

    const childEnvironment = minimalChildEnvironment();
    childEnvironment.HOME = runtimeHome;
    childEnvironment.USERPROFILE = runtimeHome;
    const wavPath = path.join(tempDir, "audio.wav");
    await execFileAsync(options.ffmpegBin, ffmpegArgs(inputPath, wavPath), {
      timeout: FFMPEG_TIMEOUT_MS,
      env: childEnvironment
    });

    const outputBase = path.join(tempDir, "transcript");
    await execFileAsync(options.whisperBin, whisperArgs(options.modelPath, wavPath, outputBase), {
      timeout: WHISPER_TIMEOUT_MS,
      env: childEnvironment
    });

    const transcript = await readFile(`${outputBase}.txt`, "utf8");
    return transcript.trim();
  } finally {
    activeTranscriptions -= 1;
    if (tempDir) {
      await rm(tempDir, { force: true, recursive: true });
    }
    if (runtimeHome) {
      await rm(runtimeHome, { force: true, recursive: true });
    }
  }
}
