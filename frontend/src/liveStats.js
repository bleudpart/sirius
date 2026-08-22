// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés.
// Horloge et stats système isolées : évite de re-rendre tout le HUD chaque seconde.
import { useEffect, useState } from "react";
import { Cpu, Activity } from "lucide-react";
import { formatLocalDate, formatLocalTime, formatUtcTime } from "./dateTime";

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

function useClockNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => {
      setNow(new Date());
    }, 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function getClockValues() {
  const nowLocal = new Date();
  const nowUTC = new Date(Date.now());
  return {
    timeLocal: formatLocalTime(nowLocal),
    timeUTC: formatUtcTime(nowUTC),
    dayLocal: formatLocalDate(nowLocal),
  };
}

export function LiveTime() {
  useClockNow();
  return getClockValues().timeLocal;
}

export function LiveDate() {
  useClockNow();
  return getClockValues().dayLocal;
}

export function LiveClock({ variant = "hud" }) {
  useClockNow();
  const { timeLocal, timeUTC, dayLocal } = getClockValues();

  if (variant === "card") {
    return (
      <div className="cc-clock" data-testid="sirius-clock-card">
        <div className="cc-huge" data-testid="sirius-time">{timeLocal}</div>
        <div className="cc-utc" data-testid="sirius-time-utc">UTC · {timeUTC}</div>
        <div className="cc-date" data-testid="sirius-date">{dayLocal}</div>
      </div>
    );
  }

  return (
    <div className="hud-clock-values">
      <div className="hud-time" data-testid="sirius-time">{timeLocal}</div>
      <div className="hud-utc" data-testid="sirius-time-utc">UTC · {timeUTC}</div>
      <div className="hud-date" data-testid="sirius-date">{dayLocal}</div>
    </div>
  );
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
