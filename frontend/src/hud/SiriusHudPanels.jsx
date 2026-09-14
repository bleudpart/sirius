import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Calendar, Target, PieChart, ListChecks, Users, Bell, Settings2,
  Scale, Sparkles, TrendingUp, ChevronRight, Cpu, Activity, Wifi, WifiOff, Clock, RotateCcw, X, Anchor,
} from "lucide-react";
import HudPanel from "@/hud/HudPanel";
import {
  useHudHiddenKeys, restoreHudPanel, hideHudPanel,
  readFloatPos, writeFloatPos, clearFloatPos,
} from "@/hud/hudPanelState";
import { LiveClock, useLiveStats } from "@/liveStats";
import "@/hud/hud.css";

const BACKEND_BASE = process.env.REACT_APP_BACKEND_URL || "http://127.0.0.1:8001";
const API = BACKEND_BASE + "/api";
const apiEntries = new Map();

function useApi(path, refreshMs = 300000) {
  const [state, setState] = useState(() => {
    const entry = apiEntries.get(path);
    return entry ? { data: entry.data, error: entry.error } : { data: null, error: false };
  });
  useEffect(() => {
    let entry = apiEntries.get(path);
    if (!entry) {
      entry = { data: null, error: false, listeners: new Set(), timer: null, loading: false };
      apiEntries.set(path, entry);
    }
    const notify = () => setState({ data: entry.data, error: entry.error });
    entry.listeners.add(notify);
    const load = async () => {
      if (entry.loading) return;
      entry.loading = true;
      try {
        const response = await fetch(`${API}${path}`, { credentials: "include" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        entry.data = await response.json();
        entry.error = false;
      } catch (error) {
        entry.error = true;
      } finally {
        entry.loading = false;
        entry.listeners.forEach((listener) => listener());
      }
    };
    if (!entry.timer) {
      load();
      entry.timer = setInterval(load, refreshMs);
    }
    notify();
    return () => {
      entry.listeners.delete(notify);
      if (!entry.listeners.size) {
        clearInterval(entry.timer);
        apiEntries.delete(path);
      }
    };
  }, [path, refreshMs]);
  return [state.data, state.error];
}

const MOIS = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];
const JOURS = ["L", "M", "M", "J", "V", "S", "D"];

function ExecutiveCalendar({ events, connected }) {
  const [cursor, setCursor] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [selected, setSelected] = useState(() => new Date().getDate());
  const today = new Date();

  const eventDays = useMemo(() => {
    const set = new Set();
    (events || []).forEach((e) => {
      const d = new Date(e.start);
      if (d.getFullYear() === cursor.y && d.getMonth() === cursor.m) set.add(d.getDate());
    });
    return set;
  }, [events, cursor]);

  const dayEvents = useMemo(() => (events || []).filter((e) => {
    const d = new Date(e.start);
    return d.getFullYear() === cursor.y && d.getMonth() === cursor.m && d.getDate() === selected;
  }), [events, cursor, selected]);

  const first = new Date(cursor.y, cursor.m, 1);
  const offset = (first.getDay() + 6) % 7;
  const nbDays = new Date(cursor.y, cursor.m + 1, 0).getDate();
  const move = (dir) => setCursor((c) => {
    const d = new Date(c.y, c.m + dir, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  return (
    <HudPanel title="Agenda Exécutif" icon={<Calendar size={13} />} meta={`${MOIS[cursor.m]} ${cursor.y}`} side="left" delay={0} panelKey="agenda" link>
      <div className="shud-cal-nav">
        <button type="button" onClick={() => move(-1)} aria-label="Mois précédent">‹</button>
        <button type="button" onClick={() => move(1)} aria-label="Mois suivant">›</button>
      </div>
      <div className="shud-cal" role="grid" aria-label={`Calendrier ${MOIS[cursor.m]} ${cursor.y}`}>
        {JOURS.map((j, i) => <b key={`${j}${i}`}>{j}</b>)}
        {Array.from({ length: offset }, (_, i) => <span key={`v${i}`} />)}
        {Array.from({ length: nbDays }, (_, i) => {
          const day = i + 1;
          const isToday = day === today.getDate() && cursor.m === today.getMonth() && cursor.y === today.getFullYear();
          return (
            <button
              key={day}
              type="button"
              className={`shud-day ${isToday ? "today" : ""} ${day === selected ? "sel" : ""}`}
              onClick={() => setSelected(day)}
              aria-label={`Jour ${day}`}
            >
              {day}
              {eventDays.has(day) && <i className="shud-evt-dot" />}
            </button>
          );
        })}
      </div>
      {!connected && <small className="shud-muted">Agenda non connecté</small>}
      {connected && dayEvents.length > 0 && (
        <ul className="shud-evt-list">
          {dayEvents.slice(0, 3).map((e, i) => (
            <li key={i}>{e.allDay ? e.title : `${new Date(e.start).getHours()}h — ${e.title}`}</li>
          ))}
        </ul>
      )}
    </HudPanel>
  );
}

function DailyPriorities({ objectif, bilan }) {
  const items = useMemo(() => {
    const list = [];
    if (objectif && objectif.montant > 0) {
      list.push({ label: "Objectif mensuel", pct: Math.min(100, Math.round(objectif.progression_pct || 0)), tone: "gold" });
    }
    const ech = (bilan && bilan.echeances) || [];
    const retards = ech.filter((e) => e.days < 0).length;
    const proches = ech.filter((e) => e.days >= 0 && e.days <= 7).length;
    if (retards) list.push({ label: `Régler ${retards} facture${retards > 1 ? "s" : ""} en retard`, pct: 12, tone: "gold" });
    if (proches) list.push({ label: `${proches} échéance${proches > 1 ? "s" : ""} sous 7 jours`, pct: 45, tone: "cyan" });
    if (!list.length) list.push({ label: "Aucune priorité urgente", pct: 100, tone: "cyan" });
    return list.slice(0, 5);
  }, [objectif, bilan]);

  return (
    <HudPanel title="Priorités de la Journée" icon={<Target size={13} />} side="left" delay={140} panelKey="priorites" link>
      {items.map((p, i) => (
        <div className="shud-prio" key={i}>
          <div className="shud-line"><span>{p.label}</span><b>{p.pct}%</b></div>
          <div className="shud-track"><i className={p.tone} style={{ width: `${p.pct}%` }} /></div>
        </div>
      ))}
    </HudPanel>
  );
}

function StrategicPerformance({ objectif, market }) {
  const perf = Math.min(100, Math.max(0, Math.round((objectif && objectif.progression_pct) || 0)));
  const assets = ((market && market.assets) || []).filter((a) => typeof a.change === "number");
  const upCount = assets.filter((a) => a.change >= 0).length;
  const marketPct = assets.length ? Math.round((upCount / assets.length) * 100) : 0;
  const seg1 = perf;
  const seg2 = Math.min(100 - seg1, Math.round(marketPct * 0.25));
  const rest = 100 - seg1 - seg2;
  const grad = `conic-gradient(var(--sir-gold) 0 ${seg1}%, var(--sir-cyan) ${seg1}% ${seg1 + seg2}%, var(--sir-steel) ${seg1 + seg2}% 100%)`;

  return (
    <HudPanel title={<>Recommandations<br />Stratégiques &amp; Performance</>} icon={<PieChart size={13} />} side="right" delay={80} panelKey="recommandations" className="shud-wide" link>
      <div className="shud-donut-row">
        <div className="shud-donut" style={{ background: grad }} role="img" aria-label={`Performance ${seg1}%, marchés ${seg2}%, restant ${rest}%`} />
        <div className="shud-legend">
          <span><em className="g">{seg1}%</em> Objectif</span>
          <span><em className="c">{marketPct}%</em> Marchés haussiers</span>
          <span><em>{rest}%</em> Marge</span>
        </div>
      </div>
      {assets.length > 0 && (
        <div className="shud-line shud-sep">
          <span><TrendingUp size={11} /> {assets[0].label}</span>
          <b className={assets[0].change >= 0 ? "up" : "down"}>{assets[0].change >= 0 ? "+" : ""}{assets[0].change.toFixed(1)}%</b>
        </div>
      )}
    </HudPanel>
  );
}

function GoalsTracker({ objectif, bilan }) {
  const ech = (bilan && bilan.echeances) || [];
  const retards = ech.filter((e) => e.days < 0).length;
  const proches = ech.filter((e) => e.days >= 0 && e.days <= 7).length;
  const rows = [
    { label: "Objectif", val: `${Math.round((objectif && objectif.progression_pct) || 0)}%`, pct: Math.min(100, Math.round((objectif && objectif.progression_pct) || 0)) },
    { label: "Échéances 7 j", val: String(proches), pct: ech.length ? Math.round((proches / ech.length) * 100) : 0 },
    { label: "Retards", val: String(retards), pct: ech.length ? Math.round((retards / ech.length) * 100) : 0 },
  ];
  return (
    <HudPanel title="Déterminations" icon={<ListChecks size={13} />} side="right" delay={220} panelKey="determinations" link>
      {rows.map((r) => (
        <div className="shud-prio" key={r.label}>
          <div className="shud-line"><span>{r.label}</span><b>{r.val}</b></div>
          <div className="shud-track"><i className="gold" style={{ width: `${r.pct}%` }} /></div>
        </div>
      ))}
    </HudPanel>
  );
}

function PersonalResources({ connected }) {
  const { cpu, ram } = useLiveStats();
  return (
    <HudPanel title="Ressources Personnelles" icon={<Users size={13} />} side="left" delay={300} panelKey="ressources" link>
      <div className="shud-res">
        <span className="shud-res-ico"><Cpu size={13} /></span>
        <div className="shud-res-main">
          <div className="shud-line"><span>Processeur</span><b>{Math.round(cpu)}%</b></div>
          <div className="shud-track"><i className="cyan" style={{ width: `${Math.round(cpu)}%` }} /></div>
        </div>
      </div>
      <div className="shud-res">
        <span className="shud-res-ico"><Activity size={13} /></span>
        <div className="shud-res-main">
          <div className="shud-line"><span>Mémoire</span><b>{Math.round(ram)}%</b></div>
          <div className="shud-track"><i className="cyan" style={{ width: `${Math.round(ram)}%` }} /></div>
        </div>
      </div>
      <div className="shud-res">
        <span className="shud-res-ico">{connected ? <Wifi size={13} /> : <WifiOff size={13} />}</span>
        <div className="shud-res-main">
          <div className="shud-line"><span>Réseau</span><b>{connected ? "Stable" : "Hors ligne"}</b></div>
        </div>
      </div>
    </HudPanel>
  );
}

function ActiveNotifications({ bilan, weather, connected, onOpenThemis }) {
  const notifs = useMemo(() => {
    const list = [];
    const ech = (bilan && bilan.echeances) || [];
    ech.filter((e) => e.days < 0).slice(0, 2).forEach((e) => {
      list.push({ icon: <Scale size={12} />, title: e.label || "Facture en retard", sub: `${Math.abs(e.days)} j de retard`, badge: "Retard", unread: true, onClick: onOpenThemis });
    });
    ech.filter((e) => e.days >= 0 && e.days <= 7).slice(0, 2).forEach((e) => {
      list.push({ icon: <Scale size={12} />, title: e.label || "Échéance proche", sub: `Dans ${e.days} j`, badge: "Échéance", unread: false, onClick: onOpenThemis });
    });
    if (weather && weather.description) {
      list.push({ icon: <Sparkles size={12} />, title: `Météo ${weather.ville || ""}`, sub: `${weather.description}, ${weather.temp}°`, badge: `${weather.temp}°`, unread: false });
    }
    if (!connected) {
      list.push({ icon: <WifiOff size={12} />, title: "Connexion au noyau", sub: "Reconnexion en cours…", badge: "Hors ligne", unread: true });
    }
    if (!list.length) list.push({ icon: <Bell size={12} />, title: "Aucune notification", sub: "Tout est calme", badge: "OK", unread: false });
    return list;
  }, [bilan, weather, connected, onOpenThemis]);

  return (
    <HudPanel title="Notifications Actives" icon={<Bell size={13} />} meta={String(notifs.filter((n) => n.unread).length || "")} side="left" delay={380} panelKey="notifications" link>
      <ul className="shud-notifs">
        {notifs.map((n, i) => (
          <li key={i}>
            <button type="button" onClick={n.onClick} disabled={!n.onClick}>
              <span className="shud-res-ico">{n.icon}</span>
              <span className="shud-notif-txt"><b>{n.title}</b><small>{n.sub}</small></span>
              <span className={`shud-badge ${n.unread ? "unread" : ""}`}>{n.badge}</span>
            </button>
          </li>
        ))}
      </ul>
    </HudPanel>
  );
}

function TimePanel() {
  return (
    <HudPanel title="Heure & UTC" icon={<Clock size={13} />} side="right" delay={340} panelKey="heure" className="shud-clock">
      <LiveClock />
    </HudPanel>
  );
}

function QuickSettings({ ecoMode, setEcoMode }) {
  const [vol, setVol] = useState(() => Math.round(parseFloat(localStorage.getItem("sirius_ambient_volume") || "0.12") * 100));
  const applyVol = (v) => {
    setVol(v);
    localStorage.setItem("sirius_ambient_volume", String(v / 100));
    if (window.__siriusAmbient) window.__siriusAmbient.volume = v / 100;
  };
  return (
    <HudPanel title="Paramètres" icon={<Settings2 size={13} />} side="right" delay={460} panelKey="parametres">
      <label className="shud-select">
        <span>Mode d'énergie</span>
        <select value={ecoMode ? "eco" : "normal"} onChange={(e) => setEcoMode(e.target.value === "eco")}>
          <option value="normal">Performance</option>
          <option value="eco">Économie</option>
        </select>
      </label>
      <label className="shud-select">
        <span>Volume ambiance</span>
        <select value={String(vol)} onChange={(e) => applyVol(Number(e.target.value))}>
          <option value="0">Coupé</option>
          <option value="12">12 %</option>
          <option value="25">25 %</option>
          <option value="50">50 %</option>
        </select>
      </label>
    </HudPanel>
  );
}

function QuickActions({ onOpenOracle, onOpenThemis, onOpenAgora }) {
  const acts = [
    { label: "Oracle · Prévisions", icon: <Sparkles size={13} />, fn: onOpenOracle },
    { label: "Thémis · Gestion", icon: <Scale size={13} />, fn: onOpenThemis },
    { label: "Agora · Objectifs", icon: <TrendingUp size={13} />, fn: onOpenAgora },
  ];
  return (
    <div className="shud-actions" role="group" aria-label="Actions rapides">
      {acts.map((a) => (
        <button key={a.label} type="button" onClick={a.fn}>
          {a.icon}<span>{a.label}</span><ChevronRight size={12} />
        </button>
      ))}
    </div>
  );
}

const NEXT_ACTIONS_KEY = "prochaines-actions";

// Pilule « Prochaines Actions » : jusqu'ici un simple bouton figé (ni déplaçable, ni
// fermable, et le clic passait mal via automatisation à cause de l'animation de flottement
// shudFloat) — on lui donne le même comportement de fenêtre HUD que les autres panneaux :
// glisser pour déplacer (position mémorisée), bouton de fermeture (masque la pilule, avec
// une petite puce de restauration), et le popover garde son bouton de fermeture propre.
function NextActionsButton({ events, bilan, connected }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const draggedRef = useRef(false);
  const hiddenKeys = useHudHiddenKeys();
  const hidden = hiddenKeys.has(NEXT_ACTIONS_KEY);
  const [floatPos, setFloatPos] = useState(() => readFloatPos(NEXT_ACTIONS_KEY));
  const todayIso = new Date().toISOString().slice(0, 10);
  const todays = (events || []).filter((e) => (e.start || "").slice(0, 10) === todayIso);
  const proches = ((bilan && bilan.echeances) || []).filter((e) => e.days >= 0 && e.days <= 7);

  const onPointerDown = (e) => {
    // Exclut le popover et les petits boutons fermer/réancrer (leur propre clic doit rester
    // prioritaire) — mais PAS le bouton principal .shud-next : toute la pilule visible EST
    // ce bouton, donc le glisser doit pouvoir démarrer dessus (le seuil de distance ci-dessous
    // distingue ensuite un simple clic d'un vrai glisser).
    if (e.target.closest(".shud-next-pop, .shud-next-close, .shud-next-redock")) return;
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const startLeft = r.left, startTop = r.top;
    const sx = e.clientX, sy = e.clientY;
    draggedRef.current = false;
    const onMove = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!draggedRef.current && Math.hypot(dx, dy) < 5) return; // seuil : distingue clic vs glisser
      if (!draggedRef.current) {
        draggedRef.current = true;
        el.classList.add("shud-dragging");
      }
      const nl = Math.min(Math.max(0, startLeft + dx), window.innerWidth - 40);
      const nt = Math.min(Math.max(0, startTop + dy), window.innerHeight - 40);
      el.style.position = "fixed";
      el.style.left = `${nl}px`;
      el.style.top = `${nt}px`;
      el.style.margin = "0";
      el.style.zIndex = "500";
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      el.classList.remove("shud-dragging");
      if (draggedRef.current) {
        const rect = el.getBoundingClientRect();
        const pos = { left: rect.left, top: rect.top };
        setFloatPos(pos);
        writeFloatPos(NEXT_ACTIONS_KEY, pos);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const handleToggle = () => {
    if (draggedRef.current) { draggedRef.current = false; return; } // ignore le clic qui suit un glisser
    setOpen((o) => !o);
  };

  const redock = () => {
    const el = wrapRef.current;
    if (el) {
      el.style.position = "";
      el.style.left = "";
      el.style.top = "";
      el.style.margin = "";
      el.style.zIndex = "";
    }
    setFloatPos(null);
    clearFloatPos(NEXT_ACTIONS_KEY);
  };

  if (hidden) {
    return (
      <button
        type="button"
        className="shud-next-restore"
        onClick={() => restoreHudPanel(NEXT_ACTIONS_KEY)}
        title="Réafficher « Prochaines Actions »"
      >
        <RotateCcw size={11} /> Prochaines Actions
      </button>
    );
  }

  return (
    <div
      ref={wrapRef}
      className="shud-next-wrap"
      onPointerDown={onPointerDown}
      style={floatPos ? { position: "fixed", left: floatPos.left, top: floatPos.top, margin: 0, zIndex: 500 } : undefined}
      title="Glisser pour déplacer cette pilule"
    >
      <button type="button" className="shud-next" onClick={handleToggle} aria-expanded={open}>
        Prochaines Actions <ChevronRight size={13} />
      </button>
      {floatPos && (
        <button type="button" className="shud-icon-btn shud-next-redock" onClick={redock} title="Réancrer">
          <Anchor size={11} />
        </button>
      )}
      <button
        type="button"
        className="shud-icon-btn shud-close shud-next-close"
        onClick={() => hideHudPanel(NEXT_ACTIONS_KEY)}
        title="Fermer cette pilule"
      >
        <X size={11} />
      </button>
      {open && (
        <div className="shud-next-pop" role="dialog" aria-label="Prochaines actions">
          <button type="button" className="shud-next-pop-close" onClick={() => setOpen(false)} title="Fermer">
            <X size={12} />
          </button>
          <b>Aujourd'hui</b>
          {todays.length
            ? todays.slice(0, 4).map((e, i) => <p key={i}>{e.allDay ? e.title : `${new Date(e.start).getHours()}h — ${e.title}`}</p>)
            : <p>{connected ? "Aucun rendez-vous aujourd'hui." : "Agenda non connecté."}</p>}
          {proches.length > 0 && (<><b>Échéances</b>{proches.slice(0, 3).map((e, i) => <p key={i}>{e.label || "Échéance"} · {e.days} j</p>)}</>)}
        </div>
      )}
    </div>
  );
}

const LEFT_PANEL_TITLES = { agenda: "Agenda Exécutif", priorites: "Priorités de la Journée", ressources: "Ressources Personnelles", notifications: "Notifications Actives" };
const RIGHT_PANEL_TITLES = { recommandations: "Recommandations", determinations: "Déterminations", heure: "Heure & UTC", parametres: "Paramètres" };

// Barre compacte listant les fenêtres HUD fermées de cette colonne, pour les rouvrir d'un
// clic — sans elle, fermer une fenêtre serait irréversible sans vider le localStorage.
function HudRestoreBar({ titles }) {
  const hidden = useHudHiddenKeys();
  const entries = Object.entries(titles).filter(([k]) => hidden.has(k));
  if (!entries.length) return null;
  return (
    <div className="shud-restore-bar" role="group" aria-label="Fenêtres masquées">
      {entries.map(([k, label]) => (
        <button key={k} type="button" className="shud-restore-chip" onClick={() => restoreHudPanel(k)} title={`Réafficher « ${label} »`}>
          <RotateCcw size={10} /> {label}
        </button>
      ))}
    </div>
  );
}

export function SiriusLeftColumn({ weather, connected, onOpenThemis }) {
  const [cal, calErr] = useApi("/calendar/events?max_results=30");
  const [objectif] = useApi("/agora/objectif");
  const [bilan] = useApi("/themis/bilan");
  const events = (cal && cal.events) || [];
  const calConnected = !calErr && !!cal;
  return (
    <>
      <ExecutiveCalendar events={events} connected={calConnected} />
      <DailyPriorities objectif={objectif} bilan={bilan} />
      <PersonalResources connected={connected} />
      <ActiveNotifications bilan={bilan} weather={weather} connected={connected} onOpenThemis={onOpenThemis} />
      <HudRestoreBar titles={LEFT_PANEL_TITLES} />
    </>
  );
}

export function SiriusRightColumn({ ecoMode, setEcoMode, onOpenOracle, onOpenThemis, onOpenAgora }) {
  const [objectif] = useApi("/agora/objectif");
  const [bilan] = useApi("/themis/bilan");
  const [market] = useApi("/nummarius/market");
  return (
    <>
      <StrategicPerformance objectif={objectif} market={market} />
      <GoalsTracker objectif={objectif} bilan={bilan} />
      <TimePanel />
      <QuickSettings ecoMode={ecoMode} setEcoMode={setEcoMode} />
      <QuickActions onOpenOracle={onOpenOracle} onOpenThemis={onOpenThemis} onOpenAgora={onOpenAgora} />
      <HudRestoreBar titles={RIGHT_PANEL_TITLES} />
    </>
  );
}

export function SiriusNextAction({ connected }) {
  const [cal, calErr] = useApi("/calendar/events?max_results=30");
  const [bilan] = useApi("/themis/bilan");
  const events = (cal && cal.events) || [];
  const calConnected = !calErr && !!cal;
  return <NextActionsButton events={events} bilan={bilan} connected={calConnected} />;
}

export default function SiriusHudPanels({
  weather, connected, ecoMode, setEcoMode,
  onOpenOracle, onOpenThemis, onOpenAgora,
}) {
  const [drawer, setDrawer] = useState(false);
  const [cal, calErr] = useApi("/calendar/events?max_results=30");
  const [objectif] = useApi("/agora/objectif");
  const [bilan] = useApi("/themis/bilan");
  const [market] = useApi("/nummarius/market");
  const events = (cal && cal.events) || [];
  const calConnected = !calErr && !!cal;

  return (
    <>
      <button type="button" className="shud-drawer-btn" onClick={() => setDrawer((d) => !d)} aria-expanded={drawer} aria-label="Afficher les panneaux">
        HUD
      </button>
      <div className={`shud-layer ${drawer ? "open" : ""}`} data-testid="sirius-hud-panels">
        <div className="shud-col left">
          <ExecutiveCalendar events={events} connected={calConnected} />
          <DailyPriorities objectif={objectif} bilan={bilan} />
          <PersonalResources connected={connected} />
          <ActiveNotifications bilan={bilan} weather={weather} connected={connected} onOpenThemis={onOpenThemis} />
        </div>
        <div className="shud-col right">
          <StrategicPerformance objectif={objectif} market={market} />
          <GoalsTracker objectif={objectif} bilan={bilan} />
          <TimePanel />
          <QuickSettings ecoMode={ecoMode} setEcoMode={setEcoMode} />
          <QuickActions onOpenOracle={onOpenOracle} onOpenThemis={onOpenThemis} onOpenAgora={onOpenAgora} />
        </div>
        <NextActionsButton events={events} bilan={bilan} connected={calConnected} />
      </div>
    </>
  );
}
