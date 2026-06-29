import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CodexConfig, PackedProjectContext } from "./types.js";

export type CodexRequestMode = "answer" | "action";

export interface AnswerOptions {
  codex: CodexConfig;
  question: string;
  context: PackedProjectContext;
  mode?: CodexRequestMode;
  signal?: AbortSignal;
}

export async function answerWithProjectContext(options: AnswerOptions): Promise<string> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "devbot-codex-"));
  const outputFile = path.join(tempDir, "answer.txt");

  try {
    const mode = options.mode ?? "answer";
    const prompt = buildPrompt(options.context, options.question, mode);
    const args = [
      "exec",
      "--ephemeral",
      "--sandbox",
      mode === "action" ? options.codex.actionSandbox : options.codex.sandbox,
      "--cd",
      options.context.project.root,
      "--output-last-message",
      outputFile,
      prompt
    ];

    if (options.codex.model) {
      args.splice(1, 0, "--model", options.codex.model);
    }

    await runCodex(options.codex.bin, args, options.codex.timeoutMs, options.signal);
    const answer = (await readFile(outputFile, "utf8")).trim();
    return answer || "Codex did not produce a final text answer.";
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

function buildPrompt(context: PackedProjectContext, question: string, mode: CodexRequestMode): string {
  if (mode === "action") {
    return [
      "You are handling a Discord request for a local developer through a bot.",
      "Use the selected project directory as your working directory and primary source of truth.",
      "You may inspect files and make focused project edits when needed by the request.",
      "Do not make destructive changes, delete unrelated files, modify secrets, or change files outside the selected project.",
      "Prefer the project's existing patterns. Keep changes tight and verify with targeted commands when practical.",
      "Respond with this fixed structure:",
      "Project: <project name>",
      "Request: <one sentence>",
      "Actions: <files changed or commands run>",
      "Verification: <commands run, or why not run>",
      "Result: <concise outcome and any next step>",
      "",
      `Project: ${context.project.name}`,
      `Project root: ${context.project.root}`,
      `Preselected context files: ${context.files.map((file) => file.relativePath).join(", ") || "none"}`,
      "",
      "Preselected local context snippets:",
      context.packedText || "No local project files matched the request.",
      "",
      "Developer request:",
      question
    ].join("\n");
  }

  return [
    "You are answering a Discord slash-command request for a local developer.",
    "Use the selected project directory as your primary source of truth.",
    "You may inspect local project files, but this run is read-only: do not edit files, install packages, start servers, or run destructive commands.",
    "Be direct and practical. Cite file paths when making codebase-specific claims.",
    "If the supplied snippets and readable project files are insufficient, say what is missing.",
    "",
    `Project: ${context.project.name}`,
    `Project root: ${context.project.root}`,
    `Preselected context files: ${context.files.map((file) => file.relativePath).join(", ") || "none"}`,
    "",
    "Preselected local context snippets:",
    context.packedText || "No local project files matched the request.",
    "",
    "Question:",
    question
  ].join("\n");
}

function runCodex(bin: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      terminateChild(child.pid);
      finish(new Error(`Codex timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    const abort = (): void => {
      terminateChild(child.pid);
      finish(new Error("Codex run was canceled."));
    };

    if (signal?.aborted) {
      abort();
      return;
    }

    signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", finish);
    child.on("close", (code) => {
      if (code === 0) {
        finish();
        return;
      }

      finish(new Error(`Codex exited with code ${code}.\n${trimProcessOutput(stderr || stdout)}`));
    });

    function finish(error?: Error): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) {
        reject(error);
        return;
      }

      resolve();
    }
  });
}

function terminateChild(pid: number | undefined): void {
  if (!pid) {
    return;
  }

  try {
    if (process.platform === "win32") {
      process.kill(pid, "SIGTERM");
      return;
    }

    process.kill(-pid, "SIGTERM");
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Process already exited.
      }
    }, 2_000).unref();
  } catch {
    // Process already exited.
  }
}

function trimProcessOutput(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) {
    return "No process output was captured.";
  }

  return trimmed.slice(-1_500);
}
