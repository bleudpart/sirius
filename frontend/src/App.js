// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).


import { useEffect, useRef, useState, useCallback } from "react";
import { Mic, MicOff, Clock, Cpu, Wifi, Wind, Cloud, Thermometer, MapPin, Calendar, Activity, X, Leaf, UserCog, Brain, Plus, Trash2, Pencil, Check, Music, Youtube, Repeat, RotateCcw, BarChart3, Workflow, FolderOpen, Code2, Database, Sparkles, Eye, Landmark, Library, Orbit, Monitor, ShieldCheck, AudioLines, Radar, ShieldAlert, Camera, Fingerprint, Zap, Package, Clapperboard, Grip, Radio, Wrench, FileCode, History, Maximize, Minimize, KeyRound, Home as HomeIcon, BadgeInfo, Globe2, Hammer, TrendingUp, Newspaper, Scale, Flame, BookOpen, Sigma, AlarmClock, Power } from "lucide-react";
import {
  ArchitectPanel, SpectatorView, FilesPanel, DevCompanion, ZeusCortex, SiriusPrime, OracleDivin,
  PantheonSystem, NexusCeleste, SiriusDisplay, EuropeanaViewer, HaccpModule, KeysStatus, KeraunosPanel,
  AboutPanel, EspacePanel, ArchiveGallery, MemoryManager, InstallWizard, ScriptInstaller, LocusPanel,
  AtlasPanel, HeraclesPanel, HephaistosPanel, MythosGallery, ConsultPanel, PrometheePanel, CalliopePanel, CalendarPanel,
  FaceIdPanel, PythagorePanel, PackagerPanel, TrailerGallery, SiriusSetup, PromoPanel, ThemisPanel,
  AdminPanel, PortusNummarius, AgoraPipeline, NewsPanel, ReveilPanel, SpotifyPanel, MediaHUD, ProductivityPanel,
} from "@/lazyModules";
import { LiveClock, LiveDate, CpuRamMini, useLiveStats, pushStats, pushSimStats } from "@/liveStats";
import { formatLocalDate, formatLocalTime, getLocalDateKey } from "@/dateTime";
import { STATES, isLocalTimeQuestion, localAnswer, weatherInfo, pttBeep } from "@/appLogic";
import { MedallionRing, ReactorCore, Waveform } from "@/components/ReactorVisuals";
import OverlayApp from "@/OverlayApp";
import HoloScene from "@/HoloScene";
import SanctuaryAmbience from "@/SanctuaryAmbience";
import WebWindows from "@/WebWindows";
import TaskWindows from "@/TaskWindows";
import SiriusProgress, { progress } from "@/SiriusProgress";
import useTouchNav from "@/useTouchNav";
import PwaPrompt from "@/PwaPrompt";
import GlobalDrop from "@/GlobalDrop";
import ProactivePanel from "@/ProactivePanel";
import ArgusPanel, { ArgusWatcher } from "@/ArgusPanel";
import { ModeBanner, FrugalWatcher, VisionModule } from "@/SystemModes";
import GoldSparkles from "@/GoldSparkles";
import CommandPalette from "@/CommandPalette";
import ModulesMenu from "@/ModulesMenu";
import { useAuth } from "@/AuthGate";
import { speakFr, cancelSpeech, speakCinematic, speakSeries, speakAsCharacter } from "@/voice";
import { loadHud, applyHud } from "@/hudPrefs";
import { initUiSounds } from "@/uiSounds";
import { initHoloFx } from "@/holoFx";
import { getDisplayAutoCloseDelay } from "@/displayTiming";
import { initReadAloud } from "@/readAloud";
import { initHoloWindows, minimizeAll } from "@/holoWindows";
import { ConfirmButton } from "@/ConfirmButton";
import { getHUDStyleVariables, renderHUD } from "@/theme";
import HolographicGlobe from "@/HolographicGlobe";
import "@/App.css";

/* executeIntent moved into the real App component (see later in the file) */

// HUD SIRIUS — interface holographique
// Ne pas tenter de créer un WebSocket local si aucun backend n'est réellement attendu.
const WS_URL = process.env.REACT_APP_WS_URL || (
  typeof window !== "undefined" && window.location && window.location.hostname !== "localhost"
    ? "ws://127.0.0.1:8001/api/ws"
    : ""
);

// Correspondance tâche SIRIUS -> fenêtre de progression globale
const progressMap = {};

// ⚡ FIX : Fallback explicite vers http://127.0.0.1:8001 si la variable d'env est vide
const BACKEND_BASE = process.env.REACT_APP_BACKEND_URL || "http://127.0.0.1:8001";
const API = BACKEND_BASE + "/api";

const dispatchAutonomousVideoAction = (action) => {
  const prompt = typeof action?.prompt === "string" ? action.prompt.trim() : "";
  if (typeof window === "undefined" || action?.type !== "video_generation" || !prompt) return false;
  window.dispatchEvent(new CustomEvent("sirius:video-generation", { detail: { ...action, prompt } }));
  return true;
};


// Logos holographiques dédiés (or & cyan) — remplacent l'icône Landmark partagée
const HoloLogo = ({ src, size = 16 }) => (
  <img src={src} width={size} height={size} alt="" style={{ objectFit: "contain", filter: "drop-shadow(0 0 5px rgba(245, 197, 66, 0.55))" }} />
);
const ThemisLogo = ({ size = 16 }) => <HoloLogo src="/holo/logo-themis.png" size={size} />;
const PantheonLogo = ({ size = 16 }) => <HoloLogo src="/holo/logo-pantheon.png" size={size} />;
const MythosLogo = ({ size = 16 }) => <HoloLogo src="/holo/logo-mythos.png" size={size} />;

// Salutation adaptée à l'heure du sanctuaire (aube dorée, jour, crépuscule, nuit feutrée)
const phaseOfDay = () => {
  const h = new Date().getHours();
  return h >= 5 && h < 9 ? "dawn" : h >= 9 && h < 17 ? "day" : h >= 17 && h < 22 ? "dusk" : "night";
};
const PHASE_GREETINGS = {
  dawn: (n) => `Bonjour${n}. L'aube dorée se lève sur le sanctuaire.`,
  day: (n) => `Bonjour${n}.`,
  dusk: (n) => `Bonsoir${n}. Le crépuscule embrase le sanctuaire.`,
  night: (n) => `Bonsoir${n}. La nuit veille sur le sanctuaire, je reste à voix feutrée.`,
};
const greetByPhase = (name) => PHASE_GREETINGS[phaseOfDay()](name ? " " + name : "");

// Sagesse antique : un clic sur le noyau déclame une citation philosophique
const PHILO_QUOTES = [
  { t: "Connais-toi toi-même.", a: "Socrate" },
  { t: "Je ne sais qu'une chose, c'est que je ne sais rien.", a: "Socrate" },
  { t: "Le commencement est la moitié de tout.", a: "Pythagore" },
  { t: "On ne se baigne jamais deux fois dans le même fleuve.", a: "Héraclite" },
  { t: "L'excellence n'est pas un acte, mais une habitude.", a: "Aristote" },
  { t: "Le doute est le commencement de la sagesse.", a: "Aristote" },
  { t: "La patience est amère, mais son fruit est doux.", a: "Aristote" },
  { t: "Nul n'est méchant volontairement.", a: "Platon" },
  { t: "La musique donne une âme à nos cœurs et des ailes à la pensée.", a: "Platon" },
  { t: "Il n'y a qu'un chemin vers le bonheur : cesser de s'inquiéter des choses qui ne dépendent pas de notre volonté.", a: "Épictète" },
  { t: "Ce qui trouble les hommes, ce ne sont pas les choses, mais les jugements qu'ils portent sur elles.", a: "Épictète" },
  { t: "Hâte-toi de bien vivre et songe que chaque jour est à lui seul une vie.", a: "Sénèque" },
  { t: "La fortune sourit aux audacieux.", a: "Virgile" },
  { t: "Tout ce que nous entendons est une opinion, non un fait. Tout ce que nous voyons est une perspective, non la vérité.", a: "Marc Aurèle" },
  { t: "Le bonheur de ta vie dépend de la qualité de tes pensées.", a: "Marc Aurèle" },
];

const GOD_QUOTES = {
  HERACLES: [
    { t: "Les douze travaux commencent tous par le premier geste.", a: "HERACLES" },
    { t: "La rigueur d'aujourd'hui est le bouclier de demain.", a: "HERACLES" },
    { t: "Nul exploit sans discipline : la propreté est ma treizième épreuve.", a: "HERACLES" },
    { t: "La force ne sert à rien sans la constance qui la guide.", a: "HERACLES" },
  ],
  HEPHAISTOS: [
    { t: "Dans ma forge, chaque panne est un métal qui attend d'être redressé.", a: "HÉPHAÏSTOS" },
    { t: "Ce qui est cassé peut renaître plus fort, si la main qui répare est patiente.", a: "HÉPHAÏSTOS" },
    { t: "Le feu ne détruit que ce qu'on refuse de façonner.", a: "HÉPHAÏSTOS" },
    { t: "Un outil bien entretenu vaut mieux que cent promesses.", a: "HÉPHAÏSTOS" },
  ],
  THEMIS: [
    { t: "La justice sans rigueur n'est qu'une opinion ; la rigueur sans justice, une tyrannie.", a: "THÉMIS" },
    { t: "Un compte exact est une parole tenue.", a: "THÉMIS" },
    { t: "L'équilibre de la balance se gagne chiffre après chiffre.", a: "THÉMIS" },
    { t: "Ce qui est écrit et signé protège celui qui a donné sa parole.", a: "THÉMIS" },
  ],
  HERMES: [
    { t: "Vendre, c'est d'abord écouter ce que l'autre n'ose pas dire.", a: "HERMÈS" },
    { t: "Une objection n'est pas un mur : c'est une porte qui demande la bonne clé.", a: "HERMÈS" },
    { t: "Le meilleur messager livre la vérité avec le sourire du marchand.", a: "HERMÈS" },
    { t: "L'affaire conclue trop vite se dénoue de même ; prends le temps de la confiance.", a: "HERMÈS" },
  ],
  ARGUS: [
    { t: "Cent yeux ne suffisent pas si aucun ne sait ce qu'il cherche.", a: "ARGUS" },
    { t: "La vigilance est un art silencieux : on ne la remarque que lorsqu'elle manque.", a: "ARGUS" },
    { t: "Ce que tu surveilles avec constance ne te trahira jamais par surprise.", a: "ARGUS" },
  ],
  KERAUNOS: [
    { t: "La foudre ne frappe pas au hasard : elle choisit le point le plus haut.", a: "KERAUNOS" },
    { t: "La puissance sans maîtrise n'est qu'un orage perdu.", a: "KERAUNOS" },
    { t: "Un seul éclair suffit à révéler tout un paysage.", a: "KERAUNOS" },
  ],
  ZEUS: [
    { t: "Régner, c'est décider quand tous hésitent encore.", a: "ZEUS" },
    { t: "Du sommet de l'Olympe, les grands problèmes redeviennent petits.", a: "ZEUS" },
    { t: "L'ordre du monde tient à ceux qui veillent quand les autres dorment.", a: "ZEUS" },
  ],
  LOCUS: [
    { t: "Chaque lieu garde la mémoire de ceux qui l'ont traversé.", a: "LOCUS" },
    { t: "Savoir où l'on est, c'est déjà savoir qui l'on est.", a: "LOCUS" },
    { t: "Le chemin le plus court n'est pas toujours celui qui t'apprend le plus.", a: "LOCUS" },
  ],
};
// Profil + clés API stockés localement sur le PC de chaque utilisateur
const loadProfile = () => {
  try { return JSON.parse(localStorage.getItem("sirius_profile")) || null; } catch { return null; }
};
const loadKeys = () => {
  try { return JSON.parse(localStorage.getItem("sirius_keys")) || {}; } catch { return {}; }
};
// Mémoire long terme datée : accepte l'ancien format (chaînes) et le nouveau ({t, d})
const loadMemory = () => {
  try {
    const raw = JSON.parse(localStorage.getItem("sirius_memory")) || [];
    return raw.map((m) => (typeof m === "string" ? { t: m, d: null } : m)).filter((m) => m && m.t);
  } catch { return []; }
};
const todayStr = () => getLocalDateKey();

const DAILY_BRIEFING_COMMAND = /^\s*(?:(?:mon|le)\s+)?(?:briefing(?:\s+(?:quotidien|du jour|matinal))?|r[ée]sum[ée]\s+du\s+jour)\s*[?.!]*\s*$/i;

// (horloge isolée dans liveStats.js : LiveClock / LiveDate — évite un re-render global chaque seconde)


const isAbortError = (error) => {
  if (!error) return false;
  if (error.name === "AbortError") return true;
  if (error.code === 20) return true;
  return /abort/i.test(String(error.message || ""));
};

const imageFileToBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error("Lecture de l'image de référence impossible."));
  reader.onload = () => {
    const encoded = String(reader.result || "").split(",", 2)[1];
    if (!encoded) reject(new Error("Image de référence vide."));
    else resolve(encoded);
  };
  reader.readAsDataURL(file);
});

function App() {
  function speakOut(message) {
    if (!message) {
      setStatus("idle");
      return;
    }
    currentSpokenRef.current = message;
    const t0 = performance.now();
    if (window._siriusTTSTimer) clearTimeout(window._siriusTTSTimer);
    const safetyTimeoutMs = Math.max(3000, (message.length / 12) * 1000 + 2000);
    window._siriusTTSTimer = setTimeout(() => {
      setStatus("idle");
      speakingRef.current = false;
    }, safetyTimeoutMs);

    speakFr(message, {
      onstart: () => {
        setStatus("speaking");
        setMetrics((m) => ({ ...m, tts: { ...m.tts, latMs: Math.round(performance.now() - t0), count: m.tts.count + 1 } }));
        onSpeechStart();
        if (autoMicRef.current && !micOnRef.current) startInterruptListener();
      },
      onend: () => {
        if (window._siriusTTSTimer) clearTimeout(window._siriusTTSTimer);
        setMetrics((m) => ({ ...m, tts: { ...m.tts, durMs: Math.round(performance.now() - t0) } }));
        stopInterruptListener();
        onSpeechEnd();
        setStatus("idle");
      },
      onerror: () => {
        if (window._siriusTTSTimer) clearTimeout(window._siriusTTSTimer);
        stopInterruptListener();
        onSpeechEnd();
        setStatus("idle");
      }
    });
  }

  // ──👉 EXECUTEINTENT (collé automatiquement) — garder au tout début du composant App
  const executeIntent = (d) => {
    const act = d.action;
    const target = (d.target || "").toLowerCase().trim();
    const confirm = (msg) => { setStatus("speaking"); setText(msg); speakOut(msg); };
    const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (act === "minimize_all") {
      const n = minimizeAll();
      confirm(d.say || (n === 0 ? "Rien à ranger, aucune fenêtre ouverte." : n === 1 ? "C'est rangé, une fenêtre réduite en pastille." : `C'est rangé, ${n} fenêtres réduites en pastilles.`));
      return true;
    }
    if (act === "stop_reading") { cancelSpeech(); setStatus("idle"); setText("Silence, monsieur."); return true; }
    if (act === "vision_look") { setVisionAuto(true); setShowVision(true); confirm(d.say || "Un instant, j'observe ce que vous me montrez."); return true; }
    if (act === "web_agent" && target) { launchWebAgent(d.target.trim()); return true; }
    if (act === "daily_briefing") {
      confirm(d.say || "Je vous prépare votre résumé du jour, monsieur.");
      if (runBriefingRef.current) runBriefingRef.current(true);
      return true;
    }
    if (act === "stop_music") { if (ambientRef.current) ambientRef.current.pause(); confirm(d.say || "Musique d'ambiance coupée, monsieur."); return true; }
    if (act === "play_music") { if (ambientRef.current) ambientRef.current.play().catch(() => {}); confirm(d.say || "Musique d'ambiance relancée."); return true; }
    if (act === "spotify") {
      setShowSpotifyWin(true);
      confirm(d.say || "J'ouvre le lecteur Spotify, monsieur.");
      return true;
    }
    if (act === "media_control") {
      setMediaIntent(d.media || {});
      setShowMediaHud(true);
      confirm(d.say || "J'ouvre le controle multimedia, monsieur.");
      return true;
    }
    if (act === "productivity_control") {
      setProductivityIntent(d.productivity || {});
      setShowProductivity(true);
      confirm(d.say || "J'ouvre le module Productivite et Travail, monsieur.");
      return true;
    }
    if (act === "open_module" && target) {
      const it = moduleItemsRef.current.find((m) => m.id === target);
      if (it) { it.run(); confirm(d.say || `J'ouvre ${it.label.split("—")[0].trim()}.`); return true; }
      const extra = { setup: () => setShowSetup(true), gallery: () => setShowGallery(true), outlook: () => launchOutlookMail(), outlook_agenda: () => launchOutlookAgenda(), outlook_read: () => readMailAloud() }[target];
      if (extra) { extra(); confirm(d.say || "C'est ouvert, monsieur."); return true; }
      return openModuleByName(target);
    }
    if (act === "close_module" && target) {
      const CLOSERS = {
        display: () => setDisplayOpen(false), files: () => setShowFiles(false), architect: () => setShowArchitect(false),
        pantheon: () => setShowPantheon(false), cortex: () => setShowCortex(false), nexus: () => setShowNexus(false),
        oracle: () => setShowOracle(false), nummarius: () => setShowNummarius(false), europeana: () => setShowEuropeana(false),
        haccp: () => setHaccp(null), prime: () => setShowPrime(false), dev: () => setShowDev(false),
        analytics: () => setShowAnalytics(false), memory: () => setShowMemory(false), memorymgr: () => setShowMemoryMgr(false),
        argus: () => setShowArgus(false), keys: () => setShowKeysStatus(false), gcal: () => setShowCalendar(false),
        faceid: () => setShowFaceId(false), keraunos: () => setShowKeraunos(false), espace: () => setShowEspace(false),
        about: () => setShowAbout(false), locus: () => setShowLocus(false), atlas: () => setShowAtlas(false),
        heracles: () => setShowHeracles(false), hephaistos: () => setShowHephaistos(false), mythos: () => setShowMythosGallery(false),
        trailer: () => setShowTrailer(false), promo: () => setShowPromo(false), themis: () => setShowThemis(false),
        agora: () => setShowAgora(false), solon: () => setShowSolon(false), promethee: () => setShowPromethee(false),
        calliope: () => setShowCalliope(false), pythagore: () => setShowPythagore(false), news: () => setShowNews(false),
        packager: () => setShowPackager(false), install: () => setShowInstall(false), scripts: () => setShowScripts(false),
        vision: () => setShowVision(false), admin: () => setShowAdmin(false), setup: () => setShowSetup(false),
        gallery: () => setShowGallery(false), spotify: () => setShowSpotifyWin(false), media: () => setShowMediaHud(false),
        productivity: () => setShowProductivity(false),
      };
      const fn = CLOSERS[target];
      if (fn) { fn(); confirm(d.say || "Fenêtre fermée, monsieur."); return true; }
      return false;
    }
    if (act === "minimize_module" && target) {
      const it = moduleItemsRef.current.find((m) => m.id === target);
      const label = norm((it ? it.label : target).split("—")[0]).trim();
      for (const w of document.querySelectorAll(".holo-win:not(.holo-minimized)")) {
        const t = w.querySelector(".zeus-title, .eu-title, .gcal-title, .setup-title, h1, h2");
        const title = norm((t && t.textContent) || w.getAttribute("data-testid") || "");
        if (title.includes(label) || label.includes(title.trim()) || norm(w.getAttribute("data-testid") || "").includes(target)) {
          const btn = w.querySelector(".holo-win-min");
          if (btn) { btn.click(); confirm(d.say || "Fenêtre réduite en pastille."); return true; }
        }
      }
      return false;
    }
    return false;
  };

  const [profile, setProfile] = useState(loadProfile);
  const [keys, setKeys] = useState(loadKeys);
  const [memory, setMemory] = useState(loadMemory);
  const memoryRef = useRef(memory);
  memoryRef.current = memory;
  const saveMemory = useCallback((arr) => {
    setMemory(arr);
    localStorage.setItem("sirius_memory", JSON.stringify(arr));
  }, []);
  const [showSetup, setShowSetup] = useState(() => !localStorage.getItem("sirius_profile"));
  const [showMemory, setShowMemory] = useState(false);
  const [musicChoice, setMusicChoice] = useState(null);
  const [spotify, setSpotify] = useState(() => {
    try { return JSON.parse(localStorage.getItem("sirius_spotify")) || null; } catch { return null; }
  });
  const spotifyRef = useRef(spotify);
  spotifyRef.current = spotify;
  const [nowPlaying, setNowPlaying] = useState(null);
  const saveSpotify = useCallback((tok) => {
    setSpotify(tok);
    if (tok) localStorage.setItem("sirius_spotify", JSON.stringify(tok));
    else localStorage.removeItem("sirius_spotify");
  }, []);
  const userName = (profile?.name || "").trim();
  const [status, setStatus] = useState("idle");
  const [booting, setBooting] = useState(true);
  const volume = undefined; // → statusPulseRef.current.volume (sans re-render)
  const [text, setText] = useState(
    `${greetByPhase(userName)} Tous mes systèmes sont en ligne.`
  );
  const [connected, setConnected] = useState(false);
  const [isShuttingDown, setIsShuttingDown] = useState(false);
  const isLocalDevServer = typeof window !== "undefined"
    && window.location.protocol === "http:"
    && ["localhost", "127.0.0.1"].includes(window.location.hostname)
    && window.location.port !== "8001";
  const [cpu, ram] = [undefined, undefined]; // → useLiveStats (liveStats.js), sans re-render global
  const [cmd, setCmd] = useState("");
  const [imageReference, setImageReference] = useState(null);
  const imageReferenceRef = useRef(null);
  const imageReferenceInputRef = useRef(null);
  const wsRef = useRef(null);
  const recognitionRef = useRef(null);
  const serverRecorderRef = useRef(null);
  const serverRecorderStreamRef = useRef(null);
  const serverRecorderTimerRef = useRef(null);
  const discardServerRecordingRef = useRef(false);
  const preferServerSttRef = useRef(false);
  const micOnRef = useRef(false);
  // Push-to-talk (talkie-walkie) : maintenir Espace ou le bouton dédié
  const [pttActive, setPttActive] = useState(false);
  const pttRef = useRef(false);
  const speakingRef = useRef(false);
  const isBusy = useRef(false); // ⚡ Verrou anti-surchauffe / anti-doublon (partagé entre resolveIntent et handleCommand)
  const [micOn, setMicOn] = useState(false);
  const [showVoicePanel, setShowVoicePanel] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [ecoMode, setEcoMode] = useState(() => localStorage.getItem("sirius_eco") === "1");
  useEffect(() => { localStorage.setItem("sirius_eco", ecoMode ? "1" : "0"); }, [ecoMode]);
  const [autoMic, setAutoMic] = useState(false); // micro jamais déclenché automatiquement (fonction retirée)
  const autoMicRef = useRef(autoMic);
  autoMicRef.current = autoMic;
  useEffect(() => { localStorage.setItem("sirius_auto_mic", "0"); }, [autoMic]);
  const startListenRef = useRef(null);
  const autoListenTimerRef = useRef(null);
  const [weather, setWeather] = useState(null);
  const [activeCard, setActiveCard] = useState(null);
  const cardTimer = useRef(null);
  const sessionId = useRef("sirius-" + Math.random().toString(36).slice(2) + Date.now().toString(36));
  const ambientRef = useRef(null); // musique d'ambiance
  const playerDeviceRef = useRef(null); // lecteur Spotify intégré (Web Playback SDK)
  // Pop-ups holographiques contextuels (gérés par Sirius, fermés manuellement)
  const [popups, setPopups] = useState([]);
  // Visionneuse d'archives plein écran (clic sur une image de pop-up)
  const [archiveView, setArchiveView] = useState(null);
  const [showEuropeana, setShowEuropeana] = useState(false);
  const [webWindows, setWebWindows] = useState([]);
  // Clé Kimi K3 côté serveur (DANIEL_DEV_K3) : active l'IA cloud même sans clé saisie par l'utilisateur
  const [envGroq, setEnvGroq] = useState(false);
  const envGroqRef = useRef(false);
  // Témoin cerveau : quelle clé alimente Sirius (personnelle / serveur / repli-serveur)
  const [keySource, setKeySource] = useState(null);
  useEffect(() => {
    fetch(`${API}/chat/status`).then((r) => r.json()).then((d) => {
      setEnvGroq(!!d.groq_env);
      envGroqRef.current = !!d.groq_env;
      // Clé Google Maps du projet (backend/.env) : Atlas fonctionne sans saisie manuelle
      if (d.gmaps_env) {
        setKeys((k) => {
          if (k.gmaps) return k;
          const nk = { ...k, gmaps: d.gmaps_env };
          localStorage.setItem("sirius_keys", JSON.stringify(nk));
          return nk;
        });
      }
    }).catch(() => {});
  }, []);
  // SIRIUS DISPLAY : panneau piloté par Sirius — s'ouvre automatiquement, se ferme après
  const [display, setDisplay] = useState({ type: "idle" });
  const [displayHistory, setDisplayHistory] = useState([]);
  const [displayOpen, setDisplayOpen] = useState(false);
  const displayCloseTimer = useRef(null);
  const pinDisplay = useCallback(() => { clearTimeout(displayCloseTimer.current); }, []);
  useEffect(() => () => clearTimeout(displayCloseTimer.current), []);
  const showOnDisplay = useCallback((item) => {
    const entry = { ...item, id: Date.now() + Math.random() };
    setDisplay(entry);
    setDisplayHistory((h) => [entry, ...h].slice(0, 8));
    setDisplayOpen(true);
    clearTimeout(displayCloseTimer.current);
    const closeDelay = getDisplayAutoCloseDelay(item);
    if (closeDelay) {
      displayCloseTimer.current = setTimeout(() => setDisplayOpen(false), closeDelay);
    }
  }, []);
  const openWebWindow = useCallback((url, titre, iframeOk, noscript) => {
    showOnDisplay({ type: "web", url, titre, iframeOk, noscript: !!noscript });
  }, [showOnDisplay]);
  const closeWebWindow = useCallback((id) => {
    setWebWindows((ws) => ws.filter((w) => w.id !== id));
  }, []);

  // Fenêtres de tâches SIRIUS : ouvertes et pilotées par Sirius (créations, rendus, analyses)
  // Moteur émotionnel : humeur & énergie de Sirius (module le ton du LLM et des interventions)
  const moodBoostRef = useRef({ humeur: null, until: 0, delta: 0 });
  const computeMood = useCallback(() => {
    const h = new Date().getHours();
    let humeur = "focalisé", energie = 70;
    if (h >= 6 && h < 12) { humeur = "enthousiaste"; energie = 85; }
    else if (h >= 12 && h < 19) { humeur = "focalisé"; energie = 70; }
    else if (h >= 19) { humeur = "calme"; energie = 55; }
    else { humeur = "en veille basse"; energie = 35; }
    const b = moodBoostRef.current;
    if (b.until > Date.now()) {
      if (b.humeur) humeur = b.humeur;
      energie = Math.max(5, Math.min(100, energie + b.delta));
    }
    return { humeur, energie };
  }, []);
  const moodEvent = useCallback((type) => {
    const map = {
      task_done: { humeur: "enthousiaste", delta: 12, min: 10 },
      task_fail: { humeur: "vigilant", delta: -8, min: 10 },
      alert: { humeur: "vigilant", delta: -5, min: 15 },
      idle: { humeur: "calme", delta: -10, min: 20 },
    };
    const m = map[type];
    if (!m) return;
    moodBoostRef.current = { humeur: m.humeur, delta: m.delta, until: Date.now() + m.min * 60000 };
  }, []);
  // Proactivité : suivi d'activité + annonce différée (speakOut défini plus bas)
  const speakRef = useRef(() => {});
  const lastActivityRef = useRef(Date.now());
  const idleNotifiedRef = useRef(false);
  const cpuRef = useRef(12);
  const ramRef = useRef(43);
  useEffect(() => { cpuRef.current = cpu; ramRef.current = ram; }, [cpu, ram]);

  const [tasks, setTasks] = useState([]);
  const taskCountRef = useRef(0);
  const openTask = useCallback((titre, type) => {
    const n = taskCountRef.current++;
    const id = `task-${Date.now()}-${n}`;
    progressMap[id] = progress.start(titre);
    setTasks((ts) => [...ts, {
      id, titre, type, status: "running", steps: [], result: null,
      x: Math.max(60, window.innerWidth - 640 - (n % 5) * 40),
      y: 84 + (n % 5) * 34,
    }]);
    return id;
  }, []);
  const patchTask = useCallback((id, fn) => {
    setTasks((ts) => ts.map((t) => (t.id === id ? fn(t) : t)));
  }, []);
  const pushStep = useCallback((id, label) => {
    progress.log(progressMap[id], label);
    patchTask(id, (t) => t.status !== "running" ? t : ({
      ...t,
      steps: [...t.steps.map((s) => (s.state === "active" ? { ...s, state: "done" } : s)), { label, state: "active" }],
    }));
  }, [patchTask]);
  const finishTask = useCallback((id, result) => {
    progress.done(progressMap[id], "Tâche terminée avec succès");
    delete progressMap[id];
    moodEvent("task_done");
    patchTask(id, (t) => ({
      ...t, status: "done", result,
      steps: t.steps.map((s) => (s.state === "active" ? { ...s, state: "done" } : s)),
    }));
  }, [patchTask, moodEvent]);
  const failTask = useCallback((id, label) => {
    progress.error(progressMap[id], label);
    delete progressMap[id];
    moodEvent("task_fail");
    patchTask(id, (t) => ({
      ...t, status: "error",
      steps: [...t.steps.map((s) => (s.state === "active" ? { ...s, state: "done" } : s)), { label, state: "error" }],
    }));
  }, [patchTask, moodEvent]);
  const closeTask = useCallback((id) => {
    setTasks((ts) => ts.filter((t) => t.id !== id));
  }, []);
  // Archive en attente de confirmation d'affichage (« veux-tu que je l'affiche ? »)
  const [archiveChoice, setArchiveChoice] = useState(null);
  // Galerie des archives (commande « liste tes archives ») + navigation vocale
  const [showGallery, setShowGallery] = useState(false);
  const [galleryNav, setGalleryNav] = useState(null);
  useEffect(() => {
    if (!archiveView) return;
    const onKey = (e) => { if (e.key === "Escape") setArchiveView(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [archiveView]);
  const addPopup = useCallback((p) => {
    setPopups((prev) => [...prev.slice(-3), { id: Date.now() + Math.random(), ...p }]);
  }, []);
  const closePopup = useCallback((id) => setPopups((prev) => prev.filter((x) => x.id !== id)), []);
  // Tableau analytique : métriques temps réel du pipeline vocal
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [metrics, setMetrics] = useState({
    stt: { ms: null, conf: null, count: 0 },
    nlu: { intent: "—", count: 0 },
    ctx: { exchanges: 0 },
    pipeline: { apiMs: null, brainMs: null, search: false },
    tts: { latMs: null, durMs: null, count: 0 },
  });
  const updateMetric = useCallback((key, patch) => {
    setMetrics((m) => ({ ...m, [key]: { ...m[key], ...patch } }));
  }, []);
  const sttT0Ref = useRef(null);
  // Mode conversationnel spécial (brainstorming) + interruption naturelle
  const [mode, setMode] = useState(() => localStorage.getItem("sirius_mode") || "normal");
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const switchMode = useCallback((m) => {
    setMode(m);
    localStorage.setItem("sirius_mode", m);
  }, []);
  const interruptRecRef = useRef(null);
  const currentSpokenRef = useRef("");
  const processCommandRef = useRef(null);
  // Architecte visuel (générateur de diagrammes IA)
  const [showArchitect, setShowArchitect] = useState(false);
  const [architectPrompt, setArchitectPrompt] = useState("");
  const [showFiles, setShowFiles] = useState(false);
  // Mains holographiques 3D (couche R3F superposée) + pouls synchronisé avec le réacteur
  const [hands3D, setHands3D] = useState(() => localStorage.getItem("sirius_hands3d") !== "0");
  const [showDev, setShowDev] = useState(false);
  const [showCortex, setShowCortex] = useState(false);
  const [showPrime, setShowPrime] = useState(false);
  const [showOracle, setShowOracle] = useState(false);
  const [showMemoryMgr, setShowMemoryMgr] = useState(false);
  const [outlookChoice, setOutlookChoice] = useState(null);
  const [showInstall, setShowInstall] = useState(false);
  const [showArgus, setShowArgus] = useState(false);
  const [argusAlert, setArgusAlert] = useState(null);
  const [sysMode, setSysMode] = useState("normal");
  const [sysCause, setSysCause] = useState("");
  const [frugalManual, setFrugalManual] = useState(null);
  const [showVision, setShowVision] = useState(false);
  const [visionAuto, setVisionAuto] = useState(false);
  const runBriefingRef = useRef(null);
  const [showScripts, setShowScripts] = useState(false);
  const [showLocus, setShowLocus] = useState(false);
  const [locusQuery, setLocusQuery] = useState("");
  const [locusRoute, setLocusRoute] = useState(null);
  const [showAtlas, setShowAtlas] = useState(false);
  const [atlasQuery, setAtlasQuery] = useState("");
  const [atlasRoute, setAtlasRoute] = useState(null);
  const [showHeracles, setShowHeracles] = useState(false);
  const [showHephaistos, setShowHephaistos] = useState(false);
  const [heraclesInput, setHeraclesInput] = useState("");
  const [showMythosGallery, setShowMythosGallery] = useState(false);
  const [mythosFocus, setMythosFocus] = useState(null);
  const [showPackager, setShowPackager] = useState(false);
  const [packagerAutoInstall, setPackagerAutoInstall] = useState(false);
  const [showTrailer, setShowTrailer] = useState(false);
  const [showPromo, setShowPromo] = useState(false);
  const [showThemis, setShowThemis] = useState(false);
  const [showAgora, setShowAgora] = useState(false);
  const [showSolon, setShowSolon] = useState(false);
  const [showPromethee, setShowPromethee] = useState(false);
  const [showCalliope, setShowCalliope] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);
  const [showFaceId, setShowFaceId] = useState(false);
  const [showReveil, setShowReveil] = useState(false);
  const [showSpotifyWin, setShowSpotifyWin] = useState(false);
  const [showMediaHud, setShowMediaHud] = useState(false);
  const [mediaIntent, setMediaIntent] = useState(null);
  const [showProductivity, setShowProductivity] = useState(false);
  const [productivityIntent, setProductivityIntent] = useState(null);
  const [showPythagore, setShowPythagore] = useState(false);
  const [showNews, setShowNews] = useState(false);
  const [showModulesMenu, setShowModulesMenu] = useState(false);
  const [showKeysStatus, setShowKeysStatus] = useState(false);
  const [showKeraunos, setShowKeraunos] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showEspace, setShowEspace] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [showNummarius, setShowNummarius] = useState(false);
  const authUser = (useAuth() || {}).user;
  // Plein écran global du HUD (API Fullscreen du navigateur)
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  const toggleFullscreen = useCallback(() => {
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
    } catch (e) { /* non supporté */ }
  }, []);
  const [showCmdPalette, setShowCmdPalette] = useState(false);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowCmdPalette((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const cmdTimesRef = useRef([]);

  // Modes système : secours / frugal (JSON strict côté serveur)
  const setSystemMode = useCallback(async (mode, trigger = "manual", cause = "") => {
    setSysMode(mode);
    setSysCause(mode === "normal" ? "" : cause);
    if (mode !== "frugal") setFrugalManual(mode === "normal" ? null : frugalManual);
    try {
      const r = await fetch(`${API}/system/mode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, trigger, cause }),
      });
      return await r.json();
    } catch (e) { return null; }
  }, [frugalManual]);

  // ARGUS : réparations déléguées au HUD (severe/critical côté client)
  const handleArgusClientAction = useCallback((fixId) => {
    if (fixId === "restart_hud") { window.location.reload(); return; }
    if (fixId === "restart_vocal") {
      try { window.speechSynthesis.cancel(); } catch (e) {}
      setMicOn(false);
      setTimeout(() => setMicOn(true), 900);
      return;
    }
    if (fixId === "reload_profile") { setProfile(loadProfile()); return; }
    if (fixId === "reload_modules" || fixId === "relance_module") {
      setShowPrime(false); setShowOracle(false); setShowMemoryMgr(false);
      setShowPantheon(false); setShowDev(false); setHaccp(null);
      return;
    }
    if (fixId === "reconnect_groq") { setShowSetup(true); }
  }, []);

  // Assistant d'installation : lancé automatiquement au premier démarrage (profil créé, jamais installé)
  useEffect(() => {
    if (profile && (profile.name || profile.prenom) && !localStorage.getItem("sirius_installed")) {
      const t = setTimeout(() => setShowInstall(true), 12000);
      return () => clearTimeout(t);
    }
  }, [profile]);

// Vérification automatique des clés API au démarrage : annonce vocale des clés invalides
  const keysCheckedRef = useRef(false);
  useEffect(() => {
    if (!profile || !(profile.name || profile.prenom) || keysCheckedRef.current) return;
    
    keysCheckedRef.current = true;
    
    const t = setTimeout(async () => {
      try {
        const k = JSON.parse(localStorage.getItem("sirius_keys")) || {};
        const r = await fetch(`${API}/keys/check`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keys: k }),
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.invalid && d.invalid.length) {
          if (speakRef.current) speakRef.current(d.speech);
          if (addPopup) {
            addPopup({
              kind: "info",
              titre: "VÉRIFICATION DES CLÉS API",
              contenu: (d.checks || []).filter((c) => c.status !== "absente").map((c) => `${c.label} : ${c.status.toUpperCase()}`).join("\n"),
            });
          }
        }
      } catch (_) {}
    }, 15000);

    return () => clearTimeout(t);
  }, [profile, addPopup]); // Exécute quand profile ou addPopup changent (évite les warnings ESLint)

  const [showPantheon, setShowPantheon] = useState(false);
  const [showNexus, setShowNexus] = useState(false);
  const [haccp, setHaccp] = useState(null); // { sujet, auto } quand ouvert
  const pulseRef = useRef(0.5);

  // Pouls synchronisé avec le réacteur 2D (même formule que ReactorCore)
  const statusPulseRef = useRef({ status: "idle", volume: 0.15 });
  useEffect(() => {
    let raf;
    const t0 = performance.now();
    const tick = () => {
      const t = (performance.now() - t0) / 1000;
      const s = statusPulseRef.current;
      pulseRef.current = s.status === "speaking"
        ? Math.min(1, s.volume)
        : 0.18 + 0.12 * Math.sin(t * 1.6) + (s.status === "thinking" ? 0.2 : 0);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, []);

  const now = undefined; // horloge rendue par <LiveClock/> / <LiveDate/>

  // HÉPHAÏSTOS : diagnostic automatique au démarrage (1×/session), alerte vocale si module FAIL
  useEffect(() => {
    if (booting || showSetup) return;
    if (sessionStorage.getItem("sirius_autodiag")) return;
    sessionStorage.setItem("sirius_autodiag", "1");
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`${API}/hephaistos/diagnostic?source=auto`);
        const d = await r.json();
        if (!r.ok || !d.summary) return;
        if (d.summary.failed > 0) {
          const msg = `Alerte Héphaïstos : diagnostic automatique à ${d.summary.rate} pour cent. Modules en échec : ${d.summary.failed_modules.slice(0, 4).join(", ")}.`;
          setStatus("speaking"); setText(msg); speakRef.current(msg);
        }
      } catch {}
    }, 12000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booting, showSetup]);
  const conf = STATES[status] || STATES.idle;

  // Carte holographique centrale (auto-masquée après 9s)
  const showCard = useCallback((card) => {
    setActiveCard(card);
    clearTimeout(cardTimer.current);
    cardTimer.current = setTimeout(() => setActiveCard(null), 9000);
  }, []);

  // Météo réelle (géoloc navigateur + Open-Meteo, sans clé API)
  useEffect(() => {
    let cancelled = false;
    let retries = 0;
    let retryTimer;
    const fetchWeather = async (lat, lon, city) => {
      try {
        const r = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m,weather_code`
        );
        const d = await r.json();
        if (cancelled) return;
        const c = d.current || {};
        if (!Number.isFinite(c.temperature_2m)) throw new Error("météo invalide");
        setWeather({
          temp: Math.round(c.temperature_2m),
          wind: Math.round(c.wind_speed_10m || 0),
          code: c.weather_code,
          city: city || "Ma position",
        });
      } catch (e) {
        // Raté passager de l'API → on garde le placeholder (jamais NaN) et on retente 2 fois
        if (!cancelled && retries < 2) {
          retries += 1;
          retryTimer = setTimeout(() => fetchWeather(lat, lon, city), 20000);
        }
      }
    };
    // Si une ville est définie dans le profil → on l'utilise en priorité (géocodage Open-Meteo)
    const city = (profile?.city || "").trim();
    if (city) {
      (async () => {
        try {
          const g = await fetch(
            `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=fr`
          );
          const gd = await g.json();
          const loc = gd.results && gd.results[0];
          if (loc) {
            fetchWeather(loc.latitude, loc.longitude, loc.name);
            return;
          }
        } catch (e) {}
        fetchWeather(48.8566, 2.3522, city);
      })();
    } else if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => fetchWeather(pos.coords.latitude, pos.coords.longitude, null),
        () => fetchWeather(48.8566, 2.3522, "Paris"),
        { timeout: 5000 }
      );
    } else {
      fetchWeather(48.8566, 2.3522, "Paris");
    }
    return () => { cancelled = true; clearTimeout(retryTimer); };
  }, [profile?.city]);

  // Couleur défilante pendant la réflexion
  const [thinkColor, setThinkColor] = useState(STATES.thinking.color);
  useEffect(() => {
    if (status !== "thinking") return;
    const palette = ["#fbbf24", "#fb7185", "#f472b6", "#a78bfa", "#818cf8", "#38bdf8", "#34d399"];
    let i = 0;
    setThinkColor(palette[0]);
    const id = setInterval(() => {
      i = (i + 1) % palette.length;
      setThinkColor(palette[i]);
    }, 320);
    return () => clearInterval(id);
  }, [status]);

  const isThinking = status === "thinking";
  const accentColor = isThinking ? thinkColor : conf.color;
  const glowColor = isThinking ? thinkColor : conf.glow;
  const hudTheme = renderHUD({
    coreActive: status !== "idle",
    guardianActive: true,
    infoPanels: true,
  });

  // Stats simulées (remplacées par le backend si connecté) — via bus liveStats, sans re-render du HUD
  useEffect(() => {
    const id = setInterval(() => pushSimStats(), 1500);
    return () => clearInterval(id);
  }, []);

  // Volume animé en mode parole — écrit dans la ref du pouls, sans re-render
  useEffect(() => {
    if (status !== "speaking" || connected) return;
    const id = setInterval(() => {
      statusPulseRef.current.volume = 0.4 + 0.35 * Math.abs(Math.sin(Date.now() / 120)) + Math.random() * 0.15;
    }, 60);
    return () => clearInterval(id);
  }, [status, connected]);

  // Connexion WebSocket au backend Sirius (localhost) — stabilisée :
  // reconnexion automatique (backoff exponentiel 1s → 15s max) + keepalive 25s.
  // En preview cloud → échoue proprement → mode démo, et réessaie en arrière-plan.
  useEffect(() => {
    let ws = null;
    let stopped = false;
    let retryTimer = null;
    let pingTimer = null;
    let attempt = 0;
    if (!WS_URL) { setConnected(false); return undefined; }

    const cleanupSocket = () => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        try { ws.close(); } catch (e) {}
        ws = null;
      }
      wsRef.current = null;
    };

    const scheduleReconnect = () => {
      if (stopped || retryTimer) return;
      // En ligne (preview/prod) : max 4 tentatives vers le backend local pour ne pas spammer la console
      if (attempt >= 4 && window.location.hostname !== "localhost") return;
      const delay = Math.min(15000, 1000 * 2 ** Math.min(attempt, 4));
      attempt += 1;
      retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
    };

    const connect = () => {
      if (stopped) return;
      cleanupSocket();
      try {
        ws = new WebSocket(WS_URL);
      } catch (e) {
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
        // Keepalive : évite les fermetures silencieuses pour inactivité
        pingTimer = setInterval(() => {
          if (ws && ws.readyState === 1) {
            try { ws.send(JSON.stringify({ type: "ping" })); } catch (e) {}
          }
        }, 25000);
      };
      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          const a = data.action;
          // Protocole exact du backend Sirius/Jarvis
          if (a === "set_state") {
            const st = data.state === "active" ? "listening" : data.state;
            if (STATES[st]) setStatus(st);
          } else if (a === "jarvis_text") {
            setText(data.text || "");
          } else if (a === "set_volume") {
            statusPulseRef.current.volume = Math.max(0.05, Math.min(1, data.volume ?? 0.2));
          } else if (a === "system_stats") {
            if (data.cpu != null) pushStats({ cpu: data.cpu });
            if (data.ram != null) pushStats({ ram: data.ram });
          }
        } catch (e) {}
      };
      ws.onclose = () => {
        setConnected(false);
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
        wsRef.current = null;
        scheduleReconnect();
      };
      ws.onerror = () => {
        // onclose suit toujours onerror → la reconnexion y est gérée
        try { ws && ws.close(); } catch (e) {}
      };
    };

    connect();
    return () => {
      stopped = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      cleanupSocket();
    };
  }, []);

  const triggerState = useCallback((s) => {
    setStatus(s);
    const msgs = {
      idle: "En veille. Dites « Sirius » pour m'activer.",
      listening: userName ? `Je t'écoute, ${userName}...` : "Je t'écoute...",
      thinking: "Réflexion en cours...",
      speaking: userName ? `Bien sûr ${userName}, voici ma réponse.` : "Bien sûr, voici ma réponse.",
    };
    setText(msgs[s]);
  }, [userName]);

  // Veille intelligente : la moindre interaction (voix, texte, clic) réveille Sirius (→ Écoute),
  // puis la Veille se réactive automatiquement après 25 s d'inactivité.
  const wakeStatusRef = useRef(status);
  wakeStatusRef.current = status;
  const idleBackTimerRef = useRef(null);
  useEffect(() => {
    const wake = () => {
      if (wakeStatusRef.current === "idle") setStatus("listening");
      clearTimeout(idleBackTimerRef.current);
      idleBackTimerRef.current = setTimeout(() => {
        if (wakeStatusRef.current === "listening" && !micOnRef.current) setStatus("idle");
      }, 25000);
    };
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);
    return () => {
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
      clearTimeout(idleBackTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

 // Préchargement des voix de synthèse du navigateur (asynchrone)
  useEffect(() => {
    const synth = window.speechSynthesis;
    if (synth) synth.getVoices();
  }, []);

  const onSpeechStart = useCallback(() => {
    speakingRef.current = true;
    setStatus("speaking");
  }, []);

  const onSpeechEnd = useCallback(() => {
    speakingRef.current = false;
    setStatus("idle");
    // Mode conversation : on rouvre le micro automatiquement après que Sirius a parlé
    if (autoMicRef.current && !micOnRef.current) {
      if (autoListenTimerRef.current) clearTimeout(autoListenTimerRef.current);
      autoListenTimerRef.current = setTimeout(() => {
        if (autoMicRef.current && !speakingRef.current && !micOnRef.current && startListenRef.current) {
          startListenRef.current();
        }
      }, 600);
    }
  }, []);

  // Réponse intelligente via le cerveau cloud (Kimi K3 analyse → Groq formule, en flux avec fallbacks)
  const cloudAnswer = useCallback(async (command) => {
    setStatus("thinking");

    if (isLocalTimeQuestion(command)) {
      const answer = localAnswer(command);
      setText(answer);
      speakOut(answer);
      showOnDisplay({ type: "message", titre: "SIRIUS — HEURE LOCALE", contenu: answer });
      return;
    }

    let pid = null;
    if (typeof progress !== "undefined" && progress?.start) {
      pid = progress.start("Réponse de Sirius", { silent: true });
    }

    const payload = JSON.stringify({
      text: command,
      session_id: sessionId.current,
      keys,
      profile: profile || {},
      memory: memoryRef.current,
      mode: modeRef.current,
      ia_mode: localStorage.getItem("sirius_ia_mode") || "jarvis",
      mood: computeMood(),
      frugal: sysMode === "frugal",
      activity: cmdTimesRef.current?.length >= 3 ? "intense" : "exploration",
    });

    // -------------------------------------------------------------
    // NIVEAU 1 : VOIE FLUX STREAM (SSE) avec timeout global de 60 s
    // -------------------------------------------------------------
    let streamTimeoutId;
    let streamProducedOutput = false;
    try {
      if (pid && progress?.log) progress.log(pid, "Interrogation du cerveau (voie stream)...", 30);

      const controller = new AbortController();
      streamTimeoutId = setTimeout(() => controller.abort(), 60000);

      const resp = await fetch(`${API}/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal: controller.signal,
      });

      if (resp.ok && resp.body && (resp.headers.get("content-type") || "").includes("text/event-stream")) {
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = "", full = "", pending = "", data = null, spoken = false;

        const speakChunk = (phrase) => {
          const ph = (phrase || "").trim();
          if (!ph) return;
          if (!spoken) { spoken = true; setStatus("speaking"); }
          currentSpokenRef.current = ((currentSpokenRef.current || "") + " " + ph).slice(-400);
          speakSeries(ph);
        };

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let cut;
            while ((cut = buf.indexOf("\n\n")) >= 0) {
              const line = buf.slice(0, cut).trim();
              buf = buf.slice(cut + 2);
              if (!line.startsWith("data:")) continue;
              let ev;
              try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; }
              if (ev.type === "delta") {
                streamProducedOutput = true;
                full += ev.text; pending += ev.text;
                setText(full);
                let m;
                while ((m = /^([\s\S]*?[.!?…])(?:\s+|$)/.exec(pending)) && m[1].trim().length > 1) {
                  speakChunk(m[1]);
                  pending = pending.slice(m[0].length);
                }
              } else if (ev.type === "done") {
                data = ev;
              }
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
        }

        if (data) {
          if (dispatchAutonomousVideoAction(data.action)) {
            if (pid && progress?.done) progress.done(pid, "Action vidéo transmise");
            return;
          }
          if (pending.trim()) speakChunk(pending);
          const answer = (data.answer || full || "").trim();
          if (!spoken) { setText(answer); speakOut(answer); } else { setText(answer); }
          showOnDisplay({ type: "message", titre: "SIRIUS — RÉPONSE", contenu: answer });
          if (pid && progress?.done) progress.done(pid, "Réponse délivrée en direct");
          return; // ✅ SUCCÈS STREAM : On sort ici
        }
      }
    } catch (e) {
      if (!isAbortError(e)) {
        console.warn("⚠️ Stream interrompu ou timeout (60s) -> Passage en voie classique...", e);
      }
      if (streamProducedOutput) {
        if (pid && progress?.error) progress.error(pid, "Réponse interrompue après restitution partielle");
        return;
      }
    } finally {
      if (streamTimeoutId) clearTimeout(streamTimeoutId);
    }

    // -------------------------------------------------------------
    // NIVEAU 2 : VOIE CLASSIQUE HTTP (Repli si le Stream échoue/expire)
    // -------------------------------------------------------------
    try {
      if (pid && progress?.log) progress.log(pid, "Passage en voie classique de secours...", 60);

      const resp = await fetch(`${API}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });

      if (resp.ok) {
        const data = await resp.json();
        if (dispatchAutonomousVideoAction(data.action)) {
          if (pid && progress?.done) progress.done(pid, "Action vidéo transmise");
          return;
        }
        const answer = data.answer || "Réponse reçue du serveur.";
        setText(answer);
        speakOut(answer);
        showOnDisplay({ type: "message", titre: "SIRIUS — RÉPONSE", contenu: answer });
        if (pid && progress?.done) progress.done(pid, "Réponse délivrée (voie classique)");
        return; // ✅ SUCCÈS CLASSIQUE : On sort ici
      }
    } catch (e) {
      console.warn("⚠️ Échec voie classique -> Passage en réponse locale...", e);
    }

    // -------------------------------------------------------------
    // NIVEAU 3 : RÉPONSE LOCALE (Mode Secours si le serveur est hors-ligne)
    // -------------------------------------------------------------
    if (pid && progress?.error) progress.error(pid, "Serveur cloud indisponible — réponse locale");
    const fallback = typeof localAnswer === "function" 
      ? localAnswer(command.toLowerCase()) 
      : "Mode secours : Le serveur Sirius ne répond pas actuellement.";
      
    setText(fallback);
    speakOut(fallback);
    showOnDisplay({ type: "message", titre: "SIRIUS — RÉPONSE LOCALE", contenu: fallback });

  }, [speakOut, keys, profile, computeMood, showOnDisplay, sysMode]);

  // ---- Interruption naturelle : le micro écoute PENDANT que Sirius parle ----
  const stopInterruptListener = useCallback(() => {
    const rec = interruptRecRef.current;
    interruptRecRef.current = null;
    try { rec && rec.stop(); } catch (e) {}
  }, []);

  const startInterruptListener = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR || interruptRecRef.current) return;
    try {
      const rec = new SR();
      rec.lang = "fr-FR";
      rec.interimResults = true;
      rec.continuous = true;
      const STOPWORDS = /(^|\s)(stop|arr[êe]te|attends|attend|tais[- ]toi|chut|silence|pause|sirius)(\s|$)/i;
      rec.onresult = (e) => {
        if (!speakingRef.current) return;
        let final = "";
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) final += t;
          else interim += t;
        }
        const heard = (final || interim).toLowerCase().trim();
        if (!heard) return;
        // Filtre anti-écho : Sirius s'entend parler → on ignore ses propres mots
        const spoken = (currentSpokenRef.current || "").toLowerCase();
        const words = heard.split(/\s+/).filter((w) => w.length > 2);
        if (!words.length) return;
        const overlap = words.filter((w) => spoken.includes(w)).length / words.length;
        if (overlap > 0.5) return;
        const isStop = STOPWORDS.test(heard);
        // On coupe si : mot d'arrêt / « Sirius » (immédiat), ou vraie phrase de 3 mots et +
        if (!isStop && !(final && words.length >= 3)) return;
        if (typeof cancelSpeech === "function") cancelSpeech();
        speakingRef.current = false;
        stopInterruptListener();
        const cmd = final.trim().replace(/\b(sirius|syrius|cirius|sirus)\b/gi, " ").replace(/\s+/g, " ").trim();
        const isJustStop = isStop && words.length <= 2;
        if (!isJustStop && cmd && cmd.split(/\s+/).length >= 2) {
          setText("Toi : « " + cmd + " »");
          setTimeout(async () => {
            try {
              if (processCommandRef.current) {
                await processCommandRef.current(cmd);
              } else if (typeof cloudAnswer === "function") {
                await cloudAnswer(cmd);
              }
            } catch (err) {
              console.error("Erreur commande vocale :", err);
              setStatus("idle");
            }
          }, 50);
        } else {
          setStatus("listening");
          setText("Oui ? Je t'écoute...");
          setTimeout(() => { if (!micOnRef.current && !speakingRef.current && startListenRef.current) startListenRef.current(); }, 250);
        }
      };
      rec.onerror = () => { stopInterruptListener(); };
      rec.onend = () => {
        // Relance tant que Sirius parle encore (Chrome coupe la reco régulièrement)
        if (speakingRef.current && interruptRecRef.current === rec) {
          try { rec.start(); } catch (e) { interruptRecRef.current = null; }
        }
      };
      interruptRecRef.current = rec;
      rec.start();
    } catch (e) {}
  }, [stopInterruptListener, cloudAnswer]);

  // Citation philosophique : un clic sur le noyau fait parler la sagesse antique.
  // Si le panneau d'un dieu est ouvert (ou l'a été il y a moins de 3 min), c'est lui qui déclame.
  const openGod =
    showAgora ? "HERMES" :
    showThemis ? "THEMIS" :
    showHephaistos ? "HEPHAISTOS" :
    showHeracles ? "HERACLES" :
    showAtlas ? "ATLAS" :
    showOracle ? "ORACLE" :
    showArgus ? "ARGUS" :
    showKeraunos ? "KERAUNOS" :
    showCortex ? "ZEUS" :
    showLocus ? "LOCUS" : null;
  const lastGodRef = useRef(null);
  useEffect(() => {
    if (openGod) lastGodRef.current = { god: openGod, t: Date.now() };
    else if (lastGodRef.current) lastGodRef.current.t = Date.now();
  }, [openGod]);

  const speakQuote = useCallback(() => {
    let god = openGod;
    if (!god && lastGodRef.current && Date.now() - lastGodRef.current.t < 180000) god = lastGodRef.current.god;
    const pool = (god && GOD_QUOTES[god]) || PHILO_QUOTES;
    const q = pool[Math.floor(Math.random() * pool.length)];
    setStatus("speaking");
    setText(`« ${q.t} » — ${q.a}`);
    speakOut(`${q.t} ${q.a}.`);
  }, [speakOut, openGod]);

  // Progression vocale : Sirius annonce à voix haute le début et la fin de chaque tâche suivie
  const progNamesRef = useRef({});
  useEffect(() => {
    const nom = (n) => (n || "tâche en cours").replace(/—/g, ",").toLowerCase();
    const say = (m) => { setStatus("speaking"); setText(m); speakOut(m); };
    const onProg = (e) => {
      const { action, id, task, message, silent } = e.detail || {};
      if (!id) return;
      if (action === "start") {
        progNamesRef.current[id] = { task, silent };
        if (!silent) say(`Je lance la tâche : ${nom(task)}.`);
      } else if (action === "done") {
        const t = progNamesRef.current[id] || {};
        if (!t.silent) say(`Tâche terminée : ${nom(t.task)}.`);
        delete progNamesRef.current[id];
      } else if (action === "error") {
        const t = progNamesRef.current[id] || {};
        if (!t.silent) say(`Tâche interrompue : ${nom(t.task)}${message ? ` — ${message}` : ""}.`);
        delete progNamesRef.current[id];
      }
    };
    window.addEventListener("sirius-progress", onProg);
    return () => window.removeEventListener("sirius-progress", onProg);
  }, [speakOut]);

  // Actualités en direct (NewsAPI) : lecture vocale des titres + pop-up détaillé
  const launchNews = useCallback(async (topic) => {
    setStatus("thinking");
    setText(topic ? `Je consulte les actualités sur ${topic}...` : "Je consulte les actualités...");
    try {
      const r = await fetch(`${API}/news/headlines?limit=6${topic ? `&q=${encodeURIComponent(topic)}` : ""}`);
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.articles && d.articles.length) {
        const top = d.articles.slice(0, 3).map((a) => a.titre).filter(Boolean);
        addPopup({
          kind: "info",
          titre: topic ? `ACTUALITÉS — ${topic.toUpperCase()}` : "ACTUALITÉS FRANCE",
          contenu: d.articles.map((a) => `• ${a.titre}${a.source ? ` (${a.source})` : ""}`).join("\n"),
        });
        setStatus("speaking");
        const m = `Voici les titres${topic ? ` sur ${topic}` : ""} : ${top.join(". ")}.`;
        setText(m); speakOut(m);
        return;
      }
      setStatus("speaking");
      const m = r.status === 429
        ? "Le quota d'actualités du jour est atteint, monsieur."
        : topic ? `Aucune actualité trouvée sur ${topic}.` : "Les actualités sont indisponibles pour le moment.";
      setText(m); speakOut(m);
    } catch (e) {
      setStatus("speaking");
      const m = "Les actualités sont indisponibles pour le moment.";
      setText(m); speakOut(m);
    }
  }, [speakOut, addPopup]);

  // HERMÈS AGORA# — consultation commerciale vocale dans le chat principal (voix Mythos, ajustable)
  const AGORA_VOICE = { module: "HERMÈS AGORA#" };
  const launchAgora = useCallback(async (question) => {
    if (!question) { setShowAgora(true); return; }
    setStatus("thinking");
    setText("Hermès Agora analyse ton affaire...");
    cancelSpeech();
    speakAsCharacter("Hermès Agora. J'analyse ton affaire.", AGORA_VOICE);
    try {
      let ks = {};
      try { ks = JSON.parse(localStorage.getItem("sirius_keys")) || {}; } catch (e) { ks = {}; }
      const r = await fetch(`${API}/mythos/consult`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ module: "HERMÈS AGORA#", question, keys: ks }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.reponse) {
        addPopup({ kind: "info", titre: "HERMÈS AGORA# — PLAN DE VENTE", contenu: d.reponse });
        const actions = d.reponse.split(/ACTIONS IMM[ÉE]DIATES/i)[1];
        const spoken = "Plan de vente prêt. " +
          (actions ? "Actions immédiates : " + actions.trim().slice(0, 320) : d.reponse.slice(0, 320)) +
          " Le détail complet est à l'écran.";
        setStatus("speaking");
        setText("HERMÈS AGORA# — plan de vente affiché à l'écran.");
        speakAsCharacter(spoken, AGORA_VOICE);
        return;
      }
      const m = typeof d.detail === "string" ? d.detail : "Consultation commerciale impossible pour le moment.";
      setStatus("speaking"); setText(m); speakOut(m);
    } catch (e) {
      const m = "Hermès Agora est injoignable, monsieur.";
      setStatus("speaking"); setText(m); speakOut(m);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speakOut, addPopup]);

  // Météo temps réel (OpenWeatherMap) : réponse parlée détaillée + pop-up
  const launchWeather = useCallback(async (city) => {
    const target = (city || profile?.city || "Paris").trim();
    setStatus("thinking");
    setText(`Je consulte la météo à ${target}...`);
    try {
      const r = await fetch(`${API}/weather/current?city=${encodeURIComponent(target)}`);
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        addPopup({
          kind: "info",
          titre: `MÉTÉO — ${(d.ville || target).toUpperCase()}`,
          contenu: `${d.description}\nTempérature : ${d.temp}°C (ressenti ${d.ressenti}°C)\nMin / Max : ${d.tmin}°C / ${d.tmax}°C\nHumidité : ${d.humidite} %\nVent : ${d.vent} km/h`,
        });
        setStatus("speaking");
        const m = `À ${d.ville}, ${d.description ? d.description.toLowerCase() + ", " : ""}il fait ${d.temp} degrés, ressenti ${d.ressenti}. Humidité ${d.humidite} pour cent, vent ${d.vent} kilomètres heure.`;
        setText(m); speakOut(m);
        return;
      }
      setStatus("speaking");
      const m = r.status === 404 ? `Je ne trouve pas la ville ${target}.` : "La météo est indisponible pour le moment.";
      setText(m); speakOut(m);
    } catch (e) {
      setStatus("speaking");
      const m = "La météo est indisponible pour le moment.";
      setText(m); speakOut(m);
    }
  }, [speakOut, addPopup, profile?.city]);

  // Fiche pays (REST Countries) : capitale, population, monnaie, langues...
  const launchCountry = useCallback(async (name, focus) => {
    setStatus("thinking");
    setText(`Je consulte la fiche de ${name}...`);
    try {
      const r = await fetch(`${API}/country?name=${encodeURIComponent(name)}`);
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        const pop = d.population ? d.population.toLocaleString("fr-FR") : "inconnue";
        addPopup({
          kind: "info",
          titre: `${d.drapeau ? d.drapeau + " " : ""}FICHE PAYS — ${(d.nom || name).toUpperCase()}`,
          contenu: `Capitale : ${d.capitale || "?"}\nPopulation : ${pop} habitants\nRégion : ${d.region}${d.sous_region ? " — " + d.sous_region : ""}\nSuperficie : ${d.superficie_km2 ? d.superficie_km2.toLocaleString("fr-FR") + " km²" : "?"}\nMonnaie : ${(d.monnaies || []).join(", ") || "?"}\nLangues : ${(d.langues || []).join(", ") || "?"}`,
        });
        setStatus("speaking");
        const m = focus === "capitale"
          ? `${d.nom} a pour capitale ${d.capitale}.`
          : focus === "population"
            ? `${d.nom} compte ${pop} habitants.`
            : `${d.nom} : capitale ${d.capitale}, ${pop} habitants, région ${d.sous_region || d.region}. Détails à l'écran.`;
        setText(m); speakOut(m);
        return;
      }
      setStatus("speaking");
      const m = r.status === 404 ? `Je ne trouve pas le pays ${name}.` : "La fiche pays est indisponible.";
      setText(m); speakOut(m);
    } catch (e) {
      setStatus("speaking");
      const m = "La fiche pays est indisponible.";
      setText(m); speakOut(m);
    }
  }, [speakOut, addPopup]);

  // Bulletin tech Hacker News présenté par Sirius
  const launchTechBulletin = useCallback(async () => {
    setStatus("thinking");
    setText("Je compile le bulletin tech Hacker News...");
    try {
      const r = await fetch(`${API}/technews/bulletin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.bulletin) {
        addPopup({ kind: "info", titre: "BULLETIN TECH — HACKER NEWS", contenu: d.bulletin });
        setStatus("speaking");
        setText(d.bulletin);
        speakOut(d.bulletin);
        return;
      }
      setStatus("speaking");
      const m = "Le bulletin tech est indisponible pour le moment.";
      setText(m); speakOut(m);
    } catch (e) {
      setStatus("speaking");
      const m = "Le bulletin tech est indisponible pour le moment.";
      setText(m); speakOut(m);
    }
  }, [speakOut, addPopup, keys]);

  // Mini-documentaire historique narré par Sirius (Wikipedia, Wikidata, Gallica, OpenLibrary)
  const launchDocumentary = useCallback(async (sujet) => {
    setStatus("thinking");
    setText(`Je prépare un mini-documentaire sur ${sujet}...`);
    try {
      const r = await fetch(`${API}/documentary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sujet, keys }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.documentaire) {
        addPopup({
          kind: "info",
          titre: `MINI-DOCUMENTAIRE — ${sujet.toUpperCase()}`,
          contenu: d.documentaire,
          images: d.images || [],
        });
        setStatus("speaking");
        setText(d.documentaire);
        speakOut(d.documentaire);
        return;
      }
      setStatus("speaking");
      const m = r.status === 404 ? `Je n'ai trouvé aucune archive sur ${sujet}.` : "Le documentaire est indisponible pour le moment.";
      setText(m); speakOut(m);
    } catch (e) {
      setStatus("speaking");
      const m = "Le documentaire est indisponible pour le moment.";
      setText(m); speakOut(m);
    }
  }, [speakOut, addPopup, keys]);

  // SIRIUS WebBrowser : ouvre toute URL ou le 1er résultat d'une recherche, sans confirmation
  const launchWebBrowser = useCallback(async (target) => {
    setStatus("thinking");
    setText(`Ouverture de ${target}...`);
    try {
      const r = await fetch(`${API}/webbrowser/open`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, keys }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.rapport) {
        openWebWindow(d.url, d.titre || target, d.iframe_ok !== false);
        addPopup({
          kind: "info",
          titre: `WEBBROWSER — ${(d.titre || target).toUpperCase().slice(0, 44)}`,
          contenu: d.rapport,
        });
        setStatus("speaking");
        const m = `J'affiche ${d.titre || d.url} sur votre écran. ${d.resume || ""}`.slice(0, 250);
        setText(m); speakOut(m);
        return;
      }
      setStatus("speaking");
      setText("Page inaccessible"); speakOut("Page inaccessible");
    } catch (e) {
      setStatus("speaking");
      setText("Page inaccessible"); speakOut("Page inaccessible");
    }
  }, [speakOut, addPopup, keys, openWebWindow]);

  const lastArchiveRef = useRef(null);

  // Archivage automatique de chaque création dans la médiathèque SIRIUS
  const archiveCreation = useCallback(async (taskId, kind, nom, payload) => {
    try {
      const r = await fetch(`${API}/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, nom, ...payload }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.dossier) {
        lastArchiveRef.current = { id: d.id, dossier: d.dossier, original_filename: d.fichier, nom, content_type: payload.url ? "video/mp4" : (payload.mime || "image/png") };
        patchTask(taskId, (t) => ({ ...t, archive: `${d.dossier} / ${d.fichier}` }));
        const m = `Création terminée — je l'affiche sur votre écran. Archivée dans : ${d.dossier} / ${d.fichier}`;
        setText(m); speakOut(m);
        return;
      }
      throw new Error();
    } catch (e) {
      const m = "Archivage échoué — la création reste affichée dans sa fenêtre.";
      setText(m); speakOut(m);
    }
  }, [patchTask, speakOut]);

  // Tâche SIRIUS : génération d'image (Nano Banana) — tout s'affiche dans la fenêtre dédiée, jamais dans le chat
  const launchImageTask = useCallback(async (prompt, requireReference = false) => {
    const id = openTask(`IMAGE — ${prompt.slice(0, 42).toUpperCase()}`, "image");
    pushStep(id, "Initialisation du moteur de rendu");
    setTimeout(() => pushStep(id, "Analyse du prompt"), 1000);
    setTimeout(() => pushStep(id, "Traitement — génération neuronale"), 2600);
    try {
      const displayReference = window.__siriusDisplayFile?.kind === "image"
        ? window.__siriusDisplayFile.file
        : null;
      const referenceFile = imageReferenceRef.current?.file || displayReference;
      if (requireReference && !referenceFile) {
        failTask(id, "Ajoutez d'abord une image de référence avec le bouton image.");
        const message = "Ajoutez d'abord l'image de référence avec le bouton situé dans la barre de commande.";
        setText(message);
        return;
      }
      const request = { prompt };
      if (referenceFile) {
        if (referenceFile.size > 10 * 1024 * 1024) {
          throw new Error("L'image de référence dépasse 10 Mo.");
        }
        pushStep(id, `Analyse de la référence — ${referenceFile.name || "image"}`);
        request.reference_image = await imageFileToBase64(referenceFile);
        request.reference_mime = referenceFile.type;
      }
      const r = await fetch(`${API}/task/image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.image) {
        pushStep(id, "Rendu de l'image");
        setTimeout(() => {
          pushStep(id, "Finalisation");
          finishTask(id, { kind: "image", src: `data:${d.mime || "image/png"};base64,${d.image}`, legende: d.texte || prompt });
          archiveCreation(id, "image", prompt, { data: d.image, mime: d.mime || "image/png" });
        }, 700);
        return;
      }
      failTask(id, d.detail || "Échec de la génération");
    } catch (e) {
      failTask(id, e.message || "Moteur de rendu injoignable");
    }
  }, [openTask, pushStep, finishTask, failTask, archiveCreation]);

  const selectImageReference = useCallback((file) => {
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      const message = "Format non accepté. Utilisez une image PNG, JPEG ou WebP.";
      setText(message);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      const message = "Cette image dépasse la limite de 10 mégaoctets.";
      setText(message);
      return;
    }
    if (imageReferenceRef.current?.url) URL.revokeObjectURL(imageReferenceRef.current.url);
    const next = { file, name: file.name, url: URL.createObjectURL(file) };
    imageReferenceRef.current = next;
    setImageReference(next);
    setText(`Image de référence prête : ${file.name}. Décrivez maintenant la transformation souhaitée.`);
  }, []);

  const clearImageReference = useCallback(() => {
    if (imageReferenceRef.current?.url) URL.revokeObjectURL(imageReferenceRef.current.url);
    imageReferenceRef.current = null;
    setImageReference(null);
    if (imageReferenceInputRef.current) imageReferenceInputRef.current.value = "";
  }, []);

  useEffect(() => () => {
    if (imageReferenceRef.current?.url) URL.revokeObjectURL(imageReferenceRef.current.url);
  }, []);

  const openArchiveWindow = useCallback((file) => {
    lastArchiveRef.current = file;
    if ((file.content_type || "") === "text/x-sirius-link" && file.url) {
      openWebWindow(file.url, file.nom || file.original_filename, false);
      setStatus("speaking");
      const m = "J'affiche l'archive sur votre écran.";
      setText(m); speakOut(m);
      return;
    }
    const isVideo = (file.content_type || "").startsWith("video/");
    const id = openTask(`ARCHIVE — ${(file.nom || file.original_filename).slice(0, 40).toUpperCase()}`, isVideo ? "video" : "image");
    pushStep(id, `Ouverture de l'archive ${file.dossier || "Médiathèque"} / ${file.original_filename}`);
    finishTask(id, {
      kind: isVideo ? "video" : "image",
      src: file.url || file.src || (file.content ? `data:${file.content_type};base64,${file.content}` : undefined),
      legende: file.nom || file.original_filename,
    });
    showOnDisplay({
      type: isVideo ? "video" : "image",
      src: file.url || file.src || (file.content ? `data:${file.content_type};base64,${file.content}` : undefined),
      legende: file.nom || file.original_filename,
    });
    setStatus("speaking");
    const m = `J'affiche ${isVideo ? "la vidéo" : "l'image"} sur votre écran.`;
    setText(m); speakOut(m);
  }, [openTask, pushStep, finishTask, openWebWindow, speakOut, showOnDisplay]);

  // Tâche SIRIUS : agent web invisible (Playwright) — recherche Google/DuckDuckGo + capture pour le Display
  const launchWebAgent = useCallback(async (query) => {
    const id = openTask(`WEB — ${query.slice(0, 44).toUpperCase()}`, "image");
    setStatus("thinking");
    const m0 = `Très bien, je lance la recherche web : ${query}.`;
    setText(m0); speakOut(m0);
    pushStep(id, "Lancement du navigateur invisible");
    setTimeout(() => pushStep(id, "Navigation et recherche en cours"), 1500);
    try {
      const r = await fetch(`${API}/webagent/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.image_b64) {
        pushStep(id, "Capture d'écran du résultat");
        pushStep(id, d.file ? "Capture sauvegardée dans la Médiathèque" : "Affichage du résultat");
        finishTask(id, { kind: "image", src: `data:image/jpeg;base64,${d.image_b64}`, legende: d.titre || query });
        const ext = (d.extraits || []).slice(0, 2).join(". ");
        const msg = `Recherche effectuée${d.moteur ? ` sur ${d.moteur}` : ""}.${ext ? ` Premiers résultats : ${ext}.` : ""} La capture est dans votre Médiathèque.`;
        setStatus("speaking"); setText(msg); speakOut(msg);
        return;
      }
      failTask(id, d.detail || "L'agent web a échoué");
      const msg = d.detail || "L'agent web a échoué, monsieur.";
      setStatus("speaking"); setText(msg); speakOut(msg);
    } catch (e) {
      failTask(id, "Agent web injoignable");
      const msg = "L'agent web est injoignable, monsieur.";
      setStatus("speaking"); setText(msg); speakOut(msg);
    }
  }, [openTask, pushStep, finishTask, failTask, speakOut]);

  // Tâche SIRIUS : génération de clip vidéo (fal.ai) — suivi en direct dans la fenêtre dédiée
  const launchVideoTask = useCallback(async (prompt) => {
    const id = openTask(`CLIP — ${prompt.slice(0, 44).toUpperCase()}`, "video");
    const technicalComment = "Analyse de la demande. Module vidéo requis.";
    setStatus("thinking");
    setText(technicalComment); speakOut(technicalComment);
    pushStep(id, technicalComment);
    pushStep(id, "Activation du moteur fal.ai. Construction du clip.");
    const durM = prompt.match(/(\d{1,2})\s*(?:s\b|sec\b|secondes?)/i);
    const wanted = durM ? parseInt(durM[1], 10) : 6;
    const dur = [6, 8, 10, 12, 14, 16, 18, 20].reduce((a, b) => (Math.abs(b - wanted) < Math.abs(a - wanted) ? b : a));
    pushStep(id, `Coût estimé : ~${(dur * 0.04).toFixed(2).replace(".", ",")} $ — ${dur} s × 0,04 $/s (LTX-2 fast · 1080p)`);
    let reqId = null;
    try {
      const r = await fetch(`${API}/task/video/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, keys, duration: dur }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.request_id) { failTask(id, d.detail || "Pipeline vidéo indisponible"); return; }
      reqId = d.request_id;
      pushStep(id, d.technical_comment || "File de génération fal.ai activée.");
    } catch (e) {
      failTask(id, "Pipeline vidéo injoignable");
      return;
    }
    pushStep(id, "Traitement — génération vidéo asynchrone");
    let renderStepDone = false;
    let statusFailures = 0;
    for (let i = 0; i < 90; i++) {
      await new Promise((res) => setTimeout(res, 5000));
      try {
        const r = await fetch(`${API}/task/video/status/${reqId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, keys }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { failTask(id, d.detail || "Échec de la génération vidéo"); return; }
        statusFailures = 0;
        const videoUrl = d.display_url || d.video_url;
        if (d.etat === "termine" && videoUrl && !videoUrl.startsWith("data:")) {
          pushStep(id, d.technical_comment || "Conversion du résultat. Préparation du fichier vidéo.");
          pushStep(id, d.display_comment || "Affichage du fichier vidéo dans SIRIUS Display.");
          finishTask(id, { kind: "video", src: videoUrl, legende: prompt });
          showOnDisplay({ type: "video", src: videoUrl, legende: prompt });
          archiveCreation(id, "video", prompt, { url: videoUrl });
          return;
        }
        if (d.etat === "termine") { failTask(id, "Fichier vidéo exploitable introuvable"); return; }
        if (d.etat === "en_cours" && !renderStepDone) {
          renderStepDone = true;
          pushStep(id, d.technical_comment || "Rendu — synthèse des images en cours");
        }
      } catch (e) {
        statusFailures += 1;
        if (statusFailures === 1) pushStep(id, "Contrôle technique du rendu interrompu. Nouvelle vérification.");
        if (statusFailures >= 3) { failTask(id, "Contrôle du rendu vidéo indisponible"); return; }
      }
    }
    failTask(id, "Délai de génération dépassé");
  }, [openTask, pushStep, finishTask, failTask, speakOut, keys, showOnDisplay, archiveCreation]);

  useEffect(() => {
    const onVideoGeneration = (event) => {
      const prompt = typeof event.detail?.prompt === "string" ? event.detail.prompt.trim() : "";
      if (prompt) launchVideoTask(prompt);
    };
    window.addEventListener("sirius:video-generation", onVideoGeneration);
    return () => window.removeEventListener("sirius:video-generation", onVideoGeneration);
  }, [launchVideoTask]);


  // Recherche une archive et propose son affichage
  const launchArchiveSearch = useCallback(async (query, noun) => {
    setStatus("thinking");
    setText(`Recherche dans la médiathèque : ${query || noun}...`);
    try {
      const r = await fetch(`${API}/archive/search?q=${encodeURIComponent(query)}&kind=${encodeURIComponent(noun || "")}`);
      const d = await r.json().catch(() => ({}));
      setStatus("speaking");
      if (r.ok && d.archive) {
        const isVideo = (d.archive.content_type || "").startsWith("video/");
        const isLink = (d.archive.content_type || "") === "text/x-sirius-link";
        const label = isLink ? "Archive trouvée" : isVideo ? "Vidéo trouvée" : "Image trouvée";
        setArchiveChoice({ file: d.archive, action: "open" });
        lastArchiveRef.current = d.archive;
        const m = `${label} : ${d.archive.dossier || "Médiathèque"} / ${d.archive.original_filename}. Veux-tu que je l'affiche ?`;
        setText(m); speakOut(m);
        return;
      }
      const m = "Aucune archive correspondante dans ma médiathèque.";
      setText(m); speakOut(m);
    } catch (e) {
      setStatus("speaking");
      const m = "Médiathèque momentanément inaccessible.";
      setText(m); speakOut(m);
    }
  }, [speakOut]);

  // Suppression d'archive à la voix (avec confirmation)
  const deleteArchive = useCallback(async (file) => {
    try {
      const r = await fetch(`${API}/files/${file.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error();
      setStatus("speaking");
      const m = `Archive supprimée : ${file.dossier || "Médiathèque"} / ${file.original_filename}.`;
      setText(m); speakOut(m);
    } catch (e) {
      setStatus("speaking");
      const m = "Suppression impossible pour le moment.";
      setText(m); speakOut(m);
    }
  }, [speakOut]);

  const launchArchiveDelete = useCallback(async (query, noun) => {
    setStatus("thinking");
    try {
      const r = await fetch(`${API}/archive/search?q=${encodeURIComponent(query)}&kind=${encodeURIComponent(noun || "")}`);
      const d = await r.json().catch(() => ({}));
      setStatus("speaking");
      if (r.ok && d.archive) {
        setArchiveChoice({ file: d.archive, action: "delete" });
        lastArchiveRef.current = d.archive;
        const m = `Archive trouvée : ${d.archive.dossier || "Médiathèque"} / ${d.archive.original_filename}. Confirmez-vous la suppression ?`;
        setText(m); speakOut(m);
        return;
      }
      const m = "Aucune archive correspondante à supprimer.";
      setText(m); speakOut(m);
    } catch (e) {
      setStatus("speaking");
      const m = "Médiathèque momentanément inaccessible.";
      setText(m); speakOut(m);
    }
  }, [speakOut]);

  // Renommage d'archive à la voix (« renomme l'image du phénix en phenix-final », « renomme-la en X »)
  const launchArchiveRename = useCallback(async (targetQuery, newName) => {
    setStatus("thinking");
    let file = null;
    if (targetQuery && targetQuery.length > 2) {
      try {
        const r = await fetch(`${API}/archive/search?q=${encodeURIComponent(targetQuery)}`);
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.archive) file = d.archive;
      } catch (e) {}
    } else {
      file = lastArchiveRef.current;
    }
    setStatus("speaking");
    if (!file) {
      const m = "Précisez quelle archive renommer.";
      setText(m); speakOut(m);
      return;
    }
    try {
      const r = await fetch(`${API}/archive/${file.id}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nom: newName }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.fichier) {
        lastArchiveRef.current = { ...file, nom: newName, original_filename: d.fichier };
        const m = `Archive renommée : ${d.dossier || "Médiathèque"} / ${d.fichier}.`;
        setText(m); speakOut(m);
        return;
      }
      throw new Error();
    } catch (e) {
      const m = "Renommage impossible pour le moment.";
      setText(m); speakOut(m);
    }
  }, [speakOut]);

  // Plateformes externes en fenêtre HUD dédiée (via proxy SIRIUS) + archivage des contenus consultés
  const launchPlatform = useCallback(async (key, query) => {
    const PLATFORMS = {
      youtube: { nom: "YouTube", home: "https://www.youtube.com/results?search_query=tendances+du+jour", search: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}` },
      tiktok: { nom: "TikTok", home: "https://www.tiktok.com/explore", search: (q) => `https://www.tiktok.com/search?q=${encodeURIComponent(q)}` },
      instagram: { nom: "Instagram", home: "https://www.instagram.com", search: (q) => `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(q)}` },
      facebook: { nom: "Facebook", home: "https://www.facebook.com", search: (q) => `https://www.facebook.com/search/top?q=${encodeURIComponent(q)}` },
      whatsapp: { nom: "WhatsApp", home: "https://web.whatsapp.com", search: null },
    };
    const p = PLATFORMS[key];
    if (!p) return;
    const url = query && p.search ? p.search(query) : p.home;
    openWebWindow(url, query ? `${p.nom} — ${query}` : p.nom, false);
    setStatus("speaking");
    if (!query) {
      const m = `J'affiche ${p.nom} sur votre écran.`;
      setText(m); speakOut(m);
      return;
    }
    let m = `J'affiche ${p.nom} — ${query} sur votre écran.`;
    try {
      const r = await fetch(`${API}/archive/link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nom: `${p.nom} — ${query}`, url, dossier: p.nom }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.dossier) {
        lastArchiveRef.current = { id: d.id, dossier: d.dossier, original_filename: d.fichier, nom: `${p.nom} — ${query}`, content_type: "text/x-sirius-link", url };
        m += ` Archive créée : ${d.dossier} / ${d.fichier}. Emplacement mémorisé.`;
      }
    } catch (e) {}
    setText(m); speakOut(m);
  }, [openWebWindow, speakOut]);

  // ---- Outlook (Microsoft Graph) : emails + calendrier dans des fenêtres HUD ----
  const connectOutlook = useCallback(() => {
    window.open(`${API}/auth/microsoft/login`, "_blank", "noopener,noreferrer");
    setStatus("speaking");
    const m = "Connexion Outlook lancée dans un nouvel onglet. Authentifiez-vous, puis revenez ici.";
    setText(m); speakOut(m);
  }, [speakOut]);

  // Lecture vocale des derniers mails Outlook (Microsoft Graph par utilisateur, repli sur l'ancien connecteur)
  const readMailAloud = useCallback(async () => {
    const id = openTask("OUTLOOK — LECTURE DES MAILS", "outlook");
    pushStep(id, "Connexion à Microsoft Graph");
    let mails = null, nonLus = 0;
    try {
      const r = await fetch(`${API}/microsoft/mail?top=5`);
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        mails = (d.mails || []).map((m) => ({ de: m.de, sujet: m.sujet, apercu: m.apercu, lu: m.lu, date: m.recu }));
        nonLus = mails.filter((m) => !m.lu).length;
      } else if (r.status === 401 || r.status === 409) {
        failTask(id, "Compte Microsoft non connecté");
        setStatus("speaking");
        const m = "Ton compte Outlook n'est pas encore connecté. Dis « connecte Outlook », authentifie-toi avec Microsoft, puis demande-moi de lire tes emails.";
        setText(m); speakOut(m);
        return;
      } else {
        throw new Error(d.detail || `Microsoft Graph a répondu avec le code ${r.status}`);
      }
    } catch (e) {
      failTask(id, e.message || "Microsoft Graph injoignable");
      setStatus("speaking");
      const m = "Je n'arrive pas à joindre Microsoft Graph pour le moment.";
      setText(m); speakOut(m);
      return;
    }
    setStatus("speaking");
    if (!mails.length) {
      finishTask(id, { kind: "text", texte: "Boîte de réception vide.", legende: "Outlook · aucun mail" });
      const m = "Ta boîte de réception Outlook est vide.";
      setText(m); speakOut(m);
      return;
    }
    pushStep(id, "Composition de la lecture vocale");
    const top = mails.slice(0, 3);
    let spoken = nonLus > 0 ? `Tu as ${nonLus} mail${nonLus > 1 ? "s" : ""} non lu${nonLus > 1 ? "s" : ""}. ` : "Aucun mail non lu. ";
    spoken += top.length > 1 ? `Voici tes ${top.length} derniers mails. ` : "Voici ton dernier mail. ";
    top.forEach((m, i) => {
      spoken += `${i + 1} : de ${m.de || "expéditeur inconnu"}, sujet : ${m.sujet || "sans objet"}. `;
      if (!m.lu && m.apercu) spoken += `Aperçu : ${m.apercu}. `;
    });
    const lignes = mails.map((m) => `${m.lu ? "  " : "● "}${m.date || ""} — ${m.de}\n   ${m.sujet}\n   ${m.apercu || ""}`).join("\n\n");
    finishTask(id, { kind: "text", texte: lignes, legende: `Outlook · lecture de ${top.length} mail(s)` });
    setText(spoken); speakOut(spoken);
  }, [openTask, pushStep, finishTask, failTask, speakOut]);

  // Lecture des mails Gmail (compte Google connecté via l'Agenda) : voix + fenêtre HUD
  const readGmailAloud = useCallback(async (openOnly = false) => {
    const id = openTask(openOnly ? "GMAIL — BOÎTE DE RÉCEPTION" : "GMAIL — LECTURE DES MAILS", "outlook");
    pushStep(id, "Connexion à Gmail");
    try {
      const r = await fetch(`${API}/gmail/messages?top=5`);
      const d = await r.json().catch(() => ({}));
      setStatus("speaking");
      if (r.status === 401) {
        failTask(id, "Compte Google non connecté");
        const m = "Connecte d'abord ton compte Google : ouvre l'Agenda, clique sur « Connecter Google », puis redemande-moi tes mails Gmail.";
        setText(m); speakOut(m);
        return;
      }
      if (!r.ok) {
        const msg = d.detail || "Gmail est injoignable pour le moment.";
        failTask(id, msg);
        setText(msg); speakOut(msg);
        return;
      }
      const mails = d.mails || [];
      if (!mails.length) {
        finishTask(id, { kind: "text", texte: "Boîte de réception vide.", legende: "Gmail · aucun mail" });
        const m = "Ta boîte Gmail est vide.";
        setText(m); speakOut(m);
        return;
      }
      const lignes = mails.map((m) => `${m.lu ? "  " : "● "}${m.date || ""} — ${m.de}\n   ${m.sujet}\n   ${m.apercu || ""}`).join("\n\n");
      finishTask(id, { kind: "text", texte: `NON LUS : ${d.non_lus}\n\n${lignes}`, legende: `Gmail · ${d.non_lus} non lu(s)` });
      let spoken;
      if (openOnly) {
        spoken = d.non_lus > 0 ? `Tu as ${d.non_lus} mail${d.non_lus > 1 ? "s" : ""} Gmail non lu${d.non_lus > 1 ? "s" : ""}. Détails dans la fenêtre.` : "Aucun mail Gmail non lu. Boîte affichée dans la fenêtre.";
      } else {
        const top = mails.slice(0, 3);
        spoken = d.non_lus > 0 ? `Tu as ${d.non_lus} mail${d.non_lus > 1 ? "s" : ""} Gmail non lu${d.non_lus > 1 ? "s" : ""}. ` : "Aucun mail Gmail non lu. ";
        spoken += top.length > 1 ? `Voici tes ${top.length} derniers mails. ` : "Voici ton dernier mail. ";
        top.forEach((m, i) => {
          spoken += `${i + 1} : de ${m.de || "expéditeur inconnu"}, sujet : ${m.sujet || "sans objet"}. `;
          if (!m.lu && m.apercu) spoken += `Aperçu : ${m.apercu}. `;
        });
      }
      setText(spoken); speakOut(spoken);
    } catch (e) {
      failTask(id, "Gmail injoignable");
      const m = "Je n'arrive pas à joindre Gmail pour le moment.";
      setText(m); speakOut(m);
    }
  }, [openTask, pushStep, finishTask, failTask, speakOut]);

  const launchOutlookMail = useCallback(async () => {    const id = openTask("OUTLOOK — BOÎTE DE RÉCEPTION", "outlook");
    pushStep(id, "Connexion à Microsoft Graph");
    try {
    const r = await fetch(`${API}/microsoft/mail?top=12`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        failTask(id, d.detail || "Lecture impossible");
        setStatus("speaking");
        const m = r.status === 401 || r.status === 409
          ? "Ton compte Outlook n'est pas encore connecté. Dis « connecte Outlook », puis authentifie-toi avec Microsoft."
          : (d.detail || "Je n'arrive pas à lire Outlook pour le moment.");
        setText(m); speakOut(m);
        return;
      }
      pushStep(id, "Analyse de la boîte de réception");
      const mails = d.mails || [];
      const nonLus = mails.filter((mail) => !mail.lu).length;
      const lignes = mails.map((m) =>
        `${m.lu ? "  " : "● "}${m.recu || ""} — ${m.de}\n   ${m.sujet}\n   ${m.apercu || ""}`).join("\n\n") || "Boîte de réception vide.";
      finishTask(id, { kind: "text", texte: `NON LUS : ${nonLus}\n\n${lignes}`, legende: `Outlook · ${nonLus} non lu(s)` });
      setStatus("speaking");
      const m = nonLus > 0 ? `Vous avez ${nonLus} email${nonLus > 1 ? "s" : ""} non lu${nonLus > 1 ? "s" : ""}. Détails dans la fenêtre.` : "Aucun email non lu. Boîte affichée dans la fenêtre.";
      setText(m); speakOut(m);
    } catch (e) { failTask(id, "Microsoft Graph injoignable"); }
  }, [openTask, pushStep, finishTask, failTask, speakOut]);

  const launchOutlookAgenda = useCallback(async () => {
    const id = openTask("OUTLOOK — AGENDA (14 JOURS)", "outlook");
    pushStep(id, "Connexion à Microsoft Graph");
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!tz) {
        failTask(id, "Fuseau horaire local indisponible");
        return;
      }
      const r = await fetch(`${API}/outlook/events?tz=${encodeURIComponent(tz)}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { failTask(id, d.detail || "Lecture impossible"); return; }
      pushStep(id, "Lecture du calendrier");
      const evts = d.evenements || [];
      const lignes = evts.map((e) => `▸ ${e.debut} → ${e.fin.slice(-5)}\n   ${e.titre}${e.lieu ? `\n   Lieu : ${e.lieu}` : ""}`).join("\n\n") || "Aucun rendez-vous dans les 14 prochains jours.";
      finishTask(id, { kind: "text", texte: lignes, legende: `Outlook · ${evts.length} événement(s)` });
      setStatus("speaking");
      const m = evts.length ? `${evts.length} rendez-vous à venir. Prochain : ${evts[0].titre}, le ${evts[0].debut}. Agenda affiché.` : "Aucun rendez-vous à venir sur 14 jours.";
      setText(m); speakOut(m);
    } catch (e) { failTask(id, "Microsoft Graph injoignable"); }
  }, [openTask, pushStep, finishTask, failTask, speakOut]);

  const launchOutlookCreateEvent = useCallback(async (rest) => {
    const d = new Date();
    if (/apr[èe]s[- ]demain/.test(rest)) d.setDate(d.getDate() + 2);
    else if (/demain/.test(rest)) d.setDate(d.getDate() + 1);
    const hm = rest.match(/(\d{1,2})\s*h\s*(\d{2})?/);
    d.setHours(hm ? parseInt(hm[1], 10) : 9, hm && hm[2] ? parseInt(hm[2], 10) : 0, 0, 0);
    const titre = rest.replace(/apr[èe]s[- ]demain|demain|aujourd'hui/g, "")
      .replace(/(\d{1,2})\s*h\s*(\d{2})?/, "").replace(/^\s*[àa]\s+/, "").trim() || "Rendez-vous";
    const fin = new Date(d.getTime() + 3600000);
    const fmt = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}T${String(x.getHours()).padStart(2, "0")}:${String(x.getMinutes()).padStart(2, "0")}:00`;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz) {
      setStatus("speaking");
      const m = "Fuseau horaire local indisponible.";
      setText(m); speakOut(m);
      return;
    }
    setStatus("thinking");
    try {
      const r = await fetch(`${API}/outlook/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ titre, start: fmt(d), end: fmt(fin), tz }),
      });
      const dd = await r.json().catch(() => ({}));
      setStatus("speaking");
      const m = r.ok ? `Rendez-vous créé : ${titre}, le ${fmt(d).slice(0, 10)} à ${fmt(d).slice(11, 16)}.` : (dd.detail || "Création impossible");
      setText(m); speakOut(m);
    } catch (e) {
      setStatus("speaking");
      setText("Microsoft Graph injoignable"); speakOut("Microsoft Graph injoignable");
    }
  }, [speakOut]);

  // ---- Intents Outlook (JSON strict) : lecture directe, actions sensibles confirmées ----
  const runOutlookExecute = useCallback(async (intent, parameters, actionToken) => {
    const id = openTask(`OUTLOOK — ${intent.replace("outlook.", "").toUpperCase()}`, "outlook");
    pushStep(id, "Exécution via Microsoft Graph");
    try {
      const r = await fetch(`${API}/outlook/intent/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent, parameters, actionToken: actionToken || null }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        failTask(id, d.detail || "Exécution impossible");
        setStatus("speaking"); setText(d.detail || "Exécution impossible"); speakOut(d.detail || "Exécution impossible");
        return;
      }
      const res = d.result || {};
      let texte = d.responseText || "";
      if (res.messages) {
        texte = (res.messages.map((m) => `${m.lu ? "  " : "● "}${m.date} — ${m.de}\n   ${m.sujet}\n   ${m.apercu}`).join("\n\n")) || "Aucun message.";
        if (res.non_lus !== undefined) texte = `NON LUS : ${res.non_lus}\n\n${texte}`;
      }
      if (res.dossiers) texte = res.dossiers.map((f) => `▸ ${f.nom} — ${f.non_lus} non lu(s) / ${f.total} message(s)`).join("\n");
      if (res.corps) texte = `DE : ${res.de}\nSUJET : ${res.sujet}\nDATE : ${res.date}\n\n${res.corps}`;
      finishTask(id, { kind: "text", texte, legende: (d.responseText || "").slice(0, 90) });
      setStatus("speaking"); setText(d.responseText); speakOut(d.responseText);
    } catch (e) { failTask(id, "Microsoft Graph injoignable"); }
  }, [openTask, pushStep, finishTask, failTask, speakOut]);

  const launchOutlookIntent = useCallback(async (command) => {
    setStatus("thinking");
    try {
      const r = await fetch(`${API}/outlook/intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: command, keys }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setStatus("speaking");
        const m = d.detail || "Commande Outlook non comprise.";
        setText(m); speakOut(m);
        return;
      }
      if (d.requiresConfirmation) {
        setOutlookChoice({ intent: d.intent, parameters: d.parameters, token: d.actionToken });
        setStatus("speaking"); setText(d.responseText); speakOut(d.responseText);
        return;
      }
      runOutlookExecute(d.intent, d.parameters, null);
    } catch (e) {
      setStatus("speaking");
      setText("Microsoft Graph injoignable"); speakOut("Microsoft Graph injoignable");
    }
  }, [keys, runOutlookExecute, speakOut]);

  // Lance directement la requête sur le service choisi
  // Spotify connecté → VRAIE lecture via l'API (appareil actif requis, Premium pour la lecture à distance)
  const launchMusic = useCallback(async (query, source) => {
    if (source === "spotify" && spotifyRef.current && spotifyRef.current.access_token) {
      setStatus("thinking");
      setText(`Lancement de « ${query} » sur Spotify...`);
      try {
        const r = await fetch(`${API}/spotify/play`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...spotifyRef.current, query, device_id: playerDeviceRef.current || "" }),
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok) {
          if (d.access_token) saveSpotify({ ...spotifyRef.current, access_token: d.access_token });
          setStatus("speaking");
          const m = `Lecture de ${d.title}${d.artist ? `, de ${d.artist}` : ""}, sur Spotify.`;
          setText(m); speakOut(m);
          return;
        }
        setStatus("speaking");
        if (d.error === "no_device") {
          const m = "Aucun appareil Spotify disponible. Reconnectez votre compte Spotify pour activer mon lecteur intégré, ou ouvrez l'application Spotify.";
          setText(m); speakOut(m);
          return;
        }
        if (d.error === "premium") {
          const m = "La lecture à distance nécessite Spotify Premium. J'ouvre la recherche à la place.";
          setText(m); speakOut(m);
          try { window.open("https://open.spotify.com/search/" + encodeURIComponent(query), "_blank"); } catch (e) {}
          return;
        }
        if (r.status === 401 || d.error === "scope") {
          const m = "Reconnectez votre compte Spotify (bouton en haut à droite) pour m'autoriser à lancer la lecture.";
          setText(m); speakOut(m);
          return;
        }
        if (d.error === "not_found") {
          const m = `Je n'ai trouvé aucun titre pour « ${query} » sur Spotify.`;
          setText(m); speakOut(m);
          return;
        }
      } catch (e) {}
      // Erreur inattendue → repli sur la recherche web
    }
    const url = source === "youtube"
      ? "https://www.youtube.com/results?search_query=" + encodeURIComponent(query)
      : "https://open.spotify.com/search/" + encodeURIComponent(query);
    try { window.open(url, "_blank"); } catch (e) {}
    setStatus("speaking");
    const msg = `Je lance « ${query} » sur ${source === "youtube" ? "YouTube" : "Spotify"}.`;
    setText(msg);
    speakOut(msg);
  }, [speakOut, saveSpotify]);

// Détermine la requête puis demande le service (sauf préférence enregistrée)
  const openMusic = useCallback((command) => {
    const rawCmd = typeof command === 'string' ? command : (command?.text || "");
    const low = rawCmd.toLowerCase();
    
    let query = "";
    if (/(d[ée]tente|relax|calme|zen|chill)/.test(low)) query = "ambiance relaxante lofi";
    else if (/(concentration|travail|focus|[ée]tudier|bosser)/.test(low)) query = "musique concentration focus lofi";
    else if (/(pluie)/.test(low)) query = "bruit de pluie pour dormir";
    else if (/(dormir|sommeil|nuit)/.test(low)) query = "musique pour dormir";
    else {
      // On retire les mots déclencheurs et on garde le reste comme recherche
      query = low
        .replace(/\b(sirius|mets[- ]?moi|mets|met|mettre|joue[r]?|lance[r]?|s'il te pla[îi]t|stp|de la|du|des|une|un|de|moi)\b/gi, " ")
        .replace(/\s+/g, " ").trim();
      if (!query || query === "musique" || query === "chanson" || query === "son" || query === "ambiance")
        query = "musique playlist tendance";
    }

    const pref = localStorage.getItem("sirius_music_source");
    if (pref === "spotify" || pref === "youtube") { launchMusic(query, pref); return; }
    
    setMusicChoice(query);
    setStatus("speaking");
    const msg = `Sur quoi je lance « ${query} » ? Spotify ou YouTube ?`;
    setText(msg);
    speakOut(msg);
  }, [launchMusic, speakOut]);

  // Connexion Spotify (popup OAuth, lecture seule)
  const connectSpotify = useCallback(async () => {
    try {
      const r = await fetch(`${API}/spotify/login`);
      const d = await r.json();
      if (!d.auth_url) throw new Error("no url");
      window.open(d.auth_url, "spotify-auth", "width=520,height=720");
      setText("Connecte-toi à Spotify dans la fenêtre qui s'ouvre...");
    } catch (e) {
      setText("Impossible de lancer la connexion Spotify pour le moment.");
    }
  }, []);

  // Réception des tokens Spotify renvoyés par la popup
  useEffect(() => {
    const onMsg = (e) => {
      if (e.origin !== window.location.origin) return; // sécurité : n'accepte que notre propre popup
      const data = e.data;
      if (!data || data.type !== "spotify-auth") return;
      if (data.error || !data.access_token) {
        setText("La connexion Spotify a échoué. Réessayez.");
        return;
      }
      saveSpotify({ access_token: data.access_token, refresh_token: data.refresh_token });
      setStatus("speaking");
      const m = "Spotify connecté. Demandez-moi « qu'est-ce qui joue ? ».";
      setText(m); speakOut(m);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [saveSpotify, speakOut]);

  // Récupère le morceau en cours sur Spotify et l'annonce
  const fetchNowPlaying = useCallback(async () => {
    const tok = spotifyRef.current;
    if (!tok || !tok.access_token) {
      setStatus("speaking");
      const m = "Connectez d'abord votre compte Spotify avec le bouton en haut à droite.";
      setText(m); speakOut(m);
      return;
    }
    setStatus("thinking");
    setText("Je vérifie ce qui joue sur Spotify...");
    try {
      const resp = await fetch(`${API}/spotify/now-playing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tok),
      });
      if (resp.status === 401) {
        saveSpotify(null);
        setStatus("speaking");
        const m = "Votre session Spotify a expiré. Reconnectez-vous.";
        setText(m); speakOut(m);
        return;
      }
      const d = await resp.json();
      if (d.access_token) saveSpotify({ ...tok, access_token: d.access_token });
      setStatus("speaking");
      if (!d.title) {
        setNowPlaying(null);
        const m = "Rien ne joue sur Spotify en ce moment.";
        setText(m); speakOut(m);
        return;
      }
      setNowPlaying({ title: d.title, artist: d.artist, image: d.image, playing: d.playing, progress_ms: d.progress_ms, duration_ms: d.duration_ms });
      showCard({ type: "spotify", title: d.title, artist: d.artist, album: d.album, image: d.image, playing: d.playing });
      const m = `${d.playing ? "En écoute" : "En pause"} : ${d.title}, de ${d.artist}.`;
      setText(m); speakOut(m);
    } catch (e) {
      setStatus("speaking");
      const m = "Je n'arrive pas à joindre Spotify pour le moment.";
      setText(m); speakOut(m);
    }
  }, [saveSpotify, speakOut, showCard]);

  // Mise à jour silencieuse du bandeau « En écoute » (sans parler)
  const refreshNowPlayingBanner = useCallback(async () => {
    const tok = spotifyRef.current;
    if (!tok || !tok.access_token) return;
    try {
      const resp = await fetch(`${API}/spotify/now-playing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tok),
      });
      if (resp.status === 401) { saveSpotify(null); setNowPlaying(null); return; }
      const d = await resp.json();
      if (d.access_token) saveSpotify({ ...tok, access_token: d.access_token });
      if (d.title) setNowPlaying({ title: d.title, artist: d.artist, image: d.image, playing: d.playing, progress_ms: d.progress_ms, duration_ms: d.duration_ms });
      else setNowPlaying(null);
    } catch (e) {}
  }, [saveSpotify]);

  // Sondage périodique du morceau en cours quand Spotify est connecté
  useEffect(() => {
    if (!spotify || !spotify.access_token) { setNowPlaying(null); return; }
    refreshNowPlayingBanner();
    const id = setInterval(refreshNowPlayingBanner, 10000);
    return () => clearInterval(id);
  }, [spotify, refreshNowPlayingBanner]);

  // Lecteur Spotify intégré : le HUD devient un appareil Spotify Connect « SIRIUS HUD »
  // (Web Playback SDK — nécessite Spotify Premium ; sans Premium, repli sur les appareils externes)
  useEffect(() => {
    const refreshTok = spotify && spotify.refresh_token;
    if (!refreshTok) return;
    let player = null;
    let cancelled = false;
    const init = () => {
      if (cancelled || playerDeviceRef.current) return;
      try {
        player = new window.Spotify.Player({
          name: "SIRIUS HUD",
          volume: 0.8,
          getOAuthToken: async (cb) => {
            try {
              const r = await fetch(`${API}/spotify/refresh`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ refresh_token: spotifyRef.current && spotifyRef.current.refresh_token }),
              });
              const d = await r.json();
              if (d.access_token) {
                saveSpotify({ ...spotifyRef.current, access_token: d.access_token });
                cb(d.access_token);
              }
            } catch (e) {}
          },
        });
        player.addListener("ready", ({ device_id }) => { playerDeviceRef.current = device_id; });
        player.addListener("not_ready", () => { playerDeviceRef.current = null; });
        player.addListener("account_error", () => { playerDeviceRef.current = null; }); // pas de Premium
        player.addListener("initialization_error", () => {});
        player.addListener("authentication_error", () => {});
        player.connect();
      } catch (e) {}
    };
    if (window.Spotify && window.Spotify.Player) init();
    else {
      window.onSpotifyWebPlaybackSDKReady = init;
      if (!document.getElementById("spotify-sdk")) {
        const s = document.createElement("script");
        s.id = "spotify-sdk";
        s.src = "https://sdk.scdn.co/spotify-player.js";
        s.async = true;
        document.body.appendChild(s);
      }
    }
    return () => {
      cancelled = true;
      if (player) { try { player.disconnect(); } catch (e) {} }
      playerDeviceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotify && spotify.refresh_token, saveSpotify]);

  // Ouverture / restauration vocale d'un module (« ouvre la bourse », « affiche thémis »)
  const moduleItemsRef = useRef([]);
  const openModuleByName = useCallback((raw) => {
    const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const t = norm(raw).replace(/[?!.]+$/, "").trim();
    if (!t || t.length < 3) return false;
    const words = t.split(/\s+/).filter((w) => w.length > 3);
    const matches = (hay) => hay.includes(t) || (words.length > 0 && words.every((w) => hay.includes(w)));
    // 1) fenêtre réduite en pastille → restaurer
    for (const p of document.querySelectorAll(".holo-dock-pill")) {
      if (matches(norm(p.textContent))) {
        p.click();
        const msg = "Je restaure la fenêtre.";
        setText(msg);
        speakOut(msg);
        return true;
      }
    }
    // 2) module du panthéon par libellé / id / alias
    const ALIASES = {
      nummarius: "bourse marches finances actions cryptos portus",
      cortex: "zeus cerveau",
      themis: "facturation factures devis clients stocks",
      admin: "administration comptes utilisateurs",
      gcal: "calendrier agenda google",
      display: "ecran display",
      oracle: "oracle previsions",
      memorymgr: "souvenirs memoire",
    };
    for (const it of moduleItemsRef.current) {
      const hay = norm(`${it.label} ${it.id} ${ALIASES[it.id] || ""}`);
      if (matches(hay)) {
        it.run();
        const msg = `J'ouvre ${it.label.split("—")[0].trim()}.`;
        setText(msg);
        speakOut(msg);
        return true;
      }
    }
    return false;
  }, [speakOut]);

// Compréhension naturelle : la phrase part vers Groq, qui renvoie une intention UI ou « none »
  const resolveIntent = useCallback(async (command) => {
    if (!command || isBusy.current) return;

    setStatus("thinking");
    isBusy.current = true;

    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 90000);

      const r = await fetch(`${API}/intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: command }),
        signal: ctrl.signal,
      });

      clearTimeout(to);
      const d = await r.json().catch(() => null);

      // Si une intention UI est détectée et exécutée, on s'arrête là
      if (r.ok && d && d.action && d.action !== "none" && executeIntent(d)) {
        setMetrics((m) => ({ ...m, nlu: { intent: `groq · ${d.action}`, count: m.nlu.count } }));
        return;
      }

      // Sinon, on bascule sur la réponse classique du cerveau (cloudAnswer)
      await cloudAnswer(command);

    } catch (e) {
      if (isAbortError(e)) {
        setStatus("idle");
        return;
      }
      console.error("[SIRIUS NLU] Erreur intent :", e);
      // En cas de pépin sur l'intent, fallback de secours sur cloudAnswer
      await cloudAnswer(command).catch(() => {});
    } finally {
      // ⚡ SECURITE ABSOLUE : Débloque le réacteur et ferme le flou visuel dans 100% des cas
      isBusy.current = false;
      setStatus("idle");
    }
  }, [executeIntent, cloudAnswer]);

  const processCommand = useCallback((command) => {
    if (!command) return;
    const low = command.toLowerCase();

    // Mode contextuel adaptatif : suivi du rythme d'activité
    cmdTimesRef.current = [...cmdTimesRef.current.filter((t) => Date.now() - t < 120000), Date.now()];

    // Suivi analytique : intention détectée + compteur d'échanges
    const mark = (intent) => {
      setMetrics((m) => ({
        ...m,
        nlu: { intent, count: m.nlu.count + 1 },
        ctx: { exchanges: m.ctx.exchanges + 1 },
      }));
    };

    if (DAILY_BRIEFING_COMMAND.test(low) && runBriefingRef.current) {
      mark("briefing · demande");
      runBriefingRef.current(true);
      return;
    }

    mark("analyse...");

  // Lancement de la résolution d'intention
    resolveIntent(command);
  }, [resolveIntent]);

// ⚡ PIPELINE DE COMMANDE SÉCURISÉ (Inclus : Archives, Proactivité & Sécurité)
  const handleCommand = async (command, intent = null) => {
    if (!command || (typeof command === "string" && !command.trim())) return;

    // 00) Normalisation UNE SEULE FOIS pour tout le pipeline
    const low = (typeof command === "string" ? command : command?.text || "").toLowerCase().trim();

    // Suivi analytique : intention détectée + compteur d'échanges (partagé dans tout le pipeline)
    const mark = (intentLabel) => {
      setMetrics((m) => ({
        ...m,
        nlu: { intent: intentLabel, count: m.nlu.count + 1 },
        ctx: { exchanges: m.ctx.exchanges + 1 },
      }));
    };

    // 01) Proactivité & Maintien de l'activité utilisateur
    lastActivityRef.current = Date.now();
    idleNotifiedRef.current = false;

    // 02) Modes système : secours / frugal / diagnostic / vision
    if (/\bmode (de )?secours\b|safe ?mode/.test(low)) {
      mark("système · mode secours");
      setSystemMode("safe", "manual", "activation manuelle").then((d) => {
        const m = (d && d.responseText) || "Mode restreint activé.";
        setStatus("speaking"); setText(m); speakOut(m);
      });
      return;
    }

    // 03) Gestion des confirmations interactives (Dialogue d'archive)
    if (archiveChoice) {
      const pending = archiveChoice;
      setArchiveChoice(null);

      if (/\b(oui|ouais|vas[- ]y|affiche|montre|ok|d'accord|bien s[ûu]r|confirme)\b/.test(low)) {
        if (pending.action === "delete") {
          mark("archive · suppression");
          deleteArchive(pending.file);
        } else {
          mark("archive · affichage");
          openArchiveWindow(pending.file);
        }
        return;
      }

      if (/\b(non|annule|laisse|pas maintenant|plus tard)\b/.test(low)) {
        mark("archive · refus");
        setStatus("speaking");
        const m = pending.action === "delete" ? "Suppression annulée." : "Très bien, l'archive reste en réserve.";
        setText(m);
        speakOut(m);
        return;
      }
    }

    // 04) Apprentissage SIRIUS PRIME (Enregistrement en arrière-plan)
    fetch(`${API}/prime/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: typeof command === "string" ? command : command?.text, intent }),
    }).catch(() => {});

    // 00bis) Action Outlook sensible en attente : « oui » → exécution réelle
    if (outlookChoice) {
      const pending = outlookChoice;
      setOutlookChoice(null);
      if (/\b(oui|ouais|vas[- ]y|ok|d'accord|confirme|je confirme|bien s[ûu]r)\b/.test(low)) {
        mark("outlook · confirmation");
        runOutlookExecute(pending.intent, pending.parameters, pending.token);
        return;
      }
      if (/\b(non|annule|laisse|pas maintenant|surtout pas)\b/.test(low)) {
        mark("outlook · annulation");
        setStatus("speaking");
        const m = "Action Outlook annulée, monsieur.";
        setText(m); speakOut(m);
        return;
      }
    }
    
    if (sysMode !== "normal" && /\bmode normal\b|d[ée]sactive le mode (secours|frugal|restreint)|frugal off/.test(low)) {
      mark("système · retour normal");
      setFrugalManual(null);
      setSystemMode("normal", "manual").then((d) => {
        const m = (d && d.responseText) || "Retour au fonctionnement normal.";
        setStatus("speaking"); setText(m); speakOut(m);
      });
      return;
    }
    if (/\bmode frugal\b|frugal on/.test(low)) {
      mark("système · mode frugal");
      setFrugalManual(true);
      setSystemMode("frugal", "manual", "activation manuelle").then(() => {
        const m = "Mode frugal activé : animations réduites, réponses courtes, appels IA limités.";
        setStatus("speaking"); setText(m); speakOut(m);
      });
      return;
    }
    if (/^diagnostic( syst[èe]me)?$|pourquoi es[- ]tu en mode (secours|restreint)/.test(low.trim())) {
      mark("système · diagnostic");
      fetch(`${API}/system/diagnostic`).then((r) => r.json()).then((d) => {
        setStatus("speaking"); setText(d.responseText); speakOut(d.responseText);
      }).catch(() => {});
      return;
    }
    if (/active (la |ta )?(vision|cam[ée]ra)|que vois[- ]tu|qu'?est[- ]ce que tu vois|regarde[- ]?(moi )?(ça|ceci|cela)\b|regarde[- ]moi\b|ouvre (la |ta )?cam[ée]ra/.test(low)) {
      mark("système · vision");
      if (sysMode === "safe") {
        const m = "Vision indisponible en mode de secours, monsieur.";
        setStatus("speaking"); setText(m); speakOut(m);
        return;
      }
      const auto = /que vois[- ]tu|qu'?est[- ]ce que tu vois|regarde[- ]?(moi )?(ça|ceci|cela)\b/.test(low);
      setVisionAuto(auto);
      setShowVision(true);
      const m = auto ? "Un instant, j'observe ce que vous me montrez." : "Module vision activé. J'observe via la caméra dès que vous l'autorisez.";
      setStatus("speaking"); setText(m); speakOut(m);
      return;
    }
    // 0) Panneau ZEUS CORTEX
    if (/montre[\s-]*(moi)?[\s-]*(ton|le)?[\s-]*cortex/.test(low)) {
      mark("cortex");
      setShowCortex(true);
      const m = "Accès autorisé. Voici mon cortex, Sirius t'écoute.";
      setText(m); speakOut(m);
      return;
    }
    // 0bis) Commande vocale des modules : « ouvre le panthéon », « montre le nexus »...
    const moduleCmds = [
      [/panth[ée]on/, () => setShowPantheon(true), () => setShowPantheon(false), "Panthéon ouvert. Supervision globale en ligne."],
      [/nexus/, () => setShowNexus(true), () => setShowNexus(false), "Nexus céleste ouvert. Connexions inter-modules affichées."],
      [/oracle/, () => setShowOracle(true), () => setShowOracle(false), "Oracle divin ouvert. Consultation des prédictions."],
      [/\bprime\b|apprentissage/, () => setShowPrime(true), () => setShowPrime(false), "Sirius Prime ouvert. Mémoire et apprentissage."],
      [/compagnon|mode dev\b/, () => setShowDev(true), () => setShowDev(false), "Compagnon dev ouvert. Collez votre code."],
      [/gestion.*m[ée]moire|m[ée]moire longue|gestionnaire.*m[ée]moire/, () => setShowMemoryMgr(true), () => setShowMemoryMgr(false), "Gestionnaire de mémoire ouvert. Vos souvenirs sont sous votre contrôle."],
      [/(lance|d[ée]marre|ouvre|relance).{0,14}installation|assistant d'installation|diagnostic d'installation|v[ée]rifie (ton |l')installation/, () => setShowInstall(true), () => setShowInstall(false), "Assistant d'installation lancé. Vérification de tous les systèmes."],
      [/argus|surveillance (du )?syst[èe]me|r[ée]paration automatique|analyse (le|les) (syst[èe]me|erreurs)/, () => setShowArgus(true), () => setShowArgus(false), "ARGUS activé. Analyse des systèmes en cours."],
      [/installe (ce |un |mon )?script|installateur de scripts?|analyse (ce |mon )?script/, () => setShowScripts(true), () => setShowScripts(false), "Installateur de scripts ouvert. Collez votre script pour analyse de sécurité."],
      [/keraunos|domotique|maison connect[ée]e/, () => setShowKeraunos(true), () => setShowKeraunos(false), "KERAUNOS ouvert. Contrôle domotique en ligne."],
      [/\batlas\b|module carte/, () => { setAtlasQuery(""); setAtlasRoute(null); setShowAtlas(true); }, () => setShowAtlas(false), "ATLAS ouvert. Carte et navigation en ligne."],
      [/h[ée]pha[iï]stos|auto.?maintenance|diagnostic (complet|syst[èe]me)|forge/, () => setShowHephaistos(true), () => setShowHephaistos(false), "HÉPHAÏSTOS activé. Forge de diagnostic en ligne."],
      [/syst[èe]me solaire|plan[èe]tes|zone espace|module espace/, () => setShowEspace(true), () => setShowEspace(false), "Zone ESPACE activée. Système solaire holographique en ligne."],
    ];
    if (/(ouvre|montre|affiche|lance|active)/.test(low)) {
      for (const [re, open, , msg] of moduleCmds) {
        if (re.test(low)) {
          mark("module");
          open();
          setText(msg); speakOut(msg);
          return;
        }
      }
    }
    if (/(ferme|quitte|masque)/.test(low)) {
      for (const [re, , close] of moduleCmds) {
        if (re.test(low)) {
          mark("module");
          close();
          const m = "Panneau fermé.";
          setText(m); speakOut(m);
          return;
        }
      }
    }
    // 0septies) Musique d'ambiance : « coupe la musique » / « remets la musique »
    if (/(coupe|arr[êe]te|stoppe?|[ée]teins|enl[èe]ve).{0,12}(musique|ambiance|fond sonore)/.test(low)) {
      mark("ambiance off");
      if (ambientRef.current) ambientRef.current.pause();
      setStatus("speaking");
      const m = "Musique d'ambiance coupée, monsieur.";
      setText(m); speakOut(m);
      return;
    }
    if (/(remets?|relance|reprends?|rallume|r[ée]active).{0,12}(musique|ambiance|fond sonore)/.test(low)) {
      mark("ambiance on");
      if (ambientRef.current) ambientRef.current.play().catch(() => {});
      setStatus("speaking");
      const m = "Musique d'ambiance relancée.";
      setText(m); speakOut(m);
      return;
    }
    // 0ambiance-ter) Choix de la piste d'ambiance : « mets le chant grégorien », « mets la musique épique »
    if (/(mets?|joue|passe|lance|active|remets?).{0,24}(chant\s+)?gr[ée]gorien/.test(low) ||
        /(mets?|joue|passe|lance|active|remets?).{0,20}(musique|ambiance)\s+[ée]pique/.test(low) ||
        /(mets?|joue|passe|lance|active|remets?).{0,20}(ambiance|musique d'ambiance).{0,12}(normale|habituelle|[ée]pique)/.test(low)) {
      mark("ambiance · piste");
      const choice = /gr[ée]gorien/.test(low) ? "gregorien" : "epique";
      localStorage.setItem("sirius_ambient_track", choice);
      if (ambientRef.current) { try { ambientRef.current.pause(); ambientRef.current.src = ""; } catch (e) {} }
      const na = new Audio(choice === "gregorien" ? "/audio/gregorien.mp3" : "/audio/ambiance.mp3");
      na.loop = true;
      const sv = parseFloat(localStorage.getItem("sirius_ambient_volume") || "0.12");
      na.volume = isNaN(sv) ? 0.12 : sv;
      na.play().catch(() => {});
      ambientRef.current = na;
      window.__siriusAmbient = na;
      setStatus("speaking");
      const m = choice === "gregorien" ? "Chant grégorien en ambiance, monsieur." : "Musique épique en ambiance, monsieur.";
      setText(m); setStatus("speaking"); speakOut(m);
      return;
    }
    // 0ambiance-quater) Volume de l'ambiance : « baisse la musique », « monte la musique », « musique à 50 % »
    const ambVolPct = low.match(/(?:musique|ambiance|fond sonore).{0,24}?(\d{1,3})\s*(?:%|pour ?cent)/) ||
                      low.match(/volume.{0,18}(?:musique|ambiance).{0,14}?(\d{1,3})/);
    if (ambVolPct ||
        /(baisse|diminue|r[ée]duis|monte|augmente).{0,18}(la |le |du |de la )?(musique|ambiance|fond sonore)/.test(low) ||
        /(musique|ambiance|fond sonore).{0,14}(plus fort|moins fort|[àa] fond)/.test(low)) {
      mark("ambiance · volume");
      const stored = parseFloat(localStorage.getItem("sirius_ambient_volume") || "0.12");
      const cur = ambientRef.current ? ambientRef.current.volume : (isNaN(stored) ? 0.12 : stored);
      let nv;
      if (ambVolPct) nv = Math.min(100, Math.max(0, parseInt(ambVolPct[1], 10))) / 100;
      else if (/[àa] fond/.test(low)) nv = 1;
      else if (/(baisse|diminue|r[ée]duis|moins fort)/.test(low)) nv = Math.max(0.02, cur - 0.08);
      else nv = Math.min(1, cur + 0.12);
      nv = Math.round(nv * 100) / 100;
      localStorage.setItem("sirius_ambient_volume", String(nv));
      if (ambientRef.current) ambientRef.current.volume = nv;
      setStatus("speaking");
      const m = `Volume de l'ambiance réglé à ${Math.round(nv * 100)} pour cent.`;
      setText(m); speakOut(m);
      return;
    }
    // 0keraunos) Domotique : « allume le salon », « éteins la lampe », « lumière à 50 % », « lance la scène soirée »
    const domoVerb = /\b(allume[sz]?|allumer|rallume[sz]?|[ée]teins|[ée]teindre|[ée]teignez)\b/.test(low) ||
      /(mets?|r[èe]gle|baisse|monte).{0,24}(luminosit[ée]|lumi[èe]re|lampe)/.test(low) ||
      /lance.{0,12}sc[èe]ne/.test(low) ||
      /(coupe|d[ée]sactive).{0,16}(lumi[èe]re|lampe|prise|ventilateur|chauffage|plafonnier|spot)/.test(low);
    if (domoVerb && !/(musique|ambiance|cam[ée]ra|vision|micro|[ée]cran|documentaire|mode )/.test(low)) {
      mark("domotique");
      setStatus("thinking");
      const pid = progress.start("Commande domotique", { silent: true });
      progress.log(pid, "Analyse de l'ordre et recherche de l'appareil…", 30);
      fetch(`${API}/ha/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: command }),
      }).then((r) => r.json()).then((d) => {
        const m = d.speech || "Commande domotique traitée.";
        if (d.ok) progress.done(pid, m);
        else progress.error(pid, m);
        setStatus("speaking"); setText(m); speakOut(m);
        if (d.ok === false && /pas encore connect/.test(m)) setShowKeraunos(true);
      }).catch(() => {
        progress.error(pid, "Module domotique injoignable");
        const m = "Le module domotique ne répond pas, monsieur.";
        setStatus("speaking"); setText(m); speakOut(m);
      });
      return;
    }
    // 0undecies-haccp) Analyse HACCP : « analyse HACCP du poulet rôti », « HACCP de la chaîne du froid »
    if (/\bhaccp\b|s[ée]curit[ée] alimentaire|conformit[ée] (?:hygi|sanitaire|alimentaire)/.test(low)) {
      if (/(?:ouvre|montre|affiche|lance|active)\s+(?:le\s+)?(?:module\s+)?haccp\s*$/.test(low)) {
        mark("haccp");
        setHaccp({ sujet: "", auto: false });
        const m = "Module HACCP ouvert — hygiène et sécurité alimentaire.";
        setStatus("speaking"); setText(m); speakOut(m);
        return;
      }
      const haccpM = low.match(/haccp\s+(?:du|de la|de l'|des|de|pour le|pour la|sur le|sur la|sur|le|la|les)?\s*(.+)/) ||
                     low.match(/(?:s[ée]curit[ée]|hygi[èe]ne)\s+alimentaire\s+(?:du|de la|de l'|des|de|pour|sur)?\s*(.+)/) ||
                     low.match(/(?:analyse|v[ée]rifie|contr[ôo]le)\s+(?:la\s+)?(?:conformit[ée]\s+)?(?:hygi[èe]ne\s+)?(?:de\s+)?(.+)/);
      const sujet = ((haccpM && haccpM[1]) || "").replace(/[?!.]+$/, "").replace(/\bhaccp\b/gi, "").trim();
      mark("haccp");
      if (sujet) {
        setHaccp({ sujet, auto: true });
        const m = `J'ouvre l'analyse HACCP pour ${sujet}.`;
        setStatus("speaking"); setText(m); speakOut(m);
      } else {
        setHaccp({ sujet: "", auto: false });
        const m = "Module HACCP ouvert — hygiène et sécurité alimentaire.";
        setStatus("speaking"); setText(m); speakOut(m);
      }
      return;
    }

    // 0undecies) Mini-documentaire : « documentaire sur X », « raconte-moi l'histoire de X »
    const docM = low.match(/(?:mini[- ]documentaire|documentaire)\s+(?:sur|de|du|des|de la|de l')\s+(.+)/) ||
                 low.match(/raconte[- ]moi l'histoire\s+(?:de la|de l'|du|des|de)\s+(.+)/);
    if (docM) {
      mark("documentaire");
      const sujet = (docM[1] || "").replace(/[?!.]+$/, "").trim();
      if (sujet) { launchDocumentary(sujet); return; }
    }
    // 0decies) Bulletin tech Hacker News : « bulletin tech », « hacker news », « tendances tech »
    if (/(bulletin tech|hacker news|tendances? tech)/.test(low)) {
      mark("bulletin tech");
      launchTechBulletin();
      return;
    }
    // 0octies-a) Panneau ACTUALITÉS plein écran : « ouvre les actualités », « module actualités », « flux d'actualités »
    if (/(module actualit[ée]s?|ouvre (?:les? |le )?(?:flux d'?)?actualit[ée]s?|flux d'?actualit[ée]s?|panneau (?:des? )?actualit[ée]s?)/.test(low)) {
      mark("actualités · panneau");
      setShowNews(true);
      const m = "Voici le flux d'actualités en direct, monsieur.";
      setStatus("speaking"); setText(m); speakOut(m);
      return;
    }
    // 0octies-b) Pipeline de vente HERMÈS AGORA# : « pipeline de vente », « mes deals », « suivi des deals »
    if (/(pipeline (?:de |commercial)?vente|pipeline commercial|mes deals|suivi des deals|mes prospects)/.test(low)) {
      mark("agora · pipeline");
      setShowAgora(true);
      const m = "Pipeline de vente ouvert. Hermès Agora surveille vos relances, monsieur.";
      setStatus("speaking"); setText(m);
      cancelSpeech(); speakAsCharacter(m, { module: "HERMÈS AGORA#" });
      return;
    }
    // 0octies-c) Consultation vocale HERMÈS AGORA# : « agora, … », « hermès agora … », « conseil de vente … »
    const agoraM = low.match(/^(?:herm[èe]s\s+)?agora[\s,:]+(.+)/) ||
                   low.match(/(?:conseil (?:de )?vente|conseil commercial|plan de vente|aide[- ]moi à vendre)\s*[:,]?\s*(.*)/);
    if (agoraM) {
      mark("agora · consultation");
      launchAgora((agoraM[1] || "").replace(/[?!.]+$/, "").trim());
      return;
    }
    // 0octies) Actualités en direct : « les actualités », « les news tech »...
    const newsM = low.match(/(?:actualit[ée]s?|les news|les infos|quoi de neuf)(?:\s+(?:sur|de la|de|du|des|en)\s+(.+))?/);
    if (newsM) {
      mark("actualités");
      launchNews((newsM[1] || "").replace(/[?!.]+$/, "").trim());
      return;
    }
    // 0nonies) Fiche pays : « capitale du Japon », « population du Brésil », « fiche pays Norvège »
    const capM = low.match(/capitale\s+(?:du|de la|de l'|des|de)\s+(.+)/);
    const popM = low.match(/population\s+(?:du|de la|de l'|des|de)\s+(.+)/);
    const ficheM = low.match(/(?:fiche pays|infos? pays|parle[- ]moi du pays)\s+(?:du|de la|de l'|des|de)?\s*(.+)/);
    if (capM || popM || ficheM) {
      mark("fiche pays");
      const cname = ((capM || popM || ficheM)[1] || "").replace(/[?!.]+$/, "").trim();
      if (cname) { launchCountry(cname, capM ? "capitale" : popM ? "population" : ""); return; }
    }
    // 0terdecies) Galerie des archives : « liste tes archives » + navigation vocale
    if (/liste[sz]?\s+(?:tes|mes|les)\s+archives|galerie\s+(?:des\s+|d')?archives/.test(low)) {
      mark("archives · galerie");
      setShowGallery(true);
      setGalleryNav(null);
      setStatus("speaking");
      const m = "Galerie des archives ouverte.";
      setText(m); speakOut(m);
      return;
    }
    if (showGallery) {
      if (/^\s*retour\b|reviens en arri[èe]re/.test(low)) {
        mark("archives · retour");
        setGalleryNav({ type: "back", seq: Date.now() });
        return;
      }
      const galM = low.match(/(?:ouvre|montre)(?:[- ]moi)?\s+(?:le\s+dossier\s+|la\s+section\s+|les\s+|mes\s+)([a-z0-9à-ÿ' -]{3,})/);
      if (galM && !/(site|page|panth|nexus|oracle|prime|cortex|m[ée]diath|fichier|document|analytique)/.test(galM[1])) {
        mark("archives · dossier");
        setGalleryNav({ type: "folder", q: galM[1].replace(/[?!.]+$/, "").trim(), seq: Date.now() });
        return;
      }
    }
    // 0septdecies) Outlook : connexion, emails, agenda, création de rendez-vous, envoi
    // 0gmail) Gmail : « ouvre gmail » (nouvel onglet), « lis mes mails gmail » (voix + fenêtre), « montre ma boîte gmail » (fenêtre)
    if (/gmail|bo[îi]te google|mails? google/.test(low)) {
      if (/\b(?:lis|lis-moi|lire|lecture)\b/.test(low)) {
        mark("gmail · lecture");
        readGmailAloud(false);
        return;
      }
      if (/(montre|affiche|liste)/.test(low)) {
        mark("gmail · boîte HUD");
        readGmailAloud(true);
        return;
      }
      if (/(ouvre|acc[èe]de|va sur|lance)/.test(low)) {
        mark("gmail · onglet");
        try { window.open("https://mail.google.com", "_blank"); } catch (e) { /* popup bloquée */ }
        const m = "J'ouvre ta boîte Gmail dans un nouvel onglet.";
        setStatus("speaking"); setText(m); speakOut(m);
        return;
      }
    }
    if (/connect(?:e|er|ion)?(?:[- ]moi)?\s*(?:à\s+)?outlook/.test(low)) {
      mark("outlook · connexion"); connectOutlook(); return;
    }
    if (/^(?:microsoft\s+)?outlook[\s?!.]*$/.test(low)) {
      mark("outlook · ouverture"); launchOutlookMail(); return;
    }
    const sendM = low.match(/envoie (?:un )?(?:e-?mail|mail|courriel|message) [àa]\s+(.+)/);
    if (sendM) {
      mark("outlook · envoi"); launchOutlookIntent(command); return;
    }
    if (/(?:supprime|efface|d[ée]truis)\w*\s+(?:le\s|ce\s|la\s)?(?:dernier\s)?(?:e-?mail|mail|courriel)/.test(low)) {
      mark("outlook · suppression"); launchOutlookIntent(command); return;
    }
    if (/(?:cherche|recherche|trouve)\w*\s+(?:les\s|des\s|mes\s)?(?:e-?mails?|mails?|courriels?)/.test(low)) {
      mark("outlook · recherche"); launchOutlookIntent(command); return;
    }
    if (/(?:lis|ouvre|affiche|montre)\w*(?:[- ]moi)?\s+(?:le\s|ce\s)?(?:dernier\s)?(?:e-?mail|mail|courriel)\s+(?:de|d')/.test(low)) {
      mark("outlook · lecture mail"); launchOutlookIntent(command); return;
    }
    if (/(?:liste|affiche|montre)\w*(?:[- ]moi)?\s+(?:mes\s|les\s)?dossiers(?:\s+(?:outlook|mails?|e-?mails?|de messagerie))/.test(low)) {
      mark("outlook · dossiers"); launchOutlookIntent(command); return;
    }
    const rdvM = low.match(/ajoute (?:un )?rendez-vous\s+(.+)/);
    if (rdvM) {
      mark("outlook · rendez-vous"); launchOutlookCreateEvent(rdvM[1].replace(/[?!.]+$/, "").trim()); return;
    }
    // Ouverture directe d'Outlook (jamais Google Calendar) : agenda Outlook d'abord, sinon boîte mail
    if (/(?:ouvre|lance|affiche|montre)[\wàâéèêëîïôùûç' -]*\b(?:agenda|calendrier)[\wàâéèêëîïôùûç' -]*\boutlook|outlook[\wàâéèêëîïôùûç' -]*\b(?:agenda|calendrier)/.test(low)) {
      mark("outlook · agenda"); launchOutlookAgenda(); return;
    }
    if (/(?:ouvre|lance|affiche|montre|acc[èe]de à)\s+(?:le\s+|la\s+|mon\s+|ma\s+)?(?:module\s+|messagerie\s+)?outlook/.test(low)) {
      mark("outlook · ouverture"); launchOutlookMail(); return;
    }
    // Lecture vocale des mails : « lis mes mails », « lis-moi mes derniers mails outlook »...
    if (/\b(?:lis|lis-moi|lire|lecture)\b[\wàâéèêëîïôùûç' -]*\b(?:e-?mails?|mails?|courriels?)/.test(low)) {
      mark("outlook · lecture vocale"); readMailAloud(); return;
    }
    if (/(?:mes|les)\s+(?:e-?mails?|mails?|courriels?)|emails? non lus?|bo[îi]te de r[ée]ception/.test(low)) {
      mark("outlook · emails"); launchOutlookMail(); return;
    }
    if (/(?:mes|mon)\s+(?:rendez-vous|agenda|calendrier)|prochains? rendez-vous/.test(low)) {
      mark("outlook · agenda"); launchOutlookAgenda(); return;
    }
    // 0quaterdecies) Plateformes externes : « ouvre YouTube », « ouvre TikTok sur les chiens »...
    const platM = low.match(/(?:ouvre|lance|acc[èe]de à)\s+(?:la\s+plateforme\s+|mes\s+messages\s+|les\s+messages\s+)?(youtube|you tube|tik ?tok|instagram|insta\b|facebook|whatsapp|whats app)(?:\s+(?:sur|pour|avec|à propos de)\s+(.+))?/);
    if (platM) {
      mark("plateforme");
      const key = platM[1].replace(/\s/g, "").replace(/^insta$/, "instagram");
      launchPlatform(key, (platM[2] || "").replace(/[?!.]+$/, "").trim());
      return;
    }
    // 0quindecies) Suppression d'archive : « supprime l'image du phénix »
    const delNoun = (low.match(/(vid[ée]o|clip|image|photo|illustration|archive|cr[ée]ation|lien)/) || [])[1];
    const delM = low.match(/(?:supprime|efface|retire)(?:[- ]moi)?\s+(?:la\s+|le\s+|l')?(?:vid[ée]o|clip|image|photo|illustration|archive|cr[ée]ation|lien)\s*(?:sur|de la|de l'|du|des|de|d')?\s*(.*)/);
    if (delM) {
      mark("archive · suppression");
      launchArchiveDelete((delM[1] || "").replace(/[?!.]+$/, "").trim(), delNoun || "");
      return;
    }
    // 0sexdecies) Renommage d'archive : « renomme l'image du phénix en X », « renomme-la en X »
    const renM = low.match(/renomme(?:[- ](?:la|le))?\s*(.*?)\s*\ben\s+(.+)$/);
    if (renM) {
      mark("archive · renommage");
      const target = (renM[1] || "")
        .replace(/^(?:l'|la\s+|le\s+)?(?:vid[ée]o|clip|image|photo|illustration|archive|cr[ée]ation|lien)?\s*(?:sur|de la|de l'|du|des|de|d')?\s*/, "")
        .trim();
      launchArchiveRename(target, renM[2].replace(/[?!.]+$/, "").trim());
      return;
    }
    // 0terdecies) Réouverture d'archive : « affiche la vidéo sur les chiens », « montre l'image du dragon »
    const archM = low.match(/(?:affiche|montre|r[ée]?ouvre|r[ée]affiche|retrouve|ressors)(?:[- ]moi)?\s+(?:la\s+|le\s+|l'|une?\s+|mon\s+|ma\s+)?(vid[ée]o|clip|animation|image|photo|illustration|dessin|logo|affiche|rendu|analyse|d[ée]monstration|archive|cr[ée]ation)\s*(?:sur|de la|de l'|du|des|de|d'|à propos de)?\s*(.*)/);
    if (archM) {
      mark("archive · recherche");
      launchArchiveSearch((archM[2] || "").replace(/[?!.]+$/, "").trim(), archM[1]);
      return;
    }
    // 0terdecies) Fenêtres de tâches SIRIUS : créations d'images et de clips vidéo
    const imgEditM = low.match(/(?:transforme|modifie|retouche|adapte|recr[ée]e|refais)(?:[- ]moi)?\s+(?:cette\s+|l['’])?(?:image|photo|illustration)\s*(?:pour|en|avec|afin de|comme)?\s*(.*)/);
    const vidTaskM = low.match(/(?:cr[ée]{1,2}|g[ée]n[èe]re|fais|r[ée]alise|produis|monte)(?:[- ]moi)?\s+(?:une?\s+|le\s+|la\s+)?(?:clip|vid[ée]o|animation|court[- ]m[ée]trage)\s*(?:de|d'|du|des|sur|avec|repr[ée]sentant|montrant)?\s*(.*)/);
    const imgTaskM = low.match(/(?:cr[ée]{1,2}|g[ée]n[èe]re|fais|dessine|imagine|produis)(?:[- ]moi)?\s+(?:une?\s+|l')?(?:image|photo|illustration|logo|affiche|dessin)\s*(?:de|d'|du|des|sur|avec|repr[ée]sentant|montrant)?\s*(.*)/);
    if (imgEditM) {
      mark("tâche · transformation image");
      launchImageTask((imgEditM[1] || "").replace(/[?!.]+$/, "").trim() || command, true);
      return;
    }
    if (vidTaskM) {
      mark("tâche · clip");
      launchVideoTask((vidTaskM[1] || "").replace(/[?!.]+$/, "").trim() || command);
      return;
    }
    if (imgTaskM) {
      mark("tâche · image");
      launchImageTask((imgTaskM[1] || "").replace(/[?!.]+$/, "").trim() || command);
      return;
    }
    // DISPLAY ASK : questions vocales (avec suivi de conversation) sur le fichier affiché dans le SIRIUS DISPLAY
    const dispCtx = window.__siriusDisplayFile;
    const dispChat = window.__siriusDisplayChat || [];
    const dispFollowUp = dispChat.length > 0 &&
      /^(et |mais |aussi |combien|comment|pourquoi|quel|quelle|quels|quelles|quand |o[ùu] |donne|pr[ée]cise|d[ée]taille|ensuite|encore|traduis|liste|cite|compare)/.test(low);
    if (dispCtx && (/(fichier|document|le pdf|photo|le display|[àa] l'?[ée]cran|que vois|tu vois|l[àa][- ]dessus|de quoi (parle|s'agit)|r[ée]sume|explique[- ]moi (ce|cette|le|la))/.test(low) || dispFollowUp)) {
      mark("display · question fichier");
      (async () => {
        setStatus("thinking");
        setText(`Sirius interroge ${dispCtx.name}…`);
        try {
          const r = await fetch(`${API}/display/ask`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question: command, context: dispCtx, keys, history: dispChat.slice(-8) }),
          });
          const d = await r.json().catch(() => ({}));
          const msg = r.ok && d.answer ? d.answer : (d.detail || "Je n'arrive pas à interroger le fichier affiché, monsieur.");
          if (r.ok && d.answer) {
            window.__siriusDisplayChat = [...dispChat, { role: "user", content: command }, { role: "assistant", content: msg }].slice(-12);
          }
          setStatus("speaking"); setText(msg); speakOut(msg);
        } catch {
          const msg = "Le module d'interrogation du fichier est injoignable.";
          setStatus("speaking"); setText(msg); speakOut(msg);
        }
      })();
      return;
    }
    // 0themis-bilan) THÉMIS# bilan financier vocal : « bilan financier », « rappels d'échéances »
    if (/(bilan (financier|comptable|de (l'|mon |ton )?entreprise)|rappels? d.?[ée]ch[ée]ances?|[ée]ch[ée]ances? (de paiement|à venir)|situation financi[èe]re)/.test(low)) {
      mark("themis · bilan");
      (async () => {
        try {
          const r = await fetch(`${API}/themis/bilan`);
          const d = await r.json();
          const msg = r.ok && d.speech ? d.speech : "Le bilan financier est indisponible pour le moment, monsieur.";
          setStatus("speaking"); setText(msg); speakOut(msg);
        } catch {
          const msg = "Le module comptable de Thémis est injoignable, monsieur.";
          setStatus("speaking"); setText(msg); speakOut(msg);
        }
      })();
      return;
    }
    // 0themis) THÉMIS# : gestion d'entreprise « ouvre thémis », « module entreprise », « mes factures », « mes devis »
    if (/(th[ée]mis|module entreprise|gestion (d')?entreprise|mes (factures|devis|commandes|stocks|clients)|ouvre (les |la )?(factur|devis|comptabilit))/.test(low)) {
      mark("themis · entreprise");
      setShowThemis(true);
      return;
    }
    // 0novodecies-bis) PROMO# : storyboard vidéo promo « storyboard », « vidéo promo », « promo »
    if (/(storyboard|vid[ée]o promo|module promo|ouvre (la |le )?promo)/.test(low)) {
      mark("promo · storyboard");
      setShowPromo(true);
      return;
    }
    // 0novodecies) TRAILER# : clichés cinématiques « clichés trailer », « bande annonce », « vidéo de présentation », « teaser »
    if (/(clich[ée]s?|trailer|bande[- ]?annonce|teaser|vid[ée]o de pr[ée]sentation|clips? cin[ée]ma)/.test(low)) {
      mark("trailer · clichés");
      setShowTrailer(true);
      return;
    }
    // 0octodecies-bis) PACKAGER# universel : « installe SIRIUS partout », « installateur universel »
    if (/(installe[- ]?(moi\s+)?sirius\s+partout|installateur universel|t[ée]l[ée]charge (l'|un )?installateur)/.test(low)) {
      mark("packager · installateur universel");
      setPackagerAutoInstall(true);
      setShowPackager(true);
      return;
    }
    // 0octodecies) PACKAGER# : « prépare le package », « génère l'installateur », « package multi-plateforme »
    if (/(pr[ée]pare (le )?package|g[ée]n[èe]re (l'|un )?installateur|package multi[- ]?plateforme|cr[ée]e (le )?livrable)/.test(low)) {
      mark("packager · livrable");
      setShowPackager(true);
      return;
    }
    // 0septdecies) Galerie MYTHOS : « galerie mythos », « montre les personnages », « affiche les modules », « le panthéon », « les dieux »
    if (/(galerie mythos|montre[- ]?(moi)? les personnages|(le\s+)?panth[ée]on des dieux|montre[- ]?(moi)? les dieux|galerie des personnages)/.test(low)
      || /(?:affiche|montre|ouvre|liste|pr[ée]sente)[a-z]*(?:[- ]moi)?\s+(?:les |mes |tes |tous les |la liste des )?modules(?:\s+(?:holographiques|du panth[ée]on|de sirius))?\s*[?!.]*\s*$/.test(low)) {
      mark("mythos · galerie");
      setShowMythosGallery(true);
      speakOut("Voici le Panthéon de mes modules, monsieur.");
      return;
    }
    // 0quindecies) HERACLES# : investigation OSINT « enquête sur X », « vérifie l'email X », « analyse le numéro X », « qui est X »
    const herM = low.match(/(?:enqu[êe]te|investigue|osint)\s+(?:sur\s+|à propos de\s+)?(.+)/) ||
      low.match(/(?:v[ée]rifie|analyse|contr[ôo]le)\s+(?:l['e]\s*)?(?:email|adresse|mail|pseudo|compte|num[ée]ro|t[ée]l[ée]phone|identit[ée])\s+(?:de\s+)?(.+)/) ||
      low.match(/qui\s+(?:est|se cache derri[èe]re)\s+(.+)/);
    if (herM) {
      mark("heracles · osint");
      setHeraclesInput((herM[1] || "").replace(/[?!.]+$/, "").trim());
      setShowHeracles(true);
      const hm = "Module HERACLES activé — investigation OSINT en cours sur données publiques.";
      setText(hm); speakOut(hm);
      return;
    }
    // 0atlas) ATLAS# : « montre-moi Paris sur la carte », « carte de Lyon », « montre-moi Paris », « ouvre la carte »
    if (/^(?:ouvre|affiche|montre)(?:[- ]moi)?\s+(?:la\s+)?carte\s*$/.test(low)) {
      mark("atlas · carte");
      setAtlasQuery(""); setAtlasRoute(null); setShowAtlas(true);
      const am = "ATLAS ouvert. Carte et navigation en ligne.";
      setText(am); speakOut(am);
      return;
    }
    const atlasM = low.match(/(?:montre|affiche|mets)(?:[- ]moi)?\s+(.+?)\s+sur\s+(?:la\s+|l')?(?:carte|map|atlas)/) ||
      low.match(/(?:carte|plan)\s+(?:de\s+la\s+|de\s+l'|de\s+|du\s+|des\s+|d')(.+)/) ||
      low.match(/^(?:montre|affiche)[- ]?(?:moi)?\s+(?!.*(?:photo|image|vid[ée]o|film|musique|chanson|fichier|document|m[ée]t[ée]o|heure|date|actualit|news|cortex|panth[ée]on|nexus|oracle|m[ée]moire|archive|module|carte|display|[ée]cran|journal|t[âa]che|script|cl[ée]|code|dossier|galerie|espace|plan[èe]te|syst[èe]me))(?:la ville de\s+|le\s+|la\s+|l')?([a-zà-ÿœ' -]{2,40})$/);
    if (atlasM) {
      const place = (atlasM[1] || "").replace(/[?!.]+$/, "").trim();
      if (place) {
        mark("atlas · carte");
        setAtlasQuery(place); setAtlasRoute(null); setShowAtlas(true);
        const am = `Module ATLAS activé — affichage de ${place} sur la carte.`;
        setText(am); speakOut(am);
        return;
      }
    }
    const atlasNavM = low.match(/(?:emm[èe]ne[- ]moi|conduis[- ]moi|guide[- ]moi)\s+(?:à|a|vers|jusqu'à|au|en)\s+(.+)/);
    if (atlasNavM) {
      mark("atlas · navigation");
      setAtlasRoute({ from: "", to: atlasNavM[1].replace(/[?!.]+$/, "").trim() });
      setAtlasQuery(""); setShowAtlas(true);
      const am = "Module ATLAS activé — calcul du trajet depuis votre position.";
      setText(am); speakOut(am);
      return;
    }
    // 0quaterdecies) ATLAS# itinéraire « itinéraire de X à Y », puis LOCUS# géolocalisation « localise X »
    const routeM = low.match(/(?:itin[ée]raire|trajet|route)\s+(?:de|depuis|entre)\s+(.+?)\s+(?:à|a|vers|jusqu'à|et)\s+(.+)/) ||
      low.match(/combien de temps (?:de|entre|depuis)\s+(.+?)\s+(?:à|a|vers|jusqu'à|et)\s+(.+)/);
    if (routeM) {
      mark("atlas · itinéraire");
      setAtlasRoute({ from: routeM[1].replace(/[?!.]+$/, "").trim(), to: routeM[2].replace(/[?!.]+$/, "").trim() });
      setAtlasQuery(""); setShowAtlas(true);
      const rm = "Module ATLAS activé — calcul de l'itinéraire en cours.";
      setText(rm); speakOut(rm);
      return;
    }
    const locusM = low.match(/(?:localise|g[ée]olocalise|g[ée]ocode)(?:[- ]moi)?\s+(.+)/) ||
      low.match(/o[ùu]\s+(?:se trouve|se situe|est situ[ée]?e?)\s+(?:la\s+|le\s+|l'|les\s+)?(.+)/) ||
      low.match(/(?:donne|trouve|cherche)(?:[- ]moi)?\s+les\s+coordonn[ée]es\s+(?:gps\s+)?(?:de la|de l'|du|des|de|d')?\s*(.+)/);
    if (locusM) {
      mark("locus · géocodage");
      setLocusQuery((locusM[1] || "").replace(/[?!.]+$/, "").trim());
      setShowLocus(true);
      const lm = "Module LOCUS activé — géocodage en cours.";
      setText(lm); speakOut(lm);
      return;
    }
    // 0spotify) « ouvre spotify » : lecteur intégré dans une fenêtre HUD (ne capte pas « lance X sur spotify »)
    if (/(?:ouvre|affiche|montre|lance|d[ée]marre)\s+(?:le\s+|mon\s+)?(?:lecteur\s+|module\s+)?spotify\s*[?!.]*$/.test(low)) {
      mark("spotify · lecteur");
      setShowSpotifyWin(true);
      const m = "Lecteur Spotify ouvert dans le HUD.";
      setText(m); speakOut(m);
      return;
    }
    if (/(?:ferme|quitte|masque)\s+(?:le\s+)?(?:lecteur\s+)?spotify\s*[?!.]*$/.test(low)) {
      mark("spotify · fermeture");
      setShowSpotifyWin(false);
      const m = "Lecteur Spotify fermé.";
      setText(m); speakOut(m);
      return;
    }

    // 0réveil) Réveil matinal : « réveille-moi à 7h30 », « active/désactive le réveil », « ouvre le réveil »
    if (/r[ée]veil/.test(low)) {
      const tm = low.match(/(\d{1,2})\s*(?:h(?:eures?)?|:)\s*(\d{1,2})?/);
      if (tm && /(r[èé]gle|mets?|programme|fixe|cale|r[ée]veille|active|place)/.test(low)) {
        mark("réveil · réglage");
        const h = Math.min(23, parseInt(tm[1], 10) || 0);
        const mn = Math.min(59, parseInt(tm[2] || "0", 10));
        const time = `${String(h).padStart(2, "0")}:${String(mn).padStart(2, "0")}`;
        localStorage.setItem("sirius_reveil", JSON.stringify({ on: true, time }));
        localStorage.removeItem("sirius_reveil_last");
        const m = `Réveil matinal réglé à ${h} heure${h > 1 ? "s" : ""}${mn ? ` ${mn}` : ""}. Je lancerai ton briefing, la météo et tes mails à cette heure.`;
        setStatus("speaking"); setText(m); speakOut(m);
        return;
      }
      if (/(d[ée]sactive|coupe|annule|enl[èe]ve|arr[êe]te|supprime)/.test(low)) {
        mark("réveil · off");
        let cur = {}; try { cur = JSON.parse(localStorage.getItem("sirius_reveil")) || {}; } catch (e) { /* config illisible */ }
        localStorage.setItem("sirius_reveil", JSON.stringify({ ...cur, on: false }));
        const m = "Réveil matinal désactivé.";
        setStatus("speaking"); setText(m); speakOut(m);
        return;
      }
      if (/(active|allume|remets|r[ée]arme)/.test(low)) {
        mark("réveil · on");
        let cur = { time: "07:30" }; try { cur = { time: "07:30", ...(JSON.parse(localStorage.getItem("sirius_reveil")) || {}) }; } catch (e) { /* config illisible */ }
        localStorage.setItem("sirius_reveil", JSON.stringify({ ...cur, on: true }));
        localStorage.removeItem("sirius_reveil_last");
        const m = `Réveil matinal activé à ${cur.time.replace(":", " heures ")}.`;
        setStatus("speaking"); setText(m); speakOut(m);
        return;
      }
      if (/(ouvre|montre|affiche|configure)/.test(low)) {
        mark("réveil · ouverture");
        setShowReveil(true);
        const m = "Voici la configuration du réveil matinal.";
        setText(m); speakOut(m);
        return;
      }
    }
    // 0briefing) Briefing à la demande : « refais-moi le briefing », « résumé du jour »
    if (/(refais|relance|redonne|repasse|refait)[- ]?(moi )?(le |mon )?(briefing|r[ée]sum[ée])|briefing du jour|(mon |le )?r[ée]sum[ée] du jour|donne[- ]moi (le |mon )?briefing/.test(low)) {
      mark("briefing · demande");
      const m = "Très bien monsieur, je vous prépare votre résumé du jour.";
      setStatus("thinking"); setText(m); speakOut(m);
      if (runBriefingRef.current) runBriefingRef.current(true);
      return;
    }
    // 0webagent) SIRIUS Web Agent : « cherche X sur le web/google », « recherche web X et montre-moi »
    const webAgentM = low.match(/(?:cherche|recherche|trouve)(?:[- ]moi)?\s+(.+?)\s+sur\s+(?:le\s+)?(?:web|internet|google|duckduckgo)\b/) ||
      low.match(/(?:recherche|cherche)\s+web\s+(.+)/) ||
      low.match(/(?:fais|lance)\s+une\s+recherche\s+(?:web\s+|internet\s+)?(?:sur|de|pour)\s+(.+)/);
    if (webAgentM) {
      mark("webagent · recherche");
      const q = (webAgentM[1] || "").replace(/\s*(?:et\s+)?montre[- ]?(?:le\s+)?moi.*$/, "").replace(/[?!.]+$/, "").trim();
      if (q) { launchWebAgent(q); return; }
    }
    // 0duodecies) SIRIUS WebBrowser : URL directe ou « ouvre le site / la page / navigue vers X »
    const urlM = command.match(/https?:\/\/\S+|www\.\S+|\b[a-z0-9-]{2,}\.(?:com|org|net|fr|io|dev|eu|info|gouv\.fr)(?:\/\S*)?/i);
    const navM = low.match(/(?:navigue vers|ouvre (?:le site|la page)|cherche et ouvre)\s+(.+)/);
    if (urlM || navM) {
      mark("webbrowser");
      launchWebBrowser(urlM ? urlM[0] : navM[1].replace(/[?!.]+$/, "").trim());
      return;
    }
    // 0) Choix musique en attente : « spotify » ou « youtube »
    if (musicChoice) {
      if (/(spotify|spoti)/.test(low)) { const q = musicChoice; setMusicChoice(null); launchMusic(q, "spotify"); return; }
      if (/(youtube|you tube|utube|tube)/.test(low)) { const q = musicChoice; setMusicChoice(null); launchMusic(q, "youtube"); return; }
    }
    // 0bis) Spotify : qu'est-ce qui joue ?
    if (/(qu['’ ]?est[- ]?ce qui (joue|passe)|c['’ ]?est quoi (cette|la) (chanson|musique|morceau)|quel (morceau|titre|chanson)|titre en cours|chanson en cours|qui chante|now playing)/.test(low)) {
      mark("musique · spotify");
      fetchNowPlaying();
      return;
    }
    // 0ter) Tableau analytique des performances
    if (/(tableau|panneau|rapport|affiche|montre|ouvre).{0,15}analytique|analytique|(tes|les) performances|diagnostic (du )?pipeline/.test(low)) {
      mark("analytique");
      setShowAnalytics(true);
      setStatus("speaking");
      const m = "Voici mon tableau analytique de performances.";
      setText(m); speakOut(m);
      return;
    }
    // 0sexies) Médiathèque (fichiers & médias)
    if (/(ouvre|montre|affiche).{0,12}(m[ée]diath[èe]que|mes fichiers|mes documents|mes m[ée]dias)|m[ée]diath[èe]que/.test(low)) {
      mark("médiathèque");
      setShowFiles(true);
      setStatus("speaking");
      const m = "Voici votre médiathèque.";
      setText(m); speakOut(m);
      return;
    }
    // 0quinquies) Architecte visuel : « dessine-moi l'architecture de... »
    const archMatch = low.match(/(?:dessine|g[éè]n[èe]re|cr[ée]e|fais|montre)[- ]?(?:moi|nous)?\s*(?:l['e]\s*|une?\s*|le\s*)?(?:architecture|diagramme|sch[ée]ma)\s*(?:de|d'|du|pour)?\s*(.*)/);
    if (archMatch || /(ouvre|lance).{0,10}(architecte|l'architecte)/.test(low)) {
      mark("architecte");
      const sujet = archMatch && archMatch[1] ? archMatch[1].trim() : "";
      setArchitectPrompt(sujet ? command : "");
      setShowArchitect(true);
      setStatus("speaking");
      const m = sujet ? "Très bien, je dessine cette architecture sous vos yeux." : "J'ouvre l'architecte visuel. Décrivez-moi ce que vous voulez construire.";
      setText(m); speakOut(m);
      return;
    }
    // 0quater) Mode brainstorming (activation / retour normal)
    if (/(mode normal|stop brainstorm|arr[êe]te le brainstorm|fin du brainstorm|quitte le brainstorm|termine le brainstorm)/.test(low)) {
      mark("mode normal");
      switchMode("normal");
      setStatus("speaking");
      const m = "Fin de la séance. Je repasse en mode assistant classique.";
      setText(m); speakOut(m);
      return;
    }
    if (/(mode|active|lance|passe en).{0,14}brainstorm|brainstorming/.test(low)) {
      mark("brainstorming");
      switchMode("brainstorm");
      setStatus("speaking");
      const m = "Mode brainstorming activé. Balancez votre idée, je vais la challenger comme un associé.";
      setText(m); speakOut(m);
      return;
    }
    // 1) Ouvrir les réglages / changer le profil
    if (/((change|changer|modifie|modifier|ouvre|ouvrir|affiche|afficher|r[ée]gle).*(profil|r[ée]glage|param[èe]tre|cl[ée]s?))|((mon|mes) (profil|r[ée]glages?|param[èe]tres?|cl[ée]s?))/.test(low)) {
      mark("réglages");
      setShowSetup(true);
      setStatus("idle");
      setText("J'ouvre tes réglages. Tu peux modifier ton profil et tes clés.");
      speakOut("J'ouvre vos réglages.");
      return;
    }
    // 2) Mémoire : effacer
    if (/(oublie tout|oublie moi|efface ta m[ée]moire|vide ta m[ée]moire|efface ce que tu sais|oublie ce que tu sais|efface tout ce que tu sais)/.test(low)) {
      mark("mémoire · effacement");
      saveMemory([]);
      // Réinitialise aussi l'historique côté serveur + nouvelle session
      fetch(`${API}/chat/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId.current }),
      }).catch(() => {});
      sessionId.current = "sirius-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      setStatus("speaking");
      const m = "C'est fait, j'ai tout effacé. Je ne sais plus rien sur vous.";
      setText(m); speakOut(m);
      return;
    }
 // 3) Mémoire : rappeler
    if (/(qu['’ ]?est[- ]?ce que tu sais (sur|de) moi|que sais[- ]?tu (sur|de) moi|qu['’ ]?est[- ]?ce que tu retiens|que retiens[- ]?tu|ta m[ée]moire|tu sais quoi sur moi)/.test(low)) {
      mark("mémoire · rappel");
      setStatus("speaking");
      const m = memoryRef.current.length
        ? `Voici ce que je sais sur vous : ${memoryRef.current.map((f) => f.t).join(". ")}.`
        : "Je ne retiens encore rien sur vous. Dites « souviens-toi que… » pour m'apprendre quelque chose.";
      setText(m); speakOut(m);
      return;
    }
    // 4) Mémoire : enregistrer
    const memMatch = command.match(/(?:souviens[- ]?toi(?:\s+que)?|retiens(?:\s+que)?|note que|rappelle[- ]?toi(?:\s+que)?)\s+(.+)/i);
    if (memMatch && memMatch[1]) {
      mark("mémoire · enregistrement");
      const fait = memMatch[1].trim().replace(/[.!?]+$/, "");
      const next = [...memoryRef.current.filter((f) => f.t.toLowerCase() !== fait.toLowerCase()), { t: fait, d: todayStr() }].slice(-30);
      saveMemory(next);
      addPopup({ kind: "memory", titre: "MÉMOIRE ENREGISTRÉE", contenu: fait });
      setStatus("speaking");
      const m = `C'est noté : ${fait}.`;
      setText(m); speakOut(m);
      return;
    }
    // Ouverture / restauration vocale d'un module : « ouvre la bourse », « affiche thémis »
    const openM = low.match(/^(?:sirius[, ]*)?(?:ouvre|ouvrir|affiche|afficher|restaure|restaurer|rouvre)\s+(?:le |la |les |l'|mon |ma |une? )?(?:module |fen[êe]tre |panneau )?(.+)$/);
    if (openM && openModuleByName(openM[1])) {
      mark("ouverture module");
      return;
    }
    // Rangement des fenêtres : « range tout », « réduis tout », « minimise les fenêtres »
    if (/(range|ranger|r[ée]duis|r[ée]duire|minimise|ramasse)\b.*\b(tout|toutes? les fen[êe]tres|les fen[êe]tres)/.test(low)) {
      mark("rangement");
      const n = minimizeAll();
      const msg = n === 0 ? "Rien à ranger, aucune fenêtre ouverte." : n === 1 ? "C'est rangé, une fenêtre réduite en pastille." : `C'est rangé, ${n} fenêtres réduites en pastilles.`;
      setText(msg);
      speakOut(msg);
      return;
    }
  };

  const sendCommand = useCallback((e) => {
    if (e) e.preventDefault();
    const text = cmd.trim();
    if (!text) return;
    processCommand(text);
    setCmd("");
  }, [cmd, processCommand]);

  // Enregistrement du profil + clés (1er lancement ou modification)
  const handleSetupComplete = useCallback((newProfile, newKeys) => {
    setProfile(newProfile);
    setKeys(newKeys);
    localStorage.setItem("sirius_profile", JSON.stringify(newProfile));
    localStorage.setItem("sirius_keys", JSON.stringify(newKeys));
    setShowSetup(false);
    setText(`${greetByPhase(newProfile.name)} Tous mes systèmes sont en ligne.`);
  }, []);
  
  // ---- Reconnaissance vocale navigateur (Web Speech API) ----
  const handleTranscript = useCallback((transcript, isFinal) => {
    if (speakingRef.current) return; // Sirius parle → on ignore (évite l'écho)
    setVoiceTranscript(transcript.trim());
    const t = transcript.toLowerCase().trim();
    if (!isFinal) {
      setStatus("listening");
      setText(transcript);
      return;
    }
    // Réponse vocale « oui / non » à une proposition de lecture à voix haute
    if (window.__siriusReadAloudAnswer && window.__siriusReadAloudAnswer(t)) {
      setStatus("idle");
      return;
    }
    // Le micro est déjà activé manuellement → on répond à TOUT ce qui est dit.
    // On retire juste le mot d'activation s'il est reconnu (souvent mal transcrit).
    const wake = /\b(sirius|syrius|cirius|sirus|cyrus|serious|s[ée]rieux|cilius|syriusse|sirio)\b/gi;
    const command = t.replace(wake, " ").replace(/\s+/g, " ").trim().replace(/^[,.\s]+/, "");
    if (!command) {
      setStatus("listening");
      setText("Oui, je t'écoute...");
      speakOut("Oui, je t'écoute.");
      return;
    }
    processCommand(command);
  }, [processCommand, speakOut]);

  // Référence stable vers handleTranscript pour la reconnaissance vocale
  const handleTranscriptRef = useRef(null);
  handleTranscriptRef.current = handleTranscript;

  const startServerListening = useCallback(async () => {
    if (serverRecorderRef.current || micOnRef.current || speakingRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setText("L'enregistrement vocal n'est pas disponible sur cet appareil.");
      setStatus("idle");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (speakingRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const preferredType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
        .find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, preferredType ? { mimeType: preferredType } : undefined);
      const chunks = [];
      discardServerRecordingRef.current = false;
      serverRecorderRef.current = recorder;
      serverRecorderStreamRef.current = stream;
      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunks.push(event.data);
      };
      recorder.onstop = async () => {
        clearTimeout(serverRecorderTimerRef.current);
        serverRecorderTimerRef.current = null;
        serverRecorderRef.current = null;
        serverRecorderStreamRef.current = null;
        stream.getTracks().forEach((track) => track.stop());
        micOnRef.current = false;
        window.__siriusMicOn = false;
        setMicOn(false);
        if (discardServerRecordingRef.current) {
          setStatus((current) => (current === "listening" ? "idle" : current));
          return;
        }
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        if (blob.size < 800) {
          setText("Je n'ai pas reçu assez de son. Rapprochez-vous du microphone et réessayez.");
          setStatus("idle");
          return;
        }
        setStatus("thinking");
        setText("Transcription vocale SIRIUS en cours...");
        try {
          const form = new FormData();
          const extension = blob.type.includes("mp4") ? "m4a" : "webm";
          form.append("file", blob, `sirius-voice.${extension}`);
          const response = await fetch(`${API}/stt`, { method: "POST", body: form });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload.detail || "Transcription vocale impossible.");
          const transcript = (payload.text || payload.transcript || "").trim();
          if (!transcript) {
            setText("Je n'ai pas distingué de parole. Réessayez plus près du microphone.");
            setStatus("idle");
            return;
          }
          handleTranscriptRef.current(transcript, true);
        } catch (error) {
          console.error("Erreur transcription SIRIUS :", error);
          setText(error.message || "La transcription vocale SIRIUS est indisponible.");
          setStatus("idle");
        }
      };
      recorder.onerror = () => {
        discardServerRecordingRef.current = true;
        setText("L'enregistrement du microphone a été interrompu.");
        setStatus("idle");
      };
      recorder.start(250);
      setVoiceTranscript("");
      micOnRef.current = true;
      window.__siriusMicOn = true;
      setMicOn(true);
      setStatus("listening");
      setText("Je t'écoute — transcription SIRIUS...");
      serverRecorderTimerRef.current = setTimeout(() => {
        if (serverRecorderRef.current?.state === "recording") serverRecorderRef.current.stop();
      }, 15000);
    } catch (error) {
      console.error("Impossible d'ouvrir le microphone :", error);
      setText(error?.name === "NotAllowedError"
        ? "Accès au micro refusé. Autorisez le microphone dans les paramètres de SIRIUS."
        : "Impossible d'ouvrir le microphone sur cet appareil.");
      setStatus("idle");
    }
  }, []);

  // Arrête l'écoute en cours
  const stopListening = useCallback(() => {
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    const serverRecorder = serverRecorderRef.current;
    if (serverRecorder) {
      discardServerRecordingRef.current = true;
      if (serverRecorder.state !== "inactive") serverRecorder.stop();
    }
    clearTimeout(serverRecorderTimerRef.current);
    serverRecorderTimerRef.current = null;
    if (!serverRecorder && serverRecorderStreamRef.current) {
      serverRecorderStreamRef.current.getTracks().forEach((track) => track.stop());
      serverRecorderStreamRef.current = null;
    }
    micOnRef.current = false;
    window.__siriusMicOn = false;
    setMicOn(false);
    if (rec) {
      rec.onend = null;
      rec.onerror = null;
      try { rec.stop(); } catch (e) {}
    }
    setStatus((current) => (current === "listening" ? "idle" : current));
  }, []);

  const shutdownSirius = useCallback(async () => {
    if (isShuttingDown || !isLocalDevServer) return;

    setIsShuttingDown(true);
    cancelSpeech();
    stopListening();
    if (ambientRef.current) ambientRef.current.pause();
    setStatus("idle");
    setText("Extinction sécurisée de SIRIUS en cours...");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch("/__sirius/shutdown", {
        method: "POST",
        headers: { "X-Sirius-Shutdown": "1" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Le contrôleur d'arrêt a répondu ${response.status}.`);
      }
      setText("SIRIUS s'éteint. Vous pourrez le relancer depuis l'icône du Bureau.");
    } catch (error) {
      console.error("Impossible d'éteindre SIRIUS.", error);
      setIsShuttingDown(false);
      setText("L'extinction automatique a échoué. Fermez les consoles SIRIUS Backend et SIRIUS Frontend.");
    } finally {
      clearTimeout(timeoutId);
    }
  }, [isLocalDevServer, isShuttingDown, stopListening]);

  // Démarre l'écoute via la reconnaissance vocale du navigateur (instantanée, gratuite)
  const startListening = useCallback(() => {
    if (micOnRef.current || speakingRef.current) return;
    if (preferServerSttRef.current) {
      startServerListening();
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      preferServerSttRef.current = true;
      startServerListening();
      return;
    }
    try {
      const rec = new SR();
      rec.lang = "fr-FR";
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;
      let gotFinal = false;
      let hadError = false;
      let useServerFallback = false;
      rec.onresult = (e) => {
        let interim = "";
        let final = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) final += t;
          else interim += t;
        }
        if (!sttT0Ref.current) sttT0Ref.current = performance.now();
        if (final.trim()) {
          gotFinal = true;
          const confRaw = e.results[e.results.length - 1][0].confidence;
          const ms = Math.round(performance.now() - sttT0Ref.current);
          setMetrics((m) => ({ ...m, stt: { ms, conf: confRaw ? Math.round(confRaw * 100) : m.stt.conf, count: m.stt.count + 1 } }));
          handleTranscriptRef.current(final.trim(), true);
        }
        else if (interim.trim()) handleTranscriptRef.current(interim, false);
      };
      rec.onerror = (e) => {
        hadError = e.error !== "no-speech";
        micOnRef.current = false;
        window.__siriusMicOn = false;
        setMicOn(false);
        if (e.error === "not-allowed") {
          setText("Accès au micro refusé. Autorisez le microphone pour parler à Sirius.");
          setStatus("idle");
        } else if (e.error === "network" || e.error === "service-not-allowed") {
          preferServerSttRef.current = true;
          useServerFallback = true;
          setText("Le service vocal du navigateur est indisponible. Le mode transcription SIRIUS prend le relais.");
          setStatus("idle");
        } else if (e.error === "audio-capture") {
          setText("Aucun microphone utilisable n'a été détecté.");
          setStatus("idle");
        } else if (e.error === "no-speech") {
          setText("Je n'ai rien entendu. Parlez plus près du microphone.");
        } else {
          setText(`Reconnaissance vocale interrompue (${e.error || "erreur inconnue"}).`);
          setStatus("idle");
        }
      };
      rec.onend = () => {
        if (recognitionRef.current && recognitionRef.current !== rec) return;
        if (recognitionRef.current === rec) recognitionRef.current = null;
        micOnRef.current = false;
        window.__siriusMicOn = false;
        setMicOn(false);
        if (useServerFallback && !speakingRef.current) {
          setTimeout(() => startServerListening(), 150);
          return;
        }
        if (!gotFinal && !speakingRef.current) {
          setStatus((s) => (s === "listening" ? "idle" : s));
          // Mode conversation : si rien n'a été dit, on relance l'écoute
          if (autoMicRef.current && !hadError) {
            if (autoListenTimerRef.current) clearTimeout(autoListenTimerRef.current);
            autoListenTimerRef.current = setTimeout(() => {
              if (autoMicRef.current && !speakingRef.current && !micOnRef.current && startListenRef.current) {
                startListenRef.current();
              }
            }, 500);
          }
        }
      };
      recognitionRef.current = rec;
      sttT0Ref.current = null;
      rec.start();
      setVoiceTranscript("");
      micOnRef.current = true;
      window.__siriusMicOn = true;
      setMicOn(true);
      setStatus("listening");
      setText("Je t'écoute...");
    } catch (e) {
      setText("Impossible de démarrer le micro sur cet appareil.");
      setStatus("idle");
    }
  }, [startServerListening]);

  // Référence pour relancer l'écoute depuis onSpeechEnd (mode conversation)
  startListenRef.current = startListening;

  const finishVoiceCapture = useCallback(() => {
    try {
      if (serverRecorderRef.current?.state === "recording") serverRecorderRef.current.stop();
      else if (recognitionRef.current) recognitionRef.current.stop();
    } catch (error) {
      console.error("Impossible de terminer la capture vocale :", error);
    }
  }, []);

  // ---- Talkie-walkie (push-to-talk) : maintenir = micro actif, relâcher = envoi ----
  const pttDown = useCallback(() => {
    if (pttRef.current) return;
    pttRef.current = true;
    setPttActive(true);
    // Priorité au canal : on coupe la voix de Sirius immédiatement
    cancelSpeech();
    speakingRef.current = false;
    stopInterruptListener();
    pttBeep(false);
    if (micOnRef.current) {
      try { recognitionRef.current && recognitionRef.current.stop(); } catch (e) {}
      micOnRef.current = false;
      setMicOn(false);
    }
    setTimeout(() => { if (pttRef.current) startListening(); }, 130);
  }, [startListening, stopInterruptListener]);

  const pttUp = useCallback(() => {
    if (!pttRef.current) return;
    pttRef.current = false;
    setPttActive(false);
    pttBeep(true);
    // stop() finalise la reconnaissance → le transcript final part vers l'assistant IA
    try {
      if (serverRecorderRef.current?.state === "recording") serverRecorderRef.current.stop();
      else if (recognitionRef.current) recognitionRef.current.stop();
    } catch (e) {}
  }, []);

  useEffect(() => {
    if (booting || showSetup) return;
    const isTyping = (e) => {
      const el = e.target;
      return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
    };
    const down = (e) => {
      if (e.code !== "Space" || e.repeat || isTyping(e)) return;
      e.preventDefault();
      pttDown();
    };
    const up = (e) => {
      if (e.code !== "Space" || !pttRef.current) return;
      e.preventDefault();
      pttUp();
    };
    const cancel = () => { if (pttRef.current) pttUp(); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", cancel);
    };
  }, [booting, showSetup, pttDown, pttUp]);

  // Démarrage automatique du micro une fois le boot terminé (mode mains-libres)
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (booting || showSetup) return;
    if (!autoMic) return;
    if (autoStartedRef.current) return;
    autoStartedRef.current = true;
    const id = setTimeout(() => {
      if (autoMicRef.current && !speakingRef.current && !micOnRef.current && startListenRef.current) {
        startListenRef.current();
      }
    }, 1200);
    return () => clearTimeout(id);
  }, [booting, showSetup, autoMic]);

  // Si on coupe le mode auto, on arrête les relances programmées
  useEffect(() => {
    if (!autoMic && autoListenTimerRef.current) {
      clearTimeout(autoListenTimerRef.current);
      autoListenTimerRef.current = null;
    }
  }, [autoMic]);

  // Musique d'ambiance libre de droits : volume 12 %, en boucle, démarrage au chargement de la scène
  useEffect(() => {
    if (booting || showSetup) return;
    const track = localStorage.getItem("sirius_ambient_track") || "epique";
    if (track === "none") return;
    const audio = new Audio(track === "gregorien" ? "/audio/gregorien.mp3" : "/audio/ambiance.mp3");
    audio.loop = true;
    const storedVol = parseFloat(localStorage.getItem("sirius_ambient_volume") || "0.12");
    audio.volume = isNaN(storedVol) ? 0.12 : storedVol;
    audio.preload = "auto";
    ambientRef.current = audio;
    window.__siriusAmbient = audio;
    const unlockers = [];
    const clearUnlockers = () => { unlockers.forEach(([e, f]) => window.removeEventListener(e, f)); unlockers.length = 0; };
    const tryPlay = () => audio.play().then(clearUnlockers).catch(() => {});
    tryPlay();
    // Autoplay bloqué par le navigateur → démarre au premier geste utilisateur
    ["click", "keydown", "touchstart"].forEach((e) => {
      const f = () => tryPlay();
      unlockers.push([e, f]);
      window.addEventListener(e, f);
    });
    return () => {
      clearUnlockers();
      audio.pause();
      audio.src = "";
      ambientRef.current = null;
    };
  }, [booting, showSetup]);

  // Panneaux flottants (HEURE, CPU/RAM, NOYAU, MÉTÉO) déplaçables à la souris, position mémorisée
  useEffect(() => {
    if (booting || showSetup) return;
    const ids = ["sirius-stats", "sirius-cpu-ram", "sirius-clock", "sirius-meteo"];
    const readSaved = () => { try { return JSON.parse(localStorage.getItem("sirius_panel_pos")) || {}; } catch (e) { return {}; } };
    const saved = readSaved();
    const cleanups = [];
    ids.forEach((key) => {
      const el = document.querySelector(`[data-testid="${key}"]`);
      if (!el) return;
      const pos = saved[key];
      if (pos) {
        el.style.left = Math.min(Math.max(0, pos.x), window.innerWidth - 90) + "px";
        el.style.top = Math.min(Math.max(0, pos.y), window.innerHeight - 60) + "px";
        el.style.right = "auto";
        el.style.bottom = "auto";
      }
      el.classList.add("draggable-panel");
      let drag = null;
      const onDown = (e) => {
        if (e.button !== 0 || e.target.closest("button, input, a, select")) return;
        const r = el.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        el.classList.add("dragging");
        e.preventDefault();
      };
      const onMove = (e) => {
        if (!drag) return;
        const x = Math.min(Math.max(0, e.clientX - drag.dx), window.innerWidth - el.offsetWidth);
        const y = Math.min(Math.max(0, e.clientY - drag.dy), window.innerHeight - el.offsetHeight);
        el.style.left = x + "px";
        el.style.top = y + "px";
        el.style.right = "auto";
        el.style.bottom = "auto";
      };
      const onUp = () => {
        if (!drag) return;
        drag = null;
        el.classList.remove("dragging");
        try {
          const all = readSaved();
          all[key] = { x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0 };
          localStorage.setItem("sirius_panel_pos", JSON.stringify(all));
        } catch (e) {}
      };
      el.addEventListener("pointerdown", onDown);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      cleanups.push(() => {
        el.removeEventListener("pointerdown", onDown);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        el.classList.remove("draggable-panel", "dragging");
      });
    });
    return () => cleanups.forEach((f) => f());
  }, [booting, showSetup]);

  // Raccourcis clavier globaux : Ctrl+K modules, Ctrl+P pipeline, Ctrl+M Mythos, Ctrl+J actualités, / focus commande
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === "k") { e.preventDefault(); setShowModulesMenu((o) => !o); }
        else if (k === "p") { e.preventDefault(); setShowAgora(true); }
        else if (k === "m") { e.preventDefault(); setShowMythosGallery(true); }
        else if (k === "j") { e.preventDefault(); setShowNews(true); }
        return;
      }
      if (e.key === "/" && !/^(input|textarea|select)$/i.test(e.target.tagName)) {
        const inp = document.querySelector("input[placeholder*='commande']");
        if (inp) { e.preventDefault(); inp.focus(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Préférences HUD (transparence, taille, minimal) appliquées au démarrage + sons d'interface
  useEffect(() => { applyHud(loadHud()); initUiSounds(); initHoloFx(); initReadAloud(); initHoloWindows(); }, []);

  // Thème par heure : le sanctuaire évolue avec la journée (aube dorée, jour, crépuscule, nuit profonde)
  useEffect(() => {
    const applyPhase = () => { document.body.dataset.phase = phaseOfDay(); };
    applyPhase();
    const iv = setInterval(applyPhase, 60000);
    return () => clearInterval(iv);
  }, []);

  // Retour de paiement Stripe : confirmation vocale après un encaissement Hermès Agora
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const pay = params.get("payment");
    if (!pay) return;
    const sid = params.get("session_id");
    window.history.replaceState({}, "", window.location.pathname);
    if (pay === "cancel") { setText("Paiement annulé — le lien reste utilisable si ton client souhaite réessayer."); return; }
    if (!sid) return;
    let tries = 0;
    const poll = async () => {
      tries += 1;
      try {
        const r = await fetch(`${API}/payments/status/${sid}`, { credentials: "include" });
        const d = await r.json();
        if (d.payment_status === "paid") {
          speakRef.current(`Paiement de ${(d.amount / 100).toLocaleString("fr-FR")} euros confirmé. Hermès salue ton encaissement.`);
          return;
        }
        if (["failed", "expired"].includes(d.payment_status)) { setText("Le paiement n'a pas abouti — vous pouvez générer un nouveau lien."); return; }
      } catch (e) { /* attente */ }
      if (tries < 8) setTimeout(poll, 2500);
      else setText("Paiement en cours de confirmation — consultez le pipeline Hermès dans un instant.");
    };
    poll();
  }, []);

  // Gardien animé : léger regard/inclinaison vers le curseur (le balancement de cape est en CSS)
  useEffect(() => {
    let raf = 0;
    const onMove = (e) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const rig = document.querySelector(".guardian-rig");
        if (!rig) return;
        const r = rig.getBoundingClientRect();
        const dx = (e.clientX - (r.left + r.width / 2)) / window.innerWidth;
        const dy = (e.clientY - (r.top + r.height * 0.18)) / window.innerHeight;
        rig.style.setProperty("--gy", `${Math.max(-7, Math.min(7, dx * 15))}deg`);
        rig.style.setProperty("--gx", `${Math.max(-3, Math.min(3, -dy * 6))}deg`);
      });
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => { window.removeEventListener("mousemove", onMove); if (raf) cancelAnimationFrame(raf); };
  }, []);

 // Relances automatiques HERMÈS AGORA# : annonce vocale des relances de prospects en retard au démarrage
  const relancesDoneRef = useRef(false);
  useEffect(() => {
    if (booting || showSetup || relancesDoneRef.current) return;
    relancesDoneRef.current = true;
    let retried = false;
    const announce = async () => {
      try {
        const r = await fetch(`${API}/agora/deals`, { credentials: "include" });
        // ⚡ Sécurité : Si 401/404/500, on stoppe immédiatement avant de parser
        if (!r.ok) return;

        const d = await r.json().catch(() => ({}));
        if (!d || !d.deals) return;

        const jour = todayStr();
        const late = d.deals.filter((x) => x.relance && x.relance <= jour && !["GAGNÉ", "PERDU"].includes(x.etape));
        if (!late.length) return;

        // Une autre voix parle (briefing…) → on repasse une seule fois, 20 s plus tard
        if (statusPulseRef.current.status === "speaking" && !retried) {
          retried = true;
          setTimeout(announce, 20000);
          return;
        }

        const detail = late.slice(0, 4).map((x) => `${x.nom}${x.entreprise ? ` de ${x.entreprise}` : ""}`).join(", ");
        const msg = late.length === 1
          ? `Hermès Agora, monsieur. Une relance de prospect est en retard : ${detail}. Le pipeline attend votre closing.`
          : `Hermès Agora, monsieur. ${late.length} relances de prospects sont en retard : ${detail}. Le pipeline attend votre closing.`;

        addPopup({ kind: "info", titre: "HERMÈS AGORA# — RELANCES EN RETARD", contenu: late.map((x) => `• ${x.nom}${x.entreprise ? ` (${x.entreprise})` : ""} — ${x.etape} — relance prévue le ${new Date(x.relance + "T00:00:00").toLocaleDateString("fr-FR")}`).join("\n") });
        setText(msg);
        speakAsCharacter(msg, { module: "HERMÈS AGORA#" });
      } catch (e) { /* pipeline injoignable au démarrage — silencieux */ }
    };

    const t = setTimeout(announce, 24000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booting, showSetup]);

  // Briefing matinal parlé et affiché dans SIRIUS Display.
  const briefingDoneRef = useRef(false);
  const runBriefingDisplay = useCallback(async (force = false) => {
    const pid = progress.start("Briefing du jour", { silent: true });
    progress.log(pid, "Collecte des actualités et de la veille…", 25);
    try {
      const r = await fetch(`${API}/oracle/overview`, { credentials: "include" });
      const d = await r.json();
      if (d.briefing) {
        progress.log(pid, "Briefing synthétisé, lecture vocale…", 80);
        localStorage.setItem("sirius_last_briefing", todayStr());
          const salut = greetByPhase(userName);
          // Météo Atlas détaillée de la ville du profil
          let meteoAtlas = "";
          const ville = (profile?.city || "").trim();
          if (ville) {
            try {
              const rw = await fetch(`${API}/weather/current?city=${encodeURIComponent(ville)}`, { credentials: "include" });
              const w = await rw.json();
              if (rw.ok && w.ville) {
                meteoAtlas = ` Atlas annonce à ${w.ville} : ${w.description ? w.description.toLowerCase() + ", " : ""}${w.temp} degrés, ressenti ${w.ressenti}, vent ${w.vent} kilomètres heure, humidité ${w.humidite} pour cent.`;
              }
            } catch (e) { /* météo indisponible — briefing sans Atlas */ }
          }
          // Objectif mensuel HERMÈS AGORA# dans le briefing
          let objAgora = "";
          try {
            const ro = await fetch(`${API}/agora/objectif`, { credentials: "include" });
            const o = await ro.json();
            if (ro.ok && o.montant > 0) {
              objAgora = ` Hermès Agora signale : objectif mensuel atteint à ${Math.round(o.progression_pct)} pour cent, ${Math.round(o.gagne_mois)} euros gagnés sur ${Math.round(o.montant)}.`;
            }
          } catch (e) { /* objectif indisponible — briefing sans Agora */ }
          // Résumé Quotidien : agenda du jour, rappels d'échéances et tendances des marchés
          let agendaTxt = "", rappelsTxt = "", bourseTxt = "";
          await Promise.all([
            (async () => {
              try {
                const ra = await fetch(`${API}/calendar/events?max_results=8`, { credentials: "include" });
                if (!ra.ok) return;
                const a = await ra.json();
                const todayIso = todayStr();
                const evts = (a.events || []).filter((e) => (e.start || "").slice(0, 10) === todayIso);
                if (evts.length) {
                  const fmt = (e) => {
                    if (e.allDay) return e.title;
                    const dt = new Date(e.start);
                    const h = dt.getHours(), mn = dt.getMinutes();
                    return `${e.title} à ${h} heure${h > 1 ? "s" : ""}${mn ? ` ${mn}` : ""}`;
                  };
                  agendaTxt = ` À votre agenda aujourd'hui : ${evts.slice(0, 4).map(fmt).join(", puis ")}.`;
                } else {
                  agendaTxt = " Aucun rendez-vous à votre agenda aujourd'hui.";
                }
              } catch (e) { /* agenda non connecté — briefing sans agenda */ }
            })(),
            (async () => {
              try {
                const rt = await fetch(`${API}/themis/bilan`, { credentials: "include" });
                if (!rt.ok) return;
                const t = await rt.json();
                const ech = t.echeances || [];
                const retards = ech.filter((e) => e.days < 0);
                const proches = ech.filter((e) => e.days >= 0 && e.days <= 7);
                const bits = [];
                if (retards.length) bits.push(`${retards.length} facture${retards.length > 1 ? "s" : ""} en retard de paiement`);
                if (proches.length) bits.push(`${proches.length} échéance${proches.length > 1 ? "s" : ""} sous 7 jours`);
                if (bits.length) rappelsTxt = ` Rappels Thémis : ${bits.join(" et ")}.`;
              } catch (e) { /* rappels indisponibles — briefing sans Thémis */ }
            })(),
            (async () => {
              try {
                const rb = await fetch(`${API}/nummarius/market`, { credentials: "include" });
                if (!rb.ok) return;
                const b = await rb.json();
                const assets = (b.assets || []).filter((x) => typeof x.change === "number");
                if (!assets.length) return;
                const up = [...assets].sort((x, y) => y.change - x.change)[0];
                const down = [...assets].sort((x, y) => x.change - y.change)[0];
                const dir = (v) => `${v >= 0 ? "plus" : "moins"} ${Math.abs(v).toFixed(1)} pour cent`;
                let s = ` Tendances Portus Nummarius : ${up.label} en tête à ${dir(up.change)}`;
                if (down.id !== up.id) s += `, ${down.label} en repli à ${dir(down.change)}`;
                bourseTxt = `${s}.`;
              } catch (e) { /* marchés indisponibles — briefing sans bourse */ }
            })(),
          ]);
          const msg = `${salut}${meteoAtlas}${agendaTxt}${rappelsTxt} ${d.briefing}${objAgora}${bourseTxt}`;
          showOnDisplay({
            type: "message",
            titre: "BRIEFING QUOTIDIEN",
            contenu: msg,
          });
          setStatus("speaking");
          setText(msg);
          speakOut(msg);
          progress.done(pid, "Briefing délivré");
        } else {
          progress.done(pid, "Aucun briefing disponible");
        }
      } catch (e) { progress.error(pid, "Briefing indisponible"); }
  }, [showOnDisplay, speakOut, userName, profile]);
  useEffect(() => { runBriefingRef.current = runBriefingDisplay; }, [runBriefingDisplay]);
  useEffect(() => {
    if (booting || showSetup || briefingDoneRef.current) return;
    if (localStorage.getItem("sirius_last_briefing") === todayStr()) return;
    briefingDoneRef.current = true;
    const id = setTimeout(() => runBriefingDisplay(), 1800);
    return () => clearTimeout(id);
  }, [booting, showSetup, runBriefingDisplay]);

  // Réveil matinal : à l'heure choisie, salut vocal puis briefing (météo incluse) puis lecture des mails
  useEffect(() => {
    const tick = () => {
      let cfg = null;
      try { cfg = JSON.parse(localStorage.getItem("sirius_reveil") || "null"); } catch (e) { /* config illisible */ }
      if (!cfg || !cfg.on || !cfg.time) return;
      const nowLocal = new Date();
      const [h, m] = cfg.time.split(":").map(Number);
      if (nowLocal.getHours() !== h || nowLocal.getMinutes() !== m) return;
      const today = getLocalDateKey(nowLocal);
      if (localStorage.getItem("sirius_reveil_last") === today) return;
      localStorage.setItem("sirius_reveil_last", today);
      (async () => {
        const salut = `Réveil ! Il est ${h} heure${h > 1 ? "s" : ""}${m ? ` ${String(m).padStart(2, "0")}` : ""}. Voici ton briefing du matin.`;
        setStatus("speaking"); setText(salut); speakOut(salut);
        await new Promise((r) => setTimeout(r, 5000));
        await runBriefingDisplay(true);
        // attend la fin de la lecture du briefing avant de passer aux mails
        const t0 = Date.now();
        await new Promise((r) => setTimeout(r, 3000));
        while (speakingRef.current && Date.now() - t0 < 240000) await new Promise((r) => setTimeout(r, 1000));
        await new Promise((r) => setTimeout(r, 800));
        readMailAloud();
      })();
    };
    const id = setInterval(tick, 20000);
    return () => clearInterval(id);
  }, [runBriefingDisplay, readMailAloud, speakOut]);

  const jours = undefined, mois = undefined, dateStr = undefined, timeStr = undefined; // → LiveClock/LiveDate (liveStats.js)

  statusPulseRef.current.status = status;

  // Registre centralisé des modules (menu déroulant + palette Ctrl+K) — avec les noms inscrits
  // Navigation tactile (tablette/mobile) : balayage = module précédent/suivant, pincement = fermer/ouvrir
  const TOUCH_RING = [
    { label: "PANTHEON SYSTEM", get: () => showPantheon, set: setShowPantheon },
    { label: "NEXUS CÉLESTE", get: () => showNexus, set: setShowNexus },
    { label: "ORACLE DIVIN", get: () => showOracle, set: setShowOracle },
    { label: "SIRIUS PRIME", get: () => showPrime, set: setShowPrime },
    { label: "ZEUS CORTEX", get: () => showCortex, set: setShowCortex },
    { label: "ARGUS", get: () => showArgus, set: setShowArgus },
    { label: "LOCUS#", get: () => showLocus, set: setShowLocus },
    { label: "HERACLES#", get: () => showHeracles, set: setShowHeracles },
    { label: "HÉPHAÏSTOS#", get: () => showHephaistos, set: setShowHephaistos },
    { label: "GALERIE MYTHOS", get: () => showMythosGallery, set: setShowMythosGallery },
    { label: "TRAILER#", get: () => showTrailer, set: setShowTrailer },
    { label: "PROMO#", get: () => showPromo, set: setShowPromo },
    { label: "THÉMIS#", get: () => showThemis, set: setShowThemis },
    { label: "AGORA PIPELINE", get: () => showAgora, set: setShowAgora },
    { label: "ACTUALITÉS", get: () => showNews, set: setShowNews },
    { label: "PACKAGER#", get: () => showPackager, set: setShowPackager },
    { label: "SCRIPTS", get: () => showScripts, set: setShowScripts },
    { label: "HACCP", get: () => !!haccp, set: (v) => setHaccp(v ? { sujet: "", auto: false } : null) },
  ];
  const [touchToast, setTouchToast] = useState(null);
  const touchToastTimer = useRef(null);
  const showTouchToast = (label) => {
    setTouchToast(label);
    clearTimeout(touchToastTimer.current);
    touchToastTimer.current = setTimeout(() => setTouchToast(null), 1400);
  };
  const swipeNav = (dir) => {
    const idx = TOUCH_RING.findIndex((m) => m.get());
    if (idx === -1) return;
    const next = (idx + dir + TOUCH_RING.length) % TOUCH_RING.length;
    TOUCH_RING[idx].set(false);
    TOUCH_RING[next].set(true);
    showTouchToast(TOUCH_RING[next].label);
  };
  useTouchNav({
    onSwipeLeft: () => swipeNav(1),
    onSwipeRight: () => swipeNav(-1),
    onPinchIn: () => {
      const idx = TOUCH_RING.findIndex((m) => m.get());
      if (idx !== -1) { TOUCH_RING[idx].set(false); showTouchToast("RETOUR AU HUD"); }
      else if (showModulesMenu) setShowModulesMenu(false);
    },
    onPinchOut: () => {
      if (!TOUCH_RING.some((m) => m.get()) && !showModulesMenu) {
        setShowModulesMenu(true);
        showTouchToast("MENU MODULES");
      }
    },
  });

  const moduleItems = [
    { id: "reload", group: "SYSTÈME", label: "Recharger SIRIUS", Icon: RotateCcw, run: () => { window.__siriusBootPlayed = false; window.location.reload(); } },
    { id: "display", group: "MÉDIAS", label: "SIRIUS DISPLAY", Icon: Monitor, active: displayOpen, run: () => { pinDisplay(); setDisplayOpen((o) => !o); } },
    { id: "media-modules", group: "MÉDIAS", label: "Modules multimédia", Icon: Clapperboard, active: displayOpen && display.type === "media", run: () => showOnDisplay({ type: "media", titre: "MODULES MULTIMÉDIA" }) },
    { id: "files", group: "MÉDIAS", label: "Médiathèque", Icon: FolderOpen, run: () => setShowFiles(true) },
    { id: "architect", group: "OUTILS", label: "Architecte visuel", Icon: Workflow, run: () => { setArchitectPrompt(""); setShowArchitect(true); } },
    { id: "pantheon", group: "PANTHÉON", label: "PANTHEON SYSTEM", Icon: PantheonLogo, run: () => setShowPantheon(true) },
    { id: "cortex", group: "PANTHÉON", label: "ZEUS CORTEX# — intelligence centrale", Icon: Zap, run: () => setShowCortex(true) },
    { id: "nexus", group: "PANTHÉON", label: "NEXUS CÉLESTE", Icon: Orbit, run: () => setShowNexus(true) },
    { id: "oracle", group: "PANTHÉON", label: "ORACLE DIVIN", Icon: Eye, run: () => setShowOracle(true) },
    { id: "nummarius", group: "PANTHÉON", label: "PORTUS NUMMARIUS# — bourse & marchés", Icon: Landmark, run: () => setShowNummarius(true) },
    { id: "europeana", group: "MÉDIAS", label: "Archives Europeana", Icon: Library, run: () => setShowEuropeana(true) },
    { id: "haccp", group: "OUTILS", label: "HACCP — sécurité alimentaire", Icon: ShieldCheck, run: () => setHaccp({ sujet: "", auto: false }) },
    {
      id: "voice",
      group: "SYSTÈME",
      label: micOn ? "Reconnaissance vocale — écoute" : "Reconnaissance vocale",
      Icon: AudioLines,
      active: showVoicePanel,
      run: () => {
        setShowVoicePanel(true);
        if (!micOnRef.current) startListening();
      },
    },
    { id: "prime", group: "OUTILS", label: "SIRIUS PRIME — mémoire", Icon: Sparkles, run: () => setShowPrime(true) },
    { id: "dev", group: "OUTILS", label: "Compagnon Dev", Icon: Code2, run: () => setShowDev(true) },
    { id: "analytics", group: "OUTILS", label: "Tableau analytique", Icon: BarChart3, run: () => setShowAnalytics(true) },
    { id: "memory", group: "OUTILS", label: "Ce que Sirius sait sur moi", Icon: Brain, run: () => setShowMemory(true) },
    { id: "memorymgr", group: "OUTILS", label: "Gestion de la mémoire", Icon: Database, run: () => setShowMemoryMgr(true) },
    { id: "argus", group: "PANTHÉON", label: "ARGUS — surveillance système", Icon: Radar, run: () => setShowArgus(true) },
    { id: "journal", group: "OUTILS", label: "Journal des tâches", Icon: History, run: () => window.dispatchEvent(new Event("sirius-journal-open")) },
    { id: "keys", group: "SYSTÈME", label: "Statut des clés API", Icon: KeyRound, run: () => setShowKeysStatus(true) },
    { id: "gcal", group: "OUTILS", label: "AGENDA — Google Calendar", Icon: Calendar, run: () => setShowCalendar(true) },
    { id: "faceid", group: "SYSTÈME", label: "FACE ID — reconnaissance faciale locale", Icon: Fingerprint, run: () => setShowFaceId(true) },
    { id: "reveil", group: "SYSTÈME", label: "RÉVEIL MATINAL — briefing & mails à l'heure choisie", Icon: AlarmClock, run: () => setShowReveil(true) },
    { id: "keraunos", group: "PANTHÉON", label: "KERAUNOS# — domotique", Icon: HomeIcon, run: () => setShowKeraunos(true) },
    { id: "espace", group: "MÉDIAS", label: "ESPACE — système solaire 3D", Icon: Globe2, run: () => setShowEspace(true) },
    { id: "about", group: "SYSTÈME", label: "À propos / Informations légales", Icon: BadgeInfo, run: () => setShowAbout(true) },
    { id: "locus", group: "PANTHÉON", label: "LOCUS# — géolocalisation", Icon: MapPin, run: () => setShowLocus(true) },
    { id: "atlas", group: "PANTHÉON", label: "ATLAS# — carte & navigation", Icon: Globe2, run: () => { setAtlasQuery(""); setAtlasRoute(null); setShowAtlas(true); } },
    { id: "heracles", group: "PANTHÉON", label: "HERACLES# — investigation OSINT", Icon: Fingerprint, run: () => setShowHeracles(true) },
    { id: "hephaistos", group: "PANTHÉON", label: "HÉPHAÏSTOS# — auto-maintenance & diagnostic", Icon: Hammer, run: () => setShowHephaistos(true) },
    { id: "mythos", group: "PANTHÉON", label: "Galerie MYTHOS", Icon: MythosLogo, run: () => setShowMythosGallery(true) },
    { id: "trailer", group: "MÉDIAS", label: "TRAILER# — clichés cinématiques", Icon: Clapperboard, run: () => setShowTrailer(true) },
    { id: "promo", group: "MÉDIAS", label: "PROMO# — storyboard vidéo réseaux sociaux", Icon: Radio, run: () => setShowPromo(true) },
    { id: "themis", group: "PANTHÉON", label: "THÉMIS# — gestion d'entreprise (devis, factures, stocks)", Icon: ThemisLogo, run: () => setShowThemis(true) },
    { id: "agora", group: "PANTHÉON", label: "HERMÈS AGORA# — pipeline de vente", Icon: TrendingUp, run: () => setShowAgora(true) },
    { id: "solon", group: "PANTHÉON", label: "SOLON# — conseil juridique", Icon: Scale, run: () => setShowSolon(true) },
    { id: "promethee", group: "PANTHÉON", label: "PROMÉTHÉE# — gestion de projet", Icon: Flame, run: () => setShowPromethee(true) },
    { id: "calliope", group: "PANTHÉON", label: "CALLIOPE# — bibliothèque audio", Icon: BookOpen, run: () => setShowCalliope(true) },
    { id: "pythagore", group: "PANTHÉON", label: "PYTHAGORE# — mathématiques & géométrie", Icon: Sigma, run: () => setShowPythagore(true) },
    { id: "news", group: "MÉDIAS", label: "ACTUALITÉS — flux en direct", Icon: Newspaper, run: () => setShowNews(true) },
    { id: "packager", group: "OUTILS", label: "PACKAGER# — livrable multi-plateforme", Icon: Package, run: () => setShowPackager(true) },
    { id: "install", group: "SYSTÈME", label: "Assistant d'installation", Icon: Wrench, run: () => setShowInstall(true) },
    { id: "scripts", group: "OUTILS", label: "Bibliothèque de scripts", Icon: FileCode, run: () => setShowScripts(true) },
    { id: "vision", group: "MÉDIAS", label: "Vision caméra", Icon: Camera, active: showVision, run: () => setShowVision(!showVision) },
    { id: "productivity", group: "OUTILS", label: "PRODUCTIVITE & TRAVAIL — documents, code, notes, taches", Icon: Workflow, active: showProductivity, run: () => { setProductivityIntent(null); setShowProductivity(true); } },
    { id: "media", group: "MÉDIAS", label: "MEDIA PROXY — lecteurs et controles", Icon: Radio, active: showMediaHud, run: () => { setMediaIntent(null); setShowMediaHud(true); } },
    { id: "spotify", group: "MÉDIAS", label: spotify ? "Spotify — lecteur intégré" : "Spotify — lecteur (connexion requise)", Icon: Music, active: spotify, run: () => setShowSpotifyWin(true) },
    ...(authUser?.role === "admin" ? [{ id: "admin", group: "SYSTÈME", label: "ADMINISTRATION — comptes & activité", Icon: ShieldCheck, run: () => setShowAdmin(true) }] : []),
  ];
  moduleItemsRef.current = moduleItems;

  return (
    <div
      className={`sirius-root ${ecoMode ? "eco" : ""} mode-${sysMode}`}
      style={{ ...getHUDStyleVariables(), "--accent": accentColor, "--glow": glowColor }}
      data-core-active={hudTheme.core.active}
      data-guardian-active={hudTheme.guardian.visible}
      data-testid="sirius-hud"
    >
      <div className="grid-bg" />
      <div
        className="antique-bg presentation-bg"
        style={{ "--guardian-backdrop-image": 'url("/holo/zeus-boot.jpg")' }}
        data-testid="sirius-antique-bg"
      />
      <div className="guardian-rig" data-testid="sirius-guardian-rig">
        <img src="/holo/zeus-boot.jpg" alt="" className={`antique-guardian holo-full ${status === "speaking" ? "speaking" : status === "listening" ? "listening" : ""}`} draggable={false} data-testid="sirius-guardian" />
        <span className="guardian-bolt-glow" aria-hidden="true" data-testid="guardian-bolt-glow" />
      </div>
      <img src="/holo/jarre.png" alt="" className="antique-jar" draggable={false} data-testid="sirius-jar" />
      {/* Noyau de présentation compact rendu dans center-stage (MedallionRing géant retiré) */}
      <div className="scanline" />
      <div className="vignette" />

      {/* Ambiance bokeh/poussière retirée — fond identique à la page de présentation */}

      {/* Scène étoilée/mains retirée — fond identique à la page de présentation */}

    {/* Coins HUD */}
      <span className="corner tl" />
      <span className="corner tr" />
      <span className="corner bl" />
      <span className="corner br" />

      {booting && <BootScreen userName={userName} onDone={() => setBooting(false)} onOpenModule={(id) => {
        const openers = { argus: setShowArgus, atlas: setShowAtlas, oracle: setShowOracle, heracles: setShowHeracles, hephaistos: setShowHephaistos, keraunos: setShowKeraunos, locus: setShowLocus, pantheon: setShowPantheon, cortex: setShowCortex, themis: setShowThemis, nummarius: setShowNummarius };
        if (id === "solon") { setShowSolon(true); return; }
        if (id === "calliope") { setShowCalliope(true); return; }
        if (id === "pythagore") { setShowPythagore(true); return; }
        if (id === "promethee") { setShowPromethee(true); return; }
        if (id === "agora") {
          setMythosFocus("HERMÈS AGORA#");
          setShowMythosGallery(true);
          return;
        }
        openers[id] && openers[id](true);
      }} />}


      {showSetup && (
        <SiriusSetup
          initialProfile={profile}
          initialKeys={keys}
          onComplete={handleSetupComplete}
          onCancel={() => setShowSetup(false)}
        />
      )}

      {showMemory && (
        <MemoryPanel
          memory={memory}
          userName={userName}
          onSave={saveMemory}
          onClose={() => setShowMemory(false)}
        />
      )}

      {showAnalytics && (
        <AnalyticsPanel
          metrics={metrics}
          memoryCount={memory.length}
          onClose={() => setShowAnalytics(false)}
        />
      )}

      {showArchitect && (
        <ArchitectPanel
          keys={keys}
          initialPrompt={architectPrompt}
          onClose={() => setShowArchitect(false)}
          onSpeak={speakOut}
        />
      )}

      {showFiles && <FilesPanel onClose={() => setShowFiles(false)} />}

      {showDev && <DevCompanion keys={keys} onClose={() => setShowDev(false)} />}

      {showCortex && (
        <ZeusCortex
          onClose={() => setShowCortex(false)}
          onAsk={(t) => processCommand(t)}
          answer={text}
          speaking={status === "speaking"}
        />
      )}

      {showPrime && <SiriusPrime onClose={() => setShowPrime(false)} />}

      {showOracle && <OracleDivin onClose={() => setShowOracle(false)} />}
      {showMemoryMgr && <MemoryManager onClose={() => setShowMemoryMgr(false)} />}
      {showArgus && <ArgusPanel onClose={() => setShowArgus(false)} onClientAction={handleArgusClientAction} onRepaired={() => { setSysMode("normal"); setSysCause(""); }} />}
      <ArgusWatcher onCriticalAlert={(e) => {
        setArgusAlert(e);
        const MODS = { ia: "le module IA", vocal: "le module vocal", hud: "l'interface HUD", backend: "le noyau backend", reseau: "la liaison réseau", outlook: "le module Outlook", haccp: "le module HACCP", oracle: "l'Oracle Divin", pantheon: "le Panthéon", permissions: "les permissions" };
        if (e && e.severity === "critical") {
          speakRef.current(`Anomalie critique détectée sur ${MODS[e.errorType] || "un module système"}. ${e.proposedFix ? "Réparation proposée : " + e.proposedFix + "." : ""} Ouvre ARGUS pour intervenir.`);
          if (sysMode === "normal") {
            setSysMode("safe"); setSysCause(e.message || "erreur critique détectée");
          }
        } else if (e && e.severity === "severe") {
          speakRef.current(`Anomalie détectée sur ${MODS[e.errorType] || "un module"}. Rien de critique, mais une intervention est recommandée.`);
        }
      }} />

      <ModeBanner
        mode={sysMode}
        cause={sysCause}
        onExit={() => { setFrugalManual(null); setSystemMode("normal", "manual").then((d) => { if (d) speakRef.current(d.responseText); }); }}
        onDiagnostic={() => fetch(`${API}/system/diagnostic`, { credentials: "include" }).then((r) => r.json()).then((d) => { setText(d.responseText); speakRef.current(d.responseText); }).catch(() => {})}
      />
      <FrugalWatcher
        active={sysMode === "frugal"}
        manual={frugalManual}
        onAuto={(should, reason) => {
          if (sysMode === "safe") return;
          if (should) { setSystemMode("frugal", "auto", reason); }
          else if (sysMode === "frugal") { setSystemMode("normal", "auto"); }
        }}
      />
      {showVision && sysMode !== "safe" && (
        <VisionModule onClose={() => { setShowVision(false); setVisionAuto(false); }} onSpeak={(m) => speakRef.current(m)} keys={keys} autoAnalyze={visionAuto} />
      )}
      {showScripts && <ScriptInstaller onClose={() => setShowScripts(false)} onSpeak={(m) => speakRef.current(m)} />}
      {showLocus && <LocusPanel onClose={() => { setShowLocus(false); setLocusQuery(""); setLocusRoute(null); }} onSpeak={(m) => speakRef.current(m)} keys={keys} initialAddress={locusQuery} initialRoute={locusRoute} />}
      {showAtlas && (
        <AtlasPanel
          onClose={() => { setShowAtlas(false); setAtlasQuery(""); setAtlasRoute(null); }}
          onSpeak={(m) => speakRef.current(m)}
          keys={keys}
          onSaveKeys={(gk) => { const nk = { ...keys, gmaps: gk }; setKeys(nk); localStorage.setItem("sirius_keys", JSON.stringify(nk)); }}
          initialQuery={atlasQuery}
          initialRoute={atlasRoute}
        />
      )}
      {showHeracles && <HeraclesPanel onClose={() => { setShowHeracles(false); setHeraclesInput(""); }} onSpeak={(m) => speakRef.current(m)} initialInput={heraclesInput} />}
      {showHephaistos && <HephaistosPanel onClose={() => setShowHephaistos(false)} onSpeak={(m) => { setStatus("speaking"); setText(m); speakOut(m); }} />}
      {showMythosGallery && <MythosGallery initialModule={mythosFocus} onClose={() => { setShowMythosGallery(false); setMythosFocus(null); }} onOpenModule={(mod) => {
        setShowMythosGallery(false);
        const map = {
          "ARGUS#": setShowArgus, "LOCUS#": setShowLocus, "ORACLE#": setShowOracle,
          "PANTHÉON#": setShowPantheon, "HERACLES#": setShowHeracles,
          "SIRIUS CORTEX#": setShowCortex, "HÉPHAÏSTOS#": setShowHephaistos,
          "ATLAS#": setShowAtlas, "SIRIUS DISPLAY#": setDisplayOpen, "THÉMIS#": setShowThemis,
          "HERMÈS AGORA#": setShowAgora, "SOLON#": setShowSolon, "PROMÉTHÉE#": setShowPromethee,
          "CALLIOPE#": setShowCalliope, "PYTHAGORE#": setShowPythagore,
        };
        const open = map[mod];
        if (open) open(true);
      }} />}
      {showPackager && <PackagerPanel onClose={() => { setShowPackager(false); setPackagerAutoInstall(false); }} autoInstaller={packagerAutoInstall} onSpeak={(m) => speakRef.current(m)} />}
      {showTrailer && <TrailerGallery onClose={() => setShowTrailer(false)} />}
      {showPromo && <PromoPanel onClose={() => setShowPromo(false)} />}
      {showThemis && <ThemisPanel onClose={() => setShowThemis(false)} />}
      {showAgora && <AgoraPipeline onClose={() => setShowAgora(false)} onOpenThemis={() => { setShowAgora(false); setShowThemis(true); }} />}
      {showSolon && <ConsultPanel module="SOLON#" onClose={() => setShowSolon(false)} />}
      {showPromethee && <PrometheePanel onClose={() => setShowPromethee(false)} />}
      {showCalliope && <CalliopePanel onClose={() => setShowCalliope(false)} />}
      {showCalendar && <CalendarPanel onClose={() => setShowCalendar(false)} />}
      {showFaceId && (
        <FaceIdPanel
          onClose={() => setShowFaceId(false)}
          userName={userName}
          onRecognized={(name) => speakRef.current(`Bonjour ${name}. Identité confirmée, content de te revoir.`)}
        />
      )}
      {showReveil && (
        <ReveilPanel
          onClose={() => setShowReveil(false)}
          onSpeak={(m) => { setStatus("speaking"); setText(m); speakOut(m); }}
        />
      )}
      {showSpotifyWin && (
        <SpotifyPanel
          onClose={() => setShowSpotifyWin(false)}
          tokens={spotify}
          onConnect={connectSpotify}
          onRefreshToken={(t) => saveSpotify({ ...spotifyRef.current, access_token: t })}
          onRemotePlay={(q) => launchMusic(q, "spotify")}
          onNowPlaying={fetchNowPlaying}
          onShowTrack={(t) => showOnDisplay({ type: "image", src: t.image_big || t.image, legende: `SPOTIFY — ${t.title} · ${t.artist}` })}
        />
      )}
      {showMediaHud && (
        <MediaHUD
          initialIntent={mediaIntent}
          onClose={() => { setShowMediaHud(false); setMediaIntent(null); }}
          onShowOnDisplay={(media, onMediaControl) => showOnDisplay({
            type: "media",
            titre: `MEDIA — ${(media.provider || "").toUpperCase()}`,
            media,
            onMediaControl,
          })}
        />
      )}
      {showProductivity && (
        <ProductivityPanel
          initialTab={productivityIntent?.tab || "documents"}
          onClose={() => { setShowProductivity(false); setProductivityIntent(null); }}
        />
      )}
      {showPythagore && <PythagorePanel onClose={() => setShowPythagore(false)} />}
      {showAdmin && <AdminPanel onClose={() => setShowAdmin(false)} />}
      {showNummarius && <PortusNummarius onClose={() => setShowNummarius(false)} />}
      {showNews && <NewsPanel onClose={() => setShowNews(false)} />}
      {argusAlert && (
        <div className="argus-alert" data-testid="argus-alert">
          <div className="argus-alert-title">
            <ShieldAlert size={12} /> ARGUS — {argusAlert.severity === "critical" ? "ERREUR CRITIQUE" : "ERREUR SÉVÈRE"}
          </div>
          <p>{argusAlert.message}</p>
          <div className="argus-alert-actions">
            <button className="argus-btn" onClick={() => { setShowArgus(true); setArgusAlert(null); }} data-testid="argus-alert-open">
              OUVRIR ARGUS
            </button>
            <button className="argus-btn ghost" onClick={() => setArgusAlert(null)} data-testid="argus-alert-dismiss">
              IGNORER
            </button>
          </div>
        </div>
      )}
      {showInstall && (
        <InstallWizard
          onClose={() => setShowInstall(false)}
          onSpeak={(m) => speakRef.current(m)}
          keys={keys}
        />
      )}

      {showPantheon && <PantheonSystem onClose={() => setShowPantheon(false)} keys={keys} />}

      {showNexus && <NexusCeleste onClose={() => setShowNexus(false)} />}

      {haccp && <HaccpModule onClose={() => setHaccp(null)} />}

      {musicChoice && (
        <MusicChoice
          query={musicChoice}
          onPick={(source, remember) => {
            if (remember) localStorage.setItem("sirius_music_source", source);
            const q = musicChoice;
            setMusicChoice(null);
            launchMusic(q, source);
          }}
          onClose={() => { setMusicChoice(null); setStatus("idle"); }}
        />
      )}

      {/* Barre supérieure */}
      <header className="top-bar">
        <div className="brand-tag" data-testid="sirius-brand-tag">
          <span className="dot" />
          Σ I R I U S
        </div>
        <div className="sys-indicators" data-testid="sirius-indicators">
          <span className="ind"><i className="ind-dot orange" />IA</span>
          <span className="ind"><i className="ind-dot cyan" />CLOUD</span>
          <span className="ind"><i className={`ind-dot ${keys.groq || envGroq ? "green" : "grey"}`} />KIMI K3</span>
          {(() => {
            const ks = keySource || ((keys.groq || "").trim() ? "personnelle" : envGroq ? "serveur" : null);
            if (!ks) return null;
            const cfg = {
              personnelle: { dot: "gold", label: "CLÉ PERSO" },
              serveur: { dot: "cyan", label: "CLÉ SERVEUR" },
              "repli-serveur": { dot: "orange", label: "CLÉ SERVEUR · REPLI" },
            }[ks] || { dot: "grey", label: "CLÉ ?" };
            return (
              <span className="ind key-src-ind" data-testid="key-source-badge" title="Clé qui alimente le cerveau de Sirius en direct (mise à jour à chaque réponse)">
                <i className={`ind-dot ${cfg.dot}`} />{cfg.label}
              </span>
            );
          })()}
        </div>
        <div className="conn-status" data-testid="sirius-connection">
          <span className={`conn-led ${connected ? "on" : "off"}`} />
          {"IA CLOUD · GROQ / KIMI"}
          {mode === "brainstorm" && <span className="mode-badge" data-testid="brainstorm-badge">BRAINSTORM</span>}
          <button
            className={`profile-btn ${isFullscreen ? "on" : ""}`}
            onClick={toggleFullscreen}
            data-testid="sirius-fullscreen-btn"
            title={isFullscreen ? "Quitter le plein écran (Échap)" : "Plein écran"}
          >
            {isFullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
          </button>
          <button
            className={`profile-btn ${showModulesMenu ? "on" : ""}`}
            onClick={() => setShowModulesMenu((o) => !o)}
            data-testid="sirius-modules-btn"
            title="Menu des modules (Ctrl+K)"
          >
            <Grip size={15} />
          </button>
          <button
            className="profile-btn profile-btn-pinned"
            onClick={() => setShowSetup(true)}
            data-testid="sirius-profile-btn"
            title="Profil et clés API"
          >
            <UserCog size={15} />
          </button>
          {isLocalDevServer && (
            <ConfirmButton
              className={`profile-btn sirius-shutdown-btn ${isShuttingDown ? "is-shutting-down" : ""}`}
              onConfirm={shutdownSirius}
              testId="sirius-shutdown-btn"
              title={isShuttingDown ? "Extinction de SIRIUS en cours" : "Éteindre SIRIUS"}
              label="ÉTEINDRE ?"
            >
              <Power size={15} />
            </ConfirmButton>
          )}
        </div>
    </header>
      <ModulesMenu open={showModulesMenu} onClose={() => setShowModulesMenu(false)} items={moduleItems} />
      <CommandPalette open={showCmdPalette} onClose={() => setShowCmdPalette(false)} items={moduleItems} />

      {nowPlaying && nowPlaying.title && (
        <div className="now-playing-banner" data-testid="now-playing-banner" onClick={fetchNowPlaying} title="Voir le morceau en cours">
          {nowPlaying.image && <img src={nowPlaying.image} alt="" className="np-cover" />}
          <span className={`np-eq ${nowPlaying.playing ? "on" : ""}`}><i /><i /><i /></span>
          <div className="np-text">
            <div className="np-label">{nowPlaying.playing ? "EN ÉCOUTE" : "EN PAUSE"}</div>
            <div className="np-title">{nowPlaying.title} <span className="np-artist">— {nowPlaying.artist}</span></div>
            {nowPlaying.duration_ms > 0 && (
              <div className="np-progress" data-testid="np-progress">
                <i style={{ width: `${Math.min(100, (nowPlaying.progress_ms / nowPlaying.duration_ms) * 100)}%` }} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Pop-ups holographiques contextuels (gérés par Sirius) */}
      <HoloPopups popups={popups} onClose={closePopup} onImage={setArchiveView} />

      {/* Suggestions proactives issues de la mémoire réelle (projets, épisodes, habitudes).
          Le panneau reste invisible tant que le moteur n'a rien de pertinent à proposer. */}
      <ProactivePanel
        onAction={(a) => {
          if (!a || !a.type) return;
          if (a.type === "command") {
            if (a.prepare) { setCmd(a.text || ""); }
            else if (processCommandRef.current) { processCommandRef.current(a.text); }
          } else if (a.type === "memory_confirm" && a.memory_id) {
            fetch(`${API}/memory/${a.memory_id}`, { credentials: "include",
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ fields: a.prepare ? {} : { status: "active", confidence: 0.95 } }),
            }).catch(() => {});
            speakRef.current("Information confirmée et retenue, monsieur.");
          }
        }}
        onSpeak={(m) => speakRef.current(m)}
      />

      {/* SIRIUS WebBrowser : fenêtres web indépendantes, déplaçables, redimensionnables */}
      <WebWindows windows={webWindows} onClose={closeWebWindow} />

      {/* SIRIUS DISPLAY : écran principal permanent piloté par Sirius */}
      {displayOpen && (
        <SiriusDisplay
          item={display}
          history={displayHistory}
          onSelect={(h) => { pinDisplay(); setDisplay(h); }}
          onClose={() => setDisplayOpen(false)}
          onInteract={pinDisplay}
          onSpeak={(m) => { setStatus("speaking"); setText(m); speakOut(m); }}
        />
      )}

      {showVoicePanel && (
        <section className="voice-capture-panel" role="dialog" aria-label="Reconnaissance vocale SIRIUS" data-testid="sirius-voice-panel" data-hud-panel>
          <header className="voice-capture-header">
            <div>
              <span className="voice-capture-kicker">SIRIUS · AUDIO LINK</span>
              <strong>RECONNAISSANCE VOCALE</strong>
            </div>
            <button
              type="button"
              className="voice-capture-close"
              onClick={() => {
                stopListening();
                setShowVoicePanel(false);
              }}
              aria-label="Fermer la reconnaissance vocale"
            >
              <X size={17} />
            </button>
          </header>

          <div className={`voice-capture-core ${micOn ? "listening" : status === "thinking" ? "processing" : ""}`}>
            <div className="voice-capture-rings" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <Mic size={30} />
          </div>

          <div className="voice-capture-state">
            <span className={`voice-capture-dot ${micOn ? "on" : ""}`} />
            {micOn ? "ÉCOUTE EN COURS" : status === "thinking" ? "TRANSCRIPTION EN COURS" : "PRÊT À ÉCOUTER"}
          </div>

          <div className="voice-capture-wave" aria-hidden="true">
            {Array.from({ length: 18 }, (_, index) => <span key={index} />)}
          </div>

          <div className="voice-capture-transcript" aria-live="polite">
            <span>TRANSCRIPTION</span>
            <p>{voiceTranscript || (micOn ? "Parlez maintenant…" : "Votre dernière prise de voix apparaîtra ici.")}</p>
          </div>

          <div className="voice-capture-actions">
            <button
              type="button"
              className={`voice-capture-primary ${micOn ? "recording" : ""}`}
              onClick={micOn ? finishVoiceCapture : startListening}
            >
              {micOn ? <><MicOff size={16} /> TERMINER ET ENVOYER</> : <><Mic size={16} /> DÉMARRER L’ÉCOUTE</>}
            </button>
            <span>Maintenez aussi <b>ESPACE</b> pour parler</span>
          </div>
        </section>
      )}

      {/* Fenêtres de tâches pilotées par SIRIUS (créations, rendus, étapes en direct) */}
      <TaskWindows tasks={tasks} onClose={closeTask} />
      <SiriusProgress mode={status} />
      <PwaPrompt />
      {showKeysStatus && <KeysStatus onClose={() => setShowKeysStatus(false)} />}
      {showKeraunos && <KeraunosPanel onClose={() => setShowKeraunos(false)} />}
      {showAbout && <AboutPanel onClose={() => setShowAbout(false)} />}
      {showEspace && <EspacePanel onClose={() => setShowEspace(false)} />}
      {touchToast && <div className="touch-toast" data-testid="sirius-touch-toast">{touchToast}</div>}

      {/* Galerie de la médiathèque SIRIUS (« liste tes archives ») */}
      {showGallery && (
        <ArchiveGallery
          nav={galleryNav}
          onClose={() => setShowGallery(false)}
          onOpen={openArchiveWindow}
          onSpeak={(m) => { setStatus("speaking"); setText(m); speakOut(m); }}
        />
      )}

      {/* Visionneuse Europeana (bouton barre d'outils) */}
      {showEuropeana && (
        <EuropeanaViewer onClose={() => setShowEuropeana(false)} onImage={setArchiveView} />
      )}

      {/* Visionneuse d'archives holographique plein écran */}
      {archiveView && (
        <div className="archive-viewer" data-testid="archive-viewer" onClick={() => setArchiveView(null)}>
          <div className="av-frame" onClick={(e) => e.stopPropagation()}>
            <div className="hp-scan" />
            <img
              src={(archiveView.url || "").replace(/size=w\d+/, "size=w400")}
              alt={archiveView.legende || "archive"}
              data-testid="archive-viewer-img"
            />
            <div className="av-caption">
              <span>{archiveView.legende}</span>
              {archiveView.source && <em>{archiveView.source}</em>}
            </div>
            <button className="av-close" onClick={() => setArchiveView(null)} data-testid="archive-viewer-close" title="Fermer (Échap)">
              <X size={18} />
            </button>
          </div>
        </div>
      )}

      {/* Panneau bas-gauche : HEURE + CPU/RAM (style référence) */}
      <aside className="hud-panel bottom-left" data-testid="sirius-stats" data-hud-panel>
        <div className="hud-panel-title"><Clock size={13} /> HEURE &amp; UTC</div>
        <LiveClock />
      </aside>
      <div className="hud-panel stats-mini" data-testid="sirius-cpu-ram" data-hud-panel>
        <CpuRamMini />
      </div>

      {/* Coeur central */}
      <main className="center-stage">
        <div className={`reactor-wrap core-${status}`}>
          <div className="core-globe" aria-hidden="true">
            <HolographicGlobe />
          </div>
          <div className="core-equator" aria-hidden="true" />
          <div className="core-rings" aria-hidden="true">
            <img src="/holo/ring-gold.png" alt="" className="core-ring outer" draggable={false} />
            <img src="/holo/ring-gold.png" alt="" className="core-ring inner" draggable={false} />
            <div className="core-pulse" />
            <div className="core-orbit">
              {["Σ", "Δ", "Ω", "Θ", "Φ"].map((l, i) => (
                <span key={l} className="core-letter" style={{ "--i": i }}><i>{l}</i></span>
              ))}
            </div>
            <div className="holo-platform" aria-hidden="true">
              <span className="holo-platform-ring ring-a" />
              <span className="holo-platform-ring ring-b" />
              <span className="holo-platform-ring ring-c" />
            </div>
          </div>
          <ReactorCore status={status} volume={0.35} color="#22d3ee" eco={ecoMode} />
          <button
            className="core-quote-zone"
            data-testid="core-quote-btn"
            aria-label="Écouter une citation philosophique"
            title="Citation philosophique"
            onClick={speakQuote}
          />
          <div className={`reactor-text ${activeCard ? "dimmed" : ""}`}>
            <h1 className="sirius-title" data-testid="sirius-title">
              <button
                type="button"
                className="sirius-title-button"
                onClick={speakQuote}
                aria-label="Écouter une citation philosophique"
                title="Cliquez sur SIRIUS pour écouter une citation philosophique"
              >
                <img src="/holo/sirius-title.png" alt="ΣIRIUS" className="sirius-title-img" draggable={false} />
              </button>
            </h1>
          </div>
          {activeCard && (
            <CentralCard
              card={activeCard}
              weather={weather}
              onClose={() => setActiveCard(null)}
            />
          )}
        </div>

        <FloatingPanels
          weather={weather}
          connected={connected}
          status={status}
          hasBrain={!!keys.groq}
        />

        <Waveform status={status} color={accentColor} />

        {/* Zone de réponse supprimée : Sirius répond uniquement dans SIRIUS DISPLAY */}

        {imageReference && (
          <div className="image-reference-chip" data-testid="sirius-image-reference">
            <img src={imageReference.url} alt="" />
            <span><b>RÉFÉRENCE NANO BANANA</b>{imageReference.name}</span>
            <button type="button" onClick={clearImageReference} aria-label="Retirer l'image de référence">
              <X size={13} />
            </button>
          </div>
        )}

        <form className="cmd-bar" onSubmit={sendCommand} data-testid="sirius-cmd-form">
          <span className="cmd-prompt">SIRIUS&gt;</span>
          <input
            ref={imageReferenceInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(event) => selectImageReference(event.target.files?.[0])}
            data-testid="sirius-image-reference-input"
          />
          <button
            type="button"
            className={`image-reference-btn ${imageReference ? "active" : ""}`}
            onClick={() => imageReferenceInputRef.current?.click()}
            title="Ajouter une image de référence pour Nano Banana"
            aria-label="Ajouter une image de référence"
            data-testid="sirius-image-reference-btn"
          >
            <Camera size={15} />
          </button>
          <input
            className="cmd-input"
            type="text"
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            placeholder="Tapez une commande... (ex: allume le salon, quelle heure est-il)"
            data-testid="sirius-cmd-input"
          />
          <button
            type="button"
            className={`ptt-btn ${pttActive ? "on" : ""}`}
            onPointerDown={(e) => { e.preventDefault(); pttDown(); }}
            onPointerUp={pttUp}
            onPointerLeave={() => { if (pttRef.current) pttUp(); }}
            onContextMenu={(e) => e.preventDefault()}
            data-testid="sirius-ptt-btn"
            title="Talkie-walkie : maintenir pour parler, relâcher pour envoyer (ou touche Espace)"
          >
            <Radio size={15} />
            <span>{pttActive ? "À VOUS" : "ESPACE"}</span>
          </button>
          <button type="submit" className="cmd-send" data-testid="sirius-cmd-send">ENVOYER</button>
        </form>

        {/* Indicateur talkie-walkie : transmission en cours */}
        {pttActive && (
          <>
            <div className="ptt-frame" />
            <div className="ptt-indicator" data-testid="sirius-ptt-indicator">
              <span className="ptt-pulse" /> TRANSMISSION — RELÂCHEZ POUR ENVOYER
            </div>
          </>
        )}

        {/* Contrôles d'état retirés — le mode est affiché dans la barre d'activité SIRIUS */}
      </main>

      {/* Panneau bas-droit : NOYAU (style référence) */}
      <aside className="hud-panel bottom-right" data-testid="sirius-clock" data-hud-panel>
        <div className="noyau-status-row">
          <div className="hud-panel-title"><Brain size={13} /> NOYAU</div>
          <div className="noyau-line" data-testid="noyau-mode">{connected ? "Noyau local relié" : "IA Cloud active"}</div>
        </div>
        <div className="noyau-state">ÉTAT : <b data-testid="noyau-state">{conf.label}</b></div>
        <div className="noyau-user">UTILISATEUR · {(userName || "INVITÉ").toUpperCase()}</div>
      </aside>

      <footer className="sirius-footer" data-testid="sirius-footer">© 2026 SIRIUS Assistant – Daniel Partel</footer>
      <GlobalDrop />
    </div>
  );
}

function MemoryPanel({ memory, userName, onSave, onClose }) {
  const [items, setItems] = useState(() => [...(memory || [])]);
  const [draft, setDraft] = useState("");
  const [editIndex, setEditIndex] = useState(-1);
  const [editText, setEditText] = useState("");
  const [confirmMsg, setConfirmMsg] = useState("");
  const confirmTimer = useRef(null);
  const [localFacts, setLocalFacts] = useState([]);
  const [localDraft, setLocalDraft] = useState("");
  const [localCat, setLocalCat] = useState("preference");

  const loadLocal = useCallback(async () => {
    try {
      const r = await fetch(`${API}/local-memory`, { credentials: "include" });
      const data = await r.json();
      setLocalFacts(data.facts || []);
    } catch {}
  }, []);
  useEffect(() => { loadLocal(); }, [loadLocal]);

  const addLocal = async () => {
    const v = localDraft.trim();
    if (!v) return;
    try {
      const r = await fetch(`${API}/local-memory`, { credentials: "include",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: localCat, text: v }),
      });
      if (r.ok) { setLocalDraft(""); loadLocal(); flash("Enregistré dans la base locale ✓"); }
      else flash("Ce fait existe déjà.");
    } catch { flash("Base locale indisponible."); }
  };

  const delLocal = async (id) => {
    try {
      await fetch(`${API}/local-memory/${id}`, { credentials: "include", method: "DELETE" });
      loadLocal();
      flash("Supprimé de la base locale ✓");
    } catch {}
  };

  const flash = (msg) => {
    setConfirmMsg(msg);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setConfirmMsg(""), 2200);
  };
  useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current); }, []);

  const commit = (next) => { setItems(next); onSave(next); };

  const addItem = () => {
    const v = draft.trim().replace(/[.!?]+$/, "");
    if (!v) return;
    if (items.some((f) => f.t.toLowerCase() === v.toLowerCase())) { setDraft(""); flash("Ce souvenir existe déjà."); return; }
    commit([...items, { t: v, d: todayStr() }].slice(-30));
    setDraft("");
    flash("Souvenir ajouté ✓");
  };

  const removeItem = (i) => { commit(items.filter((_, idx) => idx !== i)); flash("Souvenir supprimé ✓"); };

  const startEdit = (i) => { setEditIndex(i); setEditText(items[i].t); };
  const saveEdit = () => {
    const v = editText.trim().replace(/[.!?]+$/, "");
    if (!v) { removeItem(editIndex); setEditIndex(-1); return; }
    commit(items.map((f, idx) => (idx === editIndex ? { ...f, t: v } : f)));
    setEditIndex(-1); setEditText("");
    flash("Modification enregistrée ✓");
  };

  return (
    <div className="setup-screen" data-testid="sirius-memory-panel" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="setup-grid-bg" />
      <div className="setup-card memory-modal">
        <button className="setup-close" onClick={onClose} data-testid="memory-close-btn"><X size={18} /></button>
        <div className="setup-head">
          <Brain size={22} />
          <div>
            <h2 className="setup-title">Ce que Sirius sait sur {userName || "vous"}</h2>
            <p className="setup-sub">Vos souvenirs personnels. Ajoutez, modifiez ou supprimez ce que Sirius retient.</p>
          </div>
        </div>

        <div className="memory-add">
          <input
            className="cmd-input"
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addItem(); } }}
            placeholder="Ex : J'adore le jazz / Mon chien s'appelle Rex"
            data-testid="memory-add-input"
          />
          <button className="cmd-send" onClick={addItem} data-testid="memory-add-btn"><Plus size={16} /> Ajouter</button>
        </div>

        <div className="memory-list" data-testid="memory-list">
          {items.length === 0 && (
            <div className="memory-empty" data-testid="memory-empty">
              Sirius ne retient encore rien sur vous. Ajoutez un souvenir ci-dessus,
              ou dites « souviens-toi que… » pendant une conversation.
            </div>
          )}
          {items.map((fact, i) => (
            <div className="memory-item" key={i} data-testid={`memory-item-${i}`}>
              {editIndex === i ? (
                <>
                  <input
                    className="cmd-input memory-edit-input"
                    type="text"
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveEdit(); } }}
                    autoFocus
                    data-testid={`memory-edit-input-${i}`}
                  />
                  <button className="memory-icon-btn" onClick={saveEdit} title="Enregistrer" data-testid={`memory-save-btn-${i}`}><Check size={16} /></button>
                </>
              ) : (
                <>
                  {fact.d && <span className="memory-date" data-testid={`memory-date-${i}`}>{fact.d}</span>}
                  <span className="memory-text">{fact.t}</span>
                  <button className="memory-icon-btn" onClick={() => startEdit(i)} title="Modifier" data-testid={`memory-edit-btn-${i}`}><Pencil size={15} /></button>
                  <button className="memory-icon-btn danger" onClick={() => removeItem(i)} title="Supprimer" data-testid={`memory-delete-btn-${i}`}><Trash2 size={15} /></button>
                </>
              )}
            </div>
          ))}
        </div>

        <div className="memory-foot">{items.length} / 30 souvenirs · Sauvegardé automatiquement sur cet appareil</div>

        <div className="local-mem-section" data-testid="local-memory-section">
          <div className="local-mem-title"><Database size={14} /> BASE LOCALE (SQLITE) — préférences & projets persistants</div>
          <div className="memory-add">
            <select
              className="local-mem-cat"
              value={localCat}
              onChange={(e) => setLocalCat(e.target.value)}
              data-testid="local-memory-category"
            >
              <option value="preference">Préférence</option>
              <option value="projet">Projet</option>
              <option value="souvenir">Souvenir</option>
            </select>
            <input
              className="cmd-input"
              type="text"
              value={localDraft}
              onChange={(e) => setLocalDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLocal(); } }}
              placeholder="Ex : Projet domotique salon / Préfère les réponses courtes"
              data-testid="local-memory-input"
            />
            <button className="cmd-send" onClick={addLocal} data-testid="local-memory-add-btn"><Plus size={16} /> Ajouter</button>
          </div>
          <div className="memory-list" data-testid="local-memory-list">
            {localFacts.length === 0 && (
              <div className="memory-empty">Aucun fait en base locale. Sirius y enregistre aussi automatiquement les nouveaux souvenirs de conversation.</div>
            )}
            {localFacts.map((f) => (
              <div className="memory-item" key={f.id} data-testid={`local-memory-item-${f.id}`}>
                <span className={`local-mem-badge ${f.category}`}>{f.category.toUpperCase()}</span>
                <span className="memory-text">{f.text}</span>
                <button className="memory-icon-btn danger" onClick={() => delLocal(f.id)} title="Supprimer" data-testid={`local-memory-delete-${f.id}`}><Trash2 size={15} /></button>
              </div>
            ))}
          </div>
        </div>

        {confirmMsg && (
          <div className="memory-confirm" data-testid="memory-confirm">
            <Check size={15} /> {confirmMsg}
          </div>
        )}
      </div>
    </div>
  );
}

// Pop-up holographique avec effet machine à écrire, fermé manuellement par l'utilisateur
function HoloPopup({ popup, onClose, onImage }) {
  const [shown, setShown] = useState("");
  const full = popup.contenu || "";
  useEffect(() => {
    let i = 0;
    const id = setInterval(() => {
      i += 2;
      setShown(full.slice(0, i));
      if (i >= full.length) clearInterval(id);
    }, 16);
    return () => clearInterval(id);
  }, [full]);
  const done = shown.length >= full.length;
  return (
    <div className={`holo-popup ${popup.kind === "memory" ? "memory" : ""}`} data-testid="holo-popup">
      <div className="hp-scan" />
      <div className="hp-head">
        {popup.kind === "memory" ? <Brain size={14} /> : <Activity size={14} />}
        <span>{popup.titre}</span>
        <button className="hp-close" onClick={onClose} data-testid="holo-popup-close" title="Fermer"><X size={14} /></button>
      </div>
      <div className="hp-body" data-testid="holo-popup-body">
        {popup.images && popup.images.length > 0 && (
          <div className="hp-images" data-testid="hp-images">
            {popup.images.map((im, i) => (
              <figure key={i} className="hp-img" onClick={() => onImage && onImage(im)} title="Agrandir l'archive">
                <img src={im.url} alt={im.legende || "archive"} loading="lazy" data-testid={`hp-image-${i}`} />
                {im.legende && <figcaption>{im.legende}{im.source ? ` — ${im.source}` : ""}</figcaption>}
              </figure>
            ))}
          </div>
        )}
        {shown}
        {!done && <span className="hp-caret">▋</span>}
      </div>
    </div>
  );
}

function HoloPopups({ popups, onClose, onImage }) {
  if (!popups.length) return null;
  return (
    <div className="holo-popups" data-testid="holo-popups">
      {popups.map((p) => (
        <HoloPopup key={p.id} popup={p} onClose={() => onClose(p.id)} onImage={onImage} />
      ))}
    </div>
  );
}

// Tableau analytique — performances en direct du pipeline vocal de Sirius
function AnalyticsPanel({ metrics, memoryCount, onClose }) {
  const fmtMs = (v) => (v != null ? `${v} ms` : "—");
  const rows = [
    {
      name: "STT", role: "Reconnaissance vocale", obj: "Réduire le temps de réaction initial",
      ok: metrics.stt.ms == null ? null : metrics.stt.ms < 6000,
      vals: [["Durée dernière écoute", fmtMs(metrics.stt.ms)], ["Confiance", metrics.stt.conf != null ? `${metrics.stt.conf} %` : "—"], ["Écoutes", metrics.stt.count]],
    },
    {
      name: "NLU", role: "Analyse d'intention", obj: "Éviter les faux positifs dans les commandes",
      ok: metrics.nlu.count === 0 ? null : true,
      vals: [["Dernière intention", metrics.nlu.intent], ["Commandes traitées", metrics.nlu.count]],
    },
    {
      name: "CONTEXTE", role: "Mémoire et historique", obj: "Conversation fluide sans répétition",
      ok: memoryCount < 30,
      vals: [["Souvenirs", `${memoryCount} / 30`], ["Échanges cette session", metrics.ctx.exchanges]],
    },
    {
      name: "PIPELINE", role: "Sélection de la réponse", obj: "Adapter la réponse en temps réel",
      ok: metrics.pipeline.apiMs == null ? null : metrics.pipeline.apiMs < 4000,
      vals: [["Aller-retour API", fmtMs(metrics.pipeline.apiMs)], ["Cerveau Kimi K3", fmtMs(metrics.pipeline.brainMs)], ["Recherche web", metrics.pipeline.search ? "OUI" : "NON"]],
    },
    {
      name: "TTS", role: "Synthèse vocale", obj: "Voix fluide et naturelle",
      ok: metrics.tts.latMs == null ? null : metrics.tts.latMs < 800,
      vals: [["Latence de la voix", fmtMs(metrics.tts.latMs)], ["Durée dernière réponse", metrics.tts.durMs != null ? `${(metrics.tts.durMs / 1000).toFixed(1)} s` : "—"], ["Réponses vocales", metrics.tts.count]],
    },
  ];
  return (
    <div className="setup-screen" data-testid="sirius-analytics-panel" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="setup-grid-bg" />
      <div className="setup-card analytics-modal">
        <button className="setup-close" onClick={onClose} data-testid="analytics-close-btn"><X size={18} /></button>
        <div className="setup-head">
          <BarChart3 size={22} />
          <div>
            <h2 className="setup-title">Tableau analytique</h2>
            <p className="setup-sub">Performances en direct du pipeline vocal. Se met à jour à chaque commande.</p>
          </div>
        </div>
        <div className="an-grid" data-testid="analytics-grid">
          {rows.map((r) => (
            <div className="an-row" key={r.name} data-testid={`analytics-row-${r.name.toLowerCase()}`}>
              <div className="an-row-head">
                <span className={`an-led ${r.ok == null ? "" : r.ok ? "ok" : "warn"}`} />
                <b>{r.name}</b>
                <span className="an-role">{r.role}</span>
              </div>
              <div className="an-vals">
                {r.vals.map(([k, v]) => (
                  <div className="an-val" key={k}><span>{k}</span><b>{v}</b></div>
                ))}
              </div>
              <div className="an-obj">Objectif : {r.obj}</div>
            </div>
          ))}
        </div>
        <div className="memory-foot">LED verte = nominal · orange = à surveiller · grise = pas encore de mesure</div>
      </div>
    </div>
  );
}

function MusicChoice({ query, onPick, onClose }) {  const [remember, setRemember] = useState(false);
  return (
    <div className="setup-screen" data-testid="sirius-music-choice" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="setup-grid-bg" />
      <div className="setup-card music-modal">
        <button className="setup-close" onClick={onClose} data-testid="music-close-btn"><X size={18} /></button>
        <div className="setup-head">
          <Music size={22} />
          <div>
            <h2 className="setup-title">Sur quoi je lance ça ?</h2>
            <p className="setup-sub">« {query} »</p>
          </div>
        </div>
        <div className="music-options">
          <button className="music-opt spotify" onClick={() => onPick("spotify", remember)} data-testid="music-pick-spotify">
            <Music size={26} /> Spotify
          </button>
          <button className="music-opt youtube" onClick={() => onPick("youtube", remember)} data-testid="music-pick-youtube">
            <Youtube size={26} /> YouTube
          </button>
        </div>
        <label className="music-remember" data-testid="music-remember">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Toujours utiliser ce service (ne plus me demander)
        </label>
      </div>
    </div>
  );
}

function Gauge({ label, value, accent, testid }) {
  const v = Math.round(value);
  return (
    <div className="gauge" data-testid={testid}>
      <div className="gauge-head">
        <span>{label}</span>
        <b>{v}%</b>
      </div>
      <div className="gauge-track">
        <div className="gauge-fill" style={{ width: `${v}%`, background: accent, boxShadow: `0 0 10px ${accent}` }} />
      </div>
    </div>
  );
}

function MiniBar({ label, v }) {
  return (
    <div className="mini-bar">
      <span>{label}</span>
      <div className="mini-bar-track">
        <div className="mini-bar-fill" style={{ width: `${v}%`, background: "var(--accent)", boxShadow: "0 0 8px var(--accent)" }} />
      </div>
      <b>{v}%</b>
    </div>
  );
}

function FloatingPanels({ weather }) {
  const w = weather ? weatherInfo(weather.code) : null;
  const WIcon = w ? w.Icon : Cloud;
  return (
    <div className="floating-panels" data-testid="floating-panels">
      <div className="float-card fc-tr" data-hud-panel data-testid="sirius-meteo">
        <div className="fc-head"><Thermometer size={13} /> MÉTÉO</div>
        {weather && Number.isFinite(weather.temp) ? (
          <div className="fc-weather">
            <WIcon size={26} />
            <div>
              <div className="fc-big">{weather.temp}°</div>
              <div className="fc-sub">{w.label}</div>
            </div>
          </div>
        ) : (
          <div className="fc-sub">Localisation...</div>
        )}
      </div>
    </div>
  );
}

function Ring({ label, v }) {
  const C = 2 * Math.PI * 42;
  return (
    <div className="cc-ring">
      <svg viewBox="0 0 100 100" width="86" height="86">
        <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="7" />
        <circle
          cx="50" cy="50" r="42" fill="none" stroke="var(--accent)" strokeWidth="7" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={C * (1 - v / 100)}
          transform="rotate(-90 50 50)"
          style={{ filter: "drop-shadow(0 0 6px var(--accent))", transition: "stroke-dashoffset 0.9s ease" }}
        />
        <text x="50" y="56" textAnchor="middle" fill="#eafaff" fontSize="22" fontFamily="Orbitron">{v}</text>
      </svg>
      <div className="cc-ring-label">{label}</div>
    </div>
  );
}

function CentralCard({ card, weather, onClose }) {
  const { cpu, ram } = useLiveStats();
  let title = "";
  let body = null;
  if (card.type === "time") {
    title = "HEURE LOCALE & UTC";
    body = <LiveClock variant="card" />;
  } else if (card.type === "date") {
    title = "DATE DU JOUR";
    body = <div className="cc-date"><LiveDate /></div>;
  } else if (card.type === "weather") {
    title = "MÉTÉO";
    if (weather) {
      const w = weatherInfo(weather.code);
      const WIcon = w.Icon;
      body = (
        <div className="cc-weather">
          <WIcon size={68} />
          <div className="cc-huge">{weather.temp}°C</div>
          <div className="cc-rows">
            <div><Wind size={14} /> {weather.wind} km/h</div>
            <div><MapPin size={14} /> {weather.city}</div>
            <div>{w.label}</div>
          </div>
        </div>
      );
    } else {
      body = <div className="cc-date">Localisation en cours...</div>;
    }
  } else if (card.type === "system") {
    title = "DIAGNOSTIC SYSTÈME";
    body = (
      <div className="cc-sys">
        <Ring label="CPU" v={Math.round(cpu)} />
        <Ring label="RAM" v={Math.round(ram)} />
        <Ring label="RÉSEAU" v={99} />
      </div>
    );
  } else if (card.type === "spotify") {
    title = card.playing ? "EN ÉCOUTE · SPOTIFY" : "EN PAUSE · SPOTIFY";
    body = (
      <div className="cc-spotify" data-testid="cc-spotify">
        {card.image && <img className="cc-cover" src={card.image} alt={card.album} />}
        <div className="cc-track-title">{card.title}</div>
        <div className="cc-track-artist">{card.artist}</div>
        {card.album && <div className="cc-track-album">{card.album}</div>}
      </div>
    );
  }
  return (
    <div className="central-card" data-testid="central-card" onClick={onClose}>
      <div className="cc-scan" />
      <div className="cc-head">
        <span>{title}</span>
        <X size={16} className="cc-close" />
      </div>
      <div className="cc-body">{body}</div>
    </div>
  );
}


function BootScreen({ onDone, userName, onOpenModule }) {
  const lines = [
    "> Initialisation du noyau S.I.R.I.U.S ...",
    "> Chargement des modules cognitifs ......... OK",
    "> Connexion aux capteurs système ........... OK",
    "> Calibration synthèse vocale .............. OK",
    "> Activation reconnaissance vocale ......... OK",
    "> Établissement liaison WebSocket .......... OK",
    "> Protocoles de sécurité ................... OK",
    userName ? `> Bienvenue, ${userName}. Système opérationnel.` : "> Système opérationnel.",
  ];
  const [shown, setShown] = useState(0);
  const [progress, setProgress] = useState(0);
  const [closing, setClosing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [speechDone, setSpeechDone] = useState(false);
  const speechStartedRef = useRef(false);
  const padRef = useRef(null);

  // Fondu de sortie de la nappe sonore
  const stopPad = () => {
    const pad = padRef.current;
    padRef.current = null;
    if (!pad) return;
    try {
      pad.master.gain.linearRampToValueAtTime(0, pad.ctx.currentTime + 0.6);
      setTimeout(() => { try { pad.ctx.close(); } catch (e) {} }, 700);
    } catch (e) { try { pad.ctx.close(); } catch (err) {} }
  };

  useEffect(() => {
    // Présentation vocale : voix française grave et posée, style bande-annonce
    // (équivalents français des mots de l'acronyme : mêmes initiales S.I.R.I.U.S,
    //  la voix française butait sur les mots anglais comme « Responsive »)
    // Garde anti-écho : une seule présentation vocale par chargement de page
    if (!window.__siriusBootSpoken) {
      window.__siriusBootSpoken = true;
      speakCinematic(
        "Système. Intelligent. Réactif. Interface. Universel. Sécurisé. " +
        "Je suis Sirius... façonné par mon créateur, Daniel Partel. " +
        "Sirius scanne tous ses services... " +
        "Tous mes services sont opérationnels... à votre disposition.",
        { onstart: () => { speechStartedRef.current = true; }, onend: () => setSpeechDone(true) }
      );
    } else {
      setSpeechDone(true);
    }
    // Nappe sonore cinématique discrète sous la voix (Web Audio, gratuite)
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      ctx.resume().catch(() => {});
      const master = ctx.createGain();
      master.gain.setValueAtTime(0, ctx.currentTime);
      master.gain.linearRampToValueAtTime(0.045, ctx.currentTime + 3);
      master.connect(ctx.destination);
      [[55, "sine", 0.6], [110.4, "triangle", 0.35], [220.8, "sine", 0.12]].forEach(([f, type, lvl]) => {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = f;
        const g = ctx.createGain();
        g.gain.value = lvl;
        o.connect(g); g.connect(master);
        o.start();
      });
      padRef.current = { ctx, master };
    } catch (e) {}
    // Sécurité : on ne bloque jamais plus de 16 s si la voix ne répond pas
    const safety = setTimeout(() => setSpeechDone(true), 16000);
    const step = 520;
    const dur = lines.length * step + 600;
    let i = 0;
    const lineTimer = setInterval(() => {
      i += 1;
      setShown(i);
      if (i >= lines.length) clearInterval(lineTimer);
    }, step);
    const start = Date.now();
    const progTimer = setInterval(() => {
      const p = Math.min(100, Math.round(((Date.now() - start) / dur) * 100));
      setProgress(p);
      if (p >= 100) { setLoaded(true); clearInterval(progTimer); }
    }, 40);
    return () => { clearInterval(lineTimer); clearInterval(progTimer); clearTimeout(safety); stopPad(); };
  }, [lines.length, onDone]);

// La présentation ne se ferme que lorsque le chargement ET le speech sont terminés
  useEffect(() => {
    if (loaded && speechDone && !closing) {
      setClosing(true);
      stopPad();
      setTimeout(onDone, 700);
    }
  }, [loaded, speechDone, closing]); // eslint-disable-line react-hooks/exhaustive-deps
  // Chargé à 100 % mais voix jamais démarrée (autoplay bloqué / onend muet) → fermeture après 2,5 s
  useEffect(() => {
    if (!loaded || speechDone) return;
    const t = setTimeout(() => { if (!speechStartedRef.current) setSpeechDone(true); }, 2500);
    return () => clearTimeout(t);
  }, [loaded, speechDone]);
  return (
    
    <div className={`boot-screen ${closing ? "closing" : ""}`} data-testid="boot-screen" onClick={() => { setClosing(true); stopPad(); setTimeout(onDone, 500); }}>
      <div className="boot-grid" />
      <div className="boot-scan" />
      <div className="boot-zeus" data-testid="boot-zeus">
        <img src="/holo/zeus-boot.jpg" alt="Zeus" draggable={false} />
        <div className="boot-zeus-caption font-divine">ZEUS · PANTHÉON#</div>
      </div>
      <div className="boot-modules" data-testid="boot-modules">
        <div className="boot-modules-title font-divine">Panthéon des Modules</div>
        {[
          ["argus", "ARGUS", "Surveillance & réparation"],
          ["atlas", "ATLAS", "Carte & navigation"],
          ["oracle", "ORACLE", "Divination des données"],
          ["heracles", "HERACLES", "Investigation"],
          ["hephaistos", "HÉPHAÏSTOS", "Forge & maintenance"],
          ["themis", "THÉMIS", "Gestion d'entreprise"],
          ["solon", "SOLON", "Conseil juridique"],
          ["promethee", "PROMÉTHÉE", "Gestion de projet"],
          ["calliope", "CALLIOPE", "Bibliothèque audio"],
          ["pythagore", "PYTHAGORE", "Mathématiques & géométrie"],
          ["agora", "HERMÈS AGORA", "Expert en vente"],
          ["nummarius", "PORTUS NUMMARIUS", "Bourse & marchés"],
          ["keraunos", "KERAUNOS", "Foudre domotique"],
          ["locus", "LOCUS", "Géolocalisation"],
          ["pantheon", "PANTHÉON", "Cœur du système"],
          ["cortex", "CORTEX", "Intelligence centrale"],
        ].map(([id, name, role], i) => (
          <div
            className="boot-module"
            key={id}
            role="button"
            tabIndex={0}
            style={{ animationDelay: `${0.9 + i * 0.28}s` }}
            data-testid={`boot-module-${id}`}
            onClick={(e) => {
              e.stopPropagation();
              setClosing(true); stopPad();
              setTimeout(() => { onDone(); onOpenModule && onOpenModule(id); }, 450);
            }}
          >
            <span className="boot-module-name font-divine">{name}</span>
            <span className="boot-module-role">{role}</span>
          </div>
        ))}
      </div>
      <div className="boot-center">
        <div className="boot-reactor" data-testid="boot-reactor">
          <div className="core-rings" aria-hidden="true">
            <img src="/holo/ring-gold.png" alt="" className="core-ring outer" draggable={false} />
            <img src="/holo/ring-gold.png" alt="" className="core-ring inner" draggable={false} />
            <div className="core-pulse" />
            <div className="core-orbit">
              {["Σ", "Δ", "Ω", "Θ", "Φ"].map((l, i) => (
                <span key={l} className="core-letter" style={{ "--i": i }}><i>{l}</i></span>
              ))}
            </div>
          </div>
          <ReactorCore status="thinking" volume={0.35} color="#22d3ee" eco={false} />
        </div>
        <h1 className="boot-title" data-testid="boot-title"><img src="/holo/sirius-title.png" alt="Σ.I.R.I.U.S" className="boot-title-img" draggable={false} /></h1>
        <div className="boot-acronym" data-testid="boot-acronym">
          {[["S", "System"], ["I", "Intelligent"], ["R", "Responsive"], ["I", "Interface"], ["U", "Universal"], ["S", "Secure"]].map(([l, w], i) => (
            <span className="boot-acro-item" key={i} style={{ animationDelay: `${0.5 + i * 0.22}s` }}>
              <b>{l}</b>
              <i>{w}</i>
            </span>
          ))}
        </div>
        <div className="boot-log">
          {lines.slice(0, shown).map((l, idx) => (
            <div key={idx} className="boot-line">{l}</div>
          ))}
        </div>
        <div className="boot-bar">
          <div className="boot-bar-fill" style={{ width: `${progress}%` }} />
        </div>
        <div className="boot-pct">{progress}%  —  cliquez pour passer</div>
      </div>
    </div>
  );
}

function Root() {
  const params = new URLSearchParams(window.location.search);
  if (params.has("spectateur")) return <SpectatorView />;
  if (params.has("overlay")) return <OverlayApp />;
  return <App />;
}

export default Root;