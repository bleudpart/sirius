import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, Client, GatewayIntentBits,
  GuildMember, MessageFlags, TextChannel, VoiceChannel } from "discord.js";
import { AudioReceiveStream, EndBehaviorType, entersState, joinVoiceChannel, VoiceConnection, VoiceConnectionStatus } from "@discordjs/voice";
import prism from "prism-media";
import { Meeting, SiriusClient } from "../../shared/client";
import { ConsentGate, publishSlack, TranscriptionQueue, wav } from "./capture";

const required = (name: string) => {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} requis.`);
  return value;
};
const config = {
  guild: required("DISCORD_GUILD_ID"), voice: required("DISCORD_VOICE_CHANNEL_ID"),
  text: required("DISCORD_TEXT_CHANNEL_ID"), owner: required("DISCORD_OWNER_ID"),
  token: required("DISCORD_TOKEN"),
};
const sirius = new SiriusClient(required("SIRIUS_API_URL"), required("SIRIUS_ACCESS_TOKEN"),
  process.env.SIRIUS_CEREBRAS_KEY || "");
const discord = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
type Phase = "CONSENT" | "STARTING" | "CAPTURING" | "STOPPING";
interface Session {
  id: string;
  gate: ConsentGate;
  phase: Phase;
  channel: VoiceChannel;
  text: TextChannel;
  connection?: VoiceConnection;
  streams: Map<string, { opus: AudioReceiveStream; decoder: Transform; flush: (closing?: boolean) => void }>;
  queue: TranscriptionQueue;
  timer?: NodeJS.Timeout;
  failed: boolean;
  startedOnServer: boolean;
}
let session: Session | undefined;
let publication: { meeting: Meeting; fingerprint: string; messageId: string; timer: NodeJS.Timeout } | undefined;
let publishBusy = false;
let startBusy = false;
class CommandError extends Error {}

function people(channel: VoiceChannel) {
  return [...channel.members.values()].filter((member) => member.id !== discord.user?.id);
}
function rosterUnchanged(current: Session) {
  const members = people(current.channel);
  return members.every((member) => !member.user.bot) && current.gate.unchanged(members.map((member) => member.id));
}
async function notify(current: Session, text: string) {
  try { await current.text.send({ content: text, allowedMentions: { parse: [] } }); }
  catch { console.error("Notification Discord non remise ; consulter SIRIUS. Référence :", current.id); }
}
function dispose(current: Session) {
  clearTimeout(current.timer);
  for (const { opus, decoder } of current.streams.values()) { opus.destroy(); decoder.destroy(); }
  current.streams.clear();
  if (current.connection && current.connection.state.status !== VoiceConnectionStatus.Destroyed)
    current.connection.destroy();
}

async function stop(current: Session, complete: boolean, reason: string) {
  if (current.phase === "STOPPING") return;
  const wasCapture = current.phase === "CAPTURING";
  current.phase = "STOPPING";
  if (wasCapture && complete && !current.failed) {
    for (const stream of current.streams.values()) stream.flush(true);
  }
  dispose(current);
  await current.queue.close(!complete);
  try {
    if (current.startedOnServer) {
      const saved = await sirius.finish(current.id, complete && !current.failed && wasCapture,
        (current.failed ? "Transcription ou transfert interrompu. " : "") + reason);
      await notify(current, `Capture arrêtée. Synthèse ${saved.state}, référence ${current.id}. ` +
        "Relisez-la dans Raycast/SIRIUS ; aucune tâche créée ni publication Slack automatique.");
    } else await notify(current, "Capture annulée avant admission SIRIUS ; aucun audio enregistré.");
  } catch {
    await notify(current, `Capture arrêtée, résultat SIRIUS non confirmé. Référence ${current.id}. ` +
      "Consulter cette référence ; aucun nouvel appel automatique.");
    console.error("Fermeture/synthèse non confirmée. Référence :", current.id);
  } finally { if (session === current) session = undefined; }
}

function enqueue(current: Session, speaker: string, pcm: Buffer, closing = false) {
  if ((current.phase !== "CAPTURING" && !closing) || pcm.length < 48000 * 4 / 5) return;
  current.queue.push(speaker, pcm);
}

function subscribe(current: Session, speaker: string) {
  if (current.phase !== "CAPTURING" || !current.gate.accepted.has(speaker) || current.streams.has(speaker)) return;
  const receiver = current.connection?.receiver;
  if (!receiver) return;
  let decoder: Transform;
  try {
    decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  } catch {
    console.error("Décodeur Opus indisponible ; aucun flux audio admis.");
    current.failed = true; void stop(current, false, "Décodeur Opus indisponible."); return;
  }
  const opus = receiver.subscribe(speaker, { end: { behavior: EndBehaviorType.AfterSilence, duration: 600 } });
  let chunks: Buffer[] = [];
  let bytes = 0;
  const flush = (closing = false) => {
    if (!bytes) return;
    const pcm = Buffer.concat(chunks, bytes); chunks = []; bytes = 0;
    enqueue(current, speaker, pcm, closing);
  };
  current.streams.set(speaker, { opus, decoder, flush });
  decoder.on("data", (chunk: Buffer) => {
    if (current.phase !== "CAPTURING") return;
    chunks.push(chunk); bytes += chunk.length;
    if (bytes >= 48000 * 4 * 5) flush();
  });
  decoder.on("end", flush);
  decoder.on("close", () => current.streams.delete(speaker));
  const fail = () => { current.failed = true; void stop(current, false, "Décodage audio indisponible."); };
  opus.on("error", fail); decoder.on("error", fail);
  opus.pipe(decoder);
}

function stopping(current: Session) { return current.phase === "STOPPING"; }

async function begin(current: Session) {
  if (session !== current || current.phase !== "CONSENT" || !current.gate.ready()) return;
  current.phase = "STARTING"; clearTimeout(current.timer);
  try {
    if (!rosterUnchanged(current)) throw new Error("Groupe modifié pendant les accords.");
    await sirius.start(current.id, "Réunion Discord", current.gate.roster);
    current.startedOnServer = true;
    if (stopping(current)) {
      await sirius.finish(current.id, false, "Admission arrivée après retrait d'accord ; aucun audio reçu.");
      return;
    }
    if (session !== current || current.phase !== "STARTING" || !rosterUnchanged(current)) {
      if (!stopping(current)) await stop(current, false, "Groupe modifié avant capture.");
      return;
    }
    current.connection = joinVoiceChannel({
      channelId: config.voice, guildId: config.guild, adapterCreator: current.channel.guild.voiceAdapterCreator,
      selfDeaf: false, selfMute: true,
    });
    current.connection.on("error", () => { void stop(current, false, "Erreur de connexion vocale."); });
    await entersState(current.connection, VoiceConnectionStatus.Ready, 15000);
    if (session !== current || current.phase !== "STARTING" || !rosterUnchanged(current)) {
      await stop(current, false, "Groupe modifié pendant la connexion."); return;
    }
    await current.text.send({ content: `Tous les accords ont été reçus. Capture IA active (20 minutes maximum), ` +
      `référence ${current.id}. Audio envoyé au STT SIRIUS puis transcription à Cerebras pour synthèse. ` +
      "Le bouton d'arrêt ou /sirius-stop interrompt la capture. Aucun audio n'est conservé sur disque.",
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder()
        .setCustomId(`stop:${current.id}`).setLabel("Retirer mon accord / arrêter").setStyle(ButtonStyle.Danger))],
      allowedMentions: { parse: [] } });
    if (session !== current || current.phase !== "STARTING" || !rosterUnchanged(current)) {
      await stop(current, false, "Accord retiré avant abonnement audio."); return;
    }
    current.phase = "CAPTURING";
    current.connection.receiver.speaking.on("start", (id) => subscribe(current, id));
    current.connection.on(VoiceConnectionStatus.Disconnected, () => {
      void stop(current, false, "Connexion vocale interrompue ; aucune reconnexion automatique.");
    });
    current.timer = setTimeout(() => { void stop(current, false, "Durée maximale de vingt minutes atteinte."); }, 20 * 60000);
  } catch {
    await stop(current, false, "Démarrage non confirmé ; vérifier SIRIUS et les permissions Discord.");
  }
}

discord.on("voiceStateUpdate", (before, after) => {
  const current = session;
  if (!current || current.phase === "STOPPING") return;
  if ((before.channelId === config.voice || after.channelId === config.voice) &&
      (before.channelId !== after.channelId || after.id === discord.user?.id)) {
    if (after.id === discord.user?.id) {
      if ((current.phase === "CAPTURING" || current.phase === "STARTING") && after.channelId !== config.voice)
        void stop(current, false, "Bot déplacé ou déconnecté.");
    } else void stop(current, false, "Participants modifiés ; nouveaux accords requis.");
  }
});

discord.on("interactionCreate", async (interaction) => {
  if (interaction.guildId !== config.guild || interaction.channelId !== config.text) return;
  let starting = false;
  let preparingPublication = false;
  let created: Session | undefined;
  try {
    if (interaction.isButton()) {
      const current = session;
      if (interaction.customId.startsWith("consent:") && current?.id === interaction.customId.slice(8)) {
        if (current.phase !== "CONSENT" || !current.gate.roster.some((item) => item.id === interaction.user.id)) {
          await interaction.reply({ content: "Accord non recevable pour cette capture.", flags: MessageFlags.Ephemeral }); return;
        }
        current.gate.accept(interaction.user.id);
        await interaction.reply({ content: "Votre accord est reçu ; vous pouvez le retirer avec le bouton d'arrêt.",
          flags: MessageFlags.Ephemeral });
        void begin(current); return;
      }
      if (interaction.customId.startsWith("stop:") && current?.id === interaction.customId.slice(5) &&
          current.gate.roster.some((item) => item.id === interaction.user.id)) {
        void stop(current, false, "Arrêt ou retrait d'accord d'un participant.");
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await interaction.editReply("Capture interrompue immédiatement ; synthèse des fragments déjà transmis seulement.");
        return;
      }
      if (interaction.customId.startsWith("publish:") && interaction.user.id === config.owner &&
          publication && interaction.message.id === publication.messageId &&
          interaction.customId === `publish:${publication.meeting.id}` && !publishBusy) {
        publishBusy = true;
        const prepared = publication; publication = undefined; clearTimeout(prepared.timer);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_CHANNEL_ID)
            throw new Error("Configuration Slack manquante.");
          const payload = await sirius.publication(prepared.meeting.id, prepared.fingerprint);
          await publishSlack(process.env.SLACK_BOT_TOKEN, process.env.SLACK_CHANNEL_ID, payload.text);
          await interaction.editReply("Slack confirme la publication dans le canal configuré.");
        } catch {
          await interaction.editReply("Publication non confirmée. Vérifier Slack et SIRIUS, ne pas renvoyer automatiquement.");
        } finally { publishBusy = false; }
        return;
      }
      await interaction.reply({ content: "Bouton expiré ou non autorisé.", flags: MessageFlags.Ephemeral }); return;
    }
    if (!interaction.isChatInputCommand()) return;
    if (interaction.user.id !== config.owner) {
      await interaction.reply({ content: "Commande réservée au propriétaire de cette intégration.", flags: MessageFlags.Ephemeral }); return;
    }
    if (interaction.commandName === "sirius-stop" && session) {
      void stop(session, true, "Arrêt explicite du propriétaire ; fin de la réunion.");
      await interaction.reply({ content: "Réception audio arrêtée ; synthèse en cours, aucune tâche assignée automatiquement.",
        flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.commandName === "sirius-start") {
      if (session || startBusy) throw new CommandError("Une capture ou demande d'accord est déjà en cours.");
      startBusy = true; starting = true;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (interaction.commandName === "sirius-start") {
      const voice = await discord.channels.fetch(config.voice);
      const text = await discord.channels.fetch(config.text);
      if (!(voice instanceof VoiceChannel) || !(text instanceof TextChannel) ||
          voice.guild.id !== config.guild || text.guild.id !== config.guild)
        throw new CommandError("Canaux voix/texte privés du serveur configuré requis.");
      const members = people(voice);
      if (!members.some((member) => member.id === config.owner) || members.some((member) => member.user.bot))
        throw new CommandError("Le propriétaire doit être présent ; aucun autre bot dans le canal.");
      const gate = new ConsentGate(members.map((member: GuildMember) => ({ id: member.id, label: member.displayName })));
      const id = randomUUID();
      const current: Session = { id, gate, channel: voice, text, phase: "CONSENT",
        streams: new Map(), failed: false, startedOnServer: false,
        queue: new TranscriptionQueue(
          (pcm) => sirius.transcribe(wav(pcm), process.env.SIRIUS_GROQ_KEY || ""),
          (sequence, speaker, value) => sirius.fragment(id, sequence, speaker, value),
          () => {
            current.failed = true;
            console.error("Fragment ou capacité non confirmé ; capture interrompue. Référence :", id);
            // Failure callbacks must not await the queue they are running in.
            void stop(current, false, "Fragment non confirmé ou limite atteinte ; aucun retry.");
          }),
      };
      session = current;
      created = current;
      current.timer = setTimeout(() => { void stop(current, false, "Accords incomplets après deux minutes."); }, 120000);
      await text.send({ content: "SIRIUS propose de capturer la réunion vocale et d'envoyer l'audio au STT configuré " +
        "(Groq/service SIRIUS), puis le texte à Cerebras. Transcription et synthèse seront conservées dans le compte " +
        "SIRIUS du propriétaire ; tâches privées après validation, publication Slack seulement après confirmation. " +
        "Chaque personne du canal doit accepter elle-même avant toute connexion audio. Un changement de participants " +
        "arrête la capture. Si vous refusez, ne cliquez pas ; vous pouvez arrêter à tout moment.",
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`consent:${current.id}`).setLabel("J'accepte cette capture IA").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`stop:${current.id}`).setLabel("Refuser / arrêter").setStyle(ButtonStyle.Danger))],
        allowedMentions: { parse: [] } });
      await interaction.editReply(`Demande d'accord publiée. Référence ${current.id}. Pas encore de capture.`);
    } else if (interaction.commandName === "sirius-stop") {
      throw new CommandError("Aucune capture en cours.");
    } else if (interaction.commandName === "sirius-publish") {
      if (publication || publishBusy) throw new CommandError("Une publication est déjà en préparation.");
      if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_CHANNEL_ID) throw new CommandError("Slack non configuré.");
      publishBusy = true; preparingPublication = true;
      const saved = await sirius.detail(interaction.options.getString("meeting", true));
      if (saved.state !== "READY" || !saved.result || !saved.fingerprint) throw new CommandError("Synthèse non disponible.");
      const preview = await sirius.publicationPreview(saved.id);
      await interaction.editReply({ content: `Relisez le contenu complet joint avant de confirmer la publication dans Slack ` +
        `(${process.env.SLACK_CHANNEL_ID}). La transcription brute n'est pas publiée.`,
        files: [new AttachmentBuilder(Buffer.from(preview.text, "utf8"), { name: "sirius-publication.txt" })],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder()
          .setCustomId(`publish:${saved.id}`).setLabel("Publier cette synthèse et les tâches validées").setStyle(ButtonStyle.Primary))],
        allowedMentions: { parse: [] } });
      const message = await interaction.fetchReply();
      const timer = setTimeout(() => { publication = undefined; }, 120000);
      publication = { meeting: saved, fingerprint: preview.fingerprint, messageId: message.id, timer };
    }
  } catch (failure) {
    if (created?.phase === "CONSENT") void stop(created, false, "Annonce de consentement non remise.");
    console.error("Commande Discord refusée ou interrompue ; consulter la référence SIRIUS.");
    if (interaction.isRepliable()) {
      const content = failure instanceof CommandError ? failure.message :
        "Demande refusée ou résultat non confirmé. Vérifier configuration, droits et suivi SIRIUS avant de recommencer.";
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content, components: [] }).catch(() => {
        console.error("Erreur de commande non remise à Discord.");
      });
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {
        console.error("Erreur de commande non remise à Discord.");
      });
    }
  } finally {
    if (starting) startBusy = false;
    if (preparingPublication) publishBusy = false;
  }
});

discord.once("clientReady", () => console.info("Bot SIRIUS prêt ; aucune capture automatique."));
discord.on("error", () => {
  console.error("Erreur client Discord.");
  if (session) void stop(session, false, "Client Discord indisponible.");
});
discord.on("shardDisconnect", () => {
  if (session) void stop(session, false, "Session Discord déconnectée.");
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  const current = session;
  if (current) { current.phase = "STOPPING"; void current.queue.close(true); dispose(current); }
  session = undefined;
  clearTimeout(publication?.timer);
  discord.destroy(); process.exitCode = 0;
  console.info("Bot arrêté ; aucune reprise de capture. Une session CAPTURING éventuelle doit être examinée dans SIRIUS.");
});
discord.login(config.token).catch(() => {
  console.error("Connexion Discord refusée ; aucun enregistrement démarré."); process.exitCode = 1;
});
