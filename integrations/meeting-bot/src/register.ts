import { REST, Routes, SlashCommandBuilder } from "discord.js";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} requis.`);
  return value;
};
const commands = [
  new SlashCommandBuilder().setName("sirius-start").setDescription("Demander les accords individuels avant capture audio"),
  new SlashCommandBuilder().setName("sirius-stop").setDescription("Arrêter immédiatement la capture puis préparer la synthèse"),
  new SlashCommandBuilder().setName("sirius-publish").setDescription("Relire et publier une réunion validée vers Slack")
    .addStringOption((option) => option.setName("meeting").setDescription("Référence SIRIUS de la réunion").setRequired(true)),
];
new REST({ version: "10" }).setToken(required("DISCORD_TOKEN")).put(
  Routes.applicationGuildCommands(required("DISCORD_APPLICATION_ID"), required("DISCORD_GUILD_ID")),
  { body: commands.map((command) => command.toJSON()) },
).then(() => console.info("Commandes installées dans le seul serveur configuré."))
  .catch(() => { console.error("Échec d'enregistrement des commandes Discord ; vérifier token, application et serveur."); process.exitCode = 1; });
