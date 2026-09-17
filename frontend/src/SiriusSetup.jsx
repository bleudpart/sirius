// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useState, useRef } from "react";
import { User, KeyRound, Sparkles, ExternalLink, X, Download, Upload, Music, Volume2, Brain, Monitor, RotateCcw, CheckCircle2, XCircle, Loader2, Zap, Layers, Rocket } from "lucide-react";
import { speakFr, speakAsCharacter, CHAR_PROFILES, MYTHOS_VOICES, loadCharOverrides, DEFAULT_VOICE, loadVoiceConfig } from "@/voice";
import { HUD_DEFAULTS, loadHud, saveHud } from "@/hudPrefs";
import { ConfirmButton } from "@/ConfirmButton";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const TABS = [
  { id: "profil", label: "PROFIL", Icon: User },
  { id: "voix", label: "VOIX", Icon: Volume2 },
  { id: "ia", label: "IA", Icon: Brain },
  { id: "hud", label: "HUD", Icon: Monitor },
  { id: "api", label: "API", Icon: KeyRound },
];
const KEY_META = {
  groq: { service: "k3", label: "Clé Kimi K3 (Moonshot)", tag: "cerveau · optionnelle", url: "https://platform.moonshot.cn/console/api-keys", ph: "sk-...", note: "Sans clé personnelle, Sirius utilise la clé du serveur." },
  serp: { service: "serp", label: "Clé SerpAPI", tag: "recherche web", url: "https://serpapi.com/manage-api-key", ph: "...", note: "Infos du web en temps réel (météo, actualités)." },
  fal: { service: "fal", label: "Clé fal.ai", tag: "clips vidéo", url: "https://fal.ai/dashboard/keys", ph: "...", note: "Génération de clips vidéo uniquement." },
  gmaps: { service: "gmaps", label: "Clé Google Maps", tag: "géocodage LOCUS#", url: "https://console.cloud.google.com/apis/credentials", ph: "AIza...", note: "Sans clé : Nominatim/OpenStreetMap (gratuit)." },
  alphavantage: { service: "alphavantage", label: "Clé Alpha Vantage", tag: "bourse ORACLE#", url: "https://www.alphavantage.co/support/#api-key", ph: "...", note: "Cotations boursières réelles (25 req/jour)." },
};

// Composant stable (hors du parent) : préserve le DOM et le focus à chaque frappe
function KeyField({ k, value, status, onChange, onTest }) {
  const meta = KEY_META[k];
  return (
    <div className="setup-keyfield">
      <label className="setup-label">
        {meta.label} <span className={`setup-tag ${k === "groq" ? "" : "opt"}`}>{meta.tag}</span>
        <a className="setup-link" href={meta.url} target="_blank" rel="noreferrer">obtenir <ExternalLink size={11} /></a>
      </label>
      <div className="setup-keyrow">
        <input className="setup-input" type="password" value={value} onChange={onChange} placeholder={meta.ph} data-testid={`setup-key-${k}`} />
        <button type="button" className="setup-keytest" onClick={onTest} disabled={status?.loading} data-testid={`setup-keytest-${k}`}>
          {status?.loading ? <Loader2 size={13} className="spin" /> : "TESTER"}
        </button>
      </div>
      {status && !status.loading && (
        <p className={`setup-keystatus ${status.ok ? "ok" : "ko"}`} data-testid={`setup-keystatus-${k}`}>
          {status.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />} {status.message}
        </p>
      )}
      {(!status || status.loading) && <p className="setup-note">{meta.note}</p>}
    </div>
  );
}

// Écran de configuration — 5 onglets : PROFIL / VOIX / IA / HUD / API (ergonomie Bastien & Scapin).
export default function SiriusSetup({ initialProfile, initialKeys, onComplete, onCancel }) {
  const [tab, setTab] = useState("profil");
  const [profile, setProfile] = useState({
    name: "", age: "", profession: "", city: "", gender: "", interests: "", style: "",
    ...(initialProfile || {}),
  });
  const [keys, setKeys] = useState({
    groq: (initialKeys && initialKeys.groq) || "",
    serp: (initialKeys && initialKeys.serp) || "",
    fal: (initialKeys && initialKeys.fal) || "",
    gmaps: (initialKeys && initialKeys.gmaps) || "",
    alphavantage: (initialKeys && initialKeys.alphavantage) || "",
  });
  const setP = (k) => (e) => setProfile((p) => ({ ...p, [k]: e.target.value }));
  const setK = (k) => (e) => { setKeys((s) => ({ ...s, [k]: e.target.value })); setKeyStatus((st) => ({ ...st, [k]: null })); };
  const fileRef = useRef(null);

  // Validation des clés API (Gestion des erreurs : valider avant de sauvegarder)
  const [keyStatus, setKeyStatus] = useState({});
  const testKey = async (k) => {
    const meta = KEY_META[k];
    const val = (keys[k] || "").trim();
    if (!val) { setKeyStatus((s) => ({ ...s, [k]: { ok: false, message: "Clé vide." } })); return; }
    setKeyStatus((s) => ({ ...s, [k]: { loading: true } }));
    try {
      const r = await fetch(`${API}/keys/validate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: meta.service, key: val }),
      });
      const d = await r.json();
      setKeyStatus((s) => ({ ...s, [k]: { ok: !!d.ok, message: d.message || "" } }));
    } catch (e) {
      setKeyStatus((s) => ({ ...s, [k]: { ok: false, message: "Vérification impossible — backend injoignable." } }));
    }
  };

  // Musique
  const [musicSource, setMusicSource] = useState(() => localStorage.getItem("sirius_music_source") || "ask");
  const [ambientTrack, setAmbientTrack] = useState(() => localStorage.getItem("sirius_ambient_track") || "epique");

  // Voix
  const [voiceCfg, setVoiceCfg] = useState(loadVoiceConfig);
  const updateVoice = (patch) => setVoiceCfg((v) => {
    const nv = { ...v, ...patch };
    localStorage.setItem("sirius_voice", JSON.stringify(nv));
    return nv;
  });
  const [voiceTesting, setVoiceTesting] = useState(false);
  const testVoice = () => {
    if (voiceTesting) return;
    setVoiceTesting(true);
    speakFr("Bonjour, je suis Sirius, votre assistant personnel. Comment puis-je vous aider aujourd'hui ?", { onend: () => setVoiceTesting(false) });
  };

  // IA : mode Rapide (Groq direct) / Profond (Kimi + Groq)
  const [iaMode, setIaMode] = useState(() => localStorage.getItem("sirius_ia_mode") || "jarvis");
  const saveIaMode = (m) => { setIaMode(m); localStorage.setItem("sirius_ia_mode", m); };

  // HUD : transparence, taille, mode minimal
  const [hud, setHud] = useState(loadHud);
  const [readAloudOn, setReadAloudOn] = useState(localStorage.getItem("sirius_read_aloud") !== "off");
  const updateHud = (patch) => setHud((h) => { const nh = { ...h, ...patch }; saveHud(nh); return nh; });

  // Dictionnaire vocal
  const [phoneticDict, setPhoneticDict] = useState(() => {
    try { return JSON.parse(localStorage.getItem("sirius_phonetic")) || []; } catch (e) { return []; }
  });
  const [newWord, setNewWord] = useState("");
  const [newSay, setNewSay] = useState("");
  const savePhonetic = (list) => { setPhoneticDict(list); localStorage.setItem("sirius_phonetic", JSON.stringify(list)); };
  const addPhonetic = () => {
    const mot = newWord.trim(), dit = newSay.trim();
    if (!mot || !dit) return;
    savePhonetic([...phoneticDict.filter((x) => x.mot.toLowerCase() !== mot.toLowerCase()), { mot, dit }]);
    setNewWord(""); setNewSay("");
  };
  const dictKeyDown = (e) => { if (e.key === "Enter") { e.preventDefault(); addPhonetic(); } };

  // Voix des personnages Mythos : gravité/débit ajustables par dieu
  const [charSel, setCharSel] = useState("PANTHÉON#");
  const [charOv, setCharOv] = useState(loadCharOverrides);
  const charDefaults = MYTHOS_VOICES[CHAR_PROFILES[charSel]] || {};
  const charCur = { gPitch: charOv[charSel]?.gPitch ?? charDefaults.gPitch ?? 0, rate: charOv[charSel]?.rate ?? charDefaults.rate ?? 1 };
  const updateChar = (patch) => {
    const next = { ...charOv, [charSel]: { ...charOv[charSel], ...patch } };
    setCharOv(next);
    localStorage.setItem("sirius_char_voices", JSON.stringify(next));
  };
  const resetChar = () => {
    const next = { ...charOv };
    delete next[charSel];
    setCharOv(next);
    localStorage.setItem("sirius_char_voices", JSON.stringify(next));
  };

  const [saved, setSaved] = useState(false);
  const [updateStatus, setUpdateStatus] = useState("");

  const checkForUpdate = async () => {
    if (!window.siriusUpdates?.check) {
      setUpdateStatus("Mise à jour disponible uniquement dans l'application Windows.");
      return;
    }
    setUpdateStatus("Vérification en cours...");
    const result = await window.siriusUpdates.check();
    if (!result?.ok) setUpdateStatus("Vérification impossible pour le moment.");
    else if (result.available) setUpdateStatus("Nouvelle version détectée. Téléchargement en cours...");
    else setUpdateStatus("SIRIUS est à jour.");
  };

  const exportProfile = () => {
    const data = JSON.stringify({ profile, keys, _app: "ΣIRIUS", _version: 1 }, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "sirius-profil.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };
  const importProfile = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (data.profile) setProfile((p) => ({ ...p, ...data.profile }));
        if (data.keys) setKeys((k) => ({ ...k, ...data.keys }));
        if (!data.profile && !data.keys) alert("Ce fichier .json ne contient pas de profil ni de clés Sirius.");
      } catch (err) {
        alert("Fichier .json invalide. Vérifiez son contenu et réessayez.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const submit = (e) => {
    e.preventDefault();
    if (!profile.name.trim()) { setTab("profil"); return; }
    if (musicSource === "ask") localStorage.removeItem("sirius_music_source");
    else localStorage.setItem("sirius_music_source", musicSource);
    localStorage.setItem("sirius_ambient_track", ambientTrack);
    const cleanKeys = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, (v || "").trim()]));
    setSaved(true);
    setTimeout(() => onComplete({ ...profile, name: profile.name.trim() }, cleanKeys), 850);
  };

  const isEdit = !!(initialProfile && (initialProfile.name || initialProfile.prenom));

  return (
    <div className="setup-screen" data-testid="sirius-setup">
      <div className="setup-grid-bg" />
      <form className="setup-card" onSubmit={submit}>
        {isEdit && (
          <button type="button" className="setup-close" onClick={onCancel} data-testid="setup-close" aria-label="Fermer">
            <X size={20} />
          </button>
        )}
        <div className="setup-head">
          <Sparkles size={26} />
          <div>
            <h1 className="setup-title">CONFIGURATION DE ΣIRIUS</h1>
            <p className="setup-sub">Personnalisez votre assistant. Tout reste sur votre ordinateur.</p>
          </div>
        </div>

        <div className="setup-tabs" data-testid="setup-tabs">
          {TABS.map((t) => (
            <button key={t.id} type="button" className={`setup-tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)} data-testid={`setup-tab-${t.id}`}>
              <t.Icon size={14} /> {t.label}
            </button>
          ))}
        </div>

        {tab === "profil" && (
          <section className="setup-section setup-single" data-testid="setup-panel-profil">
            <label className="setup-label">Prénom *</label>
            <input className="setup-input" value={profile.name} onChange={setP("name")} placeholder="Ex : Daniel" data-testid="setup-name" required />
            <div className="setup-row">
              <div style={{ flex: 1 }}>
                <label className="setup-label">Âge</label>
                <input className="setup-input" type="number" min="1" max="120" value={profile.age} onChange={setP("age")} placeholder="Ex : 34" data-testid="setup-age" />
              </div>
              <div style={{ flex: 1 }}>
                <label className="setup-label">Genre</label>
                <select className="setup-input" value={profile.gender} onChange={setP("gender")} data-testid="setup-gender">
                  <option value="">—</option>
                  <option value="Homme">Homme</option>
                  <option value="Femme">Femme</option>
                  <option value="Autre">Autre</option>
                </select>
              </div>
            </div>
            <div className="setup-row">
              <div style={{ flex: 1 }}>
                <label className="setup-label">Profession</label>
                <input className="setup-input" value={profile.profession} onChange={setP("profession")} placeholder="Ex : Électricien" data-testid="setup-profession" />
              </div>
              <div style={{ flex: 1 }}>
                <label className="setup-label">Ville (météo)</label>
                <input className="setup-input" value={profile.city} onChange={setP("city")} placeholder="Ex : Lyon" data-testid="setup-city" />
              </div>
            </div>
            <label className="setup-label">Centres d'intérêt</label>
            <textarea className="setup-input setup-textarea" value={profile.interests} onChange={setP("interests")} placeholder="Ex : astronomie, football, cuisine..." data-testid="setup-interests" rows={2} />
            <label className="setup-label">Mon style d'écriture <span className="setup-tag opt">Ghost Writer</span></label>
            <textarea className="setup-input setup-textarea" value={profile.style} onChange={setP("style")} placeholder="Collez 2-3 exemples de textes que VOUS avez écrits. Sirius imitera votre style avec « écris ... comme moi »." data-testid="setup-style" rows={3} />
            <label className="setup-label"><Music size={13} style={{ marginRight: 6, verticalAlign: "-2px" }} />Service musique</label>
            <select className="setup-input" value={musicSource} onChange={(e) => setMusicSource(e.target.value)} data-testid="setup-music-source">
              <option value="ask">Me demander à chaque fois</option>
              <option value="spotify">Toujours Spotify</option>
              <option value="youtube">Toujours YouTube</option>
            </select>
          </section>
        )}

        {tab === "voix" && (
          <section className="setup-section setup-single" data-testid="setup-panel-voix">
            <label className="setup-label">Préréglage <span className="setup-tag opt">1 clic</span></label>
            <button
              type="button"
              className={`setup-voice-preset ${voiceCfg.name === "browser-female" ? "active" : ""}`}
              onClick={() => updateVoice({ name: "browser-female", rate: 1.0, pitch: 1.08 })}
              data-testid="setup-voice-preset-browser-female"
              title="Activer la voix féminine synthétique locale"
            >
              <b>Féminine synthétique — locale</b>
              <span>Voix française Windows ou navigateur · Sans clé API · Disponible hors ligne</span>
              {voiceCfg.name === "browser-female" && <i className="setup-preset-check">ACTIVE</i>}
            </button>
            <button
              type="button"
              className={`setup-voice-preset ${voiceCfg.name === "browser" ? "active" : ""}`}
              onClick={() => updateVoice({ name: "browser", rate: 1.0, pitch: 0.85 })}
              data-testid="setup-voice-preset-browser-male"
              title="Activer la voix masculine synthétique locale"
            >
              <b>Masculine synthétique — locale</b>
              <span>Voix française Windows ou navigateur · Timbre posé · Sans clé API · Disponible hors ligne</span>
              {voiceCfg.name === "browser" && <i className="setup-preset-check">ACTIVE</i>}
            </button>
            <button
              type="button"
              className={`setup-voice-preset ${voiceCfg.name === "fr-FR-Neural2-F" && voiceCfg.rate === 1 && voiceCfg.pitch === 2 ? "active" : ""}`}
              onClick={() => updateVoice({ name: "fr-FR-Neural2-F", rate: 1.0, pitch: 2 })}
              data-testid="setup-voice-preset-neural2f"
              title="Activer la voix féminine premium"
            >
              <b>Neural2-F — Féminine premium</b>
              <span>Débit 1.00× · Gravité +2 · Timbre clair et dynamique · Articulation précise</span>
              {voiceCfg.name === "fr-FR-Neural2-F" && voiceCfg.rate === 1 && voiceCfg.pitch === 2 && <i className="setup-preset-check">ACTIVE</i>}
            </button>
            <label className="setup-label">Voix</label>
            <select className="setup-input" value={voiceCfg.name} onChange={(e) => updateVoice({ name: e.target.value })} data-testid="setup-voice-name">
              <option value="browser-female">Féminine synthétique — locale (recommandée)</option>
              <option value="fr-FR-Neural2-G">Neural2-G — neurale premium (recommandée)</option>
              <option value="fr-FR-Neural2-F">Neural2-F — féminine premium (claire & dynamique)</option>
              <option value="fr-FR-Wavenet-G">Wavenet-G — WaveNet</option>
              <option value="browser">Masculine synthétique — locale</option>
            </select>
            <label className="setup-label">Débit <span className="setup-tag opt">{voiceCfg.rate.toFixed(2)}×</span></label>
            <input className="setup-range" type="range" min="0.7" max="1.4" step="0.05" value={voiceCfg.rate}
              onChange={(e) => updateVoice({ rate: parseFloat(e.target.value) })} data-testid="setup-voice-rate" />
            {!voiceCfg.name.startsWith("browser") && (
              <>
                <label className="setup-label">Gravité <span className="setup-tag opt">{voiceCfg.pitch <= -6 ? "très grave" : voiceCfg.pitch <= -2 ? "grave" : voiceCfg.pitch >= 2 ? "claire" : "naturelle"} ({voiceCfg.pitch > 0 ? `+${voiceCfg.pitch}` : voiceCfg.pitch})</span></label>
                <input className="setup-range" type="range" min="-10" max="4" step="0.5" value={voiceCfg.pitch}
                  onChange={(e) => updateVoice({ pitch: parseFloat(e.target.value) })} data-testid="setup-voice-pitch" />
              </>
            )}
            <div className="setup-actions">
              <button type="button" className="setup-voice-test" onClick={testVoice} disabled={voiceTesting} data-testid="setup-test-voice">
                <Volume2 size={15} /> {voiceTesting ? "Lecture en cours..." : "Tester la voix"}
              </button>
              <ConfirmButton className="setup-reset" label="CONFIRMER ?" title="Réinitialiser la voix" testId="setup-reset-voice"
                onConfirm={() => { localStorage.setItem("sirius_voice", JSON.stringify(DEFAULT_VOICE)); setVoiceCfg({ ...DEFAULT_VOICE }); }}>
                <RotateCcw size={13} /> RÉINITIALISER
              </ConfirmButton>
            </div>

            <label className="setup-label" style={{ marginTop: "12px" }}>Voix des personnages Mythos <span className="setup-tag opt">par dieu</span></label>
            <select className="setup-input" value={charSel} onChange={(e) => setCharSel(e.target.value)} data-testid="setup-char-select">
              {Object.keys(CHAR_PROFILES).map((m) => (
                <option key={m} value={m}>{m}{charOv[m] ? " · modifié" : ""}</option>
              ))}
            </select>
            <label className="setup-label">Gravité <span className="setup-tag opt">{charCur.gPitch <= -5 ? "très grave" : charCur.gPitch <= -2 ? "grave" : charCur.gPitch >= 2 ? "claire" : "naturelle"} ({charCur.gPitch})</span></label>
            <input className="setup-range" type="range" min="-10" max="6" step="0.5" value={charCur.gPitch}
              onChange={(e) => updateChar({ gPitch: parseFloat(e.target.value) })} data-testid="setup-char-pitch" />
            <label className="setup-label">Débit <span className="setup-tag opt">{Number(charCur.rate).toFixed(2)}×</span></label>
            <input className="setup-range" type="range" min="0.7" max="1.4" step="0.05" value={charCur.rate}
              onChange={(e) => updateChar({ rate: parseFloat(e.target.value) })} data-testid="setup-char-rate" />
            <div className="setup-actions">
              <button type="button" className="setup-voice-test" onClick={() => speakAsCharacter(`${charSel.replace("#", "")}. Voici mon timbre de voix, monsieur.`, { module: charSel })} data-testid="setup-char-test">
                <Volume2 size={15} /> Écouter
              </button>
              <ConfirmButton className="setup-reset" label="CONFIRMER ?" title="Revenir au profil par défaut" testId="setup-char-reset" onConfirm={resetChar}>
                <RotateCcw size={13} /> DÉFAUT
              </ConfirmButton>
            </div>

            <label className="setup-label" style={{ marginTop: "12px" }}>Dictionnaire vocal <span className="setup-tag opt">prononciations</span></label>
            <p className="setup-note">Mot mal prononcé → graphie phonétique (ex : « Cortex » → « cortèxe »).</p>
            {phoneticDict.map((e) => (
              <div key={e.mot} className="setup-dict-row" data-testid="setup-dict-row">
                <span className="setup-dict-word">{e.mot}</span>
                <span className="setup-dict-arrow">→</span>
                <span className="setup-dict-say">{e.dit}</span>
                <button type="button" className="setup-dict-btn" title="Écouter" onClick={() => speakFr(e.dit)} data-testid={`setup-dict-listen-${e.mot}`}>
                  <Volume2 size={13} />
                </button>
                <button type="button" className="setup-dict-btn del" title="Supprimer" onClick={() => savePhonetic(phoneticDict.filter((x) => x.mot !== e.mot))} data-testid={`setup-dict-del-${e.mot}`}>
                  <X size={13} />
                </button>
              </div>
            ))}
            <div className="setup-dict-add">
              <input className="setup-input" value={newWord} onChange={(e) => setNewWord(e.target.value)} onKeyDown={dictKeyDown} placeholder="Mot (ex : Cortex)" data-testid="setup-dict-word-input" />
              <input className="setup-input" value={newSay} onChange={(e) => setNewSay(e.target.value)} onKeyDown={dictKeyDown} placeholder="Prononciation" data-testid="setup-dict-say-input" />
              <button type="button" className="setup-dict-addbtn" onClick={addPhonetic} disabled={!newWord.trim() || !newSay.trim()} data-testid="setup-dict-add-btn">AJOUTER</button>
            </div>
          </section>
        )}

        {tab === "ia" && (
          <section className="setup-section setup-single" data-testid="setup-panel-ia">
            <label className="setup-label">Mode de raisonnement</label>
            <div className="setup-modes">
              <button type="button" className={`setup-mode ${iaMode === "rapide" ? "active" : ""}`} onClick={() => saveIaMode("rapide")} data-testid="setup-ia-rapide">
                <Zap size={16} />
                <b>RAPIDE</b>
                <span>Groq seul. Réponse immédiate, analyse légère.</span>
              </button>
              <button type="button" className={`setup-mode ${iaMode === "jarvis" ? "active" : ""}`} onClick={() => saveIaMode("jarvis")} data-testid="setup-ia-jarvis">
                <Rocket size={16} />
                <b>JARVIS</b>
                <span>Groq répond instantanément, Kimi K3 corrige en arrière-plan. Recommandé.</span>
              </button>
              <button type="button" className={`setup-mode ${iaMode === "profond" ? "active" : ""}`} onClick={() => saveIaMode("profond")} data-testid="setup-ia-profond">
                <Layers size={16} />
                <b>PROFOND</b>
                <span>Kimi K3 analyse, Groq formule. Plus lent, plus rigoureux.</span>
              </button>
            </div>
            <p className="setup-note">Le mode s'applique immédiatement à toutes les réponses du chat principal.</p>
            <div className="setup-actions">
              <ConfirmButton className="setup-reset" label="CONFIRMER ?" title="Réinitialiser l'IA" testId="setup-reset-ia"
                onConfirm={() => saveIaMode("jarvis")}>
                <RotateCcw size={13} /> RÉINITIALISER
              </ConfirmButton>
            </div>
          </section>
        )}

        {tab === "hud" && (
          <section className="setup-section setup-single" data-testid="setup-panel-hud">
            <label className="setup-label">Transparence des panneaux <span className="setup-tag opt">{Math.round(hud.alpha * 100)} %</span></label>
            <input className="setup-range" type="range" min="0.4" max="1" step="0.05" value={hud.alpha}
              onChange={(e) => updateHud({ alpha: parseFloat(e.target.value) })} data-testid="setup-hud-alpha" />
            <label className="setup-label">Taille du texte</label>
            <div className="setup-sizes">
              {[["S", 0.9], ["M", 1], ["L", 1.1]].map(([l, z]) => (
                <button key={l} type="button" className={`setup-size ${hud.zoom === z ? "active" : ""}`} onClick={() => updateHud({ zoom: z })} data-testid={`setup-hud-size-${l}`}>{l}</button>
              ))}
            </div>
            <label className="setup-label">Mode d'affichage</label>
            <div className="setup-modes">
              <button type="button" className={`setup-mode ${hud.minimal ? "active" : ""}`} onClick={() => updateHud({ minimal: true })} data-testid="setup-hud-minimal">
                <b>HUD MINIMAL</b>
                <span>Cœur + commande. Panneaux latéraux masqués.</span>
              </button>
              <button type="button" className={`setup-mode ${!hud.minimal ? "active" : ""}`} onClick={() => updateHud({ minimal: false })} data-testid="setup-hud-complet">
                <b>HUD COMPLET</b>
                <span>Tous les panneaux et décors visibles.</span>
              </button>
            </div>
            <label className="setup-label"><Music size={13} style={{ marginRight: 6, verticalAlign: "-2px" }} />Musique d'ambiance du HUD</label>
            <select className="setup-input" value={ambientTrack} onChange={(e) => setAmbientTrack(e.target.value)} data-testid="setup-ambient-track">
              <option value="epique">Épique — Oedipus at Colonus</option>
              <option value="gregorien">Chant grégorien</option>
              <option value="none">Aucune musique</option>
            </select>
            <label className="setup-label"><Volume2 size={13} style={{ marginRight: 6, verticalAlign: "-2px" }} />Proposition de lecture à voix haute</label>
            <div className="setup-modes">
              <button type="button" className={`setup-mode ${readAloudOn ? "active" : ""}`}
                onClick={() => { localStorage.setItem("sirius_read_aloud", "on"); setReadAloudOn(true); }} data-testid="setup-readaloud-on">
                <b>ACTIVÉE</b>
                <span>Sirius propose de lire les contenus affichés.</span>
              </button>
              <button type="button" className={`setup-mode ${!readAloudOn ? "active" : ""}`}
                onClick={() => { localStorage.setItem("sirius_read_aloud", "off"); setReadAloudOn(false); }} data-testid="setup-readaloud-off">
                <b>COUPÉE</b>
                <span>Aucune proposition de lecture.</span>
              </button>
            </div>
            <div className="setup-actions">
              <ConfirmButton className="setup-reset" label="CONFIRMER ?" title="Réinitialiser le HUD" testId="setup-reset-hud"
                onConfirm={() => { saveHud({ ...HUD_DEFAULTS }); setHud({ ...HUD_DEFAULTS }); }}>
                <RotateCcw size={13} /> RÉINITIALISER
              </ConfirmButton>
            </div>
          </section>
        )}

        {tab === "api" && (
          <section className="setup-section setup-single" data-testid="setup-panel-api">
            <p className="setup-note">Chaque clé reste privée sur votre PC. Testez chaque clé avant d'enregistrer.</p>
            {Object.keys(KEY_META).map((k) => (
              <KeyField key={k} k={k} value={keys[k]} status={keyStatus[k]} onChange={setK(k)} onTest={() => testKey(k)} />
            ))}
            <div className="setup-actions">
              <ConfirmButton className="setup-reset danger" label="CONFIRMER ?" title="Effacer toutes les clés" testId="setup-reset-keys"
                onConfirm={() => { setKeys({ groq: "", serp: "", fal: "", gmaps: "", alphavantage: "" }); setKeyStatus({}); }}>
                <RotateCcw size={13} /> EFFACER LES CLÉS
              </ConfirmButton>
            </div>
          </section>
        )}

        {!keys.groq.trim() && tab === "api" && (
          <div className="setup-warn" data-testid="setup-warn-nogroq">
            Sans clé personnelle, Sirius utilise la clé du serveur — il répond toujours via l'IA connectée.
          </div>
        )}

        <div className="setup-actions" style={{ alignItems: "center", justifyContent: "center" }}>
          <button type="button" className="setup-io-btn" onClick={checkForUpdate} data-testid="setup-check-update">
            <Download size={15} /> MISE À JOUR
          </button>
          {updateStatus && <span className="setup-note" data-testid="setup-update-status">{updateStatus}</span>}
        </div>

        <button type="submit" className="setup-submit" data-testid="setup-submit">
          {isEdit ? "ENREGISTRER" : "DÉMARRER ΣIRIUS"}
        </button>

        {saved && (
          <div className="setup-saved" data-testid="setup-saved">
            ✓ {isEdit ? "Modifications enregistrées" : "Profil enregistré"}
          </div>
        )}

        <div className="setup-io">
          <button type="button" className="setup-io-btn" onClick={exportProfile} data-testid="setup-export">
            <Download size={15} /> EXPORTER (.json)
          </button>
          <button type="button" className="setup-io-btn" onClick={() => fileRef.current && fileRef.current.click()} data-testid="setup-import-btn">
            <Upload size={15} /> IMPORTER (.json)
          </button>
          <input ref={fileRef} type="file" accept="application/json,.json" onChange={importProfile} style={{ display: "none" }} data-testid="setup-import-input" />
        </div>
        <p className="setup-note" style={{ textAlign: "center", marginTop: "8px" }}>
          La sauvegarde contient vos clés API : conservez ce fichier en lieu sûr.
        </p>
      </form>
    </div>
  );
}
