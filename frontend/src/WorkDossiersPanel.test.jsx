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
    if (path.endsWith("/review-queue") && !options?.method) body = { items: [], truncated: false };
    else if (path.endsWith("/day") && !options?.method) body = { proposals: proposals.filter((item) => !dismissed.has(item.id)), commitments: [], on: "2026-10-02", verified_at: "2026-10-02T12:00:00Z", missing_info: [], read_only: true };
    else if (path.endsWith("/proposals") && !options?.method) body = {
      proposals: proposals.filter((item) => !dismissed.has(item.id)),
      integrations: [
        { module: "themis", label: "Commerce et courrier professionnel", available: true, detail: "Stocks et factures." },
        { module: "haccp", label: "HACCP", available: true, detail: "Registres autorisés." },
        { module: "outlook", label: "Boîte Outlook", available: false, detail: "Les messages entrants Outlook ne sont pas encore analysés." },
      ],
    };
    else if (path.endsWith("/work-dossiers") && !options?.method) body = { dossiers };
    else if (path.endsWith("/work-dossiers") && options?.method === "POST") {
      const input = JSON.parse(options.body);
      dossiers = [{ id: "d1", title: input.title, category: input.category, notes: [], sources: [] }];
      body = { dossier: dossiers[0] };
      status = 201;
    } else if (path.endsWith("/proposals/stock-key/review")) {
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

async function workspace({ entries = [], sources = [stock, invoice, haccp], failWrite = false, suggestions, unavailableSources = 0, proposals = [], day, dayFailure = false, preparationResponse, reviewQueue = [], clientTimeline } = {}) {
  const originalFetch = global.fetch;
  const dossiers = [{ id: "d1", title: "Boutique", category: "commerce", notes: [], sources: sources.map((item) => item.source) },
    { id: "d2", title: "Chantier", category: "chantier", notes: [], sources: [] }];
  const writes = [];
  const openThemis = jest.fn();
  const openHaccp = jest.fn();
  global.fetch = jest.fn(async (url, options) => {
    const path = new URL(url, "http://localhost").pathname.replace(/^.*\/work-dossiers/, "");
    if (!options?.method) {
      if (path === "/day" && dayFailure) return { ok: false, status: 503, json: async () => ({ detail: "Journée indisponible" }) };
      const body = path === "" ? { dossiers } : path === "/proposals" ? { proposals, integrations: [] }
        : path === "/review-queue" ? { items: reviewQueue, truncated: false }
        : path.endsWith("/client-events") ? clientTimeline || { events: [], followups: [], truncated: false }
        : path === "/day" ? day || {
        on: "2026-10-02", verified_at: "2026-10-02T12:00:00Z", proposals,
        commitments: entries.filter((entry) => entry.kind === "commitment" && entry.status === "confirmed").map((entry) => ({
          ...entry.content, dossier_id: "d1", entry_id: entry.id, task_id: null, status: "confirmed",
        })), proposal_date_basis: "live_today", missing_info: [], read_only: true,
      } : path.endsWith("/decision-journal") ? { decisions: entries.filter((entry) => entry.kind === "architect_decision"), change_impact: [], read_only: true } : {
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
    if (preparationResponse && path.endsWith(preparationResponse.path)) return { ok: true, json: async () => preparationResponse.body };
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

const explainedProposal = {
    id: "stock-proposal", title: "Vérifier le papier", reason: "Stock sous le seuil configuré",
    source: { ...stock.source, label: "Papier" },
    proposed_action: { module: "themis", label: "Examiner le stock" },
    why_suggested: { source: stock.source, rule: "stock <= alert", threshold: 3, observed: 2, verified_at: "2026-10-02T12:00:00Z", missing_info: ["Délai fournisseur"] },
  };

  test("daily overview unifies sourced signals and active commitments, with transparent métier preparation", async () => {
    const ui = await workspace({ proposals: [explainedProposal], entries: [{
      id: "active", kind: "commitment", status: "confirmed",
      content: { text: "Appeler le fournisseur", owner: "Camille", due_date: "2026-10-03" }, sources: [],
    }, {
      id: "done", kind: "commitment", status: "completed",
      content: { text: "Ancien appel", owner: "Camille" }, sources: [],
    }] });
    try {
      const day = ui.container.querySelector('[aria-label="Vue journée"]');
      expect(day.textContent).toContain("Vérifier le papier");
      expect(day.textContent).toContain("Appeler le fournisseur");
      expect(day.textContent).not.toContain("Ancien appel");
      expect(day.textContent).toContain("dossiers autorisés");
      const evidence = ui.container.querySelector(".work-dossiers-evidence");
      expect(evidence.textContent).toContain("Pourquoi cette proposition ?");
      expect(evidence.textContent).toContain("stock <= alert");
      expect(evidence.textContent).toContain("2. Vérifié dans les données");
      expect(evidence.textContent).toContain("Délai fournisseur");
      const cards = ui.container.querySelector('[aria-label="Préparations par métier"]');
      expect(cards.querySelectorAll("article")).toHaveLength(6);
      expect(cards.textContent).toContain("stock : 2");
      expect(cards.textContent).toContain("aucune couverture en jours calculable");
      expect(cards.textContent).toContain("n'atteste pas la conformité");
      expect(ui.writes).toHaveLength(0);
    } finally { ui.cleanup(); }
  });

  test.each([
    ["Reporter avec un motif", "deferred"],
    ["Écarter avec un motif", "rejected"],
  ])("proposal %s requires rationale and dossier-bound authenticated review", async (label, outcome) => {
    const ui = await workspace({ proposals: [explainedProposal] });
    try {
      await ui.click(label);
      expect(ui.button("Relire cette décision").disabled).toBe(true);
      await ui.change(ui.field("Motif de la décision"), "Attendre le délai du fournisseur");
      await ui.click("Relire cette décision");
      expect(ui.writes).toHaveLength(0);
      expect(ui.container.querySelector('[aria-label="Validation avant enregistrement"]').textContent).toContain("Attendre le délai");
      await ui.click("Valider l'enregistrement");
      expect(ui.writes).toEqual([{ path: "/proposals/stock-proposal/review", method: "POST", body: {
        outcome, rationale: "Attendre le délai du fournisseur",
      } }]);
      const writeOptions = global.fetch.mock.calls.find(([, options]) => options?.method === "POST")[1];
      expect(writeOptions.credentials).toBe("include");
      expect(ui.container.textContent).toContain("Vérifier le papier");
    } finally { ui.cleanup(); }
  });

  test("proposal decisions reset when changing dossiers and missing evidence is never invented", async () => {
    const ui = await workspace({ sources: [], proposals: [{ ...explainedProposal, why_suggested: undefined }] });
    try {
      expect(ui.container.querySelector(".work-dossiers-evidence").textContent).toContain("Non renseigné");
      await ui.click("Reporter avec un motif");
      await ui.change(ui.field("Motif de la décision"), "Attendre");
      await ui.click("Chantier · Chantier");
      expect(ui.field("Motif de la décision")).toBeUndefined();
      expect(ui.writes).toHaveLength(0);
      expect(ui.container.querySelector('[aria-label="Préparations par métier"]').textContent).toContain("Aucune source suivie");
    } finally { ui.cleanup(); }
  });
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
    await act(async () => { button("Écarter avec un motif").click(); });
    const rationale = [...container.querySelectorAll("label")].find((node) => node.firstChild.textContent === "Motif de la décision").querySelector("textarea");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(rationale, "Vérifié sur place");
      rationale.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { button("Relire cette décision").click(); });
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
    expect(ui.container.textContent).toContain("03/10/2026");
    await ui.change(ui.field("Type"), "commitment");
    await ui.change(ui.field("Engagement"), "Répondre au fournisseur");
    await ui.change(ui.field("Responsable"), "Camille");
    await ui.change(ui.field("Échéance"), "2026-10-04");
    await ui.submit();
    expect(ui.container.textContent).toContain("04/10/2026");
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

test("server day includes another dossier's confirmed task, source rationale and partial-data warnings", async () => {
  const ui = await workspace({ day: {
    on: "2026-10-02", verified_at: "2026-10-02T12:00:00Z", proposals: [explainedProposal],
    commitments: [{ dossier_id: "d2", entry_id: "meeting-1", task_id: "task-1", text: "Relire le plan",
      owner: "Alex", due_date: null, status: "confirmed", why_suggested: {
        source: { kind: "meeting", id: "meeting-1" }, rule: "confirmed_task", observed: "confirmed", threshold: null,
        verified_at: "2026-10-02T12:00:00Z", missing_info: ["Échéance"],
      } }], truncated: true, missing_info: ["Source de stock indisponible"],
  } });
  try {
    const day = ui.container.querySelector('[aria-label="Vue journée"]');
    expect(day.textContent).toContain("Relire le plan");
    expect(day.textContent).toContain("confirmed_task");
    expect(day.textContent).toContain("Échéance manquante");
    expect(day.textContent).toContain("Synthèse limitée");
    expect(day.textContent).toContain("Source de stock indisponible");
    await ui.click("Ouvrir le dossier : Chantier");
    expect(ui.container.textContent).toContain("Chantier · fil de travail");
    expect(ui.writes).toHaveLength(0);
  } finally { ui.cleanup(); }
});

test("failed day request explicitly falls back to selected dossier, never a complete-success synthesis", async () => {
  const ui = await workspace({ dayFailure: true });
  try {
    expect(ui.container.querySelector('[aria-label="Vue journée"]').textContent).toContain("Vue journée indisponible");
    expect(ui.container.textContent).toContain("dossier sélectionné uniquement");
    expect(ui.writes).toHaveLength(0);
  } finally { ui.cleanup(); }
});

test("failed day request shows only due confirmed commitments and confirmed meeting tasks", async () => {
  const past = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const ui = await workspace({ dayFailure: true, entries: [
    { id: "due", kind: "commitment", status: "confirmed", content: { text: "Appeler aujourd'hui", owner: "Alex", due_date: past } },
    { id: "future", kind: "commitment", status: "confirmed", content: { text: "Appeler plus tard", owner: "Alex", due_date: future } },
    { id: "proposed", kind: "commitment", status: "proposed", content: { text: "Non validé", owner: "Alex" } },
    { id: "meeting", kind: "meeting", status: "confirmed", content: { title: "Point", notes: "Notes", tasks: [
      { id: "task-due", status: "confirmed", text: "Vérifier le plan", owner: "Alex", due_date: past },
      { id: "task-future", status: "confirmed", text: "Vérifier plus tard", owner: "Alex", due_date: future },
    ] } },
  ] });
  try {
    const day = ui.container.querySelector('[aria-label="Vue journée"]');
    expect(day.textContent).toContain("2 engagement(s) actif(s)");
    expect(day.textContent).toContain("Appeler aujourd'hui");
    expect(day.textContent).toContain("Vérifier le plan");
    expect(day.textContent).not.toContain("Appeler plus tard");
    expect(day.textContent).not.toContain("Non validé");
    expect(day.textContent).not.toContain("Vérifier plus tard");
  } finally { ui.cleanup(); }
});

test("deferred global proposal review sends exact optional resume date and refreshes day", async () => {
  const ui = await workspace({ proposals: [explainedProposal] });
  try {
    await ui.click("Reporter avec un motif");
    await ui.change(ui.field("Motif de la décision"), "Attendre une réponse");
    await ui.change(ui.field("Date de reprise (facultative)"), "2027-01-01");
    await ui.click("Relire cette décision");
    expect(ui.writes).toHaveLength(0);
    await ui.click("Valider l'enregistrement");
    expect(ui.writes[0]).toEqual({ path: "/proposals/stock-proposal/review", method: "POST",
      body: { outcome: "deferred", rationale: "Attendre une réponse", resume_on: "2027-01-01" } });
    expect(global.fetch.mock.calls.filter(([url]) => url.endsWith("/day")).length).toBeGreaterThan(1);
  } finally { ui.cleanup(); }
});

test.each([
  ["accounting-review", "facture:invoice-1", { source: { kind: "facture", id: "invoice-1" } },
    { source: invoice.source, sourced_facts: invoice.data, remaining: null, overdue: null, due_date: null,
      missing_info: ["payment_evidence_ledger"], questions: ["Demander le justificatif"], persisted: false, executed: false }, "Solde : Non renseigné"],
  ["stock-coverage", "stock:item-1", { source: { kind: "stock", id: "item-1" }, horizon_days: 7 },
    { source: stock.source, sourced_facts: stock.data, sales_observation: null, units_per_day: null, coverage_days: null,
      horizon_days: 7, assumptions: ["Aucun mouvement futur connu"], missing_info: ["verified_sales_velocity"], persisted: false, executed: false }, "couverture (jours) : Non renseigné"],
])("review-gated %s keeps missing evidence unknown and uses exact selected source", async (mode, source, body, response, expected) => {
  const ui = await workspace({ preparationResponse: { path: `/${mode}`, body: response } });
  try {
    await ui.change(ui.field("Préparation"), mode);
    await ui.change(ui.field("Source de la préparation"), source);
    await ui.click("Relire la préparation");
    expect(ui.writes).toHaveLength(0);
    await ui.click("Lancer la préparation");
    expect(ui.writes).toEqual([{ path: `/d1/${mode}`, method: "POST", body }]);
    expect(ui.container.querySelector('[aria-label="Résultat de la préparation"]').textContent).toContain(expected);
    expect(ui.container.textContent).toContain(response.missing_info[0]);
  } finally { ui.cleanup(); }
});

test("stock coverage only sends sales after explicit checked observation with time-zone verification", async () => {
  const ui = await workspace({ preparationResponse: { path: "/stock-coverage", body: {
    source: stock.source, units_per_day: 2, coverage_days: 1, horizon_days: 7, missing_info: [],
    sales_observation: { sold_units: 4 }, assumptions: ["Aucun autre mouvement"], persisted: false, executed: false,
  } } });
  try {
    await ui.change(ui.field("Préparation"), "stock-coverage");
    await ui.change(ui.field("Source de la préparation"), "stock:item-1");
    await act(async () => ui.container.querySelector('input[type="checkbox"]').click());
    await ui.click("Relire la préparation");
    expect(ui.writes).toHaveLength(0);
    expect(ui.container.textContent).toContain("L'observation de ventes nécessite");
    await ui.change(ui.field("Unités vendues"), "4");
    await ui.change(ui.field("Début des ventes"), "2026-09-01");
    await ui.change(ui.field("Fin des ventes"), "2026-09-02");
    await ui.change(ui.field("Preuve de ventes"), "Registre signé");
    await ui.change(ui.field("Ventes vérifiées le"), "2026-09-03T10:00");
    await ui.click("Relire la préparation");
    await ui.click("Lancer la préparation");
    expect(ui.writes[0].body).toEqual({
      source: { kind: "stock", id: "item-1" }, horizon_days: 7,
      sales: { sold_units: 4, period_start: "2026-09-01", period_end: "2026-09-02",
        evidence: "Registre signé", verified_at: new Date("2026-09-03T10:00").toISOString(), verified: true },
    });
    expect(ui.container.textContent).toContain("non attestée indépendamment");
  } finally { ui.cleanup(); }
});

test("architect decision keeps plan constraints and impacts human-declared, journal is a read", async () => {
  const ui = await workspace();
  try {
    await ui.change(ui.field("Titre de la modification"), "Déplacer la cloison");
    await ui.change(ui.field("Justification architecte"), "Préserver la circulation");
    await ui.change(ui.field("Alternatives (une par ligne)"), "Garder le plan\nDéplacer la cloison");
    await ui.change(ui.field("Contraintes de plan / devis (une par ligne)"), "Plan version 3 à vérifier");
    await ui.change(ui.field("Impacts déclarés, non déduits (un par ligne)"), "Devis à revoir");
    await ui.click("Relire la préparation");
    expect(ui.writes).toHaveLength(0);
    await ui.click("Enregistrer la proposition");
    expect(ui.writes[0]).toEqual({ path: "/d1/architect-decisions", method: "POST", body: {
      title: "Déplacer la cloison", outcome: "deferred", rationale: "Préserver la circulation",
      alternatives: ["Garder le plan", "Déplacer la cloison"], constraints: ["Plan version 3 à vérifier"], declared_impacts: ["Devis à revoir"],
    } });
    await ui.click("Voir le journal architecte");
    expect(ui.container.querySelector('[aria-label="Journal des décisions architecte"]')).toBeTruthy();
    expect(ui.writes).toHaveLength(1);
  } finally { ui.cleanup(); }
});

test("architect links explicit plan, devis and milestone versions without inventing documents", async () => {
  const ui = await workspace();
  try {
    await ui.change(ui.field("Titre de la modification"), "Modifier le plan");
    await ui.change(ui.field("Justification architecte"), "Accès à revoir");
    await ui.change(ui.field("Alternatives (une par ligne)"), "Plan initial");
    await ui.change(ui.field("Référence plan (déclarée)"), "Plan A");
    await ui.click("Relire la préparation");
    expect(ui.writes).toHaveLength(0);
    expect(ui.container.textContent).toContain("référence et la version du plan");
    await ui.change(ui.field("Version plan (déclarée)"), "v3");
    await ui.change(ui.field("Référence devis (déclarée)"), "DEV-42");
    await ui.change(ui.field("Version devis (déclarée)"), "v2");
    await ui.change(ui.field("Référence jalon (déclarée)"), "Livraison");
    await ui.change(ui.field("Version jalon (déclarée)"), "2026-12");
    await ui.click("Relire la préparation");
    await ui.click("Enregistrer la proposition");
    expect(ui.writes[0].body.document_links).toEqual([
      { role: "plan", reference: "Plan A", version: "v3" },
      { role: "devis", reference: "DEV-42", version: "v2" },
      { role: "jalon", reference: "Livraison", version: "2026-12" },
    ]);
  } finally { ui.cleanup(); }
});

test("private review queue distinguishes pending confirmation from external action reported by user", async () => {
  const draft = { id: "draft-1", dossier_id: "d1", kind: "draft", status: "confirmed",
    content: { type: "stock_reorder", lines: [{ label: "Papier", qty: 3, unit_price: null }], notes: "À vérifier" },
    sources: [] };
  const decision = { id: "decision-1", dossier_id: "d2", kind: "decision", status: "proposed",
    content: { outcome: "deferred", rationale: "Attendre", next_step: null }, sources: [] };
  const ui = await workspace({ entries: [draft], reviewQueue: [
    { entry: draft, dossier_id: "d1", stage: "manual_followup", source_changed: false },
    { entry: decision, dossier_id: "d2", stage: "to_confirm", source_changed: false },
  ] });
  try {
    const queue = ui.container.querySelector('[aria-label="File de relecture"]');
    expect(queue.textContent).toContain("À relire avant confirmation");
    expect(queue.textContent).toContain("Suite manuelle à déclarer");
    expect(ui.writes).toHaveLength(0);
    await ui.change(ui.field("Suite réalisée hors de ΣIRIUS (déclaration non vérifiée)"), "Commande passée ailleurs");
    await ui.click("Relire la déclaration externe");
    expect(ui.writes).toHaveLength(0);
    expect(ui.container.querySelector('[aria-label="Validation avant enregistrement"]').textContent).toContain("non vérifiée");
    await ui.click("Valider l'enregistrement");
    expect(ui.writes[0]).toEqual({ path: "/d1/entries/draft-1/manual-outcome", method: "POST",
      body: { rationale: "Commande passée ailleurs" } });
    expect(ui.writes.some((write) => write.path.includes("/order") || write.path.includes("/send"))).toBe(false);
  } finally { ui.cleanup(); }
});

test("manual customer selection sends prose as suggestion, not an inferred contact history", async () => {
  const client = { source: { kind: "client", id: "client-1", module: "themis" }, data: { name: "Camille", email: "camille@example.test" } };
  const ui = await workspace({ sources: [client] });
  try {
    await ui.change(ui.field("Préparation"), "customer-followups");
    await ui.change(ui.field("Source de la préparation"), "client:client-1");
    await ui.change(ui.field("Objectif du suivi client"), "Demander une confirmation");
    await ui.change(ui.field("Suggestion de courrier client"), "Pourriez-vous confirmer le devis ?");
    await ui.click("Relire la préparation");
    expect(ui.writes).toHaveLength(0);
    await ui.click("Enregistrer la proposition");
    expect(ui.writes[0]).toEqual({ path: "/d1/customer-followups", method: "POST", body: {
      source: { kind: "client", id: "client-1" }, objective: "Demander une confirmation", suggested_prose: "Pourriez-vous confirmer le devis ?",
    } });
  } finally { ui.cleanup(); }
});

test("client events require a selected client, review, and a confirmed due date for a sourced follow-up", async () => {
  const client = { source: { kind: "client", id: "client-1", module: "themis" }, data: { name: "Camille" } };
  const event = { id: "event-1", kind: "client_event", status: "confirmed",
    content: { kind: "callback_promised", note: "Rappeler après accord", occurred_on: "2026-10-01", follow_up_on: "2026-10-02" } };
  const ui = await workspace({ sources: [client], clientTimeline: {
    events: [event], needs_review: [{ entry_id: "event-2", source: client.source,
      reason: "La source client a changé ; vérifier avant toute relance." }],
    followups: [{ entry_id: "event-1", source: client.source,
      kind: "callback_promised", note: "Rappeler après accord", follow_up_on: "2026-10-02",
      why_suggested: { source: client.source, rule: "Date de suivi saisie volontairement et échue.",
        observed: "2026-10-02", threshold: "2026-10-02", verified_at: "2026-10-02T10:00:00Z",
        missing_info: ["consent_to_contact_not_verified"] }, execution: "manual_only" }], truncated: false,
  } });
  try {
    await ui.change(ui.field("Préparation"), "client-events");
    await ui.change(ui.field("Source de la préparation"), "client:client-1");
    await ui.change(ui.field("Nature de l'événement"), "callback_promised");
    await ui.change(ui.field("Échange ou promesse consignée"), "Rappeler après accord");
    await ui.change(ui.field("Date de l'événement"), "2026-10-01");
    await ui.change(ui.field("Date de suivi souhaitée"), "2026-10-02");
    await ui.click("Relire la préparation");
    expect(ui.writes).toHaveLength(0);
    await ui.click("Enregistrer la proposition");
    expect(ui.writes[0]).toEqual({ path: "/d1/client-events", method: "POST", body: {
      source: { kind: "client", id: "client-1" }, kind: "callback_promised",
      note: "Rappeler après accord", occurred_on: "2026-10-01", follow_up_on: "2026-10-02",
    } });
    await ui.click("Voir le carnet client");
    const timeline = ui.container.querySelector('[aria-label="Carnet client volontaire"]');
    expect(timeline.textContent).toContain("Rappeler après accord");
    expect(timeline.textContent).toContain("consent_to_contact_not_verified");
    expect(timeline.textContent).toContain("La source client a changé");
    expect(ui.writes).toHaveLength(1);
  } finally { ui.cleanup(); }
});

test("writing revision preserves exact parent and renders facts, prose, missing information separately", async () => {
  const writing = { id: "writing-1", kind: "writing_revision", status: "proposed", sources: [invoice.source],
    content: { title: "Lettre", revision: 1, sourced_facts: [{ source: invoice.source, facts: { number: "FAC-1" } }],
      suggested_prose: "Formulation à vérifier", prose_is_verified: false, missing_facts: ["Date de livraison"], checks: ["Relire les faits"] } };
  const ui = await workspace({ entries: [writing] });
  try {
    const entry = ui.container.querySelector("#work-entry-writing-1");
    expect(entry.textContent).toContain("Faits sourcés");
    expect(entry.textContent).toContain("Formulation à vérifier");
    expect(entry.textContent).toContain("Date de livraison");
    await ui.change(ui.field("Préparation"), "writing-revisions");
    await ui.change(ui.field("Titre de la révision"), "Lettre corrigée");
    await ui.change(ui.field("Suggestion de révision"), "Nouvelle formulation");
    await ui.change(ui.field("Faits manquants (un par ligne)"), "Date de livraison\nAccord du client");
    await ui.change(ui.field("Révision précédente (facultative)"), "writing-1");
    await ui.click("Relire la préparation");
    await ui.click("Enregistrer la proposition");
    expect(ui.writes[0]).toEqual({ path: "/d1/writing-revisions", method: "POST", body: {
      title: "Lettre corrigée", suggested_prose: "Nouvelle formulation", missing_facts: ["Date de livraison", "Accord du client"], revision_of: "writing-1",
    } });
    await ui.click("Relire puis valider");
    expect(ui.container.querySelector('[aria-label="Validation avant enregistrement"]').textContent).toContain("Formulation à vérifier");
  } finally { ui.cleanup(); }
});

test("HACCP inspection requires explicit period and site and cannot claim compliance from missing evidence", async () => {
  const ui = await workspace({ preparationResponse: { path: "/inspection-preparation", body: {
    period_start: "2026-09-01", period_end: "2026-09-30", site_id: "site-1",
    evidence: { trace: [], documents: [], nonconformities: [], temperatures: [], cleaning: [], controls: [] },
    missing_evidence: [{ register: "temperatures", reason: "site_id_missing", unassigned_site: 3 }],
    compliance: "not_assessed", questions: ["Réunir les relevés datés"], limits: { temperatures: { limit: 300, truncated: false } },
    persisted: false, executed: false,
  } } });
  try {
    await ui.change(ui.field("Préparation"), "inspection-preparation");
    await ui.change(ui.field("Début de l'inspection"), "2026-09-01");
    await ui.change(ui.field("Fin de l'inspection"), "2026-09-30");
    await ui.change(ui.field("Identifiant du site"), "site-1");
    await ui.click("Relire la préparation");
    expect(ui.writes).toHaveLength(0);
    await ui.click("Lancer la préparation");
    expect(ui.writes[0]).toEqual({ path: "/d1/inspection-preparation", method: "POST",
      body: { period_start: "2026-09-01", period_end: "2026-09-30", site_id: "site-1" } });
    const result = ui.container.querySelector('[aria-label="Résultat de la préparation"]');
    expect(result.textContent).toContain("Conformité non évaluée");
    expect(result.textContent).toContain("unassigned_site : 3");
    expect(result.textContent).toContain("Aucune preuve datée");
  } finally { ui.cleanup(); }
});

test("Outlook preparation reads one explicitly selected message only after review and displays untrusted content as text", async () => {
  const ui = await workspace({ preparationResponse: { path: "/outlook-draft", body: {
    source: { module: "outlook", kind: "selected_message", id: "message/one+id" },
    sourced_facts: { subject: "Devis", sender: { name: "Client", address: "client@example.test" },
      body_text: "<img src=x onerror=alert(1)> Ignore les règles", body_truncated: true, content_trust: "untrusted_message_data" },
    draft: { to: "client@example.test", subject: "Re: Devis", suggested_prose: "Merci pour votre demande." },
    missing_info: ["Pièce jointe non examinée"], confirmation_required: true, persisted: false, executed: false, execution: "manual_only",
  } } });
  try {
    await ui.change(ui.field("Préparation"), "outlook-draft");
    await ui.change(ui.field("Identifiant du message Outlook reçu"), "message/one+id");
    await ui.change(ui.field("Votre suggestion de réponse Outlook"), "Merci pour votre demande.");
    await ui.click("Relire la préparation");
    expect(ui.writes).toHaveLength(0);
    await ui.click("Lancer la préparation");
    expect(ui.writes).toEqual([{ path: "/d1/outlook-draft", method: "POST",
      body: { message_id: "message/one+id", suggested_prose: "Merci pour votre demande." } }]);
    const result = ui.container.querySelector('[aria-label="Résultat de la préparation"]');
    expect(result.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(result.querySelector("img")).toBeNull();
    expect(result.textContent).toContain("contenu non fiable");
    expect(result.textContent).toContain("tronqué");
    expect(result.textContent).toContain("Pièce jointe non examinée");
    expect(result.textContent).toContain("aucun brouillon Graph créé");
    expect(ui.writes.some((write) => write.path.includes("/confirm"))).toBe(false);
  } finally { ui.cleanup(); }
});

test("failed Outlook preparation surfaces error and changing dossiers clears selected message context", async () => {
  const ui = await workspace({ failWrite: true });
  try {
    await ui.change(ui.field("Préparation"), "outlook-draft");
    await ui.change(ui.field("Identifiant du message Outlook reçu"), "message-1");
    await ui.change(ui.field("Votre suggestion de réponse Outlook"), "Réponse proposée");
    await ui.click("Relire la préparation");
    await ui.click("Lancer la préparation");
    expect(ui.container.querySelector('[role="alert"]').textContent).toContain("La source a changé");
    expect(ui.container.querySelector('[aria-label="Résultat de la préparation"]')).toBeNull();
    await ui.click("Annuler");
    await ui.click("Chantier · Chantier");
    expect(ui.field("Identifiant du message Outlook reçu")).toBeUndefined();
    expect(ui.field("Préparation").value).toBe("architect-decisions");
  } finally { ui.cleanup(); }
});
