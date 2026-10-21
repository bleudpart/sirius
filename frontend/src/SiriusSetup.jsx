// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useState, useRef, useEffect } from "react";
import { User, KeyRound, Sparkles, ExternalLink, X, Download, Upload, Music, Volume2, Brain, Monitor, RotateCcw, CheckCircle2, XCircle, Loader2, Zap, Layers, Rocket, HardDrive } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { speakFr, speakAsCharacter, CHAR_PROFILES, MYTHOS_VOICES, loadCharOverrides, DEFAULT_VOICE, AEDES_VOICE, loadVoiceConfig } from "@/voice";
import VoiceEqualizerPanel from "./VoiceEqualizerPanel";
import { GEMINI_VOICE, GEMINI_TIMBRES, geminiTimbreFor } from "./voice";
import { HUD_DEFAULTS, loadHud, saveHud } from "@/hudPrefs";
import { ConfirmButton } from "@/ConfirmButton";
import { exportAccountProfile, importAccountProfile, validatePersonalService } from "@/accountSetup";
import { assertSecureKeyTransport, loadApiKeys } from "@/apiKeyStorage";
import AccountServices from "@/AccountServices";
import VaultControls, { persistPersonalKeys } from "@/VaultControls";
import PrivacyData from "@/PrivacyData";
import { EMAIL_HELP_URL } from "@/helpLinks";

const TABS = [
  { id: "profil", label: "PROFIL", Icon: User },
  { id: "voix", label: "VOIX", Icon: Volume2 },
  { id: "ia", label: "IA", Icon: Brain },
  { id: "hud", label: "HUD", Icon: Monitor },
  { id: "stockage", label: "STOCKAGE", Icon: HardDrive },
  { id: "confidentialite", label: "CONFIDENTIALITÉ ET DONNÉES", Icon: HardDrive },
  { id: "api", label: "CLÉS API ET SERVICES", Icon: KeyRound },
];
const MAIN_KEYS = ["cerebras", "groq_key"];
const KEY_META = {
  cerebras: { service: "cerebras", label: "Clé Cerebras (gpt-oss-120b)", tag: "conversation rapide · optionnelle", url: "https://cloud.cerebras.ai", ph: "Votre future clé API Cerebras", note: "Prêt à configurer plus tard : laissez ce champ vide tant que vous n'avez pas de clé Cerebras. Groq reste utilisable sans cette clé ; la transcription vocale continue avec Groq. Une fois votre clé ajoutée, Cerebras devient prioritaire pour les réponses rapides. Consultez ses quotas et tarifs." },
  groq_key: { service: "groq_real", label: "Clé Groq (transcription et repli IA)", tag: "microphone · repli conversation", url: "https://console.groq.com/keys", ph: "gsk_...", note: "Conservez cette clé pour la transcription vocale. Sans clé Cerebras, Groq continue à fournir les réponses IA." },
  groq: { service: "k3", label: "Clé Kimi (Moonshot)", tag: "réflexion approfondie · optionnelle", url: "https://platform.moonshot.cn/console/api-keys", ph: "sk-...", note: "Kimi 2.6 apporte la réflexion approfondie ; Cerebras ou Groq formule la réponse. Le modèle Kimi existant est conservé." },
  serp: { service: "serp", label: "Clé SerpAPI", tag: "recherche web", url: "https://serpapi.com/manage-api-key", ph: "...", note: "Infos du web en temps réel (météo, actualités)." },
  fal: { service: "fal", label: "Clé fal.ai", tag: "clips vidéo", url: "https://fal.ai/dashboard/keys", ph: "...", note: "Génération de clips vidéo uniquement." },
  gmaps: { service: "gmaps", label: "Clé Google Maps", tag: "carte Google LOCUS", url: "https://console.cloud.google.com/apis/credentials", ph: "AIza...", note: "Clé Maps JavaScript API utilisée dans le navigateur. Restreignez-la aux origines autorisées. Le test côté serveur ne confirme pas la carte ; la recherche d'adresses n'est pas disponible actuellement." },
  alphavantage: { service: "alphavantage", label: "Clé Alpha Vantage", tag: "bourse ORACLE", url: "https://www.alphavantage.co/support/#api-key", ph: "...", note: "Cotations boursières réelles (25 req/jour)." },
  google_tts: { service: "google_tts", label: "Clé Google TTS", tag: "lecture vocale cloud · optionnelle", url: "https://console.cloud.google.com/apis/credentials", ph: "...", note: "La lecture locale de l'appareil reste possible sans cette clé." },
  gemini_tts: { service: "gemini_tts", label: "Clé Gemini TTS", tag: "lecture vocale Gemini · optionnelle", url: "https://aistudio.google.com/api-keys", ph: "...", note: "Service facultatif, soumis à la tarification de votre fournisseur." },
};
const KEY_GUIDE = {
  cerebras: [
    "Connectez-vous à Cerebras Cloud et consultez les quotas et tarifs.",
    "Créez une clé API dans votre compte, puis copiez-la dans ce champ dédié, jamais dans Groq ou Kimi.",
  ],
  groq_key: [
    "Connectez-vous à la console Groq ou créez votre compte.",
    "Dans API Keys, créez une nouvelle clé nommée « Mon ΣIRIUS », puis copiez-la.",
  ],
  groq: [
    "Connectez-vous à Moonshot et consultez les tarifs et le crédit disponible.",
    "Dans API Keys, créez et copiez une clé. Une clé de la plateforme internationale Kimi doit correspondre au service configuré sur le backend ; ne la collez pas dans Groq.",
  ],
  serp: [
    "Créez votre compte SerpAPI et choisissez une offre adaptée au nombre de recherches souhaité.",
    "Dans Manage API Key, copiez la clé privée de votre compte.",
  ],
  fal: [
    "Connectez-vous à fal.ai et vérifiez les tarifs des modèles et votre crédit.",
    "Dans Keys, créez une clé autorisant les appels de modèles (préréglage API lorsqu'il est proposé), puis copiez-la.",
  ],
  gmaps: [
    "Dans Google Cloud, choisissez ou créez un projet et vérifiez les conditions de facturation.",
    "Activez Maps JavaScript API, puis ouvrez API et services → Identifiants → Créer des identifiants → Clé API.",
    "Restreignez la clé à Maps JavaScript API et aux sites/origines autorisés. Ne supprimez pas les restrictions pour réussir un test serveur.",
    "Le test serveur ne valide pas cette clé navigateur : vérifiez ensuite la carte LOCUS. La recherche d'adresses n'est pas disponible ; une carte OpenStreetMap reste possible sans clé Google.",
  ],
  alphavantage: [
    "Sur la page Alpha Vantage, remplissez le formulaire de demande de clé API.",
    "Copiez la clé fournie après la demande et vérifiez les quotas de votre offre.",
  ],
  google_tts: [
    "Dans Google Cloud, choisissez ou créez un projet, puis vérifiez et configurez la facturation requise.",
    "Activez Cloud Text-to-Speech API dans la bibliothèque des API.",
    "Dans API et services → Identifiants, créez une clé API dédiée et restreignez-la à Cloud Text-to-Speech API. Les restrictions doivent convenir aux appels du backend, pas aux seuls sites Web.",
  ],
  gemini_tts: [
    "Connectez-vous à Google AI Studio et ouvrez la page API Keys.",
    "Créez une clé dans le projet approprié, puis copiez-la. Vérifiez l'accès aux modèles vocaux, les quotas et la facturation : une clé valide ne garantit pas cet accès.",
  ],
};

// Composant stable (hors du parent) : préserve le DOM et le focus à chaque frappe
function KeyField({ k, value, status, onChange, onTest }) {
  const meta = KEY_META[k];
  return (
    <div className="setup-keyfield">
      <label className="setup-label">
        {meta.label} <span className={`setup-tag ${k === "groq_key" ? "" : "opt"}`}>{meta.tag}</span>
        <a className="setup-link" href={meta.url} target="_blank" rel="noreferrer">obtenir <ExternalLink size={11} /></a>
      </label>
      <div className="setup-keyrow">
        <input className="setup-input" type="password" value={value} onChange={onChange} placeholder={meta.ph} maxLength={4096} autoComplete="off" data-testid={`setup-key-${k}`} />
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

// Écran de configuration — les réglages techniques restent réservés à l'administrateur.
export default function SiriusSetup({ initialProfile, initialKeys, initialTab = "profil", onComplete, onCancel, onOpenAccount, onMemory, onConnections, showAdvanced = false }) {
  const [tab, setTab] = useState(initialTab);
  const [savingKeys, setSavingKeys] = useState(false);
  const visibleTabs = TABS;
  const [profile, setProfile] = useState({
    name: "", age: "", profession: "", city: "", gender: "", interests: "", style: "",
    ...(initialProfile || {}),
  });
  const [keys, setKeys] = useState({
    cerebras: (initialKeys && initialKeys.cerebras) || "",
    groq_key: (initialKeys && initialKeys.groq_key) || "",
    groq: (initialKeys && initialKeys.groq) || "",
    serp: (initialKeys && initialKeys.serp) || "",
    fal: (initialKeys && initialKeys.fal) || "",
    gmaps: (initialKeys && initialKeys.gmaps) || "",
    alphavantage: (initialKeys && initialKeys.alphavantage) || "",
    google_tts: (initialKeys && initialKeys.google_tts) || "",
    gemini_tts: (initialKeys && initialKeys.gemini_tts) || "",
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
      assertSecureKeyTransport();
      const d = await validatePersonalService(meta.service, val);
      setKeyStatus((s) => ({ ...s, [k]: { ok: !!d.ok, message: d.message || "" } }));
    } catch (e) {
      setKeyStatus((s) => ({ ...s, [k]: { ok: false, message: "Vérification impossible — utilisez un backend HTTPS ou local et vérifiez sa connexion." } }));
    }
  };
  const validateKeys = async (nextKeys) => {
    assertSecureKeyTransport();
    const unverified = [];
    for (const [name, value] of Object.entries(nextKeys)) {
      if (!value) continue;
      const meta = KEY_META[name];
      if (!meta) throw new Error("Ces clés contiennent un service non pris en charge.");
      const result = await validatePersonalService(meta.service, value);
      const ok = result.ok === true;
      setKeyStatus((current) => ({ ...current, [name]: { ok, message: result.message || (ok ? "Test réussi." : "Service non validé.") } }));
      if (!ok && result.status === "unverifiable") unverified.push(meta.label);
      else if (!ok) throw new Error(`${meta.label} : vérification non réussie. Corrigez la clé ou réessayez avant l'enregistrement.`);
    }
    return unverified;
  };

  // Musique
  const [musicSource, setMusicSource] = useState(() => localStorage.getItem("sirius_music_source") || "ask");
  const [ambientTrack, setAmbientTrack] = useState(() => localStorage.getItem("sirius_ambient_track") || "epique");

  // Voix
  const [voiceCfg, setVoiceCfg] = useState(loadVoiceConfig);
  const localVoice = voiceCfg.name.startsWith("browser");
  const updateVoice = (patch) => setVoiceCfg((v) => {
    const nv = { ...v, ...patch };
    if (patch.name && patch.pitch === undefined && patch.name.startsWith("browser") !== v.name.startsWith("browser")) {
      nv.pitch = patch.name.startsWith("browser")
        ? Math.max(0.5, Math.min(2, 2 ** (v.pitch / 12)))
        : Math.max(-10, Math.min(4, 12 * Math.log2(v.pitch)));
    }
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
  const [actionConfirmOn, setActionConfirmOn] = useState(localStorage.getItem("sirius_action_confirm") !== "off");
  const [hudError, setHudError] = useState("");
  const updateHud = (patch) => {
    const next = { ...hud, ...patch };
    try { saveHud(next); setHud(next); setHudError(""); }
    catch (error) { console.error("Réglages d'affichage :", error); setHudError("Les réglages n'ont pas été enregistrés. Votre affichage précédent est conservé. Libérez le stockage du navigateur puis réessayez."); }
  };
  const [nas, setNas] = useState(() => {
    try { return JSON.parse(localStorage.getItem("sirius_nas")) || { path: "", enabled: false }; } catch (e) { return { path: "", enabled: false }; }
  });
  const [nasSaved, setNasSaved] = useState(false);
  const saveNas = () => {
    const next = { path: nas.path.trim(), enabled: !!nas.path.trim() };
    setNas(next);
    localStorage.setItem("sirius_nas", JSON.stringify(next));
    setNasSaved(true);
    setTimeout(() => setNasSaved(false), 2200);
  };

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
  const [saveError, setSaveError] = useState("");
  const [updateStatus, setUpdateStatus] = useState("");
  const [updateProgress, setUpdateProgress] = useState(null);
  const updatePollRef = useRef(null);

  const stopUpdatePoll = () => {
    if (updatePollRef.current) clearInterval(updatePollRef.current);
    updatePollRef.current = null;
  };
  useEffect(() => stopUpdatePoll, []);

  // Retourne true quand il n'y a plus rien à suivre (prête, erreur ou état inconnu).
  const showUpdateState = (s) => {
    const v = s?.version ? ` ${s.version}` : "";
    if (s?.phase === "ready") {
      setUpdateProgress({ phase: "ready", percent: 100 });
      setUpdateStatus(`Mise à jour${v} prête — fermez SIRIUS pour l'installer.`);
      return true;
    }
    if (s?.phase === "error") {
      setUpdateProgress(null);
      setUpdateStatus("Téléchargement interrompu. Nouvel essai automatique plus tard.");
      return true;
    }
    if (s?.phase === "downloading") {
      const percent = Math.max(0, Math.min(100, s.percent || 0));
      setUpdateProgress({ phase: "downloading", percent });
      setUpdateStatus(`Nouvelle version${v} en téléchargement… ${percent} %`);
      return false;
    }
    setUpdateProgress(null);
    return true;
  };

  const checkForUpdate = async () => {
    stopUpdatePoll();
    setUpdateProgress(null);
    if (!window.siriusUpdates?.check) {
      setUpdateStatus("Mise à jour disponible uniquement dans l'application Windows.");
      return;
    }
    setUpdateStatus("Vérification en cours...");
    const result = await window.siriusUpdates.check();
    if (!result?.ok) { setUpdateStatus("Vérification impossible pour le moment."); return; }
    if (!result.available) { setUpdateStatus("SIRIUS est à jour."); return; }
    if (!window.siriusUpdates.status) {
      setUpdateStatus("Nouvelle version détectée. Téléchargement en cours...");
      return;
    }
    if (showUpdateState(result.phase === "idle" ? { ...result, phase: "downloading" } : result)) return;
    updatePollRef.current = setInterval(async () => {
      try {
        if (showUpdateState(await window.siriusUpdates.status())) stopUpdatePoll();
      } catch (e) {
        stopUpdatePoll();
      }
    }, 1500);
  };

  const exportProfile = () => {
    const data = JSON.stringify(exportAccountProfile(profile), null, 2);
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
        const data = importAccountProfile(JSON.parse(reader.result));
        setProfile((p) => ({ ...p, ...data.profile }));
        if (data.ignoredKeys) alert("Profil importé. Les anciennes clés JSON ne sont pas importées : collez-les dans l'onglet API puis enregistrez.");
      } catch (err) {
        alert("Fichier .json invalide. Vérifiez son contenu et réessayez.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaveError("");
    if (!profile.name.trim()) { setTab("profil"); return; }
    const activeKeys = loadApiKeys();
    const allNames = new Set([...Object.keys(keys), ...Object.keys(activeKeys)]);
    if ([...allNames].some((name) => (keys[name] || "").trim() !== (activeKeys[name] || ""))) {
      setSavingKeys(true);
      try {
        const result = await persistPersonalKeys(keys, validateKeys);
        if (!result) { setTab("api"); setSaveError("Enregistrement annulé."); return; }
      } catch (failure) {
        setTab("api");
        setSaveError(failure.message || "Enregistrement des clés impossible.");
        return;
      } finally {
        setSavingKeys(false);
      }
    }
    if (musicSource === "ask") localStorage.removeItem("sirius_music_source");
    else localStorage.setItem("sirius_music_source", musicSource);
    localStorage.setItem("sirius_ambient_track", ambientTrack);
    setSaved(true);
    setTimeout(() => onComplete({ ...profile, name: profile.name.trim() }, loadApiKeys()), 850);
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
            <p className="setup-sub">Personnalisez votre assistant. Aucun réglage technique n’est obligatoire.</p>
          </div>
        </div>

        <div className="setup-tabs" data-testid="setup-tabs">
          {visibleTabs.map((t) => (
            <button key={t.id} type="button" className={`setup-tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)} data-testid={`setup-tab-${t.id}`}>
              <t.Icon size={14} /> {t.label}
            </button>
          ))}
        </div>

        {tab === "profil" && (
          <section className="setup-section setup-single" data-testid="setup-panel-profil">
            <p className="setup-note">Seul le prénom est demandé pour commencer. Les autres informations sont facultatives. Après l'enregistrement, un guide vous proposera le chat, les dossiers locaux ou la connexion de vos comptes. Le microphone n'est pas nécessaire pour utiliser le chat écrit.</p>
            <button type="button" className="setup-tab" onClick={() => setTab("api")} data-testid="setup-api-btn">
              <KeyRound size={14} /> GÉRER MES CLÉS API
            </button>
            {onOpenAccount && (
              <button type="button" className="setup-tab" onClick={onOpenAccount} data-testid="setup-account-btn">
                <User size={14} /> MON COMPTE
              </button>
            )}
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
            <div className="setup-store-qr" data-testid="setup-store-qr">
              <QRCodeSVG value="https://sirius-assistant.fr/" size={92} bgColor="#dff8ff" fgColor="#061321" level="M" includeMargin />
              <div>
                <b>RETROUVER ΣIRIUS</b>
                <span>Scannez pour découvrir le store SIRIUS.</span>
              </div>
            </div>
          </section>
        )}

        {tab === "voix" && (
          <section className="setup-section setup-single" data-testid="setup-panel-voix">
            <label className="setup-label">Préréglage <span className="setup-tag opt">1 clic</span></label>
            <button type="button" className={`setup-voice-preset ${voiceCfg.name === "gemini" ? "active" : ""}`}
              onClick={() => updateVoice({ ...GEMINI_VOICE })} data-testid="setup-voice-preset-gemini">
              <b>Gemini — voix naturelle PC et téléphone</b>
              <span>Même service vocal que sur Android · Connexion et service Gemini requis · Égaliseur disponible</span>
              {voiceCfg.name === "gemini" && <i className="setup-preset-check">ACTIVE</i>}
            </button>
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
            <button type="button"
              className={`setup-voice-preset ${voiceCfg.name === AEDES_VOICE.name ? "active" : ""}`}
              onClick={() => updateVoice({ ...AEDES_VOICE })}
              data-testid="setup-voice-preset-aedes">
              <b>Voix des AÈDES — ODYSSEIA</b>
              <span>Conteur français masculin · Débit posé · Voix locale de l’appareil, sans clé API</span>
              {voiceCfg.name === AEDES_VOICE.name && <i className="setup-preset-check">ACTIVE</i>}
            </button>
            <label className="setup-label">Voix</label>
            <select className="setup-input" value={voiceCfg.name} onChange={(e) => updateVoice(e.target.value === GEMINI_VOICE.name ? { ...GEMINI_VOICE } : e.target.value === AEDES_VOICE.name ? { ...AEDES_VOICE } : { name: e.target.value })} data-testid="setup-voice-name">
              <option value="gemini">Gemini — voix naturelle PC et téléphone</option>
              <option value="browser-female">Féminine synthétique — locale (recommandée)</option>
              <option value="fr-FR-Neural2-G">Neural2-G — neurale premium (recommandée)</option>
              <option value="fr-FR-Neural2-F">Neural2-F — féminine premium (claire & dynamique)</option>
              <option value="fr-FR-Wavenet-G">Wavenet-G — WaveNet</option>
              <option value="browser">Masculine synthétique — locale</option>
              <option value="browser-aedes">Voix des AÈDES — ODYSSEIA (conteur local)</option>
            </select>
            {voiceCfg.name !== GEMINI_VOICE.name && <>
            <label className="setup-label">Débit <span className="setup-tag opt">{voiceCfg.rate.toFixed(2)}×</span></label>
            <input className="setup-range" type="range" min="0.7" max="1.4" step="0.05" value={voiceCfg.rate}
              onChange={(e) => updateVoice({ rate: parseFloat(e.target.value) })} data-testid="setup-voice-rate" />
            </>}
            {voiceCfg.name === "gemini" ? (
              <>
                <label className="setup-label" htmlFor="setup-gemini-timbre">Timbre Gemini <span className="setup-tag opt">féminin ou masculin</span></label>
                <select id="setup-gemini-timbre" className="setup-input" value={geminiTimbreFor(voiceCfg)}
                  onChange={(e) => updateVoice({ geminiVoice: e.target.value })} data-testid="setup-gemini-timbre">
                  {GEMINI_TIMBRES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
                <p className="setup-note">Le timbre et la diction Gemini sont pilotés par le service vocal. Pour modifier les graves et les aigus du son, utilisez l'égaliseur ci-dessous.</p>
              </>
            ) : localVoice ? (
              <>
                <label className="setup-label" htmlFor="setup-local-voice-pitch">Hauteur — grave / aiguë <span className="setup-tag opt">{voiceCfg.pitch < 0.8 ? "très grave" : voiceCfg.pitch < 1 ? "grave" : voiceCfg.pitch > 1.2 ? "aiguë" : "naturelle"} ({voiceCfg.pitch.toFixed(2)}×)</span></label>
                <input id="setup-local-voice-pitch" className="setup-range" type="range" min="0.5" max="2" step="0.01" value={voiceCfg.pitch}
                  onChange={(e) => updateVoice({ pitch: parseFloat(e.target.value) })} data-testid="setup-voice-pitch" />
              </>
            ) : (
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

            <VoiceEqualizerPanel localVoice={localVoice} />
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
              <button type="button" className="setup-voice-test" onClick={() => speakAsCharacter(`${charSel.replace("#", "")}. Voici mon timbre de voix.`, { module: charSel })} data-testid="setup-char-test">
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

        {tab === "confidentialite" && <PrivacyData onOpenAccount={onOpenAccount} onMemory={onMemory} onConnections={onConnections} />}

        {tab === "hud" && (
          <section className="setup-section setup-single" data-testid="setup-panel-hud">
            <label className="setup-label">Transparence des panneaux <span className="setup-tag opt">{Math.round(hud.alpha * 100)} %</span></label>
            <input className="setup-range" type="range" min="0.4" max="1" step="0.05" value={hud.alpha}
              onChange={(e) => updateHud({ alpha: parseFloat(e.target.value) })} data-testid="setup-hud-alpha" />
            <label className="setup-label">Taille du texte</label>
            <div className="setup-sizes">
              {[["S", 0.9], ["M", 1], ["L", 1.1], ["XL", 1.25]].map(([l, z]) => (
                <button key={l} type="button" className={`setup-size ${hud.zoom === z ? "active" : ""}`} onClick={() => updateHud({ zoom: z })} data-testid={`setup-hud-size-${l}`}>{l}</button>
              ))}
            </div>
            <label className="setup-label">
              <input type="checkbox" checked={!!hud.reducedMotion} onChange={(event) => updateHud({ reducedMotion: event.target.checked })} data-testid="setup-reduced-motion" />
              {" "}Réduire les animations et effets coûteux
            </label>
            <p className="setup-note">Le réglage de réduction des mouvements du système reste respecté. Ce choix réduit aussi les effets du cœur sans modifier les données ou les fonctions métier.</p>
            <label className="setup-label">
              <input type="checkbox" checked={!!hud.highContrast} onChange={(event) => updateHud({ highContrast: event.target.checked })} data-testid="setup-high-contrast" />
              {" "}Renforcer le contraste des textes et contrôles
            </label>
            {hudError && <p role="alert">{hudError}</p>}
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
            <p className="setup-note">Sur Android, pas de pastille : dites « Sirius, lis Zeus Cortex ».</p>
            <label className="setup-label"><Volume2 size={13} style={{ marginRight: 6, verticalAlign: "-2px" }} />Confirmations vocales des actions</label>
            <div className="setup-modes">
              <button type="button" className={`setup-mode ${actionConfirmOn ? "active" : ""}`}
                onClick={() => { localStorage.setItem("sirius_action_confirm", "on"); setActionConfirmOn(true); }} data-testid="setup-actionconfirm-on">
                <b>ACTIVÉES</b>
                <span>« J'ouvre Thémis », « Je ferme Atlas »…</span>
              </button>
              <button type="button" className={`setup-mode ${!actionConfirmOn ? "active" : ""}`}
                onClick={() => { localStorage.setItem("sirius_action_confirm", "off"); setActionConfirmOn(false); }} data-testid="setup-actionconfirm-off">
                <b>COUPÉES</b>
                <span>Les actions s'exécutent sans annonce.</span>
              </button>
            </div>
            <div className="setup-actions">
              <ConfirmButton className="setup-reset" label="CONFIRMER ?" title="Réinitialiser le HUD" testId="setup-reset-hud"
                onConfirm={() => updateHud({ ...HUD_DEFAULTS })}>
                <RotateCcw size={13} /> RÉINITIALISER
              </ConfirmButton>
            </div>
          </section>
        )}

        {tab === "stockage" && (
          <section className="setup-section setup-single" data-testid="setup-panel-stockage">
            <label className="setup-label"><HardDrive size={13} style={{ marginRight: 6, verticalAlign: "-2px" }} />Stockage NAS <span className="setup-tag opt">préparation</span></label>
            <p className="setup-note">Préparez le chemin du serveur. Sirius utilisera ce stockage dès que le NAS sera disponible sur votre réseau.</p>
            <label className="setup-label">Chemin du partage ou URL WebDAV</label>
            <input
              className="setup-input"
              value={nas.path}
              onChange={(e) => setNas((current) => ({ ...current, path: e.target.value }))}
              placeholder="\\\\NAS\Sirius ou https://nas.local/dav"
              data-testid="setup-nas-path"
            />
            <p className="setup-note">Les identifiants ne sont pas enregistrés ici. Configurez les accès sur le NAS ou dans le Gestionnaire d'identifiants Windows.</p>
            <div className="setup-actions">
              <button type="button" className="setup-io-btn" onClick={saveNas} data-testid="setup-nas-save">
                <HardDrive size={15} /> ENREGISTRER LE CHEMIN
              </button>
              {nasSaved && <span className="setup-note" data-testid="setup-nas-saved">Chemin NAS prêt pour la connexion.</span>}
            </div>
          </section>
        )}

        {tab === "api" && (
          <section className="setup-section setup-single" data-testid="setup-panel-api">
            <AccountServices />
            <details data-testid="setup-api-guide">
              <summary>OBTENIR MES CLÉS API — GUIDE COMPLET PAS À PAS</summary>
              <p className="setup-note">Il n'existe pas de clé universelle ni de création de toutes les clés en un clic. Chaque fournisseur demande un compte personnel. Conservez Groq pour la transcription vocale et la conversation sans Cerebras ; vous pourrez ajouter votre clé Cerebras plus tard. Les autres services sont facultatifs. La mémoire locale de ΣIRIUS ne nécessite pas de clé API.</p>
              <ol>
                {Object.entries(KEY_META).map(([name, meta]) => (
                  <li key={name} data-testid={`setup-guide-${name}`}>
                    <h3>{meta.label}</h3>
                    <a className="setup-link" href={meta.url} target="_blank" rel="noreferrer">
                      Ouvrir {meta.label.replace(/^Clé /, "")} <ExternalLink size={11} />
                    </a>
                    <ol>
                      {KEY_GUIDE[name].map((step) => <li key={step}>{step}</li>)}
                      <li>Collez la clé dans « {meta.label} » ci-dessous. Ne communiquez pas votre clé par email ou dans une capture d'écran.</li>
                    </ol>
                  </li>
                ))}
              </ol>
              <h3>Enregistrer vos clés</h3>
              <ol>
                <li>Cliquez sur « ENREGISTRER ». Les clés sont testées, chiffrées sur cet appareil et rechargées automatiquement à chaque démarrage.</li>
                <li>Pour changer d'appareil, ouvrez « Avancé » et téléchargez une sauvegarde.</li>
              </ol>
              <p className="setup-note">Gmail et Outlook se connectent dans le Centre des connexions : leurs comptes ne sont pas des clés à coller ici. Les coûts et quotas restent ceux de chaque fournisseur ; aucune gratuité permanente n'est garantie.</p>
            </details>
            <div className="setup-note" data-testid="setup-email-help">
              <strong>Envoyer vos devis et factures par e-mail :</strong> le réglage se fait dans THÉMIS, onglet CLÉS API (Gmail, Orange, Outlook…).{" "}
              <a className="setup-link" href={EMAIL_HELP_URL} target="_blank" rel="noreferrer">
                Comment faire ? <ExternalLink size={11} />
              </a>
            </div>
            <VaultControls validateKeys={validateKeys} onKeys={(next) => { setKeys(next); setKeyStatus({}); setSaveError(""); }}>
              {MAIN_KEYS.map((k) => (
                <KeyField key={k} k={k} value={keys[k] || ""} status={keyStatus[k]} onChange={setK(k)} onTest={() => testKey(k)} />
              ))}
              <details className="vault-more-keys" data-testid="setup-more-keys"
                open={Object.keys(KEY_META).some((name) => !MAIN_KEYS.includes(name) && initialKeys?.[name]) || undefined}>
                <summary>Autres services (facultatif)</summary>
                {Object.keys(KEY_META).filter((name) => !MAIN_KEYS.includes(name)).map((k) => (
                  <KeyField key={k} k={k} value={keys[k] || ""} status={keyStatus[k]} onChange={setK(k)} onTest={() => testKey(k)} />
                ))}
              </details>
            </VaultControls>
          </section>
        )}

        <div className="setup-actions" style={{ alignItems: "center", justifyContent: "center" }}>
          <button type="button" className="setup-io-btn" onClick={checkForUpdate} data-testid="setup-check-update">
            <Download size={15} /> MISE À JOUR
          </button>
          {updateStatus && <span className="setup-note" data-testid="setup-update-status">{updateStatus}</span>}
        </div>
        {updateProgress && (
          <div
            className={`setup-update-progress${updateProgress.phase === "ready" ? " is-ready" : ""}`}
            role="progressbar"
            aria-label="Téléchargement de la mise à jour"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={updateProgress.percent}
            data-testid="setup-update-progress"
          >
            <span style={{ width: `${updateProgress.percent}%` }} />
          </div>
        )}

        <button type="submit" className="setup-submit" data-testid="setup-submit" disabled={savingKeys}>
          {savingKeys ? "VÉRIFICATION DES CLÉS…" : isEdit ? "ENREGISTRER" : "DÉMARRER ΣIRIUS"}
        </button>
        {saveError && <p className="fw-status ko" role="alert">{saveError}</p>}

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
          Le fichier de profil ne contient aucune clé. Vos clés restent enregistrées sur cet appareil.
        </p>
      </form>
    </div>
  );
}
