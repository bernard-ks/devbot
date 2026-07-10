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
  downloadBoundedAttachment,
  ffmpegArgs,
  findBinaryInDirs,
  isAllowedAttachmentUrl,
  isSupportedAudioAttachment,
  listModelCandidates,
  looksLikeAudioBuffer,
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

test("audioGateMessage enforces the byte cap even when a short duration is reported", () => {
  const message = audioGateMessage({ durationSeconds: 5, sizeBytes: MAX_FALLBACK_AUDIO_BYTES + 1 });
  assert.match(message ?? "", /too large/);
});

test("isAllowedAttachmentUrl only trusts Discord's own media hosts over https", () => {
  assert.equal(isAllowedAttachmentUrl("https://cdn.discordapp.com/attachments/1/2/voice.ogg"), true);
  assert.equal(isAllowedAttachmentUrl("https://media.discordapp.net/attachments/1/2/voice.ogg"), true);
  assert.equal(isAllowedAttachmentUrl("http://cdn.discordapp.com/attachments/1/2/voice.ogg"), false);
  assert.equal(isAllowedAttachmentUrl("https://evil.example.com/voice.ogg"), false);
  assert.equal(isAllowedAttachmentUrl("https://cdn.discordapp.com.evil.example.com/voice.ogg"), false);
  assert.equal(isAllowedAttachmentUrl("https://user:pass@cdn.discordapp.com/voice.ogg"), false);
  assert.equal(isAllowedAttachmentUrl("not a url"), false);
});

test("looksLikeAudioBuffer recognizes common audio containers and rejects arbitrary bytes", () => {
  assert.equal(looksLikeAudioBuffer(Buffer.from("OggS0000000000000")), true);
  assert.equal(looksLikeAudioBuffer(Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WAVEfmt ")])), true);
  assert.equal(looksLikeAudioBuffer(Buffer.from([0x49, 0x44, 0x33, 0, 0, 0, 0, 0, 0, 0, 0, 0])), true);
  assert.equal(looksLikeAudioBuffer(Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from("ftypM4A "), Buffer.from([0, 0, 0, 0])])), true);
  assert.equal(looksLikeAudioBuffer(Buffer.from("<html><body>not audio</body></html>")), false);
  assert.equal(looksLikeAudioBuffer(Buffer.from([1, 2, 3])), false);
});

function fakeResponse(init: {
  status?: number;
  headers?: Record<string, string>;
  body?: Uint8Array[];
}): Response {
  const headers = new Headers(init.headers ?? {});
  const chunks = init.body ?? [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  });
  return new Response(chunks.length > 0 ? stream : null, { status: init.status ?? 200, headers });
}

test("downloadBoundedAttachment refuses hosts outside the Discord media allowlist", async () => {
  await assert.rejects(
    downloadBoundedAttachment("https://evil.example.com/voice.ogg", { fetchImpl: async () => fakeResponse({}) }),
    /allowed Discord media host/
  );
});

test("downloadBoundedAttachment follows an allowlisted redirect but rejects one that leaves the allowlist", async () => {
  const redirectedOut = downloadBoundedAttachment("https://cdn.discordapp.com/attachments/1/2/voice.ogg", {
    fetchImpl: async () => fakeResponse({ status: 302, headers: { location: "https://evil.example.com/voice.ogg" } })
  });
  await assert.rejects(redirectedOut, /allowed Discord media host/);

  let calls = 0;
  const buffer = await downloadBoundedAttachment("https://cdn.discordapp.com/attachments/1/2/voice.ogg", {
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return fakeResponse({ status: 302, headers: { location: "https://media.discordapp.net/attachments/1/2/voice.ogg" } });
      }
      return fakeResponse({ body: [Buffer.from("OggS")] });
    }
  });
  assert.equal(buffer.toString("latin1"), "OggS");
});

test("downloadBoundedAttachment caps redirects", async () => {
  await assert.rejects(
    downloadBoundedAttachment("https://cdn.discordapp.com/a", {
      maxRedirects: 1,
      fetchImpl: async () => fakeResponse({ status: 302, headers: { location: "https://cdn.discordapp.com/b" } })
    }),
    /redirected too many times/
  );
});

test("downloadBoundedAttachment rejects an oversized declared content-length before streaming", async () => {
  await assert.rejects(
    downloadBoundedAttachment("https://cdn.discordapp.com/a", {
      maxBytes: 10,
      fetchImpl: async () => fakeResponse({ headers: { "content-length": "1000" }, body: [Buffer.from("x".repeat(20))] })
    }),
    /exceeds the/
  );
});

test("downloadBoundedAttachment enforces the byte cap while streaming even without a content-length header", async () => {
  await assert.rejects(
    downloadBoundedAttachment("https://cdn.discordapp.com/a", {
      maxBytes: 8,
      fetchImpl: async () => fakeResponse({ body: [Buffer.from("x".repeat(4)), Buffer.from("x".repeat(10))] })
    }),
    /exceeds the/
  );
});

test("downloadBoundedAttachment returns the buffer when within the cap", async () => {
  const buffer = await downloadBoundedAttachment("https://cdn.discordapp.com/a", {
    maxBytes: 100,
    fetchImpl: async () => fakeResponse({ body: [Buffer.from("hello "), Buffer.from("world")] })
  });
  assert.equal(buffer.toString("utf8"), "hello world");
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
