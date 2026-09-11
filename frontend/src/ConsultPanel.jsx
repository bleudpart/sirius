// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// Modules SOLON# (conseil juridique) et PROMÉTHÉE# (gestion de projet) — consultation plein écran.
// Historique cloud (MongoDB), export PDF et envoi par email (SMTP Thémis).
import { useCallback, useEffect, useState } from "react";
import { X, Scale, Flame, Loader2, ArrowRight, Volume2, History, Trash2, FileDown, Mail, Send } from "lucide-react";
import MythosBackdrop from "@/MythosBackdrop";
import { ConfirmButton } from "@/ConfirmButton";
import { speakAsCharacter, cancelSpeech } from "@/voice";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const OLD_LOCAL_KEY = "sirius_consult_history";

const smtpConf = () => {
  let k = {};
  try { k = JSON.parse(localStorage.getItem("sirius_keys")) || {}; } catch (e) { k = {}; }
  if (!(k.smtp_host || "").trim()) return null;
  return {
    host: k.smtp_host.trim(), port: Number(k.smtp_port || 587),
    user: k.smtp_user || "", password: k.smtp_pass || "",
    from_email: k.smtp_from || "", from_name: k.smtp_name || "ΣIRIUS — PANTHÉON",
  };
};

const CONF = {
  "SOLON#": {
    Icon: Scale,
    title: "SOLON# — CONSEIL JURIDIQUE",
    sub: "AVIS STRUCTURÉS · FAITS / DROIT / ANALYSE / OPTIONS · DROIT FRANÇAIS EXCLUSIVEMENT",
    img: "/api/mythos/img/solon.jpg",
    name: "Solon",
    intro: "Solon, législateur. Exposez vos faits — le droit fera le reste.",
    placeholder: "Exposez votre situation juridique (contrat, litige, travail, bail…)",
    action: "AVIS JURIDIQUE",
    start: "J'examine votre dossier, monsieur.",
    done: "Voici mon avis : faits, droit, analyse, options. Tout est à l'écran.",
  },
  "PROMÉTHÉE#": {
    Icon: Flame,
    title: "PROMÉTHÉE# — GESTION DE PROJET",
    sub: "OBJECTIF · JALONS · RISQUES · ACTIONS · MÉTHODES PMP & AGILE",
    img: "/api/mythos/img/promethee.jpg",
    name: "Prométhée",
    intro: "Prométhée. Je vois la fin du projet avant son commencement. Donnez-moi votre objectif.",
    placeholder: "Décrivez votre projet (but, délai, contraintes, équipe…)",
    action: "PLAN DE PROJET",
    start: "J'étudie votre projet, monsieur.",
    done: "Voici votre plan : objectif, jalons, risques, actions. Tout est à l'écran.",
  },
};

export default function ConsultPanel({ module, onClose }) {
  const c = CONF[module];
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
      const r = await fetch(`${API}/mythos/consult/history?module=${encodeURIComponent(module)}`);
      const d = await r.json();
      setHistory(d.history || []);
    } catch (e) { /* hors ligne */ }
  }, [module]);

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
    speakAsCharacter(c.start, { module });
    try {
      let keys = {};
      try { keys = JSON.parse(localStorage.getItem("sirius_keys")) || {}; } catch (e) { keys = {}; }
      const r = await fetch(`${API}/mythos/consult`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ module, question, keys }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.reponse) {
        setAnswer(d.reponse);
        refreshHistory();
        speakAsCharacter(c.done, { module });
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
        body: JSON.stringify({ module, question: q, reponse: a, date: dateStr || new Date().toLocaleDateString("fr-FR") }),
      });
      if (!r.ok) throw new Error();
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = module === "SOLON#" ? "solon-avis.pdf" : "promethee-plan.pdf";
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
          module, question: mail.q, reponse: mail.a, date: mail.date,
          to: mail.to.trim(), subject: mail.subject, smtp: smtpConf() || {},
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        setNotice(`Document envoyé à ${mail.to.trim()} — ${c.name} a fait porter le message.`);
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

  const slug = module === "SOLON#" ? "solon" : "promethee";
  return (
    <div className="prime-screen" data-testid={`${slug}-panel`}>
      <MythosBackdrop module={module} state={busy ? "busy" : "idle"} />
      <header className="zeus-head">
        <div className="oracle-title font-divine"><c.Icon size={20} /> {c.title}</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid={`${slug}-close-btn`}><X size={18} /></button>
      </header>
      <div className="prime-sub">{c.sub}</div>

      {notice && <div className="cal-notice" data-testid={`${slug}-notice`}>{notice}</div>}

      <div className="consult-layout">
        <div className="consult-portrait">
          <img src={c.img} alt={c.name} draggable={false} data-testid={`${slug}-portrait`} />
          <button
            className="mg-speak"
            onClick={() => { cancelSpeech(); speakAsCharacter(c.intro, { module }); }}
            data-testid={`${slug}-speak-btn`}
          >
            <Volume2 size={13} /> ENTENDRE {c.name.toUpperCase()}
          </button>
        </div>
        <section className="prime-card consult-card">
          <p className="consult-intro">« {c.intro} »</p>
          <textarea
            className="mg-consult-input"
            rows={5}
            placeholder={c.placeholder}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            data-testid={`${slug}-consult-input`}
          />
          <button
            className="mg-open consult-go"
            disabled={busy || !question.trim()}
            onClick={consult}
            data-testid={`${slug}-consult-btn`}
          >
            {busy ? <><Loader2 size={13} className="spin" /> ANALYSE EN COURS…</> : <>{c.action} <ArrowRight size={13} /></>}
          </button>
          {answer && <pre className="mg-consult-answer consult-answer" data-testid={`${slug}-consult-answer`}>{answer}</pre>}
          {answer && (
            <div className="consult-actions">
              <button className="mg-open consult-go" onClick={() => exportPdf(question, answer)} disabled={pdfBusy} data-testid={`${slug}-export-pdf-btn`}>
                {pdfBusy ? <Loader2 size={13} className="spin" /> : <FileDown size={13} />} EXPORT PDF
              </button>
              <button className="mg-open consult-go" onClick={() => openMail(question, answer)} data-testid={`${slug}-email-btn`}>
                <Mail size={13} /> ENVOYER PAR EMAIL
              </button>
            </div>
          )}

          {mail && (
            <div className="consult-mail" data-testid={`${slug}-mail-form`}>
              <div className="consult-history-head"><Mail size={12} /> ENVOI DU PDF PAR EMAIL</div>
              <input
                className="cal-select consult-mail-input"
                placeholder="Adresse du destinataire (client@exemple.fr)"
                value={mail.to}
                onChange={(e) => setMail({ ...mail, to: e.target.value })}
                data-testid={`${slug}-mail-to`}
              />
              <input
                className="cal-select consult-mail-input"
                placeholder={`Objet (défaut : ${module === "SOLON#" ? "Avis juridique — SOLON" : "Plan de projet — PROMÉTHÉE"})`}
                value={mail.subject}
                onChange={(e) => setMail({ ...mail, subject: e.target.value })}
                data-testid={`${slug}-mail-subject`}
              />
              <div className="consult-actions">
                <button className="mg-open consult-go" onClick={sendMail} disabled={mailBusy || !mail.to.trim()} data-testid={`${slug}-mail-send-btn`}>
                  {mailBusy ? <Loader2 size={13} className="spin" /> : <Send size={13} />} ENVOYER
                </button>
                <button className="cal-act" onClick={() => setMail(null)} data-testid={`${slug}-mail-cancel-btn`}>ANNULER</button>
              </div>
            </div>
          )}

          <div className="consult-history" data-testid={`${slug}-history`}>
            <div className="consult-history-head"><History size={12} /> HISTORIQUE CLOUD — {c.name.toUpperCase()}</div>
            {history.length === 0 && <span className="consult-hempty">Aucune consultation enregistrée pour le moment.</span>}
            {history.map((h) => (
              <div key={h.id} className="consult-hrow" data-testid={`${slug}-history-row`}>
                <span className="consult-hdate">{fmtDate(h.date)}</span>
                <span className="consult-hq" onClick={() => { setQuestion(h.q); setAnswer(h.a); }} data-testid={`${slug}-history-load`}>{h.q}</span>
                <button className="consult-hdel" title="Exporter cette consultation en PDF" onClick={() => exportPdf(h.q, h.a, fmtDate(h.date))} data-testid={`${slug}-history-pdf`}>
                  <FileDown size={12} />
                </button>
                <button className="consult-hdel" title="Envoyer cette consultation par email" onClick={() => openMail(h.q, h.a, fmtDate(h.date))} data-testid={`${slug}-history-mail`}>
                  <Mail size={12} />
                </button>
                <ConfirmButton
                  className="consult-hdel"
                  title="Supprimer cette consultation"
                  testId={`${slug}-history-del`}
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
