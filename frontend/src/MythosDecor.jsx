// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
// Éléments antiques décoratifs de MYTHOS : colonne ionique (gauche) + amphore grecque (droite).
// Vectoriels, teintés à la couleur du module, semi-transparents et non intrusifs.

// Colonne ionique : chapiteau à volutes, fût cannelé, base.
export function IonicColumn({ color, opacity = 0.2 }) {
  return (
    <svg className="mythos-column" viewBox="0 0 80 400" preserveAspectRatio="xMidYMax meet"
         style={{ opacity }} aria-hidden="true" data-testid="mythos-column">
      <g fill="none" stroke={color} strokeWidth="2" strokeLinecap="round">
        {/* Chapiteau + volutes */}
        <path d="M8 40 h64" />
        <path d="M12 40 c-6 0 -8 -14 2 -14 c9 0 9 12 2 12" />
        <path d="M68 40 c6 0 8 -14 -2 -14 c-9 0 -9 12 -2 12" />
        <rect x="18" y="40" width="44" height="10" />
        {/* Fût cannelé */}
        <line x1="40" y1="50" x2="40" y2="360" />
        <line x1="30" y1="52" x2="30" y2="358" strokeWidth="1.2" />
        <line x1="50" y1="52" x2="50" y2="358" strokeWidth="1.2" />
        <line x1="22" y1="56" x2="22" y2="354" strokeWidth="1" opacity="0.7" />
        <line x1="58" y1="56" x2="58" y2="354" strokeWidth="1" opacity="0.7" />
        {/* Base */}
        <rect x="16" y="360" width="48" height="12" />
        <rect x="10" y="372" width="60" height="14" />
      </g>
    </svg>
  );
}

// Amphore grecque : panse, deux anses, col et pied + eau animée réactive à l'état du module.
// state : "idle" (normal) · "busy" (chargement → écoulement rapide) · "alert" (alerte → eau rouge, rapide).
export function GreekAmphora({ color, opacity = 0.2, state = "idle" }) {
  const waterColor = state === "alert" ? "#ff3b3b" : color;
  const streamDur = state === "busy" ? "0.45s" : state === "alert" ? "0.6s" : "1.1s";
  const dropDur = state === "busy" ? "0.85s" : state === "alert" ? "1s" : "1.6s";
  return (
    <svg className="mythos-jug" viewBox="0 0 160 320" preserveAspectRatio="xMidYMax meet"
         style={{ opacity }} aria-hidden="true" data-testid="mythos-jug">
      <g fill="none" stroke={color} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round">
        {/* Col */}
        <path d="M62 20 h36" />
        <path d="M64 20 c-2 12 -4 18 -6 26" />
        <path d="M96 20 c2 12 4 18 6 26" />
        {/* Anses */}
        <path d="M58 30 c-24 4 -26 34 -6 40" />
        <path d="M102 30 c24 4 26 34 6 40" />
        {/* Panse */}
        <path d="M58 46 c-30 22 -34 78 -14 116 c14 26 58 26 72 0 c20 -38 16 -94 -14 -116" />
        {/* Bandeau de motif */}
        <path d="M46 120 h68" strokeWidth="1.4" opacity="0.8" />
        <path d="M46 134 h68" strokeWidth="1.4" opacity="0.8" />
        {/* Pied */}
        <path d="M66 196 l-6 22 h40 l-6 -22" />
        <rect x="56" y="218" width="48" height="10" />
      </g>

      {/* Eau qui s'écoule (jet + gouttes) — vitesse et couleur selon l'état */}
      <g className={`mythos-water state-${state}`} stroke={waterColor} fill={waterColor}
         data-testid={`mythos-water-${state}`}>
        <path className="mw-stream" d="M80 46 q-4 40 2 80 q5 34 -2 66 q-4 26 2 44"
              fill="none" strokeWidth="3" strokeLinecap="round" style={{ animationDuration: streamDur }} />
        <circle className="mw-drop mw-drop1" cx="80" cy="240" r="3" style={{ animationDuration: dropDur }} />
        <circle className="mw-drop mw-drop2" cx="78" cy="240" r="2.2" style={{ animationDuration: dropDur }} />
        <circle className="mw-drop mw-drop3" cx="82" cy="240" r="2.6" style={{ animationDuration: dropDur }} />
      </g>
    </svg>
  );
}
