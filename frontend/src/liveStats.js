// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés.
// Horloge et stats système isolées : évite de re-rendre tout le HUD chaque seconde.
import { useEffect, useState } from "react";
import { Cpu, Activity } from "lucide-react";

let stats = { cpu: 12, ram: 43 };
const subs = new Set();

export function pushStats(patch) {
  stats = { ...stats, ...patch };
  subs.forEach((fn) => fn(stats));
}

export function pushSimStats() {
  pushStats({
    cpu: Math.max(4, Math.min(96, stats.cpu + (Math.random() - 0.5) * 14)),
    ram: Math.max(20, Math.min(92, stats.ram + (Math.random() - 0.5) * 6)),
  });
}

export function useLiveStats() {
  const [s, setS] = useState(stats);
  useEffect(() => {
    subs.add(setS);
    return () => subs.delete(setS);
  }, []);
  return s;
}

function useClockNow(intervalMs) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

const JOURS = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

export function LiveTime() {
  const now = useClockNow(1000);
  return now.toLocaleTimeString("fr-FR");
}

export function LiveDate() {
  const now = useClockNow(60000);
  return `${JOURS[now.getDay()]} ${now.getDate()} ${MOIS[now.getMonth()]} ${now.getFullYear()}`;
}

export function CpuRamMini() {
  const { cpu, ram } = useLiveStats();
  return (
    <>
      <div className="stat-line"><Cpu size={13} /><span>CPU</span><b data-testid="stat-cpu">{Math.round(cpu)}%</b></div>
      <div className="stat-line"><Activity size={13} /><span>RAM</span><b data-testid="stat-ram">{Math.round(ram)}%</b></div>
    </>
  );
}
