import { loadApiKeys } from "@/apiKeyStorage";
// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useEffect, useState } from "react";
import { X, Volume2, ArrowRight } from "lucide-react";import { speakAsCharacter, cancelSpeech, CHAR_PROFILES } from "@/voice";
import "./MythosGallery.css";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";

// Timbre vocal unique par personnage — profils Mythos stricts (définis dans voice.js, ajustables dans la configuration VOIX)
const CHAR_VOICES = Object.fromEntries(Object.keys(CHAR_PROFILES).map((m) => [m, { module: m }]));

const COLOR_HEX = {
  "bleu froid": "#38bdf8",
  "doré": "#f0be50",
  "violet": "#a855f7",
  "sépia": "#b48c5f",
  "rouge": "#f43f5e",
  "blanc/or": "#f5e6b0",
};

const CONSULT_SPEAK = {
  "SOLON#": { start: "J'examine ton dossier.", done: "Voici mon avis : faits, droit, analyse, options. Tout est à l'écran." },
  "PROMÉTHÉE#": { start: "J'étudie ton projet.", done: "Voici ton plan : objectif, jalons, risques, actions. Tout est à l'écran." },
  "HERMÈS AGORA#": { start: "J'analyse ton marché.", done: "Voici ton plan de vente : contexte, analyse, stratégie, actions. Tout est à l'écran." },
};

const DETAIL_TABS = [
  { id: "presentation", label: "PRÉSENTATION" },
  { id: "biographie", label: "BIOGRAPHIE" },
  { id: "capacites", label: "CAPACITÉS" },
];

export default function MythosGallery({ onClose, onOpenModule, initialModule = null }) {
  const [chars, setChars] = useState([]);
  const [active, setActive] = useState(null);
  const [tab, setTab] = useState("presentation");
  const [consultQ, setConsultQ] = useState("");
  const [consultA, setConsultA] = useState("");
  const [consulting, setConsulting] = useState(false);

  useEffect(() => {
    fetch(`${API}/mythos/characters`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && d.characters) {
          setChars(d.characters);
          const first = (initialModule && d.characters.find((c) => c.module === initialModule)) || d.characters[0];
          setActive(first);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sel = active;
  const selColor = sel ? (COLOR_HEX[sel.style.color] || "#91e6f2") : "#91e6f2";

  // Chaque personnage se présente avec son propre timbre à l'ouverture de sa fiche
  useEffect(() => {
    if (!active) return;
    cancelSpeech();
    setConsultQ(""); setConsultA(""); setConsulting(false);
    setTab("presentation");
    const t = setTimeout(() => speakAsCharacter(active.voiceIntro, CHAR_VOICES[active.module] || {}), 300);
    return () => clearTimeout(t);
  }, [active]);
  useEffect(() => () => cancelSpeech(), []);

  return (
    <div className="prime-screen mythos-gallery" data-testid="mythos-gallery">
      <header className="zeus-head">
        <div className="oracle-title font-divine"><img src="/holo/logo-mythos.png" alt="" className="th-logo" data-testid="mythos-logo" /> PANTHÉON ΣIRIUS — GALERIE MYTHOS</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="mythos-gallery-close-btn"><X size={18} /></button>
      </header>
      <div className="prime-sub">LES IDENTITÉS MYTHOLOGIQUES DES MODULES ΣIRIUS#</div>

      <div className="mg-body">
        {/* Rangée de vignettes */}
        <div className="mg-thumbs" data-testid="mythos-gallery-thumbs">
          {chars.map((c) => {
            const col = COLOR_HEX[c.style.color] || "#91e6f2";
            const on = sel && sel.module === c.module;
            return (
              <button
                key={c.module}
                className={`mg-thumb ${on ? "active" : ""}`}
                onClick={() => setActive(c)}
                data-testid={`mythos-thumb-${c.module.replace("#", "").toLowerCase()}`}
                style={{ "--c": col }}
              >
                <div className="mg-thumb-img" style={{ boxShadow: on ? `0 0 22px ${col}66` : "none" }}>
                  <img src={c.image} alt={c.character} draggable={false} />
                </div>
                <span className="mg-thumb-module">{c.module}</span>
                <span className="mg-thumb-name">{c.character}</span>
              </button>
            );
          })}
        </div>

        {/* Fiche détaillée du personnage sélectionné */}
        {sel && (
          <div className="mg-detail" data-testid="mythos-gallery-detail" style={{ "--c": selColor }}>
            <div className="mg-detail-visual">
              <img src={sel.image} alt={sel.character} className="mg-detail-img" draggable={false}
                   style={{ filter: `drop-shadow(0 0 34px ${selColor}88)` }} />
            </div>
            <div className="mg-detail-info">
              <div className="mg-detail-module">{sel.module}</div>
              <h2 className="mg-detail-name" style={{ color: selColor }}>{sel.character}</h2>
              <button className="mg-speak" onClick={() => { cancelSpeech(); speakAsCharacter(sel.voiceIntro, CHAR_VOICES[sel.module] || {}); }} data-testid="mythos-speak-btn">
                <Volume2 size={13} /> ENTENDRE
              </button>
              {onOpenModule && sel.column && sel.column.enabled && (
                <button className="mg-open" onClick={() => onOpenModule(sel.module)} data-testid="mythos-open-module-btn"
                        style={{ borderColor: selColor, color: selColor }}>
                  OUVRIR LE MODULE {sel.module} <ArrowRight size={13} />
                </button>
              )}
              <p className="mg-detail-intro">« {sel.voiceIntro} »</p>
              <div className="mg-tabs" data-testid="mythos-tabs">
                {DETAIL_TABS.map((t) => (
                  <button
                    key={t.id}
                    className={`mg-tab ${tab === t.id ? "active" : ""}`}
                    style={{ "--c": selColor }}
                    onClick={() => setTab(t.id)}
                    data-testid={`mythos-tab-${t.id}`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {tab === "presentation" && <p className="mg-detail-desc" data-testid="mythos-detail-desc">{sel.details}</p>}
              {tab === "biographie" && <p className="mg-detail-desc mg-bio" data-testid="mythos-detail-bio">{sel.bio || sel.details}</p>}
              {tab === "capacites" && (
                <div className="mg-caps" data-testid="mythos-detail-caps">
                  {(sel.capacites || []).map((c) => (
                    <span key={c} className="mg-cap" style={{ "--c": selColor }}>{c}</span>
                  ))}
                </div>
              )}
              {sel.consult && (
                <div className="mg-consult" data-testid="mythos-consult">
                  <textarea
                    className="mg-consult-input"
                    rows={3}
                    placeholder={sel.consult.placeholder}
                    value={consultQ}
                    onChange={(e) => setConsultQ(e.target.value)}
                    data-testid="mythos-consult-input"
                  />
                  <button
                    className="mg-open"
                    style={{ borderColor: selColor, color: selColor }}
                    disabled={consulting || !consultQ.trim()}
                    data-testid="mythos-consult-btn"
                    onClick={async () => {
                      setConsulting(true); setConsultA("");
                      cancelSpeech();
                      speakAsCharacter((CONSULT_SPEAK[sel.module] || CONSULT_SPEAK["PROMÉTHÉE#"]).start, CHAR_VOICES[sel.module] || {});
                      try {
                        let keys = {};
                        keys = loadApiKeys();
                        const r = await fetch(`${API}/mythos/consult`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ module: sel.module, question: consultQ, keys }) });
                        const d = await r.json().catch(() => ({}));
                        if (r.ok && d.reponse) {
                          setConsultA(d.reponse);
                          speakAsCharacter((CONSULT_SPEAK[sel.module] || CONSULT_SPEAK["PROMÉTHÉE#"]).done, CHAR_VOICES[sel.module] || {});
                        } else {
                          setConsultA(typeof d.detail === "string" ? d.detail : "Consultation impossible pour le moment.");
                        }
                      } catch (e) { setConsultA("Consultation impossible — backend injoignable."); }
                      setConsulting(false);
                    }}
                  >
                    {consulting ? "ANALYSE EN COURS…" : sel.consult.action} <ArrowRight size={13} />
                  </button>
                  {consultA && <pre className="mg-consult-answer" data-testid="mythos-consult-answer">{consultA}</pre>}
                </div>
              )}
              <div className="mg-detail-style">
                <span><b>Couleur</b> {sel.style.color}</span>
                <span><b>Texture</b> {sel.style.texture}</span>
                <span><b>Posture</b> {sel.style.position}</span>
              </div>
              <p className="mg-detail-silhouette">{sel.style.silhouette}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
