// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// PYTHAGORE# — Mathématiques & géométrie : calcul exact (vocal), géométrie visuelle, tracé, explications, historique.
import { useEffect, useRef, useState } from "react";
import { X, Sigma, Loader2, ArrowRight, LineChart, GraduationCap, Calculator, Shapes, Mic, History, Trash2 } from "lucide-react";
import MythosBackdrop from "@/MythosBackdrop";
import "./Pythagore.css";
import { speakAsCharacter, cancelSpeech } from "@/voice";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const HIST_KEY = "pythagore_history";

const MODES = [
  ["eval", "Évaluer / simplifier"],
  ["solve", "Résoudre (= ou = 0)"],
  ["factor", "Factoriser"],
  ["expand", "Développer"],
  ["derive", "Dériver"],
  ["integrate", "Intégrer"],
];

const loadHist = () => { try { return JSON.parse(localStorage.getItem(HIST_KEY)) || []; } catch (e) { return []; } };
const saveHist = (h) => localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, 24)));

// Dictée mathématique : convertit le français parlé en expression calculable
const vocalToExpr = (t) => {
  let s = " " + t.toLowerCase() + " ";
  s = s.replace(/racine (?:carrée |carree )?(?:de )?(\d+(?:[.,]\d+)?|[a-z])/g, "sqrt($1)");
  s = s.replace(/ au carré| au carre/g, "^2").replace(/ au cube/g, "^3");
  s = s.replace(/ puissance /g, "^");
  s = s.replace(/multiplié par|multiplie par| fois /g, "*");
  s = s.replace(/divisé par|divise par| sur /g, "/");
  s = s.replace(/ plus /g, "+").replace(/ moins /g, "-");
  s = s.replace(/égale à|égal à|égale|égal|egale|egal/g, "=");
  s = s.replace(/ouvre (?:la )?parenthèse|ouvre (?:la )?parenthese/g, "(").replace(/ferme (?:la )?parenthèse|ferme (?:la )?parenthese/g, ")");
  s = s.replace(/virgule/g, ".").replace(/ixe/g, "x");
  return s.replace(/\s+/g, " ").trim();
};

// Résultat → parole naturelle
const resultToSpeech = (r) => (r || "")
  .replace(/\*\*/g, " puissance ").replace(/\^/g, " puissance ")
  .replace(/sqrt\(/g, " racine de ").replace(/\*/g, " fois ").replace(/\//g, " divisé par ")
  .replace(/=/g, " égale ").replace(/-/g, " moins ").replace(/\+/g, " plus ")
  .replace(/,/g, " ou ").replace(/\(|\)/g, " ").replace(/\s+/g, " ").trim();

export default function PythagorePanel({ onClose }) {
  const [char, setChar] = useState(null);
  useEffect(() => {
    fetch((process.env.REACT_APP_BACKEND_URL || "") + "/api/mythos/characters")
      .then(r => r.json())
      .then(d => {
        const p = d.characters.find(c => c.module === "PYTHAGORE#");
        setChar(p);
      });
  }, []);
  const [tab, setTab] = useState("calc");
  const [expr, setExpr] = useState("");
  const [mode, setMode] = useState("eval");
  const [variable, setVariable] = useState("x");
  const [calcOut, setCalcOut] = useState(null);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [micNotice, setMicNotice] = useState("");
  const [geoDesc, setGeoDesc] = useState("");
  const [geoUrl, setGeoUrl] = useState("");
  const [geoErr, setGeoErr] = useState("");
  const [plotExpr, setPlotExpr] = useState("");
  const [xmin, setXmin] = useState("-10");
  const [xmax, setXmax] = useState("10");
  const [plotUrl, setPlotUrl] = useState("");
  const [plotErr, setPlotErr] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [hist, setHist] = useState(loadHist);
  const recRef = useRef(null);

  useEffect(() => () => { cancelSpeech(); try { recRef.current && recRef.current.abort(); } catch (e) {} }, []);

  const pushHist = (entry) => {
    const all = [{ id: Date.now(), date: new Date().toISOString(), ...entry }, ...loadHist()];
    saveHist(all);
    setHist(all);
  };

  const calc = async (rawExpr, rawMode, speak = false) => {
    const expression = (rawExpr ?? expr).trim();
    const m = rawMode ?? mode;
    if (!expression || busy) return;
    setBusy(true); setCalcOut(null);
    try {
      const r = await fetch(`${API}/pythagore/calc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expression, mode: m, variable }),
      });
      const d = await r.json();
      if (r.ok) {
        setCalcOut(d);
        pushHist({ type: "calc", expression, mode: m, variable, result: d.result, approx: d.approx });
        if (speak) speakAsCharacter(`Résultat : ${resultToSpeech(d.result)}.`, { module: "PYTHAGORE#" });
      } else {
        setCalcOut({ error: d.detail || "Calcul impossible." });
        if (speak) speakAsCharacter("Je n'ai pas compris cette expression, reformulez.", { module: "PYTHAGORE#" });
      }
    } catch (e) { setCalcOut({ error: "Backend injoignable." }); }
    setBusy(false);
  };

  const dictate = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setMicNotice("La dictée vocale n'est pas disponible sur ce navigateur."); return; }
    if (listening) { try { recRef.current.stop(); } catch (e) {} return; }
    const rec = new SR();
    recRef.current = rec;
    rec.lang = "fr-FR";
    rec.interimResults = false;
    let watchdog = setTimeout(() => {
      watchdog = null;
      try { rec.abort(); } catch (e) {}
      setListening(false);
      setMicNotice("Dictée vocale indisponible sur ce navigateur — saisissez votre calcul au clavier.");
    }, 8000);
    const clearWd = () => { if (watchdog) { clearTimeout(watchdog); watchdog = null; } };
    rec.onstart = () => { clearWd(); setListening(true); setMicNotice(""); };
    rec.onend = () => { clearWd(); setListening(false); };
    rec.onerror = (ev) => {
      clearWd();
      setListening(false);
      const msgs = {
        "not-allowed": "Micro refusé — autorisez l'accès au microphone dans votre navigateur.",
        "service-not-allowed": "Micro refusé — autorisez l'accès au microphone dans votre navigateur.",
        "no-speech": "Je n'ai rien entendu — réessayez en parlant plus près du micro.",
        "audio-capture": "Aucun microphone détecté sur cet appareil.",
        "network": "Dictée indisponible — la reconnaissance vocale n'a pas pu joindre le réseau.",
      };
      setMicNotice(msgs[ev && ev.error] || "Dictée vocale indisponible pour le moment.");
    };
    rec.onresult = (e) => {
      const heard = e.results[0][0].transcript || "";
      const converted = vocalToExpr(heard);
      setExpr(converted);
      const m = converted.includes("=") ? "solve" : "eval";
      setMode(m);
      calc(converted, m, true);
    };
    cancelSpeech();
    try { rec.start(); } catch (e) { setMicNotice("Dictée vocale indisponible pour le moment."); }
  };

  const drawGeo = (desc) => {
    const d = (desc ?? geoDesc).trim();
    if (!d) return;
    setGeoErr("");
    setGeoUrl(`${API}/pythagore/geometry?desc=${encodeURIComponent(d)}&t=${Date.now()}`);
    pushHist({ type: "geo", expression: d });
  };

  const plot = (pe, pxmin, pxmax) => {
    const e = (pe ?? plotExpr).trim();
    if (!e) return;
    setPlotErr("");
    setPlotUrl(`${API}/pythagore/plot?expr=${encodeURIComponent(e)}&xmin=${pxmin ?? xmin}&xmax=${pxmax ?? xmax}&t=${Date.now()}`);
    pushHist({ type: "plot", expression: e, xmin: pxmin ?? xmin, xmax: pxmax ?? xmax });
  };

  const explain = async () => {
    if (!question.trim() || busy) return;
    setBusy(true); setAnswer("");
    try {
      let keys = {};
      try { keys = JSON.parse(localStorage.getItem("sirius_keys")) || {}; } catch (e) { keys = {}; }
      const r = await fetch(`${API}/mythos/consult`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ module: "PYTHAGORE#", question, keys }),
      });
      const d = await r.json().catch(() => ({}));
      setAnswer(r.ok && d.reponse ? d.reponse : (typeof d.detail === "string" ? d.detail : "Explication impossible pour le moment."));
    } catch (e) { setAnswer("Explication impossible — backend injoignable."); }
    setBusy(false);
  };

  const recallHist = (h) => {
    if (h.type === "calc") {
      setTab("calc"); setExpr(h.expression); setMode(h.mode || "eval");
      setCalcOut({ result: h.result, approx: h.approx, mode: h.mode });
    } else if (h.type === "plot") {
      setTab("plot"); setPlotExpr(h.expression); setXmin(h.xmin || "-10"); setXmax(h.xmax || "10");
      setPlotErr("");
      setPlotUrl(`${API}/pythagore/plot?expr=${encodeURIComponent(h.expression)}&xmin=${h.xmin || -10}&xmax=${h.xmax || 10}&t=${Date.now()}`);
    } else {
      setTab("geo"); setGeoDesc(h.expression);
      setGeoErr("");
      setGeoUrl(`${API}/pythagore/geometry?desc=${encodeURIComponent(h.expression)}&t=${Date.now()}`);
    }
  };

  const delHist = (id) => {
    const all = loadHist().filter((h) => h.id !== id);
    saveHist(all);
    setHist(all);
  };

  const histLabel = { calc: "CALCUL", plot: "COURBE", geo: "FIGURE" };

  return (
    <div className="prime-screen" data-testid="pythagore-panel">
      <MythosBackdrop module="PYTHAGORE#" state={busy ? "busy" : "idle"} />
      <header className="zeus-head">
        <div className="oracle-title font-divine"><Sigma size={20} /> PYTHAGORE# — MATHÉMATIQUES & GÉOMÉTRIE</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="pythagore-close-btn"><X size={18} /></button>
      </header>
      {char && (
        <img
          src={char.image}
          alt={char.character}
          className="mythos-avatar"
        />
      )}
      <div className="prime-sub">CALCUL EXACT · GÉOMÉTRIE · COURBES · EXPLICATIONS — TOUT EST NOMBRE</div>

      <div className="cal-tabs">
        <button className={`cal-tab ${tab === "calc" ? "on" : ""}`} onClick={() => setTab("calc")} data-testid="pythagore-tab-calc"><Calculator size={12} /> CALCUL</button>
        <button className={`cal-tab ${tab === "geo" ? "on" : ""}`} onClick={() => setTab("geo")} data-testid="pythagore-tab-geo"><Shapes size={12} /> GÉOMÉTRIE</button>
        <button className={`cal-tab ${tab === "plot" ? "on" : ""}`} onClick={() => setTab("plot")} data-testid="pythagore-tab-plot"><LineChart size={12} /> TRACÉ</button>
        <button className={`cal-tab ${tab === "explain" ? "on" : ""}`} onClick={() => setTab("explain")} data-testid="pythagore-tab-explain"><GraduationCap size={12} /> EXPLIQUER</button>
      </div>

      {tab === "calc" && (
        <div className="cal-body">
          <div className="cal-search-row">
            <input
              className="mg-consult-input cal-input"
              placeholder="Ex : x^2 - 5x + 6 = 0 · sqrt(144) + 3^4 · sin(pi/3) · (a+b)^3"
              value={expr}
              onChange={(e) => setExpr(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && calc()}
              data-testid="pythagore-calc-input"
            />
            <select className="cal-select" value={mode} onChange={(e) => setMode(e.target.value)} data-testid="pythagore-mode-select">
              {MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <input className="cal-select py-var" value={variable} onChange={(e) => setVariable(e.target.value)} title="Variable" data-testid="pythagore-var-input" />
            <button className={`cal-act py-mic ${listening ? "on" : ""}`} onClick={dictate} title="Dicter le calcul à voix haute" data-testid="pythagore-mic-btn">
              <Mic size={14} />
            </button>
            <button className="mg-open" onClick={() => calc()} disabled={busy || !expr.trim()} data-testid="pythagore-calc-btn">
              {busy ? <Loader2 size={13} className="spin" /> : <ArrowRight size={13} />} CALCULER
            </button>
          </div>
          {listening && <div className="cal-notice">Pythagore t'écoute… énonce ton calcul (« x au carré moins cinq x plus six égale zéro »).</div>}
          {micNotice && <div className="cal-notice" data-testid="pythagore-mic-notice">{micNotice}</div>}
          {calcOut && (
            <div className={`py-result ${calcOut.error ? "ko" : ""}`} data-testid="pythagore-calc-result">
              {calcOut.error ? calcOut.error : (
                <>
                  <div className="py-result-main">{calcOut.result}</div>
                  {calcOut.approx && <div className="py-result-approx">≈ {calcOut.approx}</div>}
                </>
              )}
            </div>
          )}
          <div className="cal-empty">Notation : ^ puissance, sqrt() racine, pi, sin/cos/tan, log/exp. Résoudre accepte « = ». Le micro dicte et Pythagore répond à voix haute.</div>
        </div>
      )}

      {tab === "geo" && (
        <div className="cal-body">
          <div className="cal-search-row">
            <input
              className="mg-consult-input cal-input"
              placeholder="Décrivez une figure : « triangle rectangle 3 4 » · « cercle de rayon 5 » · « hexagone » · « polygone 9 côtés »"
              value={geoDesc}
              onChange={(e) => setGeoDesc(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && drawGeo()}
              data-testid="pythagore-geo-input"
            />
            <button className="mg-open" onClick={() => drawGeo()} disabled={!geoDesc.trim()} data-testid="pythagore-geo-btn">
              <Shapes size={13} /> DESSINER
            </button>
          </div>
          {geoErr && <div className="py-result ko">{geoErr}</div>}
          {geoUrl && (
            <img
              className="py-plot"
              src={geoUrl}
              alt="Figure dessinée par Pythagore"
              onError={() => { setGeoErr("Figure non reconnue — essayez : triangle, cercle, carré, rectangle, pentagone… ou « polygone N côtés »."); setGeoUrl(""); }}
              data-testid="pythagore-geo-img"
            />
          )}
          <div className="cal-empty">Formes : triangle (équilatéral, rectangle, 3 côtés), cercle, carré, rectangle, pentagone → dodécagone, polygone N côtés.</div>
        </div>
      )}

      {tab === "plot" && (
        <div className="cal-body">
          <div className="cal-search-row">
            <input
              className="mg-consult-input cal-input"
              placeholder="f(x) — ex : sin(x)/x · x^3 - 3x · exp(-x^2)"
              value={plotExpr}
              onChange={(e) => setPlotExpr(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && plot()}
              data-testid="pythagore-plot-input"
            />
            <input className="cal-select py-var" value={xmin} onChange={(e) => setXmin(e.target.value)} title="x min" data-testid="pythagore-xmin" />
            <input className="cal-select py-var" value={xmax} onChange={(e) => setXmax(e.target.value)} title="x max" data-testid="pythagore-xmax" />
            <button className="mg-open" onClick={() => plot()} disabled={!plotExpr.trim()} data-testid="pythagore-plot-btn">
              <LineChart size={13} /> TRACER
            </button>
          </div>
          {plotErr && <div className="py-result ko">{plotErr}</div>}
          {plotUrl && (
            <img
              className="py-plot"
              src={plotUrl}
              alt="Courbe tracée par Pythagore"
              onError={() => { setPlotErr("Tracé impossible — vérifiez l'expression."); setPlotUrl(""); }}
              data-testid="pythagore-plot-img"
            />
          )}
        </div>
      )}

      {tab === "explain" && (
        <div className="cal-body">
          <textarea
            className="mg-consult-input"
            rows={4}
            placeholder="Posez votre question : « Explique-moi le théorème de Pythagore », « Comment résoudre une équation du second degré ? »…"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            data-testid="pythagore-explain-input"
          />
          <button className="mg-open consult-go" onClick={explain} disabled={busy || !question.trim()} data-testid="pythagore-explain-btn">
            {busy ? <><Loader2 size={13} className="spin" /> RÉFLEXION…</> : <>EXPLIQUER <ArrowRight size={13} /></>}
          </button>
          {answer && <pre className="mg-consult-answer consult-answer" data-testid="pythagore-explain-answer">{answer}</pre>}
        </div>
      )}

      {tab !== "explain" && hist.length > 0 && (
        <div className="cal-body py-hist" data-testid="pythagore-history">
          <div className="consult-history-head"><History size={12} /> DERNIERS TRAVAUX DE PYTHAGORE</div>
          {hist.slice(0, 10).map((h) => (
            <div key={h.id} className="consult-hrow" data-testid="pythagore-history-row">
              <span className="consult-hdate">{histLabel[h.type] || "CALCUL"}</span>
              <span className="consult-hq" onClick={() => recallHist(h)} data-testid="pythagore-history-load">
                {h.expression}{h.type === "calc" && h.result ? ` → ${h.result}` : ""}
              </span>
              <button className="consult-hdel" title="Retirer de l'historique" onClick={() => delHist(h.id)} data-testid="pythagore-history-del">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
