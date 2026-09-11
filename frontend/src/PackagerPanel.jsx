// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useEffect, useState } from "react";
import { X, Package, Loader2, Download, FileCheck, Monitor, Smartphone, Apple, FileText, AlertTriangle } from "lucide-react";
import "./Packager.css";
import { progress } from "@/SiriusProgress";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const BACKEND = process.env.REACT_APP_BACKEND_URL || "";

const PLATFORM_ICONS = { windows: Monitor, android: Smartphone, iphone: Apple, docs: FileText };

export default function PackagerPanel({ onClose, onSpeak, autoInstaller = false }) {
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState(null);
  const [error, setError] = useState("");
  const [autoDone, setAutoDone] = useState(false);

  useEffect(() => {
    if (!autoInstaller || autoDone) return;
    setAutoDone(true);
    const a = document.createElement("a");
    a.href = `${BACKEND}/api/packager/installer`;
    a.download = "install_sirius.bat";
    document.body.appendChild(a);
    a.click();
    a.remove();
    onSpeak && onSpeak("Installateur universel ΣIRIUS téléchargé. Un seul script pour Windows, macOS, Linux, Android et iPhone.");
  }, [autoInstaller, autoDone, onSpeak]);

  const build = async () => {
    setBusy(true); setError(""); setOut(null);
    const pid = progress.start("PACKAGER — LIVRABLE MULTI-PLATEFORME");
    progress.log(pid, "Assemblage de la structure du package (Windows / Android / iPhone)", 30);
    try {
      const r = await fetch(`${API}/packager/build`, { method: "POST" });
      progress.log(pid, "Compression et intégration de l'icône officielle", 75);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { progress.error(pid, d.detail || "Génération impossible"); setError(d.detail || "Génération impossible."); setBusy(false); return; }
      setOut(d);
      progress.done(pid, "Package multi-plateforme généré");
      onSpeak && onSpeak("Package multi-plateforme généré. Windows, Android et iPhone prêts.");
    } catch (_) { progress.error(pid, "Backend injoignable"); setError("Backend injoignable."); }
    setBusy(false);
  };

  const p = out && out.parameters;

  return (
    <div className="prime-screen" data-testid="packager-panel">
      <header className="zeus-head">
        <div className="oracle-title font-divine"><Package size={20} /> PACKAGER# — LIVRABLE MULTI-PLATEFORME</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="packager-close-btn"><X size={18} /></button>
      </header>
      <div className="prime-sub">ZIP AUTO-EXTRACTIBLE · WINDOWS / ANDROID / IPHONE · ICÔNE OFFICIELLE INTÉGRÉE</div>

      <div className="argus-body">
        <section className="prime-card argus-wide">
          {!out && (
            <div className="pkg-intro">
              <p>Génère la structure complète du package d'installation ΣIRIUS# (3 plateformes, scripts d'auto-extraction, docs et icône officielle).</p>
              <button className="pkg-build" onClick={build} disabled={busy} data-testid="packager-build-btn">
                {busy ? <Loader2 size={15} className="spin" /> : <Package size={15} />} GÉNÉRER LE PACKAGE
              </button>
              <a className="pkg-download pkg-universal" href={`${BACKEND}/api/packager/installer`} download data-testid="packager-installer-btn">
                <Download size={15} /> INSTALLATEUR UNIVERSEL — install_sirius.bat
              </a>
              <div className="pkg-universal-hint">Windows · macOS · Linux · Android (Termux) · iPhone (iSH) — un seul script autonome.</div>
            </div>
          )}

          {error && <div className="pkg-error" data-testid="packager-error">{error}</div>}

          {out && (
            <div className="pkg-result" data-testid="packager-result">
              <div className="pkg-head">
                <FileCheck size={18} />
                <span>{out.responseText}</span>
                <span className="pkg-size">{(p.sizeBytes / 1048576).toFixed(1)} Mo · {p.generatedAt}</span>
              </div>

              <div className="pkg-platforms">
                {Object.entries(p.platforms).map(([k, v]) => {
                  const Icon = PLATFORM_ICONS[k] || FileText;
                  return (
                    <div key={k} className="pkg-plat" data-testid={`packager-plat-${k}`}>
                      <Icon size={16} />
                      <span className="pkg-plat-name">{k}</span>
                      <span className="pkg-plat-status">{v.toUpperCase()}</span>
                    </div>
                  );
                })}
                <div className="pkg-plat pkg-icon">
                  <FileCheck size={16} /><span className="pkg-plat-name">icône</span>
                  <span className="pkg-plat-status">{p.icon.toUpperCase()}</span>
                </div>
              </div>

              <div className="pkg-tree" data-testid="packager-tree">
                {Object.entries(p.tree).map(([folder, files]) => {
                  const key = folder.replace("SIRIUS_INSTALLER/", "").replace("/", "");
                  const Icon = PLATFORM_ICONS[key] || FileText;
                  return (
                    <div key={folder} className="pkg-folder">
                      <div className="pkg-folder-name"><Icon size={13} /> {folder}</div>
                      <ul>{files.map((f) => <li key={f}>{f}</li>)}</ul>
                    </div>
                  );
                })}
              </div>

              <div className="pkg-note" data-testid="packager-note">
                <AlertTriangle size={14} /> {p.note}
              </div>

              <a className="pkg-download" href={`${BACKEND}${p.downloadUrl}`} download data-testid="packager-download-btn">
                <Download size={15} /> TÉLÉCHARGER SIRIUS_INSTALLER.zip
              </a>
              <a className="pkg-download pkg-universal" href={`${BACKEND}/api/packager/installer`} download data-testid="packager-installer-btn-result">
                <Download size={15} /> INSTALLATEUR UNIVERSEL — install_sirius.bat
              </a>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
