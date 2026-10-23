const { timingSafeEqual } = require("node:crypto");
const { request } = require("./client");
const { version } = require("./package.json");
const { version: platformVersion } = require("zapier-platform-core");

const fields = [
  { key: "id", type: "string" },
  { key: "event", type: "string" },
  { key: "resource_id", type: "string" },
  { key: "title", type: "string" },
  { key: "created_at", type: "datetime" },
];

const trigger = (key, event, label, description) => ({
  key,
  noun: "Evenement",
  display: { label, description },
  operation: {
    type: "hook",
    performSubscribe: (z, bundle) => request(z, bundle, "/hooks", {
      method: "POST", body: { event, target_url: bundle.targetUrl },
    }),
    performUnsubscribe: (z, bundle) => request(z, bundle,
      "/hooks/" + encodeURIComponent(bundle.subscribeData.id), { method: "DELETE" }),
    perform: (z, bundle) => {
      const headers = bundle.cleanedRequest.headers || {};
      const provided = Object.entries(headers).find(([name]) =>
        name.toLowerCase() === "x-sirius-hook-secret")?.[1];
      const expected = bundle.subscribeData?.secret;
      if (typeof provided !== "string" || typeof expected !== "string" ||
          Buffer.byteLength(provided) !== Buffer.byteLength(expected) ||
          !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
        throw new z.errors.Error("Secret de hook SIRIUS invalide.", "InvalidHook", 401);
      }
      const body = bundle.cleanedRequest.content;
      if (!body || body.event !== event || typeof body.resource_id !== "string" ||
          body.id !== event + ":" + body.resource_id || typeof body.title !== "string" ||
          typeof body.created_at !== "string" ||
          (event === "meeting.ready" && typeof body.summary !== "string")) {
        throw new z.errors.Error("Evenement SIRIUS non conforme.", "InvalidEvent", 400);
      }
      return [body];
    },
    performList: (z, bundle) => request(z, bundle, "/samples/" + event),
    sample: {
      id: event + ":exemple", event, resource_id: "exemple",
      title: "Projet exemple", created_at: "2026-01-01T12:00:00Z",
      ...(event === "meeting.ready" ? { summary: "Verifier le stock.", capture_complete: true } : {}),
    },
    outputFields: event === "meeting.ready" ? [
      ...fields, { key: "summary", type: "string" }, { key: "capture_complete", type: "boolean" },
    ] : fields,
  },
});

module.exports = {
  version,
  platformVersion,
  flags: { cleanInputData: false },
  authentication: {
    type: "custom",
    fields: [
      { key: "apiUrl", label: "URL API SIRIUS", type: "string", required: true,
        helpText: "Votre serveur HTTPS public, termine par /api. Pas localhost." },
      { key: "apiKey", label: "Cle API Zapier SIRIUS", type: "password", required: true,
        helpText: "Cle dediee szk_, jamais votre mot de passe ou votre session SIRIUS." },
    ],
    test: (z, bundle) => request(z, bundle, "/me"),
    connectionLabel: "{{label}}",
  },
  triggers: {
    new_dossier: trigger("new_dossier", "dossier.created", "Nouveau dossier",
      "Declenche apres creation d'un dossier prive dans SIRIUS."),
    meeting_ready: trigger("meeting_ready", "meeting.ready", "Synthese de reunion prete",
      "Declenche quand une nouvelle synthese est disponible, sans valider ni assigner ses taches."),
  },
  searches: {
    find_dossier: {
      key: "find_dossier", noun: "Dossier",
      display: { label: "Rechercher un dossier", description: "Recherche les dossiers prives par titre exact ou identifiant." },
      operation: {
        inputFields: [
          { key: "title", label: "Titre exact", type: "string" },
          { key: "id", label: "Identifiant du dossier (prioritaire)", type: "string" },
        ],
        perform: (z, bundle) => request(z, bundle, "/dossiers", { params: {
          title: bundle.inputData.title || "", id: bundle.inputData.id || "",
        } }),
        sample: { id: "exemple", title: "Projet exemple", category: "general", created_at: "2026-01-01T12:00:00Z" },
        outputFields: [
          { key: "id", type: "string" }, { key: "title", type: "string" },
          { key: "category", type: "string" }, { key: "created_at", type: "datetime" },
        ],
      },
    },
  },
  creates: {
    add_note: {
      key: "add_note", noun: "Note",
      display: { label: "Ajouter une note", description: "Ajoute une note dans un dossier prive, sans action externe ni appel IA." },
      operation: {
        inputFields: [
          { key: "dossier_id", label: "Identifiant du dossier", type: "string", required: true },
          { key: "text", label: "Texte de la note (4000 caracteres maximum)", type: "text", required: true },
          { key: "request_id", label: "UUID stable de cette operation", type: "string", required: true,
            helpText: "Meme UUID pour les reprises de la meme note ; UUID different pour chaque nouvelle note. Ne pas generer un nouvel UUID lors d'un retry." },
        ],
        perform: (z, bundle) => request(z, bundle, "/notes", { method: "POST", body: {
          dossier_id: bundle.inputData.dossier_id,
          text: bundle.inputData.text,
          request_id: bundle.inputData.request_id,
        } }),
        sample: { id: "00000000-0000-4000-8000-000000000001", text: "Verifier le stock.",
          created_at: "2026-01-01T12:00:00Z", origin: "zapier" },
        outputFields: [
          { key: "id", type: "string" }, { key: "text", type: "string" },
          { key: "created_at", type: "datetime" }, { key: "origin", type: "string" },
        ],
      },
    },
  },
};
