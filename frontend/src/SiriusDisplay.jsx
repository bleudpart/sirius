// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useRef, useState, useEffect, useCallback } from "react";
import { gsap } from "gsap";
import { animateWindowOpen, animateWindowClose, animateResizeSettle } from "./gsapAnimations";
import { Monitor, RotateCw, ExternalLink, Globe, MessageSquare, Film, ImageIcon, Minus, ChevronUp, ShieldCheck, X, Maximize2, Minimize2, ClipboardPaste, Save, FileText, UploadCloud, Sparkles, Loader2, Facebook, Instagram, MessageCircle, ThumbsUp, ThumbsDown, Mail, AlertTriangle, ContactRound } from "lucide-react";
import { progress } from "./SiriusProgress";
import Analysis3D from "./Analysis3D";
import ModulesMedia from "./ModulesMedia";
import { cleanTextForDisplay } from "./voice";
import MediaPlayer from "@/components/MediaPlayer";

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;
const GEO_KEY = "sirius_display_geo_v2";

// Le display revendique un collage si la souris est dessus ou s'il a le focus
export function displayClaimsPaste() {
  const el = document.querySelector("[data-testid='sirius-display']");
  if (!el) return false;
  try { if (el.matches(":hover")) return true; } catch {}
  return el.contains(document.activeElement);
}

const TYPE_META = {
  idle: { label: "EN ATTENTE", Icon: Monitor },
  message: { label: "MESSAGE", Icon: MessageSquare },
  web: { label: "WEB", Icon: Globe },
  video: { label: "VIDÉO", Icon: Film },
  image: { label: "IMAGE", Icon: ImageIcon },
  media: { label: "MÉDIAS", Icon: Film },
  emails: { label: "E-MAILS", Icon: Mail },
  contacts: { label: "CONTACTS", Icon: ContactRound },
};

// Case stylisée pour un e-mail (Outlook ou Gmail) : cliquable → ouvre la messagerie concernée
function EmailCard({ mail, onOpen }) {
  const urgent = mail.categorie === "Critique";
  const openUrl = mail.source === "gmail"
    ? (mail.id ? `https://mail.google.com/mail/u/0/#inbox/${mail.id}` : "https://mail.google.com/")
    : "https://outlook.office.com/mail/";
  return (
    <button
      type="button"
      className={`sd-email-card ${urgent ? "urgent" : ""} ${mail.lu ? "read" : "unread"}`}
      onClick={() => { try { window.open(openUrl, "_blank"); } catch (e) {} if (onOpen) onOpen(mail); }}
      title="Ouvrir ce message"
      data-testid="sirius-display-email-card"
    >
      {urgent && <span className="sd-email-urgent"><AlertTriangle size={12} /> URGENT</span>}
      <div className="sd-email-top">
        <span className="sd-email-from">{mail.de || mail.de_email || "Expéditeur inconnu"}</span>
        <span className="sd-email-date">{(mail.recu || mail.date || "").slice(0, 16)}</span>
      </div>
      <div className="sd-email-subject">{mail.sujet || "(sans objet)"}</div>
      {mail.apercu && <div className="sd-email-preview">{mail.apercu}</div>}
      <div className="sd-email-footer">
        <span className={`sd-email-badge ${mail.categorie === "Critique" ? "crit" : mail.categorie === "Important" ? "imp" : ""}`}>{mail.categorie || (mail.lu ? "Lu" : "Non lu")}</span>
        <span className="sd-email-source">{mail.source === "gmail" ? "Gmail" : "Outlook"}</span>
      </div>
    </button>
  );
}

function ContactCard({ contact }) {
  const email = contact.email || contact.emails?.[0] || "";
  const phone = contact.telephone || contact.telephones?.[0] || "";
  return (
    <button
      type="button"
      className="sd-contact-card"
      onClick={() => {
        if (email) {
          window.location.href = `mailto:${email}`;
        } else if (phone) {
          window.location.href = `tel:${phone}`;
        }
      }}
      title={email || phone ? "Contacter cette personne" : "Aucune coordonnée disponible"}
      data-testid="sirius-display-contact-card"
    >
      <div className="sd-contact-name"><ContactRound size={15} /> {contact.nom || "Contact sans nom"}</div>
      {(contact.poste || contact.entreprise) && (
        <div className="sd-contact-role">{[contact.poste, contact.entreprise].filter(Boolean).join(" · ")}</div>
      )}
      {email && <div className="sd-contact-line">{email}</div>}
      {phone && <div className="sd-contact-line">{phone}</div>}
      {!email && !phone && <div className="sd-contact-empty">Aucune coordonnée</div>}
    </button>
  );
}

// Réseaux sociaux : FB/IG/WA refusent l'iframe (X-Frame-Options), donc fenêtre dédiée pilotée par le display
const SOCIALS = [
  { id: "facebook", label: "FACEBOOK", speak: "Facebook", url: "https://www.facebook.com", color: "#1877f2", Icon: Facebook },
  { id: "instagram", label: "INSTAGRAM", speak: "Instagram", url: "https://www.instagram.com", color: "#e1306c", Icon: Instagram },
  { id: "whatsapp", label: "WHATSAPP", speak: "WhatsApp Web", url: "https://web.whatsapp.com", color: "#25d366", Icon: MessageCircle },
];

const readGeo = () => {
  try { return JSON.parse(localStorage.getItem(GEO_KEY)) || {}; } catch (e) { return {}; }
};

// Panneau d'affichage ΣIRIUS : ouvert par Sirius quand il a du contenu à montrer (messages, web, vidéos, images)
export default function SiriusDisplay({ item, history, onSelect, onClose, onInteract, onSpeak }) {
  const ref = useRef(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [minimized, setMinimized] = useState(() => !!readGeo().min);
  const [full, setFull] = useState(false);
  const [pasted, setPasted] = useState(null);
  const [saveMsg, setSaveMsg] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [analysis, setAnalysis] = useState(null);
  const [show3D, setShow3D] = useState(false);
  const [feedbackVote, setFeedbackVote] = useState(null);
  const analysisSeq = useRef(0);

  // Reset vote when a new item arrives
  const itemId = item && item.id;
  useEffect(() => { setFeedbackVote(null); }, [itemId]);

  const sendFeedback = useCallback((rating) => {
    if (!item || !item.id) return;
    setFeedbackVote(rating);
    fetch(`${API}/feedback`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_id: String(item.id), rating, context: (item.contenu || "").slice(0, 300) }),
    }).catch(() => {});
  }, [item]);

  // Analyse IA en arrière-plan du fichier déposé + commentaire vocal de Sirius
  const analyzeFile = useCallback(async (file, kind) => {
    analysisSeq.current += 1;
    const seq = analysisSeq.current;
    if (!["image", "text", "pdf"].includes(kind)) { setAnalysis(null); return; }
    if (file.size > 12 * 1048576) { setAnalysis({ error: "Fichier trop volumineux pour l'analyse IA (12 Mo max)." }); return; }
    setAnalysis({ busy: true });
    const pid = progress.start(`Analyse du dépôt — ${file.name}`, { silent: true });
    progress.log(pid, "Sirius examine le fichier…", 35);
    try {
      let keys = {};
      try { keys = JSON.parse(localStorage.getItem("sirius_keys")) || {}; } catch { keys = {}; }
      const form = new FormData();
      form.append("file", file);
      form.append("keys", JSON.stringify(keys));
      const r = await fetch(`${API}/display/analyze`, { method: "POST", body: form });
      const d = await r.json().catch(() => ({}));
      if (seq !== analysisSeq.current) { progress.done(pid, "Analyse remplacée"); return; }
      if (!r.ok) {
        progress.error(pid, d.detail || "Analyse impossible");
        setAnalysis({ error: d.detail || "Analyse impossible." });
        return;
      }
      progress.done(pid, "Analyse délivrée");
      const analysisText = d.speech || (d.analyse && d.analyse.description) || "";
      setAnalysis({ text: analysisText });
      window.__siriusDisplayFile = { ...(window.__siriusDisplayFile || {}), name: file.name, kind, analysis: analysisText };
      if (kind === "text") {
        file.text().then((t) => { if (window.__siriusDisplayFile) window.__siriusDisplayFile.text = t.slice(0, 12000); }).catch(() => {});
      }
      if (onSpeak && d.speech) onSpeak(d.speech);
    } catch {
      if (seq === analysisSeq.current) {
        progress.error(pid, "Analyse interrompue");
        setAnalysis({ error: "Module d'analyse injoignable." });
      }
    }
  }, [onSpeak]);

  // Affiche un fichier (collé ou déposé) directement dans le display : pas de médiathèque
  const showFile = useCallback((raw, hint = "collé") => {
    if (!raw) return;
    const name = raw.name || `${hint}-${Date.now()}.${(raw.type || "").split("/")[1] || "bin"}`;
    const file = raw.name ? raw : new File([raw], name, { type: raw.type });
    const ct = (file.type || "").toLowerCase();
    const kind = ct.startsWith("image/") ? "image" : ct.startsWith("video/") ? "video" : ct.startsWith("audio/") ? "audio" : ct === "application/pdf" ? "pdf" : ct.startsWith("text/") || ct === "application/json" ? "text" : "other";
    setPasted((old) => { if (old && old.url) URL.revokeObjectURL(old.url); return null; });
    if (kind === "text") {
      file.text().then((txt) => setPasted({ kind, name, file, text: txt.slice(0, 20000) }));
    } else {
      setPasted({ kind, name, file, url: URL.createObjectURL(file) });
    }
    setMinimized(false);
    setSaveMsg("");
    if (onInteract) onInteract();
    window.__siriusDisplayFile = { name, kind, file };
    window.__siriusDisplayChat = [];
    analyzeFile(file, kind);
  }, [onInteract, analyzeFile]);

  // Contexte fichier effacé à la fermeture du display
  useEffect(() => () => { delete window.__siriusDisplayFile; }, []);

  // Glisser-déposer direct dans le display : intercepté ici, jamais par le capteur global
  const hasDragFiles = (e) => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes("Files");
  const onDisplayDragOver = (e) => {
    if (!hasDragFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };
  const onDisplayDragLeave = (e) => {
    e.stopPropagation();
    if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false);
  };
  const onDisplayDrop = (e) => {
    if (!hasDragFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    showFile(e.dataTransfer.files[0], "déposé");
  };

  // Collage direct dans le display : le fichier reste ici, pas de médiathèque
  useEffect(() => {
    const onPaste = (e) => {
      const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
      const fileItem = items.find((it) => it.kind === "file");
      if (!fileItem || !displayClaimsPaste()) return;
      const raw = fileItem.getAsFile();
      if (!raw) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      showFile(raw, "collé");
    };
    window.addEventListener("paste", onPaste, true);
    return () => window.removeEventListener("paste", onPaste, true);
  }, [showFile]);

  // Libère l'URL objet du fichier collé au démontage
  const pastedUrlRef = useRef(null);
  useEffect(() => { pastedUrlRef.current = pasted && pasted.url; }, [pasted]);
  useEffect(() => () => { if (pastedUrlRef.current) URL.revokeObjectURL(pastedUrlRef.current); }, []);

  const clearPasted = () => {
    analysisSeq.current += 1;
    setAnalysis(null);
    setShow3D(false);
    setPasted((old) => { if (old && old.url) URL.revokeObjectURL(old.url); return null; });
    setSaveMsg("");
  };

  // Fenêtres sociales dédiées : ouverture / bascule calée sur la géométrie du display
  const socialWins = useRef({});
  const [activeSocial, setActiveSocial] = useState(null);
  const openSocial = (s) => {
    const el = ref.current;
    const r = el ? el.getBoundingClientRect() : { x: 80, y: 80, width: 900, height: 640 };
    const feats = `popup=yes,width=${Math.max(420, Math.round(r.width))},height=${Math.max(520, Math.round(r.height))},left=${Math.round((window.screenX || 0) + r.x)},top=${Math.round((window.screenY || 0) + r.y)}`;
    const existing = socialWins.current[s.id];
    if (existing && !existing.closed) {
      try { existing.focus(); } catch {}
    } else {
      const w = window.open(s.url, `sirius-social-${s.id}`, feats);
      socialWins.current[s.id] = w;
      if (onSpeak) onSpeak(`${s.speak} ouvert dans la fenêtre dédiée du display, monsieur.`);
    }
    setActiveSocial(s.id);
    if (onInteract) onInteract();
  };

  const saveToLibrary = async () => {
    if (!pasted) return;
    try {
      const form = new FormData();
      form.append("file", pasted.file);
      const r = await fetch(`${API}/files/upload`, { method: "POST", body: form });
      if (!r.ok) throw new Error();
      setSaveMsg("Enregistré dans la médiathèque ✓");
      window.dispatchEvent(new Event("sirius-files-updated"));
    } catch { setSaveMsg("Échec de l'enregistrement."); }
  };

  useEffect(() => {
    if (!full) return;
    const onKey = (e) => { if (e.key === "Escape") setFull(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  useEffect(() => {
    const el = ref.current;
    if (!el || full) return;
    const g = readGeo();
    const w = g.w || Math.min(640, window.innerWidth - 36);
    const h = g.h || Math.round(window.innerHeight * 0.68);
    el.style.width = w + "px";
    el.style.height = minimized ? "auto" : h + "px";
    const x = g.x != null ? g.x : window.innerWidth - w - 18;
    const y = g.y != null ? g.y : Math.max(56, Math.round((window.innerHeight - h) / 2));
    el.style.left = Math.min(Math.max(0, x), window.innerWidth - 120) + "px";
    el.style.top = Math.min(Math.max(0, y), window.innerHeight - 60) + "px";
  }, [minimized, full]);

  useEffect(() => {
    if (ref.current) animateWindowOpen(ref.current);
  }, []);

  const saveGeo = (patch) => {
    try { localStorage.setItem(GEO_KEY, JSON.stringify({ ...readGeo(), ...patch })); } catch (e) {}
  };

  const onBarDown = (e) => {
    if (e.target.closest("button") || full) return;
    const el = ref.current;
    gsap.killTweensOf(el);
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    el.classList.add("dragging");
    const move = (ev) => {
      el.style.left = Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - 140) + "px";
      el.style.top = Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - 50) + "px";
    };
    const up = () => {
      el.classList.remove("dragging");
      saveGeo({ x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0 });
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  };

  const onResizeDown = (e) => {
    if (full) return;
    const el = ref.current;
    gsap.killTweensOf(el);
    const r = el.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY, sw = r.width, sh = r.height;
    el.classList.add("dragging");
    const move = (ev) => {
      el.style.width = Math.max(300, sw + ev.clientX - sx) + "px";
      el.style.height = Math.max(220, sh + ev.clientY - sy) + "px";
    };
    const up = () => {
      el.classList.remove("dragging");
      saveGeo({ w: parseFloat(el.style.width) || 440, h: parseFloat(el.style.height) || 460 });
      animateResizeSettle(el);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
    e.stopPropagation();
  };

  const toggleMin = () => {
    setFull(false);
    setMinimized((m) => { saveGeo({ min: !m }); return !m; });
  };

  const handleClose = useCallback(() => {
    if (ref.current) animateWindowClose(ref.current, onClose);
    else onClose();
  }, [onClose]);

  const type = (item && item.type) || "idle";
  const { label, Icon } = TYPE_META[type] || TYPE_META.idle;
  const isWeb = type === "web";
  const proxied = isWeb && item.iframeOk === false;
  const webSrc = isWeb
    ? (proxied ? `${API}/webbrowser/proxy?url=${encodeURIComponent(item.url)}${item.noscript ? "&noscript=1" : ""}` : item.url)
    : null;

  return (
    <div ref={ref} className={`sirius-display ${minimized ? "minimized" : ""} ${full ? "fullscreen" : ""} ${dragOver ? "sd-dragover" : ""}`} data-testid="sirius-display" data-hud-panel onPointerDown={onInteract}
      onDragEnter={onDisplayDragOver} onDragOver={onDisplayDragOver} onDragLeave={onDisplayDragLeave} onDrop={onDisplayDrop}>
      {dragOver && (
        <div className="sd-drophint" data-testid="sirius-display-drophint">
          <UploadCloud size={22} />
          <b>Déposez ici</b>
          <span>Affiché directement dans le display</span>
        </div>
      )}
      <div className="sd-bar" onPointerDown={onBarDown} onDoubleClick={() => { setMinimized(false); setFull((f) => !f); }} title={full ? "Double-clic : quitter le plein écran" : "Glisser pour déplacer — double-clic : plein écran"} data-testid="sirius-display-bar">
        <Monitor size={13} className="sd-logo" />
        <span className="sd-name">ΣIRIUS DISPLAY</span>
        <span className={`sd-badge sd-badge-${type}`} data-testid="sirius-display-badge">
          <Icon size={10} /> {label}
        </span>
        {proxied && <span className="sd-proxy" title="Site protégé — affiché via le proxy ΣIRIUS"><ShieldCheck size={10} /></span>}
        {isWeb && (
          <>
            <button onClick={() => setReloadKey((k) => k + 1)} title="Actualiser" data-testid="sirius-display-refresh"><RotateCw size={12} /></button>
            <button onClick={() => window.open(item.url, "_blank")} title="Ouvrir dans un onglet" data-testid="sirius-display-external"><ExternalLink size={12} /></button>
          </>
        )}
        <button onClick={() => { setMinimized(false); setFull((f) => !f); }} title={full ? "Quitter le plein écran (Échap)" : "Plein écran"} data-testid="sirius-display-fullscreen">
          {full ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </button>
        <button onClick={toggleMin} title={minimized ? "Déployer" : "Réduire"} data-testid="sirius-display-minimize">
          {minimized ? <ChevronUp size={12} /> : <Minus size={12} />}
        </button>
        <button onClick={handleClose} title="Fermer" data-testid="sirius-display-close">
          <X size={12} />
        </button>
      </div>

      {!minimized && (
        <>
          <div className="sd-social" data-testid="sirius-display-social">
            {SOCIALS.map((s) => (
              <button
                key={s.id}
                className={`sd-social-btn ${activeSocial === s.id ? "active" : ""}`}
                style={{ "--sc": s.color }}
                onClick={() => openSocial(s)}
                title={`${s.label} — fenêtre dédiée (l'iframe est interdite par ${s.speak})`}
                data-testid={`sirius-display-social-${s.id}`}
              >
                <s.Icon size={12} /> {s.label}
              </button>
            ))}
            {activeSocial && (
              <span className="sd-social-note" data-testid="sirius-display-social-note">
                fenêtre dédiée active — recliquez pour basculer
              </span>
            )}
          </div>
          <div className="sd-body" data-testid="sirius-display-body">
            <div className="hp-scan" />
            {pasted && (
              <div className="sd-pasted" data-testid="sirius-display-pasted">
                <div className="sd-pasted-bar">
                  <ClipboardPaste size={11} />
                  <span title={pasted.name}>{pasted.name}</span>
                  <button onClick={saveToLibrary} title="Enregistrer dans la médiathèque" data-testid="sirius-display-pasted-save"><Save size={11} /> MÉDIATHÈQUE</button>
                  <button onClick={clearPasted} title="Retirer" data-testid="sirius-display-pasted-clear"><X size={11} /></button>
                </div>
                {saveMsg && <div className="sd-pasted-msg">{saveMsg}</div>}
                {analysis && (
                  <div className="sd-analysis" data-testid="sirius-display-analysis">
                    <div className="sd-analysis-head">
                      <Sparkles size={11} /> ANALYSE ΣIRIUS {analysis.busy && <Loader2 size={11} className="sd-spin" />}
                      {analysis.text && (
                        <button className="sd-analysis-3d-btn" onClick={() => setShow3D(true)} data-testid="sirius-display-3d-btn">
                          VUE 3D
                        </button>
                      )}
                    </div>
                    {analysis.busy && <span className="sd-analysis-busy">Sirius examine le fichier…</span>}
                    {analysis.text && <p data-testid="sirius-display-analysis-text">{analysis.text}</p>}
                    {analysis.error && <span className="sd-analysis-err" data-testid="sirius-display-analysis-error">{analysis.error}</span>}
                  </div>
                )}
                {pasted.kind === "image" && <img src={pasted.url} alt={pasted.name} className="sd-image" data-testid="sirius-display-pasted-image" />}
                {pasted.kind === "video" && <video src={pasted.url} controls className="sd-video" />}
                {pasted.kind === "audio" && <audio src={pasted.url} controls className="sd-pasted-audio" />}
                {pasted.kind === "pdf" && <iframe src={pasted.url} title={pasted.name} className="sd-frame" />}
                {pasted.kind === "text" && <pre className="sd-pasted-text" data-testid="sirius-display-pasted-text">{pasted.text}</pre>}
                {pasted.kind === "other" && (
                  <div className="sd-pasted-other"><FileText size={22} /> Aperçu indisponible — « {pasted.name} » prêt à être traité.</div>
                )}
              </div>
            )}
            {!pasted && type === "idle" && (
              <div className="sd-idle">
                <span className="sd-idle-dot" />
                <p>ÉCRAN PRINCIPAL — EN ATTENTE</p>
                <em>Sirius affichera ici ses réponses, pages web, vidéos et réflexions.</em>
              </div>
            )}
            {!pasted && type === "message" && (
              <div className="sd-message" data-testid="sirius-display-message">
                {item.titre && <div className="sd-msg-title">{item.titre}</div>}
                <p>{cleanTextForDisplay(item.contenu)}</p>
                <div className="sd-feedback" data-testid="sirius-display-feedback">
                  <button
                    className={`sd-vote up ${feedbackVote === "up" ? "active" : ""}`}
                    onClick={() => sendFeedback("up")}
                    title="Bonne réponse"
                    data-testid="sirius-display-vote-up"
                    disabled={feedbackVote !== null}
                  >
                    <ThumbsUp size={12} />
                  </button>
                  <button
                    className={`sd-vote down ${feedbackVote === "down" ? "active" : ""}`}
                    onClick={() => sendFeedback("down")}
                    title="Mauvaise réponse"
                    data-testid="sirius-display-vote-down"
                    disabled={feedbackVote !== null}
                  >
                    <ThumbsDown size={12} />
                  </button>
                  {feedbackVote && (
                    <span className="sd-vote-thanks" data-testid="sirius-display-vote-thanks">
                      {feedbackVote === "up" ? "Merci ✓" : "Noté"}
                    </span>
                  )}
                </div>
              </div>
            )}
            {!pasted && isWeb && (
              <iframe
                key={`${item.url}-${reloadKey}`}
                src={webSrc}
                title={item.titre || item.url}
                className="sd-frame"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              />
            )}
            {!pasted && type === "video" && (
              <div className="sd-media">
                <video key={item.src} src={item.src} controls autoPlay className="sd-video" data-testid="sirius-display-video" />
                {item.legende && <div className="sd-caption">{item.legende}</div>}
              </div>
            )}
            {!pasted && type === "media" && (
              <MediaPlayer state={item.media || item} onControl={item.onMediaControl} />
            )}
            {!pasted && type === "emails" && (
              <div className="sd-emails" data-testid="sirius-display-emails">
                {item.titre && <div className="sd-msg-title">{item.titre}</div>}
                {(!item.mails || !item.mails.length) && (
                  <p className="sd-emails-empty">Aucun e-mail à afficher.</p>
                )}
                <div className="sd-email-grid">
                  {(item.mails || []).map((m, i) => (
                    <EmailCard key={m.id || i} mail={m} />
                  ))}
                </div>
              </div>
            )}
            {!pasted && type === "contacts" && (
              <div className="sd-emails" data-testid="sirius-display-contacts">
                {item.titre && <div className="sd-msg-title">{item.titre}</div>}
                {(!item.contacts || !item.contacts.length) && (
                  <p className="sd-emails-empty">Aucun contact trouvé.</p>
                )}
                <div className="sd-contact-grid">
                  {(item.contacts || []).map((contact, i) => (
                    <ContactCard key={contact.id || contact.email || i} contact={contact} />
                  ))}
                </div>
              </div>
            )}
            {!pasted && type === "image" && (
              <div className="sd-media">
                <img key={item.src} src={item.src} alt={item.legende || "affichage"} className="sd-image" data-testid="sirius-display-image" />
                {item.legende && <div className="sd-caption">{item.legende}</div>}
              </div>
            )}
            {!pasted && type === "media" && (
              <ModulesMedia
                onOpenModule={(mediaModule) => {
                  if (onSpeak) onSpeak(`${mediaModule.name} ouvert dans une nouvelle fenêtre.`);
                }}
              />
            )}
          </div>

          {history.length > 0 && (
            <div className="sd-history" data-testid="sirius-display-history">
              {history.map((h) => {
                const M = TYPE_META[h.type] || TYPE_META.message;
                const active = item && h.id === item.id;
                return (
                  <button
                    key={h.id}
                    className={`sd-chip ${active ? "active" : ""}`}
                    onClick={() => onSelect(h)}
                    title={h.titre || h.legende || h.url || h.contenu || ""}
                    data-testid={`sirius-display-chip-${h.id}`}
                  >
                    <M.Icon size={10} />
                    <span>{(h.titre || h.legende || h.url || h.contenu || "—").slice(0, 22)}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="sd-resize" onPointerDown={onResizeDown} title="Redimensionner" data-testid="sirius-display-resize" />
        </>
      )}
      {show3D && analysis && analysis.text && (
        <Analysis3D
          title={pasted ? pasted.name : "ANALYSE"}
          text={analysis.text}
          imageUrl={pasted && pasted.kind === "image" ? pasted.url : null}
          onClose={() => setShow3D(false)}
        />
      )}
    </div>
  );
}
