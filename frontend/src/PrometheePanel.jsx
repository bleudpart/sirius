import { loadApiKeys } from "@/apiKeyStorage";
// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// PROMÉTHÉE# — Gestion de projet : objectif, jalons, risques, actions. Historique cloud (MongoDB),
// export PDF et envoi par email (SMTP Thémis). Dédié à Prométhée (voir ConsultPanel pour Solon).
import { useCallback, useEffect, useState } from "react";
import { X, Flame, Loader2, ArrowRight, Volume2, History, Trash2, FileDown, Mail, Send } from "lucide-react";
import MythosBackdrop from "@/MythosBackdrop";
import { ConfirmButton } from "@/ConfirmButton";
import { speakAsCharacter, cancelSpeech } from "@/voice";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const MODULE = "PROMÉTHÉE#";
const OLD_LOCAL_KEY = "sirius_consult_history";

const smtpConf = () => {
  let k = {};
  k = loadApiKeys();
  if (!(k.smtp_host || "").trim()) return null;
  return {
    host: k.smtp_host.trim(), port: Number(k.smtp_port || 587),
    user: k.smtp_user || "", password: k.smtp_pass || "",
    from_email: k.smtp_from || "", from_name: k.smtp_name || "ΣIRIUS — PANTHÉON",
  };
};

const CONF = {
  title: "PROMÉTHÉE# — GESTION DE PROJET",
  sub: "OBJECTIF · JALONS · RISQUES · ACTIONS · MÉTHODES PMP & AGILE",
  img: `${API}/mythos/img/promethee.jpg`,
  name: "Prométhée",
  intro: "Prométhée. Je vois la fin du projet avant son commencement. Donnez-moi votre objectif.",
  placeholder: "Décrivez votre projet (but, délai, contraintes, équipe…)",
  action: "PLAN DE PROJET",
  start: "J'étudie ton projet.",
  done: "Voici votre plan : objectif, jalons, risques, actions. Tout est à l'écran.",
};

export default function PrometheePanel({ onClose }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState([]);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [mail, setMail] = useState(null); // { q, a, date, to, subject }
  const [mailBusy, setMailBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => () => cancelSpeech(), []);

  const refreshHistory = useCallback(async () => {
    try {
      const r = await fetch(`${API}/mythos/consult/history?module=${encodeURIComponent(MODULE)}`);
      const d = await r.json();
      setHistory(d.history || []);
    } catch (e) { /* hors ligne */ }
  }, []);

  // Migration unique : l'ancien historique local rejoint le cloud (les échecs restent en local)
  useEffect(() => {
    (async () => {
      let old = [];
      try { old = JSON.parse(localStorage.getItem(OLD_LOCAL_KEY)) || []; } catch (e) { old = []; }
      if (old.length > 0) {
        const failed = [];
        for (const h of old) {
          try {
            const r = await fetch(`${API}/mythos/consult/history`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ module: h.module, q: h.q, a: h.a, date: h.date }),
            });
            if (!r.ok) failed.push(h);
          } catch (e) { failed.push(h); }
        }
        if (failed.length === 0) {
          localStorage.removeItem(OLD_LOCAL_KEY);
        } else {
          localStorage.setItem(OLD_LOCAL_KEY, JSON.stringify(failed));
          setNotice(`Migration partielle : ${failed.length} consultation(s) restent en local et seront re-tentées à la prochaine ouverture.`);
        }
      }
      refreshHistory();
    })();
  }, [refreshHistory]);

  const consult = async () => {
    if (!question.trim() || busy) return;
    setBusy(true); setAnswer(""); setNotice("");
    cancelSpeech();
    speakAsCharacter(CONF.start, { module: MODULE });
    try {
      let keys = {};
      keys = loadApiKeys();
      const r = await fetch(`${API}/mythos/consult`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ module: MODULE, question, keys }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.reponse) {
        setAnswer(d.reponse);
        refreshHistory();
        speakAsCharacter(CONF.done, { module: MODULE });
      } else {
        setAnswer(typeof d.detail === "string" ? d.detail : "Consultation impossible pour le moment.");
      }
    } catch (e) { setAnswer("Consultation impossible — backend injoignable."); }
    setBusy(false);
  };

  const exportPdf = async (q, a, dateStr) => {
    if (!a || pdfBusy) return;
    setPdfBusy(true);
    try {
      const r = await fetch(`${API}/mythos/consult/pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ module: MODULE, question: q, reponse: a, date: dateStr || new Date().toLocaleDateString("fr-FR") }),
      });
      if (!r.ok) throw new Error();
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "promethee-plan.pdf";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) { setNotice("Export PDF impossible pour le moment."); }
    setPdfBusy(false);
  };

  const openMail = (q, a, dateStr) => {
    if (!smtpConf()) {
      setNotice("Serveur SMTP non configuré — renseignez-le dans THÉMIS (onglet Réglages) pour envoyer des emails.");
      return;
    }
    setNotice("");
    setMail({ q, a, date: dateStr || new Date().toLocaleDateString("fr-FR"), to: "", subject: "" });
  };

  const sendMail = async () => {
    if (!mail || !mail.to.trim() || mailBusy) return;
    setMailBusy(true); setNotice("");
    try {
      const r = await fetch(`${API}/mythos/consult/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          module: MODULE, question: mail.q, reponse: mail.a, date: mail.date,
          to: mail.to.trim(), subject: mail.subject, smtp: smtpConf() || {},
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        setNotice(`Document envoyé à ${mail.to.trim()} — ${CONF.name} a fait porter le message.`);
        setMail(null);
      } else {
        setNotice(typeof d.detail === "string" ? d.detail : "Envoi impossible.");
      }
    } catch (e) { setNotice("Envoi impossible — backend injoignable."); }
    setMailBusy(false);
  };

  const removeEntry = async (hid) => {
    await fetch(`${API}/mythos/consult/history/${hid}`, { method: "DELETE" }).catch(() => {});
    refreshHistory();
  };

  const fmtDate = (iso) => {
    try { return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit" }); } catch (e) { return ""; }
  };

  return (
    <div className="prime-screen" data-testid="promethee-panel">
      <MythosBackdrop module={MODULE} state={busy ? "busy" : "idle"} />
      <header className="zeus-head">
        <div className="oracle-title font-divine"><Flame size={20} /> {CONF.title}</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="promethee-close-btn"><X size={18} /></button>
      </header>
      <div className="prime-sub">{CONF.sub}</div>

      {notice && <div className="cal-notice" data-testid="promethee-notice">{notice}</div>}

      <div className="consult-layout">
        <div className="consult-portrait">
          <img src={CONF.img} alt={CONF.name} draggable={false} data-testid="promethee-portrait" />
          <button
            className="mg-speak"
            onClick={() => { cancelSpeech(); speakAsCharacter(CONF.intro, { module: MODULE }); }}
            data-testid="promethee-speak-btn"
          >
            <Volume2 size={13} /> ENTENDRE {CONF.name.toUpperCase()}
          </button>
        </div>
        <section className="prime-card consult-card">
          <p className="consult-intro">« {CONF.intro} »</p>
          <textarea
            className="mg-consult-input"
            rows={5}
            placeholder={CONF.placeholder}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            data-testid="promethee-consult-input"
          />
          <button
            className="mg-open consult-go"
            disabled={busy || !question.trim()}
            onClick={consult}
            data-testid="promethee-consult-btn"
          >
            {busy ? <><Loader2 size={13} className="spin" /> ANALYSE EN COURS…</> : <>{CONF.action} <ArrowRight size={13} /></>}
          </button>
          {answer && <pre className="mg-consult-answer consult-answer" data-testid="promethee-consult-answer">{answer}</pre>}
          {answer && (
            <div className="consult-actions">
              <button className="mg-open consult-go" onClick={() => exportPdf(question, answer)} disabled={pdfBusy} data-testid="promethee-export-pdf-btn">
                {pdfBusy ? <Loader2 size={13} className="spin" /> : <FileDown size={13} />} EXPORT PDF
              </button>
              <button className="mg-open consult-go" onClick={() => openMail(question, answer)} data-testid="promethee-email-btn">
                <Mail size={13} /> ENVOYER PAR EMAIL
              </button>
            </div>
          )}

          {mail && (
            <div className="consult-mail" data-testid="promethee-mail-form">
              <div className="consult-history-head"><Mail size={12} /> ENVOI DU PDF PAR EMAIL</div>
              <input
                className="cal-select consult-mail-input"
                placeholder="Adresse du destinataire (client@exemple.fr)"
                value={mail.to}
                onChange={(e) => setMail({ ...mail, to: e.target.value })}
                data-testid="promethee-mail-to"
              />
              <input
                className="cal-select consult-mail-input"
                placeholder="Objet (défaut : Plan de projet — PROMÉTHÉE)"
                value={mail.subject}
                onChange={(e) => setMail({ ...mail, subject: e.target.value })}
                data-testid="promethee-mail-subject"
              />
              <div className="consult-actions">
                <button className="mg-open consult-go" onClick={sendMail} disabled={mailBusy || !mail.to.trim()} data-testid="promethee-mail-send-btn">
                  {mailBusy ? <Loader2 size={13} className="spin" /> : <Send size={13} />} ENVOYER
                </button>
                <button className="cal-act" onClick={() => setMail(null)} data-testid="promethee-mail-cancel-btn">ANNULER</button>
              </div>
            </div>
          )}

          <div className="consult-history" data-testid="promethee-history">
            <div className="consult-history-head"><History size={12} /> HISTORIQUE CLOUD — {CONF.name.toUpperCase()}</div>
            {history.length === 0 && <span className="consult-hempty">Aucune consultation enregistrée pour le moment.</span>}
            {history.map((h) => (
              <div key={h.id} className="consult-hrow" data-testid="promethee-history-row">
                <span className="consult-hdate">{fmtDate(h.date)}</span>
                <span className="consult-hq" onClick={() => { setQuestion(h.q); setAnswer(h.a); }} data-testid="promethee-history-load">{h.q}</span>
                <button className="consult-hdel" title="Exporter cette consultation en PDF" onClick={() => exportPdf(h.q, h.a, fmtDate(h.date))} data-testid="promethee-history-pdf">
                  <FileDown size={12} />
                </button>
                <button className="consult-hdel" title="Envoyer cette consultation par email" onClick={() => openMail(h.q, h.a, fmtDate(h.date))} data-testid="promethee-history-mail">
                  <Mail size={12} />
                </button>
                <ConfirmButton
                  className="consult-hdel"
                  title="Supprimer cette consultation"
                  testId="promethee-history-del"
                  onConfirm={() => removeEntry(h.id)}
                >
                  <Trash2 size={12} />
                </ConfirmButton>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
