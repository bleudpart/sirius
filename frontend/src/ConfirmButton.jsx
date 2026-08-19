// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés.
// Bouton destructif à double confirmation : 1er clic = armer (3 s), 2e clic = exécuter.
import { useEffect, useState } from "react";

export function ConfirmButton({ onConfirm, className = "", title = "Supprimer", testId, children, label = "CONFIRMER ?" }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      className={`${className} ${armed ? "confirm-armed" : ""}`}
      title={armed ? label : title}
      onClick={(e) => { e.stopPropagation(); if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}
      data-testid={testId}
    >
      {armed ? <span className="confirm-txt">{label}</span> : children}
    </button>
  );
}
