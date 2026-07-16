import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultRuntimeStatePath } from "./runtime-paths.js";

export interface CommandSyncInput<T = unknown> {
  definitions: T[];
  guildId: string;
  stateFile?: string;
  setCommands: (definitions: T[], guildId: string) => Promise<unknown>;
}

export async function syncCommandsIfChanged<T>(input: CommandSyncInput<T>): Promise<boolean> {
  const stateFile = input.stateFile ? path.resolve(input.stateFile) : defaultRuntimeStatePath("commands.sha256");
  const hash = commandDefinitionsHash(input.definitions, input.guildId);
  const previous = await readFile(stateFile, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (previous.trim() === hash) {
    return false;
  }

  await input.setCommands(input.definitions, input.guildId);
  await mkdir(path.dirname(stateFile), { recursive: true });
  const tempFile = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempFile, `${hash}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempFile, stateFile);
  return true;
}

export function commandDefinitionsHash(definitions: unknown[], guildId = ""): string {
  return createHash("sha256").update(JSON.stringify({ guildId, definitions })).digest("hex");
}
