import { useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "./lib/api";
import { checkHaccpResponse, haccpFetch } from "./haccpRequest";
import { translateString } from "./i18n/domTranslator";
import HaccpLabelCapture from "./HaccpLabelCapture";
import HaccpPrinter from "./HaccpPrinter";
import { suggestPreparationRule } from "./haccpShelfLife";
import "./HaccpWorkspace.css";

const EMPTY = { product: "", lot: "", manufacturedAt: "", utcOffset: "", hours: "", conditions: "", reason: "", operator: "Cuisine" };
const PMS_CONDITIONS = "Voir les conditions du PMS en vigueur";
const SUGGESTED_REFERENCE = "Durées prudentes suggérées par ΣIRIUS (ANSES, GBPH), relues et validées par le responsable";

function validRules(rules) {
  return rules === undefined || (rules && typeof rules === "object" && !Array.isArray(rules)
    && Object.values(rules).every((rule) => rule && Number.isSafeInteger(rule.heures) && rule.heures > 0
      && typeof rule.conditions === "string" && rule.conditions.trim()));
}

function validPreparationList(value) {
  return value && Number.isSafeInteger(value.version) && value.version >= 0
    && Array.isArray(value.noms) && value.noms.every((name) => typeof name === "string" && name.trim())
    && typeof value.reference_pms === "string" && validRules(value.regles)
    && (value.version === 0
      ? value.noms.length === 0 && value.duree_heures === null
      : Number.isSafeInteger(value.duree_heures) && value.duree_heures > 0 && value.reference_pms.trim());
}

function savedRule(list, name) {
  const rule = list?.regles?.[name];
  if (rule) return { hours: rule.heures, conditions: rule.conditions };
  return { hours: list?.duree_heures, conditions: PMS_CONDITIONS };
}

function editableRules(list) {
  return Object.fromEntries(Object.entries(list.regles || {})
    .map(([name, rule]) => [name, { hours: String(rule.heures), conditions: rule.conditions }]));
}

function currentParisTime() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map(({ type, value }) => [type, value]));
  const local = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  const localUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second));
  const minutes = Math.round((localUtc - Math.floor(now.getTime() / 1000) * 1000) / 60000);
  if (minutes !== 60 && minutes !== 120) throw new Error("Décalage Europe/Paris indisponible.");
  return { local, offset: minutes === 120 ? "+02:00" : "+01:00" };
}

export default function HaccpPreparation({ establishmentName, sessionReady, kitchenToken = "", mobilePrinting = false }) {
  const [draft, setDraft] = useState(EMPTY);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [list, setList] = useState(null);
  const [listText, setListText] = useState("");
  const [listRules, setListRules] = useState({});
  const [listReference, setListReference] = useState("");
  const [listConfirmed, setListConfirmed] = useState(false);
  const [listBusy, setListBusy] = useState(false);
  const [listMessage, setListMessage] = useState("");
  const [listError, setListError] = useState("");
  const [listReload, setListReload] = useState(0);
  const [selected, setSelected] = useState("");
  const attempt = useRef(null);
  const pending = useRef(false);
  const savingList = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!sessionReady || !establishmentName.trim()) return undefined;
    let active = true;
    setList(null); setListError(""); setListMessage(""); setSelected("");
    const params = new URLSearchParams({ restaurant_name: establishmentName.trim() });
    haccpFetch(`${API_BASE_URL}/haccp/preparations/liste?${params}`, {
      headers: kitchenToken ? { "X-Sirius-Cuisine": kitchenToken } : {},
    }, async (response) => (await checkHaccpResponse(response)).json())
      .then((value) => {
        if (!validPreparationList(value)) throw new Error("Réponse de la mise en place invalide.");
        if (!active) return;
        setList(value); setListText(value.noms.join("\n")); setListRules(editableRules(value));
        setListReference(value.reference_pms || SUGGESTED_REFERENCE); setListConfirmed(false);
      })
      .catch((failure) => { if (active) setListError(failure.message); });
    return () => { active = false; };
  }, [sessionReady, establishmentName, kitchenToken, listReload]);

  const change = (field, value) => {
    setDraft((current) => ({
      ...current, [field]: value,
      ...(field === "manufacturedAt" ? { utcOffset: "" } : {}),
      ...(field === "product" && selected ? { hours: "", conditions: "", reason: "" } : {}),
    }));
    if (field === "product") setSelected("");
    setConfirmed(false);
    setError("");
  };

  const choosePreparation = (name) => {
    setSelected(name);
    const rule = savedRule(list, name);
    let now = null;
    if (name) {
      try { now = currentParisTime(); } catch (failure) { now = null; }
    }
    const next = {
      ...draft, product: name, hours: name ? String(rule.hours) : "",
      conditions: name ? rule.conditions : "", reason: name ? list.reference_pms : "",
      ...(now ? { manufacturedAt: now.local, utcOffset: now.offset } : {}),
    };
    setDraft(next);
    setError("");
    // The manager validated this rule when saving the list: the cook's choice confirms it and creates the label.
    const automatic = Boolean(name && now && next.operator.trim() && !attempt.current);
    setConfirmed(automatic);
    if (automatic) submit(next, true, name);
  };

  const listNames = listText.split("\n").map((name) => name.trim()).filter(Boolean);
  const ruleFor = (name) => {
    if (listRules[name]) return listRules[name];
    if (list?.noms.includes(name) && list.duree_heures) {
      const rule = savedRule(list, name);
      return { hours: String(rule.hours), conditions: rule.conditions };
    }
    const suggestion = suggestPreparationRule(name);
    return { hours: String(suggestion.hours), conditions: suggestion.conditions };
  };
  const changeRule = (name, field, value) => {
    setListRules((current) => ({ ...current, [name]: { ...ruleFor(name), [field]: value } }));
    setListConfirmed(false);
  };
  const suggestAllRules = () => {
    setListRules(Object.fromEntries(listNames.map((name) => {
      const suggestion = suggestPreparationRule(name);
      return [name, { hours: String(suggestion.hours), conditions: suggestion.conditions }];
    })));
    if (!listReference.trim()) setListReference(SUGGESTED_REFERENCE);
    setListConfirmed(false);
  };

  const manufacturedNow = () => {
    try {
      const { local, offset } = currentParisTime();
      setDraft((current) => ({ ...current, manufacturedAt: local, utcOffset: offset }));
      setConfirmed(false); setError("");
    } catch (failure) {
      setError(`Heure de fabrication indisponible : ${failure.message}`);
    }
  };

  const saveList = async () => {
    if (savingList.current || !list) return;
    const names = listNames;
    const regles = Object.fromEntries(names.map((name) => {
      const rule = ruleFor(name);
      return [name, { heures: Number(rule.hours), conditions: rule.conditions.trim() }];
    }));
    const invalid = Object.values(regles).some((rule) => !Number.isSafeInteger(rule.heures) || rule.heures <= 0 || !rule.conditions);
    if (!listConfirmed || invalid || !listReference.trim()) {
      setListError("Indiquez une durée et des conditions pour chaque produit, la référence PMS, puis confirmez.");
      return;
    }
    const hours = names.length ? Math.min(...Object.values(regles).map((rule) => rule.heures)) : (list.duree_heures || 24);
    const removed = list.noms.filter((name) => !names.includes(name));
    const removalMessage = "produit(s) seront retirés de la mise en place. Continuer ?";
    if (removed.length && !window.confirm(`${removed.length} ${translateString(removalMessage) || removalMessage}`)) return;
    savingList.current = true; setListBusy(true); setListError(""); setListMessage("");
    try {
      const value = await haccpFetch(`${API_BASE_URL}/haccp/preparations/liste`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(kitchenToken ? { "X-Sirius-Cuisine": kitchenToken } : {}) },
        body: JSON.stringify({
          restaurant_name: establishmentName.trim(), version: list.version, noms: names,
          duree_heures: hours, reference_pms: listReference.trim(), regles, regle_confirmee: true,
        }),
      }, async (response) => (await checkHaccpResponse(response)).json());
      if (!validPreparationList(value) || value.version !== list.version + 1
          || JSON.stringify(value.noms) !== JSON.stringify(names) || value.duree_heures !== hours
          || value.reference_pms !== listReference.trim()
          || names.some((name) => value.regles?.[name]?.heures !== regles[name].heures
            || value.regles[name].conditions !== regles[name].conditions)) {
        throw new Error("Réponse de liste invalide. Rechargez avant toute autre modification.");
      }
      if (mounted.current) {
        setList(value); setListText(value.noms.join("\n")); setListRules(editableRules(value));
        setListReference(value.reference_pms); setListConfirmed(false);
        if (selected) {
          setSelected(""); setDraft((current) => ({ ...current, hours: "", conditions: "", reason: "" }));
          setConfirmed(false);
        }
        setListMessage("Liste enregistrée pour tous les téléphones de cet établissement.");
      }
    } catch (failure) {
      if (mounted.current) setListError(failure.message);
    } finally {
      savingList.current = false;
      if (mounted.current) setListBusy(false);
    }
  };

  const ready = (values, isConfirmed) => sessionReady && establishmentName.trim() && values.product.trim()
    && values.operator.trim() && values.manufacturedAt && Number.isSafeInteger(Number(values.hours))
    && Number(values.hours) > 0 && values.conditions.trim() && values.reason.trim() && isConfirmed && !busy && !result;
  const canSubmit = ready(draft, confirmed);

  const save = (event) => {
    event.preventDefault();
    submit(draft, confirmed, selected);
  };

  const submit = async (draft, confirmed, selected) => {
    if (pending.current) return;
    if (!ready(draft, confirmed)) {
      setError("Ouvrez le dossier et renseignez le produit, sa fabrication exacte, l’opérateur et la règle de conservation confirmée.");
      return;
    }
    const payload = {
      nom_produit: draft.product.trim(), numero_lot: draft.lot.trim() || null,
      restaurant_name: establishmentName.trim(), operateur: draft.operator.trim(),
      date_fabrication: draft.manufacturedAt + draft.utcOffset, duree_conservation_heures: Number(draft.hours),
      conditions_conservation: draft.conditions.trim(), justification_duree: draft.reason.trim(),
      regle_confirmee: confirmed,
      ...(selected && draft.product.trim() === selected && Number(draft.hours) === savedRule(list, selected).hours
        && draft.reason.trim() === list.reference_pms ? { liste_version: list.version } : {}),
    };
    const snapshot = JSON.stringify(payload);
    if (attempt.current && attempt.current.snapshot !== snapshot) {
      setError("Une tentative existe déjà. Rétablissez les mêmes données pour la vérifier, ou consultez le registre avant de choisir « Nouvelle préparation ».");
      return;
    }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if (!attempt.current) attempt.current = { id: crypto.randomUUID(), snapshot };
      const record = await haccpFetch(`${API_BASE_URL}/haccp/preparations`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(kitchenToken ? { "X-Sirius-Cuisine": kitchenToken } : {}) },
        body: JSON.stringify({ ...payload, capture_id: attempt.current.id }),
      }, async (response) => (await checkHaccpResponse(response)).json());
      if (!record || record.type_operation !== "preparation" || !Number.isSafeInteger(record.id) || record.id < 1
          || typeof record.nom_produit !== "string" || !record.nom_produit.trim()
          || typeof record.conditions_conservation !== "string" || !record.conditions_conservation.trim()
          || !Number.isFinite(Date.parse(record.date_fabrication)) || !Number.isFinite(Date.parse(record.dlc_secondaire))) {
        throw new Error("Réponse de préparation invalide. Vérifiez le registre avant toute impression.");
      }
      if (mounted.current) setResult(record);
    } catch (failure) {
      if (failure.status === 422 || failure.status === 412) attempt.current = null;
      if (mounted.current) {
        if (failure.status === 412) {
          setSelected(""); setConfirmed(false);
          setDraft((current) => ({ ...current, hours: "", conditions: "", reason: "" }));
          setListReload((current) => current + 1);
        }
        setError(failure.status === 422 || failure.status === 412 ? failure.message
          : `${failure.message} En cas de coupure, réessayez les mêmes données sans doublon ou vérifiez le registre.`);
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const reset = () => {
    attempt.current = null;
    setDraft((current) => ({ ...EMPTY, operator: current.operator }));
    setConfirmed(false);
    setResult(null);
    setError("");
    setSelected("");
  };

  const lotField = <label>Lot de préparation (facultatif, sinon généré)
    <input maxLength={128} value={draft.lot} onChange={(event) => change("lot", event.target.value)} />
  </label>;
  const ruleFields = <>
    <label>Durée de conservation validée (heures entières)
      <input type="number" min="1" step="1" required value={draft.hours} onChange={(event) => change("hours", event.target.value)} />
    </label>
    <label>Conditions de conservation : température, contenant et précautions
      <textarea required maxLength={500} value={draft.conditions} onChange={(event) => change("conditions", event.target.value)} />
    </label>
    <label>Référence de la règle PMS applicable à ce produit
      <textarea required maxLength={500} value={draft.reason} onChange={(event) => change("reason", event.target.value)} />
    </label>
  </>;

  return <section className="workspace-surface haccp-card haccp-preparation" aria-label="Étiquette de préparation">
    <h3>Préparation · DLC interne</h3>
    {!result && <>
      <p>Saisissez l’heure réelle de fabrication en Europe/Paris : « le matin » ne suffit pas. Aucune photo ni analyse IA n’est nécessaire.</p>
      <p className="haccp-notice">La durée et les conditions doivent être validées pour ce produit dans votre PMS.
        Aucune durée J+3 n’est imposée. Si votre règle prévoit 72 heures après fabrication, saisissez 72 :
        il s’agit d’heures écoulées, pas d’une fin de journée automatique.</p>
    </>}
    {(!sessionReady || !establishmentName.trim()) && <p role="status">Ouvrez le dossier de l’établissement puis choisissez « Reprendre / Continuer » si proposé.</p>}
    {!result && <form onSubmit={save}>
      <fieldset className="haccp-capture-fields" disabled={busy || !sessionReady || !establishmentName.trim()}>
        <legend>Produit fabriqué sur place</legend>
        {list?.noms.length > 0 && <label>Mise en place de la carte
          <select value={selected} onChange={(event) => choosePreparation(event.target.value)}>
            <option value="">Choisir un produit de la mise en place</option>
            {[...list.noms].sort((a, b) => a.localeCompare(b, "fr")).map((name) => <option key={name} value={name} translate="no">{name}</option>)}
          </select>
        </label>}
        {list?.noms.length > 0 && <p>Choisir un produit de la mise en place suffit : fabrication à l’heure actuelle, DLC calculée et étiquette prête à imprimer.</p>}
        <label>Nom du produit
          <input required maxLength={255} value={draft.product} onChange={(event) => change("product", event.target.value)} />
        </label>
        {selected ? <details><summary>Lot de préparation (facultatif)</summary>{lotField}</details> : lotField}
        <label>Date et heure de fabrication (Europe/Paris)
          <input type="datetime-local" step="1" required value={draft.manufacturedAt} onChange={(event) => change("manufacturedAt", event.target.value)} />
        </label>
        <button type="button" onClick={manufacturedNow}>Fabrication maintenant</button>
        <p>Pour une préparation faite plus tôt, saisissez son heure réelle, pas l’heure de fin de service.</p>
        <details><summary>Changement d’heure : préciser une heure répétée</summary>
          <label>Décalage UTC de l’heure de fabrication
            <select value={draft.utcOffset} onChange={(event) => change("utcOffset", event.target.value)}>
              <option value="">Automatique — Europe/Paris</option>
              <option value="+02:00">Heure d’été — UTC+02:00</option>
              <option value="+01:00">Heure d’hiver — UTC+01:00</option>
            </select>
          </label>
          <p>Lors du passage à l’heure d’hiver, précisez laquelle des deux occurrences vous avez relevée. Une heure inexistante ou un décalage incohérent sera refusé.</p>
        </details>
        {selected ? <details>
          <summary>Règle : {draft.hours || "à vérifier"} h après fabrication · {draft.reason || "PMS à vérifier"}</summary>
          {ruleFields}
        </details> : ruleFields}
        {!kitchenToken && <label>Opérateur
          <input required maxLength={100} value={draft.operator} onChange={(event) => change("operator", event.target.value)} />
        </label>}
        <label className="haccp-check"><input type="checkbox" required checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          Je confirme la fabrication saisie et la règle de conservation validée pour ce produit et ses conditions.
        </label>
        <button type="submit" className="haccp-primary" disabled={!canSubmit} aria-busy={busy}>
          {busy ? "Enregistrement de la préparation…" : "Calculer la DLC et générer l’étiquette"}
        </button>
      </fieldset>
    </form>}
    {error && <p role="alert">{error}</p>}
    {result && <HaccpLabelCapture key={result.id} savedRecord={result} kitchenToken={kitchenToken}
      mobilePrinting={mobilePrinting} onPrintBusyChange={setPrinting} />}
    {(result || attempt.current) && <>
      {!result && <p>Avant de repartir sur une nouvelle fiche après une erreur, vérifiez que la précédente n’est pas déjà au registre.</p>}
      <button type="button" disabled={busy || printing} onClick={reset}>Nouvelle préparation</button>
    </>}
    {sessionReady && establishmentName.trim() && <>
      {listError && <p role="alert">{listError}</p>}
      {listError && <button type="button" onClick={() => {
        const message = "Copiez les modifications non enregistrées avant de recharger. Continuer ?";
        if (list && !window.confirm(translateString(message) || message)) return;
        setListReload((current) => current + 1);
      }}>Recharger la liste</button>}
      {list && <details className="haccp-preparation-list">
        <summary>Modifier la mise en place de la carte</summary>
        <p>Un produit de mise en place par ligne. ΣIRIUS propose une durée prudente pour chaque produit d’après son nom :
          24 h pour l’œuf cru, la mayonnaise, le poisson cru ou le fromage frais entamé ; 48 h pour la volaille, la viande,
          les crudités et les produits entamés ; 72 h pour les plats et sauces cuits. En cas de doute, la durée la plus
          courte est retenue. Relisez et ajustez selon votre PMS avant d’enregistrer : la liste est partagée sur les téléphones du restaurant.</p>
        <fieldset className="haccp-capture-fields" disabled={listBusy}>
          <label>Produits de la mise en place
            <textarea rows="9" value={listText} onChange={(event) => { setListText(event.target.value); setListConfirmed(false); }} />
          </label>
          {listNames.length > 0 && <>
            <button type="button" onClick={suggestAllRules}>Recalculer toutes les durées automatiquement</button>
            <div className="haccp-preparation-rules">
              {listNames.map((name) => {
                const rule = ruleFor(name);
                return <div key={name} className="haccp-preparation-rule">
                  <span translate="no">{name}</span>
                  <input type="number" min="1" step="1" aria-label={`Heures de conservation : ${name}`} value={rule.hours}
                    onChange={(event) => changeRule(name, "hours", event.target.value)} />
                  <input maxLength={500} aria-label={`Conditions de conservation : ${name}`} value={rule.conditions}
                    onChange={(event) => changeRule(name, "conditions", event.target.value)} />
                </div>;
              })}
            </div>
          </>}
          <label>Référence PMS commune
            <input maxLength={500} value={listReference} onChange={(event) => { setListReference(event.target.value); setListConfirmed(false); }} />
          </label>
          <label className="haccp-check"><input type="checkbox" checked={listConfirmed} onChange={(event) => setListConfirmed(event.target.checked)} />
            J’ai relu la durée et les conditions de chaque produit de la mise en place et je les valide pour mon PMS.
          </label>
          <button type="button" className="haccp-primary" disabled={listBusy || !listConfirmed} onClick={saveList}>
            {listBusy ? "Enregistrement de la liste…" : "Enregistrer la liste"}
          </button>
        </fieldset>
        {listMessage && <p role="status">{listMessage}</p>}
      </details>}
    </>}
    {!kitchenToken && <details><summary>Configurer l’imprimante (une seule fois)</summary><HaccpPrinter /></details>}
  </section>;
}
