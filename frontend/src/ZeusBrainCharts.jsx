import React, { useId } from "react";
import { areaPath, donutSegments, formatMs, niceScale, sectorPath, smoothPath } from "./lib/chartMath";
import { exchangeStats } from "./cortexHistory";
import "./ZeusBrainCharts.css";

const W = 360;
const H = 200;
const BLUE = "#7fb2d4";
const GOLD = "#d8b875";
const SAND = "#ffe6a3";
const RED = "#e58a80";
const number = new Intl.NumberFormat("fr-FR");
const clock = (at) => new Date(at).toLocaleTimeString("fr-FR");
const plural = (count, one, many) => `${number.format(count)} ${count > 1 ? many : one}`;
const percent = (share) => `${(share * 100).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %`;
const safeId = (id) => id.replace(/[^a-zA-Z0-9_-]/g, "");

function ChartHead({ title, subtitle }) {
  return <figcaption className="tri-chart-head">
    <b>{title}</b>
    <span>{subtitle}</span>
  </figcaption>;
}

// Cerveau 1 : durée de chaque échange terminé et premier fragment lorsqu'il a été mesuré.
export function ExchangeChart({ exchanges, busy = false, available = true }) {
  const uid = safeId(useId());
  const stats = exchangeStats(exchanges);
  const hasData = exchanges.length > 0;
  const left = 44;
  const right = W - 48;
  const top = 34;
  const bottom = H - 30;
  const peak = Math.max(0, ...exchanges.map((item) => Math.max(item.latency_ms, item.first_token_ms ?? 0)));
  const scale = niceScale(hasData ? peak : 400, 4);
  const y = (value) => bottom - (value / scale.max) * (bottom - top);
  const x = (index) => (exchanges.length === 1 ? (left + right) / 2
    : left + 14 + (index * (right - left - 28)) / (exchanges.length - 1));
  const total = exchanges.map((item, index) => ({ x: x(index), y: y(item.latency_ms), item }));
  const fragments = [];
  let run = [];
  exchanges.forEach((item, index) => {
    if (item.first_token_ms === null) {
      if (run.length) fragments.push(run);
      run = [];
    } else {
      run.push({ x: x(index), y: y(item.first_token_ms), item });
    }
  });
  if (run.length) fragments.push(run);
  const last = total[total.length - 1];
  const stamp = (item) => (item.at === null ? "avant l’ouverture" : clock(item.at));
  const label = hasData
    ? `Durée de ${plural(stats.count, "échange mesuré", "échanges mesurés")} du Cerveau 1 : dernière ${formatMs(stats.last)}, `
      + `moyenne ${formatMs(stats.average)}, maximum ${formatMs(stats.peak)}.`
    : "Durée des échanges du Cerveau 1 : aucune mesure.";
  const pointTitle = (item) => [
    item.at === null ? "Dernier échange connu à l’ouverture" : clock(item.at),
    `durée ${formatMs(item.latency_ms)}`,
    item.first_token_ms !== null ? `premier fragment ${formatMs(item.first_token_ms)}` : null,
    item.failed ? "en échec" : null,
    item.count > 1 ? `${item.count} échanges regroupés` : null,
  ].filter(Boolean).join(" · ");

  return <figure className="tri-chart" data-testid="brain-chart-latency">
    <ChartHead title="Réactivité des échanges" subtitle="Derniers échanges mesurés" />
    <svg className="tri-plot" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <defs>
        <linearGradient id={`${uid}-area`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={BLUE} stopOpacity="0.42" />
          <stop offset="100%" stopColor={BLUE} stopOpacity="0" />
        </linearGradient>
      </defs>
      {hasData && <g className="tri-key">
        <circle cx={left + 4} cy="16" r="3.5" fill={BLUE} />
        <text x={left + 12} y="19.4">Durée totale</text>
        <circle cx={left + 88} cy="16" r="3.5" fill={SAND} />
        <text x={left + 96} y="19.4">Premier fragment</text>
      </g>}
      {scale.ticks.map((tick) => <g key={tick}>
        <line className={tick === 0 ? "tri-axis" : "tri-grid"} x1={left} x2={right} y1={y(tick)} y2={y(tick)} />
        {hasData && <text className="tri-tick" x={left - 8} y={y(tick) + 3.4} textAnchor="end">{tick === 0 ? "0" : formatMs(tick)}</text>}
      </g>)}
      {hasData && total.length > 1 && <>
        <path d={areaPath(total, bottom)} fill={`url(#${uid}-area)`} />
        <line className="tri-average" x1={left} x2={right} y1={y(stats.average)} y2={y(stats.average)} />
        <text className="tri-tick tri-tick-mean" x={right + 7} y={y(stats.average) - 2}>moy.</text>
        <text className="tri-tick tri-tick-mean" x={right + 7} y={y(stats.average) + 9}>{formatMs(stats.average)}</text>
        <path className="tri-line tri-line-total" d={smoothPath(total)} />
      </>}
      {fragments.map((points) => points.length > 1
        && <path key={points[0].x} className="tri-line tri-line-fragment" d={smoothPath(points)} />)}
      {last && <circle className={`tri-halo${busy ? " is-busy" : ""}`} cx={last.x} cy={last.y} r="9" />}
      {total.map(({ x: cx, y: cy, item }, index) => <circle key={index} cx={cx} cy={cy} r={item === last.item ? 4.4 : 3}
        className={`tri-point${item === last.item ? " is-last" : ""}${item.failed ? " is-failed" : ""}`}>
        <title>{pointTitle(item)}</title></circle>)}
      {fragments.flat().map(({ x: cx, y: cy, item }, index) => <circle key={index} className="tri-point-fragment" cx={cx} cy={cy} r="3">
        <title>{pointTitle(item)}</title></circle>)}
      {hasData && (exchanges.length === 1
        ? <text className="tri-tick" x={W / 2} y={H - 9} textAnchor="middle">{stamp(exchanges[0])}</text>
        : <>
          <text className="tri-tick" x={left} y={H - 9}>{stamp(exchanges[0])}</text>
          <text className="tri-tick" x={right} y={H - 9} textAnchor="end">{stamp(exchanges[exchanges.length - 1])}</text>
        </>)}
      {!hasData && <>
        <text className="tri-empty" x={W / 2} y={(top + bottom) / 2 - 4} textAnchor="middle">
          {available ? "Aucun échange mesuré pour l’instant" : "Mesure indisponible"}</text>
        {available && <text className="tri-empty tri-empty-small" x={W / 2} y={(top + bottom) / 2 + 14} textAnchor="middle">
          Un point apparaît à chaque échange terminé.</text>}
      </>}
    </svg>
  </figure>;
}

// Cerveau 2 : issue des tâches mesurées par l'instance (terminées, échecs, file).
export function OutcomeDonut({ completed, failures, queued, busy = false, available = true }) {
  const cx = 96;
  const cy = 100;
  const radius = 64;
  const thickness = 14;
  const inset = 2;
  const inner = radius - thickness / 2 + inset;
  const outer = radius + thickness / 2 - inset;
  const pad = (inset / radius) * (180 / Math.PI);
  const values = [completed, failures, queued];
  const names = ["Terminées", "Échecs", "En file"];
  const colors = [GOLD, RED, BLUE];
  const sum = values.reduce((total, value) => total + value, 0);
  const segments = donutSegments(values, 3.5, 6);
  const finished = completed + failures;
  const rate = finished ? completed / finished : null;
  const label = available
    ? `Tâches du Cerveau 2 : ${plural(completed, "terminée", "terminées")}, ${plural(failures, "échec", "échecs")}, `
      + `${number.format(queued)} en file${rate === null ? "." : `, taux de réussite ${Math.floor(rate * 100)} %.`}`
    : "Tâches du Cerveau 2 : mesure indisponible.";

  return <figure className="tri-chart" data-testid="brain-chart-outcomes">
    <ChartHead title="Issue des tâches" subtitle="Cumul mesuré par l’instance" />
    <svg className="tri-plot" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <g className={busy ? "tri-donut is-busy" : "tri-donut"}>
        <circle className="tri-track" cx={cx} cy={cy} r={radius} strokeWidth={thickness} />
        {segments.map((segment, index) => {
          if (!segment) return null;
          const tip = `${names[index]} : ${number.format(values[index])} (${percent(segment.share)})`;
          if (segment.share === 1) {
            return <circle key={index} cx={cx} cy={cy} r={radius} fill="none" stroke={colors[index]} strokeWidth={thickness}><title>{tip}</title></circle>;
          }
          const from = segment.from + pad;
          const to = Math.max(from, segment.to - pad);
          return <path key={index} className="tri-slice" d={sectorPath(cx, cy, inner, outer, from, to)}
            fill={colors[index]} stroke={colors[index]} strokeWidth={inset * 2}><title>{tip}</title></path>;
        })}
      </g>
      <text className="tri-big" x={cx} y={cy + 4} textAnchor="middle">{available && rate !== null ? `${Math.floor(rate * 100)} %` : "—"}</text>
      <text className="tri-sub" x={cx} y={cy + 20} textAnchor="middle">
        {!available ? "indisponible" : rate === null ? "aucune tâche terminée" : "de réussite"}</text>
      {names.map((name, index) => {
        const rowY = 58 + index * 46;
        return <g key={name}>
          {index > 0 && <line className="tri-grid" x1="196" x2={W - 14} y1={rowY - 24} y2={rowY - 24} />}
          <rect x="196" y={rowY - 10} width="10" height="10" rx="3" fill={colors[index]} />
          <text className="tri-legend-label" x="213" y={rowY}>{name}</text>
          <text className="tri-legend-sub" x="213" y={rowY + 14}>{available && sum ? percent(values[index] / sum) : "—"}</text>
          <text className="tri-legend-value" x={W - 14} y={rowY + 8} textAnchor="end">{available ? number.format(values[index]) : "—"}</text>
        </g>;
      })}
    </svg>
  </figure>;
}

const PETALS = [[3, 87], [93, 177], [183, 267], [273, 357]];

// Cerveau 3 : tâches terminées par chacun des quatre agents supervisés.
export function SquadRose({ agents, available = true }) {
  const uid = safeId(useId());
  const cx = 180;
  const cy = 100;
  const inner = 26;
  const outer = 80;
  const peak = Math.max(0, ...agents.map((agent) => agent.completed));
  const scale = niceScale(peak || 4, 4, { integer: true });
  const reach = (value) => inner + ((outer - inner) * value) / scale.max;
  const total = agents.reduce((sum, agent) => sum + agent.completed, 0);
  const label = available
    ? `Tâches terminées par agent du Cerveau 3 : ${agents.map((agent) => `${agent.label} ${agent.completed}`).join(", ")}.`
    : "Agents du Cerveau 3 : mesure indisponible.";

  return <figure className="tri-chart" data-testid="brain-chart-squad">
    <ChartHead title="Travail de l’escouade" subtitle={`Cumul de l’instance · échelle 0–${scale.max}`} />
    <svg className="tri-plot" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <defs>
        {agents.map((agent) => <radialGradient key={agent.id} id={`${uid}-${agent.id}`} gradientUnits="userSpaceOnUse"
          cx={cx} cy={cy} r={outer}>
          <stop offset={inner / outer} stopColor={agent.color} stopOpacity="0.25" />
          <stop offset="1" stopColor={agent.color} stopOpacity="0.95" />
        </radialGradient>)}
      </defs>
      {scale.ticks.slice(1).map((tick) => <circle key={tick} className="tri-grid" cx={cx} cy={cy} r={reach(tick)} fill="none" />)}
      {agents.map((agent, index) => {
        const [from, to] = PETALS[index];
        const alert = ["failed", "degraded"].includes(agent.status);
        return <g key={agent.id}>
          <path className="tri-petal-track" d={sectorPath(cx, cy, inner, outer, from, to)} />
          {available && agent.completed > 0 && <path d={sectorPath(cx, cy, inner, reach(agent.completed), from, to)}
            className={`tri-petal${agent.status === "busy" ? " is-busy" : ""}${alert ? " is-alert" : ""}`}
            fill={`url(#${uid}-${agent.id})`} stroke={alert ? RED : agent.color}>
            <title>{`${agent.label} : ${plural(agent.completed, "tâche terminée", "tâches terminées")}`
              + `${agent.failures ? `, ${plural(agent.failures, "échec", "échecs")}` : ""} · ${agent.statusLabel}`}</title>
          </path>}
        </g>;
      })}
      <text className="tri-sub" x={cx} y={cy - 5} textAnchor="middle">total</text>
      <text className="tri-big tri-big-small" x={cx} y={cy + 13} textAnchor="middle">{available ? number.format(total) : "—"}</text>
      {agents.map((agent, index) => {
        const right = index < 2;
        const baseY = index === 0 || index === 3 ? 48 : 132;
        const lx = right ? 270 : 90;
        const anchor = right ? "start" : "end";
        const dotX = right ? 264 : 96;
        const alert = ["failed", "degraded"].includes(agent.status);
        return <g key={agent.id}>
          <circle cx={dotX} cy={baseY - 3.5} r="3.5" fill={agent.color} />
          <text className="tri-legend-label" x={lx} y={baseY} textAnchor={anchor}>{agent.label}</text>
          <text className="tri-legend-sub" x={lx} y={baseY + 13} textAnchor={anchor}>
            {available ? plural(agent.completed, "terminée", "terminées") : "—"}</text>
          {available && agent.status !== "idle" && <text className={`tri-legend-sub ${alert ? "tri-warn" : agent.status === "busy" ? "tri-live" : ""}`}
            x={lx} y={baseY + 26} textAnchor={anchor}>{agent.statusLabel}</text>}
          {available && agent.failures > 0 && <text className="tri-legend-sub tri-warn" x={lx} y={baseY + (agent.status !== "idle" ? 39 : 26)}
            textAnchor={anchor}>{plural(agent.failures, "échec", "échecs")}</text>}
        </g>;
      })}
    </svg>
  </figure>;
}
