// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  X, AppWindow, ScanText, Link2, BellRing, LayoutDashboard, History,
  Loader2, Camera, XCircle,
} from "lucide-react";
import MythosBackdrop from "@/MythosBackdrop";
import useDraggableCards from "@/useDraggableCards";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";

function Stars() {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current;
    const x = c.getContext("2d");
    let raf, running = true, t = 0;
    const resize = () => { c.width = window.innerWidth; c.height = window.innerHeight; };
    resize();
    window.addEventListener("resize", resize);
    const COLORS = ["255,150,40", "255,205,90", "0,220,255", "170,80,255", "255,255,255"];
    const stars = Array.from({ length: 130 }, () => ({
      x: Math.random(), y: Math.random(),
      r: Math.random() < 0.12 ? 1.6 + Math.random() * 1.6 : 0.4 + Math.random() * 1,
      c: COLORS[Math.floor(Math.random() * COLORS.length)],
      a: 0.15 + Math.random() * 0.45, tw: 0.6 + Math.random() * 2, ph: Math.random() * Math.PI * 2,
    }));
    const loop = () => {
      if (!running) return;
      t += 0.016;
      x.clearRect(0, 0, c.width, c.height);
      stars.forEach((s) => {
        const tw = 0.55 + 0.45 * Math.sin(t * s.tw + s.ph);
        x.fillStyle = `rgba(${s.c},${(s.a * tw).toFixed(3)})`;
        x.beginPath();
        x.arc(s.x * c.width, s.y * c.height, s.r, 0, Math.PI * 2);
        x.fill();
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { running = false; cancelAnimationFrame(raf); window.removeEventListener("resize", resize); };
  }, []);
  return <canvas ref={ref} className="prime-stars" />;
}

export default function PantheonSystem({ onClose, keys }) {
  const [procs, setProcs] = useState([]);
  const [services, setServices] = useState([]);
  const [history, setHistory] = useState([]);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrResult, setOcrResult] = useState("");
  const [ocrError, setOcrError] = useState("");
  const [notif, setNotif] = useState(() => {
    try { return JSON.parse(localStorage.getItem("sirius_notif")) || { whatsapp: false, waNum: "", waKey: "" }; }
    catch { return { whatsapp: false, waNum: "", waKey: "" }; }
  });
  const [waTest, setWaTest] = useState({ busy: false, msg: "", ok: false });

  const saveNotif = (n) => { setNotif(n); localStorage.setItem("sirius_notif", JSON.stringify(n)); };

  const sendWaTest = async () => {
    if (!notif.waNum.trim() || !notif.waKey.trim()) {
      setWaTest({ busy: false, ok: false, msg: "Renseignez le numéro et la clé CallMeBot." });
      return;
    }
    setWaTest({ busy: true, msg: "", ok: false });
    try {
      const r = await fetch(`${API}/notify/whatsapp`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: notif.waNum.trim(), apikey: notif.waKey.trim(), text: "✅ ΣIRIUS — liaison WhatsApp opérationnelle. Les alertes Alpha Vantage vous seront transmises ici." }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setWaTest({ busy: false, ok: false, msg: d.detail || "Envoi refusé." }); return; }
      setWaTest({ busy: false, ok: true, msg: "Message de test envoyé — vérifiez votre WhatsApp." });
    } catch {
      setWaTest({ busy: false, ok: false, msg: "Backend injoignable." });
    }
  };

  const load = useCallback(async () => {
    try {
      const [w, cvt, h] = await Promise.all([
        fetch(`${API}/pantheon/windows`).then((r) => r.json()),
        fetch(`${API}/pantheon/connectivity`).then((r) => r.json()),
        fetch(`${API}/pantheon/history`).then((r) => r.json()),
      ]);
      setProcs(w.processes || []);
      setServices(cvt.services || []);
      setHistory(h.log || []);
    } catch {}
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [load]);

  const killProc = async (pid) => {
    try { await fetch(`${API}/pantheon/process/${pid}`, { method: "DELETE" }); } catch {}
    load();
  };

  const runOcr = async () => {
    if (ocrBusy) return;
    setOcrError(""); setOcrResult("");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = stream.getVideoTracks()[0];
      const video = document.createElement("video");
      video.srcObject = stream;
      await video.play();
      await new Promise((res) => setTimeout(res, 400));
      const scale = Math.min(1, 1280 / video.videoWidth);
      const cv = document.createElement("canvas");
      cv.width = video.videoWidth * scale;
      cv.height = video.videoHeight * scale;
      cv.getContext("2d").drawImage(video, 0, 0, cv.width, cv.height);
      track.stop();
      const b64 = cv.toDataURL("image/jpeg", 0.75).split(",")[1];
      setOcrBusy(true);
      const r = await fetch(`${API}/pantheon/ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: b64, keys: keys || {} }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || "Erreur serveur");
      setOcrResult(data.result || "");
      load();
    } catch (e) {
      setOcrError(e.message === "Permission denied" ? "Capture refusée." : (e.message || "Capture impossible."));
    } finally {
      setOcrBusy(false);
    }
  };

  const dragRef = useDraggableCards([]);

  return (
    <div className="prime-screen" data-testid="pantheon-panel" ref={dragRef}>
      <MythosBackdrop module="PANTHÉON#" />
      <Stars />
      <header className="zeus-head">
        <div className="oracle-title font-divine"><img src="/holo/logo-pantheon.png" alt="" className="th-logo" data-testid="pantheon-logo" /> PANTHEON SYSTEM</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="pantheon-close-btn"><X size={18} /></button>
      </header>
      <div className="prime-sub">CENTRE DE CONNECTIVITÉ — SERVICES, FENÊTRES &amp; ALERTES</div>

      <div className="prime-grid">
        {/* Fenêtres actives */}
        <section className="prime-card" data-testid="pantheon-windows">
          <div className="zc-section-title"><AppWindow size={12} style={{ marginRight: 6 }} />CONTRÔLE DES FENÊTRES ACTIVES</div>
          <div className="prime-scroll" style={{ maxHeight: 230 }}>
            {procs.map((p) => (
              <div className="pantheon-proc-row" key={p.pid}>
                <span className="pantheon-proc-name">{p.name}</span>
                <span className="pantheon-proc-meta">PID {p.pid} · {p.mem}% RAM · {p.status}</span>
                <button className="memory-icon-btn danger" title="Terminer" onClick={() => killProc(p.pid)} data-testid={`pantheon-kill-${p.pid}`}><XCircle size={14} /></button>
              </div>
            ))}
            {procs.length === 0 && <div className="memory-empty">Lecture des processus...</div>}
          </div>
        </section>

        {/* OCR */}
        <section className="prime-card" data-testid="pantheon-ocr">
          <div className="zc-section-title"><ScanText size={12} style={{ marginRight: 6 }} />OCR &amp; CAPTURE D'ÉCRAN</div>
          <p className="pantheon-hint">Capture l'écran de votre choix puis extrait le texte visible avec un résumé instantané (vision Kimi K3).</p>
          <button className="cmd-send dev-action-btn" onClick={runOcr} disabled={ocrBusy} data-testid="pantheon-ocr-btn">
            {ocrBusy ? <Loader2 size={15} className="dev-spin" /> : <Camera size={15} />} CAPTURER &amp; ANALYSER
          </button>
          {ocrError && <div className="dev-error" data-testid="pantheon-ocr-error">{ocrError}</div>}
          {ocrResult && <pre className="dev-result" style={{ marginTop: 12, maxHeight: 200 }} data-testid="pantheon-ocr-result">{ocrResult}</pre>}
        </section>

        {/* Connexions externes + tableau */}
        <section className="prime-card" data-testid="pantheon-connectivity">
          <div className="zc-section-title"><Link2 size={12} style={{ marginRight: 6 }} />CONNEXIONS EXTERNES</div>
          {services.map((s) => (
            <div className="pantheon-svc-row" key={s.name}>
              <span className={`zc-dot ${s.status === "CONNECTÉ" ? "on" : "off"}`} />
              <span className="pantheon-svc-name">{s.name}</span>
              <span className={`pantheon-svc-status ${s.status === "CONNECTÉ" ? "ok" : "ko"}`}>{s.status}</span>
            </div>
          ))}
          <div className="zc-section-title" style={{ marginTop: 16 }}><LayoutDashboard size={12} style={{ marginRight: 6 }} />TABLEAU DE CONNECTIVITÉ</div>
          {services.map((s) => {
            const health = s.status !== "CONNECTÉ" ? 0 : s.latency == null ? 100 : Math.max(20, 100 - Math.min(80, s.latency / 10));
            return (
              <div className="zc-bar-row" key={s.name}>
                <span className="prime-intent-name">{s.name}</span>
                <div className="zc-bar-track"><div className="zc-bar-fill" style={{ width: `${health}%`, background: health > 60 ? "#91e6f2" : health > 0 ? "#ff9500" : "#f43f5e", boxShadow: "0 0 8px rgba(52,211,153,0.5)" }} /></div>
                <b className="prime-intent-count">{s.latency != null ? `${s.latency}ms` : "—"}</b>
              </div>
            );
          })}
        </section>

        {/* Notifications + historique */}
        <section className="prime-card" data-testid="pantheon-notifications">
          <div className="zc-section-title"><BellRing size={12} style={{ marginRight: 6 }} />NOTIFICATIONS PERSONNALISÉES</div>
          <div className="pantheon-notif-row">
            <label className="pantheon-toggle">
              <input type="checkbox" checked={notif.whatsapp} onChange={(e) => saveNotif({ ...notif, whatsapp: e.target.checked })} data-testid="pantheon-notif-whatsapp" />
              WHATSAPP — ALERTES ALPHA VANTAGE
            </label>
          </div>
          {notif.whatsapp && (
            <>
              <div className="pantheon-notif-row">
                <input className="cmd-input pantheon-notif-input" placeholder="Numéro WhatsApp (+33...)" value={notif.waNum}
                  onChange={(e) => saveNotif({ ...notif, waNum: e.target.value })} data-testid="pantheon-wa-num" />
                <input className="cmd-input pantheon-notif-input" type="password" placeholder="Clé API CallMeBot" value={notif.waKey}
                  onChange={(e) => saveNotif({ ...notif, waKey: e.target.value })} data-testid="pantheon-wa-key" />
                <button className="pantheon-kill" style={{ whiteSpace: "nowrap" }} onClick={sendWaTest} disabled={waTest.busy} data-testid="pantheon-wa-test-btn">
                  {waTest.busy ? <Loader2 size={12} className="pantheon-spin" /> : <BellRing size={12} />} ENVOYER UN TEST
                </button>
              </div>
              {waTest.msg && (
                <div className="pantheon-hint" style={{ color: waTest.ok ? "#5eead4" : "#ff9a9a" }} data-testid="pantheon-wa-test-msg">{waTest.msg}</div>
              )}
              <div className="pantheon-hint">
                Activation (1 min, gratuit) : ajoutez <b>+34 644 05 92 17</b> à vos contacts, envoyez-lui sur WhatsApp
                « <b>I allow callmebot to send me messages</b> », puis collez ici la clé API reçue en réponse.
                Sirius vous écrira quand une action Alpha Vantage varie de ±2 % ou plus.
              </div>
            </>
          )}

          <div className="zc-section-title" style={{ marginTop: 14 }}><History size={12} style={{ marginRight: 6 }} />HISTORIQUE DES CONNEXIONS</div>
          <div className="prime-scroll" style={{ maxHeight: 150 }}>
            {history.map((h) => (
              <div className="prime-journal-row" key={h.id}>
                <span className="prime-time">{(h.created_at || "").slice(11, 16)}</span>
                <span className="prime-journal-text">{h.service} — {h.action} <b style={{ color: h.status === "OK" ? "#91e6f2" : "#f43f5e" }}>[{h.status}]</b></span>
              </div>
            ))}
            {history.length === 0 && <div className="memory-empty">Aucune interaction enregistrée.</div>}
          </div>
        </section>
      </div>
    </div>
  );
}
