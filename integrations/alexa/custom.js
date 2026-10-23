"use strict";
const Alexa = require("ask-sdk-core");
const { api, ApiError } = require("./api");

const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
}[c]));
const say = (input, text, end = true) => input.responseBuilder
  .speak(escape(text)).withShouldEndSession(end).getResponse();
const accountToken = (input) => input.requestEnvelope.context?.System?.user?.accessToken;
const link = (input) => input.responseBuilder
  .speak("Liez votre compte SIRIUS dans l'application Alexa pour autoriser cette lecture.")
  .withLinkAccountCard().withShouldEndSession(true).getResponse();

function makeHandler(call = api, skillId = process.env.SIRIUS_ALEXA_SKILL_ID) {
  if (!/^amzn1\.ask\.skill\.[A-Za-z0-9-]+$/.test(skillId || "")) {
    throw new Error("Configurer l'identifiant exact de la Skill personnalisée.");
  }
  const skill = Alexa.SkillBuilders.custom().withSkillId(skillId).addRequestHandlers({
    canHandle: () => true,
    async handle(input) {
      const type = Alexa.getRequestType(input.requestEnvelope);
      if (type === "SessionEndedRequest") return input.responseBuilder.getResponse();
      if (type === "LaunchRequest") {
        return accountToken(input) ? say(input,
          "SIRIUS peut lire vos dossiers ou la dernière synthèse de réunion. Dites : mes dossiers, ou dernière réunion.", false) : link(input);
      }
      if (type !== "IntentRequest") return say(input, "Cette demande n'est pas prise en charge.");
      const intent = Alexa.getIntentName(input.requestEnvelope);
      if (["AMAZON.StopIntent", "AMAZON.CancelIntent"].includes(intent)) return say(input, "À bientôt.");
      if (intent === "AMAZON.HelpIntent") return say(input,
        "Dites mes dossiers, cherche le dossier suivi de son titre, ou dernière réunion. Cette Skill ne commande aucun appareil.", false);
      if (!["ListDossiersIntent", "FindDossierIntent", "LatestMeetingIntent"].includes(intent)) {
        return say(input, "Dites mes dossiers ou dernière réunion.", false);
      }
      const token = accountToken(input);
      if (!token) return link(input);
      if (intent === "LatestMeetingIntent") {
        const data = await call("/api/integrations/alexa/meetings", token);
        if (!Array.isArray(data.items)) throw new Error("Réponse réunions invalide.");
        const meeting = data.items[0];
        if (!meeting) return say(input, "Aucune synthèse de réunion disponible.");
        if (typeof meeting.title !== "string" || typeof meeting.summary !== "string") throw new Error("Synthèse invalide.");
        return say(input, `${meeting.capture_complete ? "" : "Attention, capture déclarée incomplète. "}${meeting.title.slice(0, 200)}. ${meeting.summary.slice(0, 1800)}`);
      }
      const title = intent === "FindDossierIntent" ? Alexa.getSlotValue(input.requestEnvelope, "titre")?.trim() : "";
      if (intent === "FindDossierIntent" && !title) return say(input, "Précisez le titre exact du dossier.", false);
      if (title?.length > 200) return say(input, "Le titre est trop long. Utilisez un titre de moins de deux cents caractères.");
      const data = await call(`/api/integrations/alexa/dossiers${title ? `?title=${encodeURIComponent(title)}` : ""}`, token);
      if (!Array.isArray(data.items) || data.items.some((item) => typeof item.title !== "string")) {
        throw new Error("Réponse dossiers invalide.");
      }
      return say(input, data.items.length
        ? `Voici les dossiers : ${data.items.slice(0, 3).map((d) => d.title.slice(0, 200)).join(". ")}.`
        : "Aucun dossier correspondant.");
    },
  }).addErrorHandlers({
    canHandle: () => true,
    handle(input, error) {
      // Never log the envelope, account token or private response text.
      console.error("SIRIUS Alexa custom error", error instanceof ApiError ? error.status : error.name);
      if (error instanceof ApiError && error.status === 401) return link(input);
      return say(input, "SIRIUS ne peut pas consulter ces données pour le moment. Vérifiez votre liaison et vos autorisations dans SIRIUS.");
    },
  }).create();
  return (event, context = {}) => skill.invoke(event, context);
}

let handler;
exports.handler = (event, context) => {
  handler ||= makeHandler();
  return handler(event, context);
};
exports.makeHandler = makeHandler;
