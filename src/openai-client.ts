import OpenAI from "openai";
import type { PackedProjectContext } from "./types.js";

export interface AnswerOptions {
  apiKey: string;
  model: string;
  question: string;
  context: PackedProjectContext;
}

export async function answerWithProjectContext(options: AnswerOptions): Promise<string> {
  const client = new OpenAI({ apiKey: options.apiKey });
  const response = await client.responses.create({
    model: options.model,
    instructions: [
      "You are a senior software engineering assistant operating inside a Discord bot.",
      "Answer using the supplied local project context when it is relevant.",
      "Be direct and practical. Cite file paths when making codebase-specific claims.",
      "If the context is insufficient, say exactly what is missing instead of inventing details.",
      "Do not claim you changed files or ran commands; this bot is read-only."
    ].join(" "),
    input: [
      {
        role: "user",
        content: [
          `Project: ${options.context.project.name}`,
          `Project root: ${options.context.project.root}`,
          `Included files: ${options.context.files.map((file) => file.relativePath).join(", ") || "none"}`,
          "",
          "Local project context:",
          options.context.packedText || "No local project files matched the request.",
          "",
          "Question:",
          options.question
        ].join("\n")
      }
    ]
  });

  return response.output_text?.trim() || "I did not receive any text output from the model.";
}
