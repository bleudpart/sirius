// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useEffect, useRef, useState } from "react";
import { speakAsCharacter } from "@/voice";
import { IonicColumn, GreekAmphora } from "@/MythosDecor";
import "./Mythos.css";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";

const COLOR_GLOW = {
  "bleu froid": "rgba(56,189,248,0.55)",
  "doré": "rgba(240,190,80,0.55)",
  "violet": "rgba(168,85,247,0.55)",
  "sépia": "rgba(180,140,95,0.55)",
  "rouge": "rgba(244,63,94,0.55)",
  "blanc/or": "rgba(255,240,200,0.55)",
};
const COLOR_HEX = {
  "bleu froid": "#38bdf8", "doré": "#f0be50", "violet": "#a855f7",
  "sépia": "#b48c5f", "rouge": "#f43f5e", "blanc/or": "#f5e6b0",
};

// Silhouette mythologique + colonne ionique (gauche) + amphore grecque (droite), à la manière de CORTEX#.
// Le personnage se présente vocalement à l'ouverture du module (désactivable).
export default function MythosBackdrop({ module, state = "idle" }) {
  const [char, setChar] = useState(null);
  const spokenRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/mythos/character/${encodeURIComponent(module)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d || !d.parameters) return;
        setChar(d.parameters);
        const introsOn = localStorage.getItem("sirius_mythos_intro") !== "0";
        if (introsOn && d.parameters.voiceIntro && !spokenRef.current) {
          spokenRef.current = true;
          setTimeout(() => speakAsCharacter(d.parameters.voiceIntro, { module }), 450);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [module]);

  if (!char) return null;
  const glow = COLOR_GLOW[char.style.color] || "rgba(145,230,242,0.5)";
  const hex = COLOR_HEX[char.style.color] || "#91e6f2";
  const column = char.column;
  const jug = char.jug;

  return (
    <div className="mythos-backdrop" data-testid={`mythos-backdrop-${char.module.replace("#", "").toLowerCase()}`} aria-hidden="true">
      {column && column.enabled && (
        <div className="mythos-decor-left">
          <IonicColumn color={hex} opacity={column.opacity} />
        </div>
      )}
      <img
        src={char.image}
        alt=""
        className={`mythos-silhouette ${(char.style.opacity || 0) >= 0.9 ? "solid" : ""}`}
        draggable={false}
        style={{
          "--o": char.style.opacity,
          opacity: char.style.opacity,
          filter: (char.style.opacity || 0) >= 0.9
            ? "drop-shadow(0 26px 44px rgba(0, 0, 0, 0.65))"
            : `drop-shadow(0 0 30px ${glow})`,
        }}
        title={char.details}
      />
      {jug && jug.enabled && (
        <div className="mythos-decor-right">
          <GreekAmphora color={hex} opacity={jug.opacity} state={state} />
        </div>
      )}
      <span className="mythos-name" style={{ color: glow.replace("0.55", "0.5") }}>{char.character}</span>
    </div>
  );
}
