import { REST, Routes } from "discord.js";

import { readEnvironment } from "../config/environment.ts";
import { dottyCommand } from "./dotty-command.ts";
import { dottyPanelCommand } from "./dotty-panel.ts";

const environment = readEnvironment();
const rest = new REST({ version: "10" }).setToken(environment.DISCORD_TOKEN);

await rest.put(
  Routes.applicationGuildCommands(
    environment.DISCORD_CLIENT_ID,
    environment.DISCORD_GUILD_ID,
  ),
  { body: [dottyPanelCommand.toJSON(), dottyCommand.toJSON()] },
);

console.log("Panel /dotty y respaldo /dotty_admin registrados en el servidor de desarrollo.");
