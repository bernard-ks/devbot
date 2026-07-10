import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationCommandType } from "discord.js";
import { commandDefinitions } from "./commands.js";

interface SchemaOption {
  name: string;
  required?: boolean;
  autocomplete?: boolean;
  min_value?: number;
  max_value?: number;
  choices?: Array<{ name: string; value: string }>;
  options?: SchemaOption[];
}

interface CommandJson {
  name: string;
  type?: number;
  options?: SchemaOption[];
}

const definitions = commandDefinitions as readonly CommandJson[];

function option(command: CommandJson | undefined, name: string): SchemaOption | undefined {
  return command?.options?.find((entry) => entry.name === name);
}

test("ambient command schema exposes the workroom context menu and inbox", () => {
  const contextMenu = definitions.find((command) => command.name === "Start Devbot workroom");
  assert.equal(contextMenu?.type, ApplicationCommandType.Message);

  const inbox = definitions.find((command) => command.name === "inbox");
  assert.ok(inbox);
  const project = option(inbox, "project");
  assert.equal(project?.autocomplete, true);
  assert.equal(project?.required, false);
  assert.equal(option(inbox, "limit")?.min_value, 1);
  assert.equal(option(inbox, "limit")?.max_value, 25);
});

test("ambient setup schema binds project rooms and task recent includes approval", () => {
  const setup = definitions.find((command) => command.name === "setup");
  const projectRoom = setup?.options?.find((entry) => entry.name === "project-room");
  assert.ok(projectRoom);
  assert.deepEqual(projectRoom.options?.map((entry) => entry.name), ["action", "project", "channel"]);

  const action = option(projectRoom, "action");
  assert.deepEqual(action?.choices?.map(({ name, value }) => ({ name, value })), [
    { name: "bind", value: "bind" },
    { name: "remove", value: "remove" }
  ]);
  assert.equal(option(projectRoom, "project")?.autocomplete, true);
  assert.equal(option(projectRoom, "channel")?.required, false);

  const task = definitions.find((command) => command.name === "task");
  const recent = task?.options?.find((entry) => entry.name === "recent");
  assert.ok(recent);
  assert.ok(option(recent, "status")?.choices?.some((choice) => choice.value === "awaiting-approval"));
});
