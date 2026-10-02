import { act } from "react";
import { createRoot } from "react-dom/client";
import WorkDossiersPanel from "./WorkDossiersPanel";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("shows sourced proposals and never performs the proposed business action automatically", async () => {
  const originalFetch = global.fetch;
  const openThemis = jest.fn();
  const proposals = [{
    id: "stock-key", title: "Stock bas : Papier", reason: "2 unités en stock, seuil configuré à 3.",
    source: { module: "themis", kind: "stock", id: "item-1", label: "Papier" },
    proposed_action: { module: "themis", label: "Vérifier dans THÉMIS" },
  }, {
    id: "invoice-key", title: "Courrier à préparer : facture FAC-1 échue",
    reason: "Vérifier le destinataire avant envoi.",
    source: { module: "themis", kind: "facture", id: "invoice-1", label: "FAC-1" },
    proposed_action: { module: "themis", label: "Préparer la relance dans THÉMIS" },
    confirmation_required: true,
  }, {
    id: "haccp-key", title: "Non-conformité HACCP ouverte : température",
    reason: "Frigo hors plage.",
    source: { module: "haccp", kind: "haccp_nonconformity", id: "nc-1", label: "température" },
    proposed_action: { module: "haccp", label: "Examiner dans HACCP" },
    confirmation_required: true,
  }];
  let dossiers = [];
  const dismissed = new Set();
  global.fetch = jest.fn(async (url, options) => {
    const path = new URL(url, "http://localhost").pathname;
    let body;
    let status = 200;
    if (path.endsWith("/proposals") && !options) body = {
      proposals: proposals.filter((item) => !dismissed.has(item.id)),
      integrations: [
        { module: "themis", label: "Commerce et courrier professionnel", available: true, detail: "Stocks et factures." },
        { module: "haccp", label: "HACCP", available: true, detail: "Registres autorisés." },
        { module: "outlook", label: "Boîte Outlook", available: false, detail: "Les messages entrants Outlook ne sont pas encore analysés." },
      ],
    };
    else if (path.endsWith("/work-dossiers") && !options) body = { dossiers };
    else if (path.endsWith("/work-dossiers") && options?.method === "POST") {
      const input = JSON.parse(options.body);
      dossiers = [{ id: "d1", title: input.title, category: input.category, notes: [], sources: [] }];
      body = { dossier: dossiers[0] };
      status = 201;
    } else if (path.endsWith("/proposals/stock-key/dismiss")) {
      dismissed.add("stock-key");
      body = { dismissed: true };
    } else if (path.includes("/d1/proposals/")) {
      const pathParts = path.split("/");
      const proposalId = pathParts[pathParts.length - 1];
      const source = proposals.find((item) => item.id === proposalId).source;
      dossiers[0].sources.push(source);
      body = { source };
    } else throw new Error(`Unexpected request: ${path}`);
    return { ok: true, status, json: async () => body };
  });
  try {
    await legacyAssertions(openThemis, proposals);
  } finally {
    global.fetch = originalFetch;
  }
});

const stock = { source: { kind: "stock", id: "item-1", module: "themis" },
  data: { name: "Papier", stock: 2, alert: 3 }, fingerprint: "stock-v1" };
const invoice = { source: { kind: "facture", id: "invoice-1", module: "themis" },
  data: { number: "FAC-1", total_ttc: 100, paid: 0 }, fingerprint: "invoice-v1" };
const haccp = { source: { kind: "haccp_nonconformity", id: "nc-1", module: "haccp" },
  data: { type: "Température", description: "Frigo hors plage" }, fingerprint: "nc-v1" };

async function workspace({ entries = [], sources = [stock, invoice, haccp], failWrite = false, suggestions, unavailableSources = 0 } = {}) {
  const originalFetch = global.fetch;
  const dossiers = [{ id: "d1", title: "Boutique", category: "commerce", notes: [], sources: sources.map((item) => item.source) },
    { id: "d2", title: "Chantier", category: "chantier", notes: [], sources: [] }];
  const writes = [];
  const openThemis = jest.fn();
  const openHaccp = jest.fn();
  global.fetch = jest.fn(async (url, options) => {
    const path = new URL(url, "http://localhost").pathname.replace(/^.*\/work-dossiers/, "");
    if (!options) {
      const body = path === "" ? { dossiers } : path === "/proposals" ? { proposals: [], integrations: [] } : {
        dossier: dossiers.find((item) => path.includes(item.id)),
        entries: path.includes("d1") ? entries : [], sources: path.includes("d1") ? sources : [],
        suggestions: suggestions || [{ kind: "missing_next_step", entry_id: entries[0]?.id }],
        unavailable_sources: unavailableSources,
        what_changed: { baseline_id: "last-visit", changes: [{
          source: stock.source, change: "changed", fields: { stock: { before: 6, after: 2 } },
        }] }, limits: { execution: "manual_only" },
      };
      return { ok: true, json: async () => body };
    }
    const body = options.body ? JSON.parse(options.body) : undefined;
    writes.push({ path, method: options.method, body });
    if (failWrite) return { ok: false, status: 409, json: async () => ({ detail: "La source a changé ; préparer une nouvelle proposition." }) };
    if (path.endsWith("/simulations")) return { ok: true, json: async () => ({
      source: stock.source, assumptions: { quantity_delta: body.quantity_delta, other_movements: 0 },
      result: { stock_before: 2, stock_after: 7, below_alert: false }, persisted: false, executed: false,
    }) };
    return { ok: true, json: async () => ({ entry: { id: "new-entry" } }) };
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<WorkDossiersPanel onClose={() => {}} onOpenThemis={openThemis} onOpenHaccp={openHaccp} />));
  const button = (label) => [...container.querySelectorAll("button")].find((node) => node.textContent === label);
  const field = (label) => [...container.querySelectorAll("label")].find((node) => node.firstChild.textContent === label)?.querySelector("input,select,textarea");
  const change = async (node, value) => {
    expect(node).toBeTruthy();
    await act(async () => {
      const proto = node.tagName === "SELECT" ? HTMLSelectElement.prototype
        : node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(node, value);
      node.dispatchEvent(new Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    });
  };
  const click = async (label) => {
    expect(button(label)).toBeTruthy();
    await act(async () => button(label).click());
  };
  const submit = async () => act(async () => {
    field("Type").closest("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  return { container, writes, button, field, change, click, submit, openThemis, openHaccp,
    cleanup: () => { act(() => root.unmount()); container.remove(); global.fetch = originalFetch; } };
}

test("selected work thread shows decision rationale, actor, sources, commitments and changes without writes", async () => {
  const ui = await workspace({ entries: [
    { id: "decision-1", kind: "decision", status: "confirmed", content: {
      outcome: "accepted", rationale: "Éviter la rupture", next_step: "Vérifier le fournisseur",
      decided_by: { name: "Camille", identity: "authenticated_user" },
    }, sources: [stock.source], created_at: "2026-10-02T10:00:00Z" },
    { id: "commitment-1", kind: "commitment", status: "confirmed",
      content: { text: "Appeler le fournisseur", owner: "Camille", due_date: "2026-10-03" }, sources: [] },
  ] });
  try {
    expect(ui.container.textContent).toContain("Pourquoi : Éviter la rupture");
    expect(ui.container.textContent).toContain("Qui : Camille");
    expect(ui.container.textContent).toContain("Vérifier le fournisseur");
    expect(ui.container.textContent).toContain("stock : 6 → 2");
    expect(ui.writes).toHaveLength(0);
    expect(ui.openThemis).not.toHaveBeenCalled();
    await ui.click("Vérifier la source");
    expect(ui.openThemis).toHaveBeenCalledWith(stock.source);
    await ui.click("Chantier · Chantier");
    expect(ui.container.textContent).not.toContain("Pourquoi : Éviter la rupture");
    expect(ui.container.textContent).toContain("Chantier · fil de travail");
  } finally { ui.cleanup(); }
});

test("decision and meeting tasks require a complete review before persistence and never create external tasks", async () => {
  const ui = await workspace();
  try {
    await ui.change(ui.field("Pourquoi cette décision"), "Vérifier les prix avant achat");
    await ui.change(ui.field("Prochaine étape"), "Demander un devis");
    await ui.change(ui.field("Source suivie"), "stock:item-1");
    await ui.submit();
    expect(ui.writes).toHaveLength(0);
    expect(ui.container.textContent).toContain("Décision : Reportée");
    await ui.click("Annuler");
    expect(ui.writes).toHaveLength(0);
    await ui.submit();
    await ui.click("Valider l'enregistrement");
    expect(ui.writes[0]).toEqual({ path: "/d1/decisions", method: "POST", body: {
      outcome: "deferred", rationale: "Vérifier les prix avant achat", next_step: "Demander un devis",
      source: { kind: "stock", id: "item-1" },
    } });
    await ui.change(ui.field("Type"), "meeting");
    await ui.change(ui.field("Titre de la réunion"), "Point fournisseur");
    await ui.change(ui.field("Compte rendu de réunion"), "Camille demande le devis. Aucun achat décidé.");
    await ui.change(ui.field("Tâche proposée"), "Demander le devis");
    await ui.change(ui.field("Responsable de la tâche"), "Camille");
    await ui.click("Proposer cette tâche");
    expect(ui.writes).toHaveLength(1);
    await ui.submit();
    expect(ui.container.textContent).toContain("Tâches proposées :");
    await ui.click("Valider l'enregistrement");
    expect(ui.writes[1]).toEqual({ path: "/d1/meetings", method: "POST", body: {
      title: "Point fournisseur", notes: "Camille demande le devis. Aucun achat décidé.",
      tasks: [{ text: "Demander le devis", owner: "Camille" }],
    } });
    expect(ui.openThemis).not.toHaveBeenCalled();
  } finally { ui.cleanup(); }
});

test("source-linked draft types and handoffs preserve the exact backend contract", async () => {
  const ui = await workspace();
  try {
    for (const key of ["stock:item-1", "facture:invoice-1", "haccp_nonconformity:nc-1"]) {
      await ui.change(ui.field("Type"), "draft");
      await ui.change(ui.field("Source suivie"), key);
      if (key.startsWith("stock")) await ui.change(ui.field("Quantité proposée"), "5");
      await ui.submit();
      expect(ui.writes).toHaveLength(["stock:item-1", "facture:invoice-1", "haccp_nonconformity:nc-1"].indexOf(key));
      await ui.click("Valider l'enregistrement");
    }
    expect(ui.writes.map((write) => write.body)).toEqual([
      { source: { kind: "stock", id: "item-1" }, quantity: 5 },
      { source: { kind: "facture", id: "invoice-1" } },
      { source: { kind: "haccp_nonconformity", id: "nc-1" } },
    ]);
    await ui.change(ui.field("Type"), "handoff");
    await ui.change(ui.field("Objectif du passage inter-métiers"), "Vérifier l'incidence sur les stocks");
    await ui.change(ui.field("Métier destinataire"), "themis");
    await ui.change(ui.field("Source suivie"), "haccp_nonconformity:nc-1");
    await ui.submit();
    await ui.click("Valider l'enregistrement");
    expect(ui.writes[3].body).toEqual({ target: "themis", objective: "Vérifier l'incidence sur les stocks",
      sources: [{ kind: "haccp_nonconformity", id: "nc-1" }] });
    expect(ui.openThemis).not.toHaveBeenCalled();
    expect(ui.openHaccp).not.toHaveBeenCalled();
  } finally { ui.cleanup(); }
});

test("confirmation errors stay visible and source changes disable stale validation", async () => {
  const ui = await workspace({ failWrite: true, entries: [{
    id: "draft-1", kind: "draft", status: "proposed", content: {
      type: "invoice_followup", to: "", subject: "Relance FAC-1", message: "Bonjour",
      checks: ["Vérifier le destinataire"],
    }, sources: [invoice.source],
  }, { id: "draft-stale", kind: "draft", status: "proposed", source_changed: true,
    content: { type: "haccp_control", objet: "Frigo", resultat: null }, sources: [haccp.source] }] });
  try {
    expect(ui.container.textContent).toContain("Destinataire : À renseigner dans THÉMIS");
    expect([...ui.container.querySelectorAll("button")].filter((node) => node.textContent === "Relire puis valider")[1].disabled).toBe(true);
    await ui.click("Relire puis valider");
    expect(ui.writes).toHaveLength(0);
    await ui.click("Valider l'enregistrement");
    expect(ui.writes[0]).toEqual({ path: "/d1/entries/draft-1/confirm", method: "POST", body: { confirmed: true } });
    expect(ui.container.querySelector('[role="alert"]').textContent).toContain("La source a changé");
    expect(ui.container.textContent).toContain("Valider cette proposition dans le dossier ?");
  } finally { ui.cleanup(); }
});

test("checkpoint is explicit and simulations are read-only requests with stated assumptions", async () => {
  const ui = await workspace();
  try {
    await ui.click("J'ai relu les changements");
    expect(ui.writes).toHaveLength(0);
    await ui.click("Valider l'enregistrement");
    expect(ui.writes[0]).toEqual({ path: "/d1/snapshots", method: "POST", body: undefined });
    await ui.change(ui.field("Source à simuler"), "stock:item-1");
    await ui.change(ui.field("Variation de stock (+/−)"), "5");
    await act(async () => ui.field("Source à simuler").closest("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(ui.writes[1]).toEqual({ path: "/d1/simulations", method: "POST", body: {
      source: { kind: "stock", id: "item-1" }, quantity_delta: 5,
    } });
    expect(ui.container.textContent).toContain("Stock : 2 → 7");
    expect(ui.container.textContent).toContain("aucun autre mouvement");
    expect(ui.container.textContent).toContain("Aucune donnée enregistrée ou appliquée");
  } finally { ui.cleanup(); }
});
async function legacyAssertions(openThemis, proposals) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const openHaccp = jest.fn();
  try {
    await act(async () => {
      root.render(<WorkDossiersPanel onClose={() => {}} onOpenThemis={openThemis} onOpenHaccp={openHaccp} />);
    });
    expect(container.textContent).toContain("Stock bas : Papier");
    expect(container.textContent).toContain("Source : THÉMIS · Papier");
    expect(container.textContent).toContain("Courrier à préparer : facture FAC-1 échue");
    expect(container.textContent).toContain("vérifie les informations puis confirme séparément");
    expect(container.textContent).toContain("Les messages entrants Outlook ne sont pas encore analysés");
    expect(openThemis).not.toHaveBeenCalled();
    const input = container.querySelector('input[maxlength="120"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, "Boutique");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { container.querySelector(".work-dossiers-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(container.textContent).toContain("Créer ce dossier ?");
    expect(global.fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
    const button = (label) => [...container.querySelectorAll("button")].find((node) => node.textContent === label);
    await act(async () => { button("Valider l'enregistrement").click(); });
    expect(container.textContent).toContain("Boutique");
    await act(async () => { button("Suivre dans le dossier").click(); });
    await act(async () => { button("Valider l'enregistrement").click(); });
    expect(container.textContent).toContain("Source suivie : Papier");
    await act(async () => { button("Vérifier dans THÉMIS").click(); });
    expect(openThemis).toHaveBeenCalledTimes(1);
    expect(openThemis.mock.calls[0]).toEqual([proposals[0].source]);
    expect(openThemis.mock.calls[0][0]).toBe(proposals[0].source);
    await act(async () => { button("Examiner dans HACCP").click(); });
    expect(openHaccp).toHaveBeenCalledTimes(1);
    expect(openHaccp.mock.calls[0]).toEqual([proposals[2].source]);
    expect(openHaccp.mock.calls[0][0]).toBe(proposals[2].source);
    await act(async () => { button("Préparer la relance dans THÉMIS").click(); });
    expect(openThemis.mock.calls[1]).toEqual([proposals[1].source]);
    expect(openThemis.mock.calls[1][0]).toBe(proposals[1].source);
    await act(async () => { button("Ignorer ce signal").click(); });
    await act(async () => { button("Valider l'enregistrement").click(); });
    expect(container.textContent).not.toContain("Stock bas : Papier");
    expect(openThemis).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
}

test("commitments have an explicit owner and due date, reviewed completion cannot double-submit", async () => {
  const ui = await workspace({ entries: [{
    id: "commitment-1", kind: "commitment", status: "confirmed",
    content: { text: "Vérifier le devis", owner: "Camille", due_date: "2026-10-03" }, sources: [],
  }] });
  try {
    await ui.change(ui.field("Type"), "commitment");
    await ui.change(ui.field("Engagement"), "Répondre au fournisseur");
    await ui.change(ui.field("Responsable"), "Camille");
    await ui.change(ui.field("Échéance"), "2026-10-04");
    await ui.submit();
    expect(ui.writes).toHaveLength(0);
    await ui.click("Valider l'enregistrement");
    expect(ui.writes[0]).toEqual({ path: "/d1/commitments", method: "POST", body: {
      text: "Répondre au fournisseur", owner: "Camille", due_date: "2026-10-04",
    } });
    await ui.click("Marquer terminé");
    expect(ui.writes).toHaveLength(1);
    await act(async () => { ui.button("Valider l'enregistrement").click(); ui.button("Valider l'enregistrement").click(); });
    expect(ui.writes).toHaveLength(2);
    expect(ui.writes[1]).toEqual({ path: "/d1/entries/commitment-1", method: "PATCH", body: { status: "completed" } });
  } finally { ui.cleanup(); }
});

test("field photo remains local, invalid files are reported and note requires validation", async () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = jest.fn(() => "blob:field-photo");
  URL.revokeObjectURL = jest.fn();
  const ui = await workspace();
  try {
    const input = ui.container.querySelector('input[type="file"]');
    expect(input.getAttribute("capture")).toBe("environment");
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["photo"], "terrain.jpg", { type: "image/jpeg" })] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(ui.container.querySelector("img").src).toBe("blob:field-photo");
    expect(ui.container.textContent).toContain("non enregistrée ni transmise");
    expect(ui.writes).toHaveLength(0);
    await ui.click("Retirer la photo");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:field-photo");
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["bad"], "terrain.svg", { type: "image/svg+xml" })] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(ui.container.querySelector('[role="alert"]').textContent).toContain("JPEG, PNG ou WebP");
    await ui.change(ui.field("Note"), "Frigo à vérifier sur place");
    await act(async () => ui.field("Note").closest("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(ui.writes).toHaveLength(0);
    await ui.click("Valider l'enregistrement");
    expect(ui.writes[0]).toEqual({ path: "/d1/notes", method: "POST", body: { text: "Frigo à vérifier sur place" } });
  } finally { ui.cleanup(); URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; }
});

test("voice opts into on-device recognition only and aborts microphone before review", async () => {
  const originalRecognition = window.SpeechRecognition;
  const originalWebkit = window.webkitSpeechRecognition;
  let session;
  class LocalRecognition {
    constructor() { session = this; this.start = jest.fn(); this.stop = jest.fn(); this.abort = jest.fn(); }
  }
  LocalRecognition.prototype.processLocally = false;
  window.SpeechRecognition = LocalRecognition;
  window.webkitSpeechRecognition = undefined;
  const ui = await workspace();
  try {
    await ui.click("Dicter sur cet appareil");
    expect(session.processLocally).toBe(true);
    expect(session.lang).toBe("fr-FR");
    expect(session.start).toHaveBeenCalledTimes(1);
    await act(async () => session.onresult({ results: [[{ transcript: "Contrôle terrain à effectuer" }]] }));
    expect(ui.field("Note").value).toBe("Contrôle terrain à effectuer");
    expect(ui.writes).toHaveLength(0);
    await act(async () => ui.field("Note").closest("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(session.abort).toHaveBeenCalled();
    await ui.click("Annuler");
    await act(async () => session.onerror({ error: "language-not-supported" }));
    expect(ui.container.querySelector('[role="alert"]').textContent).toContain("Dictée locale indisponible");
  } finally { ui.cleanup(); window.SpeechRecognition = originalRecognition; window.webkitSpeechRecognition = originalWebkit; }
});

test("incomplete meeting task is not silently dropped", async () => {
  const ui = await workspace();
  try {
    await ui.change(ui.field("Type"), "meeting");
    await ui.change(ui.field("Titre de la réunion"), "Point terrain");
    await ui.change(ui.field("Compte rendu de réunion"), "Vérification à préparer.");
    await ui.change(ui.field("Tâche proposée"), "Vérifier le stock");
    await ui.submit();
    expect(ui.container.querySelector('[role="alert"]').textContent).toContain("Ajoutez la tâche en cours");
    expect(ui.writes).toHaveLength(0);
  } finally { ui.cleanup(); }
});

test("meeting action detection is local, explicit and needs an assigned owner before inclusion", async () => {
  const ui = await workspace();
  try {
    await ui.change(ui.field("Type"), "meeting");
    await ui.change(ui.field("Titre de la réunion"), "Point terrain");
    await ui.change(ui.field("Compte rendu de réunion"), "Nous discutons des stocks.\nAction : Vérifier le stock\nÀ faire : Demander un devis");
    await ui.click("Repérer les actions explicites");
    expect(ui.container.textContent).toContain("Actions repérées localement");
    expect(ui.writes).toHaveLength(0);
    await ui.click("Proposer : Vérifier le stock");
    expect(ui.field("Tâche proposée").value).toBe("Vérifier le stock");
    expect(ui.button("Proposer cette tâche").disabled).toBe(true);
    await ui.change(ui.field("Responsable de la tâche"), "Camille");
    await ui.click("Proposer cette tâche");
    await ui.submit();
    expect(ui.writes).toHaveLength(0);
    await ui.click("Valider l'enregistrement");
    expect(ui.writes[0].body.tasks).toEqual([{ text: "Vérifier le stock", owner: "Camille" }]);
  } finally { ui.cleanup(); }
});

test("final backend suggestions and unavailable sources are explicit without exposing inaccessible data", async () => {
  const ui = await workspace({ unavailableSources: 2, suggestions: [
    { kind: "manual_execution" }, { kind: "manual_handoff" }, { kind: "task_proposal", task_id: "task-1" },
  ] });
  try {
    expect(ui.container.textContent).toContain("2 source(s) indisponible(s) ou non autorisée(s)");
    expect(ui.container.textContent).toContain("ne les considérez pas comme supprimés ou terminés");
    expect(ui.container.textContent).toContain("Brouillon validé : vérifier puis appliquer manuellement");
    expect(ui.container.textContent).toContain("Préparer la transmission manuelle");
    expect(ui.container.textContent).toContain("Tâche validée dans la réunion : organiser son suivi manuel");
    expect(ui.writes).toHaveLength(0);
  } finally { ui.cleanup(); }
});

test("decision identity uses only server-derived author and legacy entries cannot claim another owner", async () => {
  const ui = await workspace({ entries: [{
    id: "legacy-decision", kind: "decision", status: "proposed",
    recorded_by: "Unverified recorder",
    content: { outcome: "deferred", rationale: "À vérifier", owner: "Unverified owner" }, sources: [],
  }] });
  try {
    expect(ui.container.textContent).toContain("Qui : Compte connecté (dossier privé)");
    expect(ui.container.textContent).not.toContain("Unverified owner");
    expect(ui.container.textContent).not.toContain("Unverified recorder");
    await ui.click("Relire puis valider");
    expect(ui.container.textContent).not.toContain("Unverified owner");
    expect(ui.container.textContent).not.toContain("Unverified recorder");
    expect(ui.writes).toHaveLength(0);
  } finally { ui.cleanup(); }
});
