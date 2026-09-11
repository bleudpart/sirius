// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { X } from "lucide-react";
import "./About.css";

export default function AboutPanel({ onClose }) {
  return (
    <div className="about-panel" data-testid="about-panel">
      <button className="about-close" onClick={onClose} data-testid="about-close-btn"><X size={14} /></button>
      <h2 className="about-title">À propos de ΣIRIUS Assistant</h2>
      <p className="about-text">
        ΣIRIUS Assistant est un logiciel propriétaire développé par Daniel Partel.
        © 2026 – Tous droits réservés.
      </p>
    </div>
  );
}
