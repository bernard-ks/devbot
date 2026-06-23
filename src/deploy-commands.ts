import { REST, Routes } from "discord.js";
import { commandDefinitions } from "./commands.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const rest = new REST({ version: "10" }).setToken(config.discordToken);

await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId), {
  body: commandDefinitions
});

console.log(`Deployed ${commandDefinitions.length} commands to guild ${config.discordGuildId}.`);
