import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  audioGateMessage,
  defaultBinaryDirs,
  defaultModelDirs,
  defaultPathDirs,
  detectVoicePipeline,
  ffmpegArgs,
  findBinaryInDirs,
  isSupportedAudioAttachment,
  listModelCandidates,
  MAX_FALLBACK_AUDIO_BYTES,
  MAX_VOICE_SECONDS,
  quoteTranscript,
  resolveFfmpegBinary,
  resolveWhisperBinary,
  resolveWhisperModel,
  selectVoiceAttachment,
  smallestModelCandidate,
  truncateTranscriptForReply,
  voiceSetupInstructions,
  whisperArgs
} from "./transcribe.js";

test("isSupportedAudioAttachment matches known audio extensions and content types", () => {
  assert.equal(isSupportedAudioAttachment({ name: "voice-message.ogg", contentType: null, duration: 3, size: 100 }), true);
  assert.equal(isSupportedAudioAttachment({ name: "clip.mp3", contentType: null, duration: null, size: 100 }), true);
  assert.equal(isSupportedAudioAttachment({ name: "note.m4a", contentType: null, duration: null, size: 100 }), true);
  assert.equal(isSupportedAudioAttachment({ name: "blob", contentType: "audio/webm", duration: null, size: 100 }), true);
  assert.equal(isSupportedAudioAttachment({ name: "screenshot.png", contentType: "image/png", duration: null, size: 100 }), false);
});

test("selectVoiceAttachment prefers the sole attachment on a voice message and falls back to audio detection", () => {
  const voiceAttachment = { name: "voice-message.ogg", contentType: "audio/ogg", duration: 4, size: 500 };
  const other = { name: "notes.txt", contentType: "text/plain", duration: null, size: 10 };
  assert.equal(selectVoiceAttachment(true, [voiceAttachment, other]), voiceAttachment);

  const mp3 = { name: "memo.mp3", contentType: null, duration: null, size: 1000 };
  assert.equal(selectVoiceAttachment(false, [other, mp3]), mp3);
  assert.equal(selectVoiceAttachment(false, [other]), undefined);
});

test("audioGateMessage enforces the five minute duration cap and a size fallback when duration is unknown", () => {
  assert.equal(audioGateMessage({ durationSeconds: 60, sizeBytes: 1000 }), undefined);
  assert.match(audioGateMessage({ durationSeconds: MAX_VOICE_SECONDS + 1, sizeBytes: 1000 }) ?? "", /5-minute limit/);
  assert.equal(audioGateMessage({ durationSeconds: null, sizeBytes: MAX_FALLBACK_AUDIO_BYTES - 1 }), undefined);
  assert.match(audioGateMessage({ durationSeconds: null, sizeBytes: MAX_FALLBACK_AUDIO_BYTES + 1 }) ?? "", /too large/);
});

test("ffmpegArgs converts to 16kHz mono wav and whisperArgs targets the model and output base", () => {
  assert.deepEqual(ffmpegArgs("/tmp/in.ogg", "/tmp/out.wav"), [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    "/tmp/in.ogg",
    "-ar",
    "16000",
    "-ac",
    "1",
    "-f",
    "wav",
    "/tmp/out.wav"
  ]);
  assert.deepEqual(whisperArgs("/models/ggml-tiny.bin", "/tmp/out.wav", "/tmp/transcript"), [
    "-m",
    "/models/ggml-tiny.bin",
    "-f",
    "/tmp/out.wav",
    "-otxt",
    "-of",
    "/tmp/transcript",
    "-nt",
    "-l",
    "auto"
  ]);
});

test("findBinaryInDirs checks directories in order and returns the first match", () => {
  const existing = new Set(["/opt/bin/whisper-cli", "/usr/bin/main"]);
  const found = findBinaryInDirs(["whisper-cli", "whisper-cpp", "main"], ["/missing", "/usr/bin", "/opt/bin"], (candidate) =>
    existing.has(candidate)
  );
  assert.equal(found, "/usr/bin/main");
});

test("resolveFfmpegBinary and resolveWhisperBinary discover binaries with fake PATH directories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-voice-bin-"));
  const dirA = path.join(root, "a");
  const dirB = path.join(root, "b");
  await mkdir(dirA, { recursive: true });
  await mkdir(dirB, { recursive: true });
  await writeFile(path.join(dirB, "ffmpeg"), "#!/bin/sh\n");
  await writeFile(path.join(dirA, "whisper-cpp"), "#!/bin/sh\n");

  const dirs = [dirA, dirB];
  assert.equal(resolveFfmpegBinary(dirs), path.join(dirB, "ffmpeg"));
  assert.equal(resolveWhisperBinary(undefined, dirs), path.join(dirA, "whisper-cpp"));
});

test("resolveWhisperBinary trusts an env override and only falls back when an absolute override is missing", () => {
  const dirs = ["/some/dir"];
  const fileExists = (candidate: string) => candidate === "/some/dir/main";

  assert.equal(resolveWhisperBinary("whisper-cli", dirs, fileExists), "whisper-cli");
  assert.equal(resolveWhisperBinary("/custom/whisper-cli", dirs, fileExists), "/some/dir/main");
  assert.equal(resolveWhisperBinary("/exists/whisper-cli", dirs, (candidate) => candidate === "/exists/whisper-cli"), "/exists/whisper-cli");
});

test("listModelCandidates only picks ggml-*.bin files and smallestModelCandidate picks the smallest", () => {
  const listDir = (dir: string): string[] => {
    if (dir === "/models") {
      return ["ggml-base.bin", "ggml-tiny.bin", "readme.txt", "ggml-large.bin.tmp"];
    }
    return [];
  };
  const sizes: Record<string, number> = {
    "/models/ggml-base.bin": 500,
    "/models/ggml-tiny.bin": 100
  };
  const candidates = listModelCandidates(["/models"], listDir, (filePath) => sizes[filePath]);
  assert.deepEqual(
    candidates.map((candidate) => candidate.path).sort(),
    ["/models/ggml-base.bin", "/models/ggml-tiny.bin"]
  );
  assert.equal(smallestModelCandidate(candidates)?.path, "/models/ggml-tiny.bin");
  assert.equal(smallestModelCandidate([]), undefined);
});

test("resolveWhisperModel trusts an explicit env override before auto-discovery", () => {
  const listDir = () => ["ggml-tiny.bin"];
  const sizeOf = () => 100;
  assert.equal(resolveWhisperModel("/explicit/model.bin", ["/models"], listDir, sizeOf), "/explicit/model.bin");
  assert.equal(resolveWhisperModel(undefined, ["/models"], listDir, sizeOf), path.join("/models", "ggml-tiny.bin"));
  assert.equal(resolveWhisperModel(undefined, ["/empty"], () => [], sizeOf), undefined);
});

test("truncateTranscriptForReply keeps short transcripts intact and truncates long ones", () => {
  const short = truncateTranscriptForReply("hello there");
  assert.equal(short.truncated, false);
  assert.equal(short.preview, "hello there");

  const long = "a".repeat(2000);
  const result = truncateTranscriptForReply(long, 100);
  assert.equal(result.truncated, true);
  assert.ok(result.preview.length <= 100 + 3);
  assert.match(result.preview, /\.\.\.$/);
});

test("quoteTranscript quotes every line", () => {
  assert.equal(quoteTranscript("line one\nline two"), "> line one\n> line two");
});

test("defaultPathDirs splits PATH with the platform delimiter", () => {
  const dirs = defaultPathDirs({ PATH: ["/a", "/b", ""].join(path.delimiter) } as NodeJS.ProcessEnv);
  assert.deepEqual(dirs, ["/a", "/b"]);
});

test("defaultBinaryDirs and defaultModelDirs include PATH plus common local install locations", () => {
  const binDirs = defaultBinaryDirs({ PATH: `/x${path.delimiter}/y` } as NodeJS.ProcessEnv, "/home/tom");
  assert.deepEqual(binDirs.slice(0, 2), ["/x", "/y"]);
  assert.equal(binDirs.includes("/opt/homebrew/bin"), true);
  assert.equal(binDirs.includes(path.join("/home/tom", "whisper.cpp")), true);

  const modelDirs = defaultModelDirs("/home/tom");
  assert.equal(modelDirs.includes(path.join("/home/tom", "whisper-models")), true);
});

test("detectVoicePipeline reports nothing when no binary or model directories resolve", () => {
  const detection = detectVoicePipeline({ env: { PATH: "" } as NodeJS.ProcessEnv, binaryDirs: [], modelDirs: [] });
  assert.equal(detection.ffmpegBin, undefined);
  assert.equal(detection.whisperBin, undefined);
  assert.equal(detection.modelPath, undefined);
});

test("detectVoicePipeline honors DEVBOT_WHISPER_BIN and DEVBOT_WHISPER_MODEL overrides", () => {
  const detection = detectVoicePipeline({
    env: { PATH: "", DEVBOT_WHISPER_BIN: "whisper-cli", DEVBOT_WHISPER_MODEL: "/models/ggml-custom.bin" } as NodeJS.ProcessEnv,
    binaryDirs: [],
    modelDirs: []
  });
  assert.equal(detection.whisperBin, "whisper-cli");
  assert.equal(detection.modelPath, "/models/ggml-custom.bin");
});

test("voiceSetupInstructions lists exactly the missing pieces", () => {
  const allMissing = voiceSetupInstructions({});
  assert.match(allMissing, /ffmpeg/);
  assert.match(allMissing, /whisper-cli/);
  assert.match(allMissing, /ggml-\*\.bin/);

  const onlyModelMissing = voiceSetupInstructions({ ffmpegBin: "/bin/ffmpeg", whisperBin: "/bin/whisper-cli" });
  assert.doesNotMatch(onlyModelMissing, /ffmpeg`/);
  assert.match(onlyModelMissing, /ggml-\*\.bin/);
});
