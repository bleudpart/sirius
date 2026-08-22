// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useCallback, useEffect, useRef, useState } from "react";
import { X, Fingerprint, Search, Loader2, ExternalLink, ShieldAlert, AtSign, Phone, User, Globe, FileDown, Boxes } from "lucide-react";
import "./Heracles.css";
import MythosBackdrop from "@/MythosBackdrop";
import useDraggableCards from "@/useDraggableCards";
import Analysis3D from "@/Analysis3D";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";

const TYPE_META = {
  username: { icon: Globe, label: "PSEUDO" },
  email: { icon: AtSign, label: "EMAIL" },
  phone: { icon: Phone, label: "TÉLÉPHONE" },
  name: { icon: User, label: "NOM" },
};

export default function HeraclesPanel({ onClose, onSpeak, initialInput }) {
  const [char, setChar] = useState(null);
  useEffect(() => {
    fetch((process.env.REACT_APP_BACKEND_URL || "") + "/api/mythos/characters")
      .then(r => r.json())
      .then(d => {
        const p = d.characters.find(c => c.module === "HERACLES#");
        setChar(p);
      });
  }, []);
  const [input, setInput] = useState(initialInput || "");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState(null);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [show3D, setShow3D] = useState(false);
  const ranRef = useRef(false);

  const investigate = useCallback(async (val) => {
    const v = (val || "").trim();
    if (!v) { setError("Identifiant vide — pseudo, email, numéro ou nom."); return; }
    setBusy(true); setError(""); setOut(null);
    try {
      const r = await fetch(`${API}/heracles/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: v }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.detail || "Investigation impossible."); setBusy(false); return; }
      setOut(d);
      onSpeak && onSpeak(d.responseText + " " + (d.result && d.result.summary ? d.result.summary : ""));
    } catch (_) { setError("Backend injoignable."); }
    setBusy(false);
  }, [onSpeak]);

  useEffect(() => {
    if (initialInput && !ranRef.current) { ranRef.current = true; investigate(initialInput); }
  }, [initialInput, investigate]);

  const exportPdf = useCallback(async () => {
    if (!out) return;
    setExporting(true);
    try {
      const r = await fetch(`${API}/heracles/pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload: out }),
      });
      if (!r.ok) { setError("Export PDF impossible."); setExporting(false); return; }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `OSINT_${(out.parameters.input || "rapport").replace(/[^\w-]+/g, "_").slice(0, 40)}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      onSpeak && onSpeak("Rapport OSINT exporté en PDF.");
    } catch (_) { setError("Backend injoignable."); }
    setExporting(false);
  }, [out, onSpeak]);

  const res = out && out.result;
  const p = out && out.parameters;
  const TypeIcon = p ? (TYPE_META[p.inputType] || {}).icon : null;

  const dragRef = useDraggableCards([]);

  return (
    <div className="prime-screen" data-testid="heracles-panel" ref={dragRef}>
      <MythosBackdrop module="HERACLES#" state={busy ? "busy" : error ? "alert" : "idle"} />
      <header className="zeus-head">
        <div className="oracle-title font-divine"><Fingerprint size={20} /> HERACLES# — INVESTIGATION OSINT</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="heracles-close-btn"><X size={18} /></button>
      </header>
      {char && (
        <img
          src={char.image}
          alt={char.character}
          className="mythos-avatar"
        />
      )}
      <div className="prime-sub">DONNÉES PUBLIQUES · PSEUDO / EMAIL / TÉLÉPHONE / NOM · RIEN N'EST STOCKÉ</div>

      <div className="argus-body">
        <section className="prime-card argus-wide">
          <div className="her-searchrow">
            <input
              className="vision-question her-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") investigate(input); }}
              placeholder="@pseudo · email@domaine.com · +33 6 12 34 56 78 · Prénom Nom"
              data-testid="heracles-input"
            />
            <button className="her-go" onClick={() => investigate(input)} disabled={busy} data-testid="heracles-check-btn">
              {busy ? <Loader2 size={14} className="spin" /> : <Search size={14} />} ENQUÊTER
            </button>
          </div>

          {error && <div className="her-error" data-testid="heracles-error">{error}</div>}

          {res && (
            <div className="her-result" data-testid="heracles-result">
              <div className="her-typebadge" data-testid="heracles-type">
                {TypeIcon && <TypeIcon size={13} />} {(TYPE_META[p.inputType] || {}).label} · <b>{p.input}</b>
                <button className="her-pdf" onClick={exportPdf} disabled={exporting} data-testid="heracles-pdf-btn" title="Exporter le rapport en PDF">
                  {exporting ? <Loader2 size={12} className="spin" /> : <FileDown size={12} />} RAPPORT PDF
                </button>
                <button className="her-pdf" onClick={() => setShow3D(true)} data-testid="heracles-3d-btn" title="Projection 3D du rapport">
                  <Boxes size={12} /> VUE 3D
                </button>
              </div>
              <div className="her-summary">{res.summary}</div>

              {res.type === "username" && (
                <div className="her-grid" data-testid="heracles-platforms">
                  {res.results.map((it) => (
                    <a key={it.platform} className={`her-plat ${it.status}`} href={it.url} target="_blank" rel="noreferrer" data-testid={`heracles-plat-${it.platform}`}>
                      <span className="her-plat-name">{it.label}</span>
                      <span className={`her-plat-status ${it.status}`}>
                        {it.status === "trouvé" ? "TROUVÉ" : it.status === "absent" ? "ABSENT" : "INCERTAIN"}
                      </span>
                      <ExternalLink size={11} />
                    </a>
                  ))}
                </div>
              )}

              {res.type === "email" && (
                <div className="her-fields" data-testid="heracles-email">
                  <div><span>FORMAT</span><b className={res.validFormat ? "ok" : "bad"}>{res.validFormat ? "VALIDE" : "INVALIDE"}</b></div>
                  <div><span>DOMAINE</span><b>{res.domain}</b></div>
                  <div><span>MX (reçoit des mails)</span><b className={res.hasMX ? "ok" : "bad"}>{res.hasMX ? "OUI" : "NON"}</b></div>
                  <div><span>JETABLE</span><b className={res.disposable ? "bad" : "ok"}>{res.disposable ? "OUI" : "NON"}</b></div>
                  {res.mxRecords && res.mxRecords.length > 0 && (
                    <div className="her-mx"><span>SERVEURS MX</span><code>{res.mxRecords.join(", ")}</code></div>
                  )}
                </div>
              )}

              {res.type === "phone" && (
                <div className="her-fields" data-testid="heracles-phone">
                  <div><span>VALIDITÉ</span><b className={res.valid ? "ok" : "bad"}>{res.valid ? "VALIDE" : "INVALIDE"}</b></div>
                  {res.international && <div><span>FORMAT INTL</span><b>{res.international}</b></div>}
                  {res.region && <div><span>RÉGION</span><b>{res.region}</b></div>}
                  {res.lineType && <div><span>TYPE</span><b>{res.lineType}</b></div>}
                  {res.carrier && res.carrier !== "—" && <div><span>OPÉRATEUR</span><b>{res.carrier}</b></div>}
                </div>
              )}

              {res.type === "name" && (
                <div className="her-grid" data-testid="heracles-name">
                  {res.links.map((l) => (
                    <a key={l.label} className="her-plat" href={l.url} target="_blank" rel="noreferrer" data-testid={`heracles-link-${l.label.toLowerCase()}`}>
                      <span className="her-plat-name">{l.label}</span>
                      <ExternalLink size={11} />
                    </a>
                  ))}
                </div>
              )}

              <details className="her-intent">
                <summary>INTENT JSON — heracles.check</summary>
                <pre data-testid="heracles-intent-json">{JSON.stringify({
                  responseText: out.responseText, intent: out.intent,
                  parameters: out.parameters, requiresConfirmation: out.requiresConfirmation,
                }, null, 2)}</pre>
              </details>
            </div>
          )}

          <div className="her-disclaimer" data-testid="heracles-disclaimer">
            <ShieldAlert size={13} /> {out ? out.disclaimer : "Ce module analyse uniquement des données publiques. Utilisation réservée aux démarches légitimes, conformes à la loi et au respect de la vie privée."}
          </div>
        </section>
      </div>
      {show3D && res && (
        <Analysis3D
          title={`OSINT · ${(p && p.input) || ""}`}
          text={`${res.summary || ""}\n\n${out && out.responseText ? out.responseText : ""}`}
          onClose={() => setShow3D(false)}
        />
      )}
    </div>
  );
}
