import { useState } from "react";
import { Activity, ArrowLeft, ArrowRight, Check, Pause, Play, Trash2, X } from "lucide-react";
import { API_BASE_URL } from "./lib/api";
import {
  buildSportSession, readSportHistory, saveSportHistory, sportStorageKey, suggestSportAdaptation,
  SPORT_ADAPTATIONS, SPORT_COMFORT, SPORT_EQUIPMENT, SPORT_GOALS,
} from "./sportSessions";
import "./SportCoachPanel.css";

const POSES = {
  chairSquat: { head: [92, 42], limbs: ["92,54 86,85 98,105", "86,85 60,93", "86,85 111,87", "98,105 76,127 59,127", "98,105 120,122 140,122"] },
  wallPush: { head: [72, 43], limbs: ["73,55 93,82 105,109", "93,82 131,66 162,68", "93,82 130,89 162,90", "105,109 81,139 68,139", "105,109 131,139 145,139"] },
  bandRow: { head: [105, 40], limbs: ["105,52 103,92 100,109", "103,77 66,94 57,81", "103,77 142,94 152,81", "100,109 75,139 66,139", "100,109 127,139 137,139"] },
  dumbbellRow: { head: [68, 49], limbs: ["78,56 106,78 125,85", "105,76 74,97 54,96", "105,76 135,71 144,94", "125,85 102,132 88,132", "125,85 146,132 159,132"] },
  bridge: { head: [40, 111], limbs: ["50,109 85,99 118,89", "79,101 65,119", "88,97 89,120", "118,89 141,123 151,123", "118,89 129,126 140,126"] },
  birdDog: { head: [64, 71], limbs: ["77,74 108,83 130,86", "97,82 86,119 73,119", "106,83 110,121 120,121", "129,86 157,67 174,66", "129,86 150,122 160,122"] },
  walk: { head: [100, 39], limbs: ["100,51 99,88 100,106", "100,71 78,83 69,68", "100,71 120,81 127,101", "100,106 74,134 59,134", "100,106 127,129 145,129"] },
};

function MovementIllustration({ kind, name }) {
  const pose = POSES[kind];
  return <svg viewBox="0 0 200 160" role="img" aria-label={`Schéma indicatif : ${name}`} className="sport-figure">
    <rect x="2" y="2" width="196" height="156" rx="14" fill="#081d28" stroke="#426f7d" />
    <path d="M25 143 H175" stroke="#426f7d" strokeWidth="2" />
    {kind === "chairSquat" && <path d="M42 118 H87 M42 118 V143 M87 118 V143" fill="none" stroke="#e3c988" strokeWidth="3" />}
    {kind === "wallPush" && <path d="M176 16 V143" stroke="#e3c988" strokeWidth="4" />}
    {kind === "bandRow" && <path d="M57 81 Q104 112 152 81" fill="none" stroke="#e3c988" strokeWidth="2" />}
    {kind === "dumbbellRow" && <path d="M137 93 H154 M140 84 V101 M151 84 V101" stroke="#e3c988" strokeWidth="3" />}
    {pose.limbs.map((points, index) =>
      <polyline key={index} points={points} fill="none" stroke="#8ee0eb" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />)}
    <circle cx={pose.head[0]} cy={pose.head[1]} r="12" fill="#8ee0eb" />
    <text x="100" y="153" textAnchor="middle" fill="#d5b873" fontSize="9">Schéma pédagogique · pas une analyse de posture</text>
  </svg>;
}

export default function SportCoachPanel({ user, onClose }) {
  return <SportCoachContent key={sportStorageKey(user)} user={user} onClose={onClose} />;
}

function SportCoachContent({ user, onClose }) {
  const [goal, setGoal] = useState("mobilite");
  const [equipment, setEquipment] = useState("aucun");
  const [minutes, setMinutes] = useState(25);
  const [session, setSession] = useState(null);
  const [index, setIndex] = useState(0);
  const [completed, setCompleted] = useState([]);
  const [paused, setPaused] = useState(false);
  const [effort, setEffort] = useState("modere");
  const [comfort, setComfort] = useState("");
  const [preparationEffort, setPreparationEffort] = useState("");
  const [proposal, setProposal] = useState(null);
  const [adaptation, setAdaptation] = useState(null);
  const [history, setHistory] = useState(() => {
    try { return { entries: readSportHistory(localStorage, user), error: "" }; }
    catch (error) { return { entries: [], error: error.message }; }
  });
  const [message, setMessage] = useState("");

  const updatePreparation = (setter, value) => {
    setter(value);
    setProposal(null);
    setAdaptation(null);
  };
  const clearPreparation = () => {
    setComfort("");
    setPreparationEffort("");
    setProposal(null);
    setAdaptation(null);
  };
  const propose = () => {
    try {
      setProposal(suggestSportAdaptation({ goal, comfort, effort: preparationEffort, history: history.entries }));
      setAdaptation(null);
      setMessage("");
    } catch (error) {
      setMessage(`Proposition impossible : ${error.message}`);
    }
  };
  const start = () => {
    setSession(buildSportSession({ goal, equipment, minutes, ...(adaptation ? { adaptation } : {}) }));
    clearPreparation();
    setCompleted([]);
    setIndex(0);
    setPaused(false);
    setEffort("modere");
    setMessage("");
  };
  const finish = () => {
    if (!session) return;
    const entry = {
      id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      at: new Date().toISOString(), goal: session.goal, equipment: session.equipment,
      minutes: session.minutes, exercises: completed, effort,
      ...(session.adaptation ? { adaptation: session.adaptation } : {}),
    };
    try {
      const entries = [entry, ...history.entries].slice(0, 50);
      saveSportHistory(localStorage, user, entries);
      setHistory({ entries, error: "" });
      setSession(null);
      setMessage("Séance enregistrée sur cet appareil.");
    } catch (error) {
      setMessage(`Enregistrement impossible : ${error.message}. La séance reste ouverte.`);
    }
  };
  const erase = () => {
    if (!window.confirm("Effacer définitivement le journal sportif de cet appareil ?")) return;
    try {
      saveSportHistory(localStorage, user, []);
      setHistory({ entries: [], error: "" });
      clearPreparation();
      setMessage("Journal local effacé.");
    } catch (error) {
      setMessage(`Suppression impossible : ${error.message}`);
    }
  };
  const resetUnreadable = () => {
    if (!window.confirm("Le journal est illisible. Effacer définitivement ces données locales pour repartir à zéro ?")) return;
    try {
      localStorage.removeItem(sportStorageKey(user));
      setHistory({ entries: [], error: "" });
      clearPreparation();
      setMessage("Journal local réinitialisé.");
    } catch (error) {
      setMessage(`Réinitialisation impossible : ${error.message}`);
    }
  };
  const exercise = session?.exercises[index];
  const finished = session && index >= session.exercises.length;

  return <section className="prime-screen sport-coach" role="dialog" aria-label="Coach Sport et Bien-être" data-testid="sport-coach">
    <header className="zeus-head sport-head">
      <h1><Activity size={22} /> ASCLÉPIOS# · BIEN-ÊTRE &amp; SANTÉ</h1>
      <button type="button" className="setup-close zeus-close" aria-label="Fermer" onClick={onClose}><X size={18} /></button>
    </header>
    <img className="mythos-avatar" src={`${API_BASE_URL}/mythos/img/asclepios.png`} alt="Portrait d'Asclépios" draggable={false} data-testid="asclepios-portrait" />
    <div className="sport-body">
      <p className="sport-notice">Guide pédagogique pour adultes, pas un avis médical ni une correction de posture. Commence à ton rythme.
        En cas de douleur, malaise, blessure ou condition médicale, arrête et demande un avis professionnel.</p>
      <p className="sport-privacy">Données de séance stockées uniquement sur cet appareil, dans le navigateur et sous ce compte. Elles ne sont ni transmises au serveur ni utilisées pour la proactivité. Sur un appareil partagé, protège ton profil.
        {" "}Les ressentis de préparation et le choix d'adaptation restent temporaires jusqu'à « Terminer et enregistrer » : ce bouton les ajoute au journal si tu as choisi une adaptation. Fermer ou arrêter ne les enregistre pas.</p>
      {history.error && <div role="alert" className="sport-error">
        <p>{history.error} Le journal n'a pas été modifié.</p>
        <button type="button" onClick={resetUnreadable}>Effacer le journal illisible</button>
      </div>}
      {message && <p role="status" className="sport-message">{message}</p>}
      {!session ? <>
        <form className="sport-form" onSubmit={(event) => { event.preventDefault(); start(); }}>
          <label>Objectif<select value={goal} onChange={(event) => updatePreparation(setGoal, event.target.value)}>
            {SPORT_GOALS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select></label>
          <label>Matériel<select value={equipment} onChange={(event) => updatePreparation(setEquipment, event.target.value)}>
            {SPORT_EQUIPMENT.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select></label>
          <label>Temps disponible<select value={minutes} onChange={(event) => updatePreparation(setMinutes, Number(event.target.value))}>
            {[15, 25, 40].map((value) => <option key={value} value={value}>{value} minutes</option>)}
          </select></label>
          <fieldset className="sport-adaptation">
            <legend>Adaptation facultative de la progression</legend>
            <p>Sur demande uniquement, Asclépios utilise tes choix et jusqu'à trois séances récentes de ce journal pour le même objectif.
              Aucune analyse médicale, aucun diagnostic, aucune progression automatique. Tu peux ignorer la proposition.</p>
            <div className="sport-form">
              <label>Confort des mouvements<select value={comfort} onChange={(event) => updatePreparation(setComfort, event.target.value)}>
                <option value="">Choisir (facultatif)</option>
                {SPORT_COMFORT.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </select></label>
              <label>Effort ressenti aujourd'hui<select value={preparationEffort} onChange={(event) => updatePreparation(setPreparationEffort, event.target.value)}>
                <option value="">Choisir (facultatif)</option>
                <option value="facile">Facile</option><option value="modere">Modéré</option><option value="difficile">Difficile</option>
              </select></label>
            </div>
            <button type="button" disabled={!!history.error || !comfort || !preparationEffort} onClick={propose}>Voir les adaptations locales</button>
            {proposal && <div className="sport-proposal" role="status">
              <p>Proposition : {SPORT_ADAPTATIONS.find(([id]) => id === proposal.choice)[1]}. {proposal.reason}</p>
              <p>{proposal.historyCount} séance(s) locale(s) avec mouvement effectué consultée(s). Les étapes passées ne prouvent pas une progression.</p>
              <p>Douce : mêmes mouvements, consignes allégées. Courte : moins de mouvements, environ {minutes === 15 ? 10 : 15} minutes.
                Habituelle : format prévu, sans augmentation.</p>
              <div className="sport-actions" role="group" aria-label="Choisir une adaptation">
                {SPORT_ADAPTATIONS.map(([choice, text]) => <button key={choice} type="button"
                  aria-pressed={adaptation?.choice === choice}
                  onClick={() => setAdaptation({ choice, comfort, effort: preparationEffort })}>Choisir : {text}</button>)}
                <button type="button" onClick={clearPreparation}>Ignorer les adaptations</button>
              </div>
            </div>}
            <p>{adaptation ? `Choix confirmé : ${SPORT_ADAPTATIONS.find(([id]) => id === adaptation.choice)[1]}.`
              : "Aucune adaptation appliquée : séance habituelle."}</p>
          </fieldset>
          <button type="submit" disabled={!!history.error}><Play size={16} /> Préparer une séance</button>
        </form>
        <p>« Prise de masse » propose une pratique régulière de renforcement, sans promettre de résultat, prescrire de charge ou fixer un régime.</p>
        <h2>Journal local</h2>
        {history.entries.length === 0 && <p>Aucune séance enregistrée.</p>}
        {history.entries.map((entry) => <article className="sport-log" key={entry.id}>
          <b>{new Date(entry.at).toLocaleDateString("fr-FR")}</b> · {SPORT_GOALS.find(([id]) => id === entry.goal)?.[1] || entry.goal}
          <span> {entry.exercises.length} mouvement(s) effectué(s) · ressenti : {entry.effort}</span>
          {entry.adaptation && <span> · choix : {SPORT_ADAPTATIONS.find(([id]) => id === entry.adaptation.choice)[1]}
            {" "}· confort de préparation : {SPORT_COMFORT.find(([id]) => id === entry.adaptation.comfort)[1]}
            {" "}· effort de préparation : {entry.adaptation.effort}</span>}
        </article>)}
        {history.entries.length > 0 && <button type="button" onClick={erase}><Trash2 size={15} /> Effacer le journal</button>}
      </> : <>
        <p className="sport-session-choice">Format : {session.adaptation
          ? SPORT_ADAPTATIONS.find(([id]) => id === session.adaptation.choice)[1] : "Habituelle"}
          {" "}· environ {session.minutes} minutes · progression manuelle uniquement.</p>
        <p>{session.warmup}</p>
        <div className="sport-progress">Étape {Math.min(index + 1, session.exercises.length)} / {session.exercises.length} · {completed.length} mouvement(s) noté(s)</div>
        {finished ? <div className="sport-step">
          <h2>Retour au calme</h2><p>{session.cooldown}</p>
          <label>Comment était cette séance ?<select value={effort} onChange={(event) => setEffort(event.target.value)}>
            <option value="facile">Facile</option><option value="modere">Modérée</option><option value="difficile">Difficile</option>
          </select></label>
          <p>Enregistrer ajoute uniquement les mouvements marqués « Effectué », le ressenti final
            {session.adaptation && ", le choix d'adaptation et les ressentis de préparation"} au journal local. Aucun envoi au serveur.</p>
          <button type="button" onClick={finish}><Check size={16} /> Terminer et enregistrer</button>
        </div> : <article className="sport-step">
          <MovementIllustration kind={exercise.illustration} name={exercise.name} />
          <div>
            <h2>{exercise.name}</h2><p>{exercise.group} · {exercise.equipment}</p>
            <p>{exercise.suggestion}</p>
            <ol>{exercise.steps.map((step) => <li key={step}>{step}</li>)}</ol>
            <p className="sport-caution">{exercise.caution}</p>
          </div>
        </article>}
        <div className="sport-actions">
          {!finished && <button type="button" onClick={() => setPaused(!paused)}><Pause size={16} /> {paused ? "Reprendre" : "Pause"}</button>}
          {index > 0 && <button type="button" onClick={() => { setIndex(index - 1); setPaused(false); }}><ArrowLeft size={16} /> Précédent</button>}
          {!finished && <button type="button" disabled={paused} onClick={() => {
            setCompleted((current) => current.includes(exercise.id) ? current : [...current, exercise.id]);
            setIndex(index + 1);
          }}>Effectué <ArrowRight size={16} /></button>}
          {!finished && <button type="button" disabled={paused} onClick={() => setIndex(index + 1)}>Passer</button>}
          <button type="button" onClick={() => { setSession(null); setMessage("Séance arrêtée sans enregistrement."); }}>Arrêter sans enregistrer</button>
        </div>
      </>}
      <p className="sport-sources">Repères généraux : <a href="https://www.who.int/news-room/fact-sheets/detail/physical-activity" target="_blank" rel="noopener noreferrer">OMS · activité physique</a> ; <a href="https://www.cdc.gov/physical-activity-basics/adding-adults/what-counts.html" target="_blank" rel="noopener noreferrer">CDC · activité et renforcement</a>. Les séances proposées sont des exemples pédagogiques, pas des prescriptions de ces organismes.</p>
    </div>
  </section>;
}
