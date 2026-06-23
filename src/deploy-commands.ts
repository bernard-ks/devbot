import { REST, Routes } from "discord.js";
import { commandDefinitions } from "./commands.js";
import { loadDiscordConfig } from "./config.js";

const config = loadDiscordConfig();
const rest = new REST({ version: "10" }).setToken(config.discordToken);

await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId), {
  body: commandDefinitions
});

console.log(`Deployed ${commandDefinitions.length} commands to guild ${config.discordGuildId}.`);
