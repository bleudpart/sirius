import { useEffect, useState } from "react";
import { API_BASE_URL } from "./lib/api";
import "./NummariusAnalytics.css";

const STOCKS = ["AAPL", "MSFT", "NVDA", "TSLA"];
const PERIODS = [["1m", "1 mois"], ["3m", "3 mois"], ["1y", "1 an"], ["5y", "5 ans"]];
export const marketNumber = (value, digits = 2) => Number.isFinite(value)
  ? value.toLocaleString("fr-FR", { maximumFractionDigits: digits }) : "Indisponible";
const percent = (value) => Number.isFinite(value) ? `${marketNumber(value)} %` : "Historique insuffisant";
const trendText = (trend) => ({
  above_mm200: "Au-dessus de la MM200", below_mm200: "Sous la MM200",
  on_mm200: "Sur la MM200", history_insufficient: "Historique insuffisant pour la MM200",
}[trend] || "Indisponible");

function PriceChart({ series, currency }) {
  const [candles, setCandles] = useState(false);
  const [selected, setSelected] = useState(null);
  const visible = candles ? series.slice(-120) : series;
  const active = visible.find((bar) => bar.date === selected) || visible[visible.length - 1];
  if (!visible.length) return <p>Aucune séance disponible.</p>;
  const plotted = visible.flatMap((bar) => [bar.low, bar.high, ...(!candles ? [bar.mm20, bar.mm50, bar.mm200] : [])])
    .filter(Number.isFinite);
  const low = Math.min(...plotted);
  const high = Math.max(...plotted);
  const span = high - low || 1;
  const y = (value) => 225 - (value - low) / span * 190;
  const x = (index) => 50 + index / Math.max(visible.length - 1, 1) * 820;
  const line = (key) => visible.map((bar, index) => Number.isFinite(bar[key]) ? `${x(index)},${y(bar[key])}` : null)
    .filter(Boolean).join(" ");
  const maxVolume = Math.max(1, ...visible.map((bar) => bar.volume || 0));
  return <div className="numm-tech-chart">
    <div className="numm-tech-toolbar">
      <h3>Cours & volumes</h3>
      <div role="group" aria-label="Type de graphique">
        <button type="button" aria-pressed={!candles} onClick={() => setCandles(false)}>Courbe + moyennes</button>
        <button type="button" aria-pressed={candles} onClick={() => setCandles(true)}>Chandeliers OHLC</button>
      </div>
    </div>
    <p className="numm-tech-readout" aria-live="polite">
      {active.date} · O {marketNumber(active.open)} · H {marketNumber(active.high)} · B {marketNumber(active.low)}
      {" · "}C {marketNumber(active.close)} {currency} · Volume {marketNumber(active.volume, 0)}
    </p>
    <svg viewBox="0 0 920 310" role="img" aria-label={`Graphique journalier de ${visible[0].date} à ${visible[visible.length - 1].date}`}>
      {[0, 0.5, 1].map((ratio) => <g key={ratio}>
        <line x1="50" x2="880" y1={225 - ratio * 190} y2={225 - ratio * 190} stroke="#274050" />
        <text x="4" y={229 - ratio * 190}>{marketNumber(low + ratio * span, 0)}</text>
      </g>)}
      {!candles && <>
        <polyline points={line("close")} fill="none" stroke="#81e6d9" strokeWidth="2" />
        {[["mm20", "#f2ce81"], ["mm50", "#a7a4ff"], ["mm200", "#fb96b2"]].map(([key, color]) =>
          <polyline key={key} points={line(key)} fill="none" stroke={color} strokeWidth="1.3" />)}
      </>}
      {visible.map((bar, index) => {
        const center = x(index), width = Math.max(1, Math.min(7, 700 / visible.length));
        const color = bar.close >= bar.open ? "#81e6d9" : "#ff9c93";
        return <g key={bar.date} tabIndex={0} role="button"
          aria-label={`${bar.date}, clôture ${marketNumber(bar.close)} ${currency}`}
          onFocus={() => setSelected(bar.date)} onMouseEnter={() => setSelected(bar.date)}
          onClick={() => setSelected(bar.date)} onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(bar.date); }
          }}>
          <title>{bar.date} · {bar.close} {currency}</title>
          <rect x={center - Math.max(width, 5) / 2} y="30" width={Math.max(width, 5)} height="250" fill="transparent" />
          {candles && <>
            <line x1={center} x2={center} y1={y(bar.high)} y2={y(bar.low)} stroke={color} />
            <rect x={center - width / 2} width={width} y={Math.min(y(bar.open), y(bar.close))}
              height={Math.max(1, Math.abs(y(bar.open) - y(bar.close)))} fill={color} />
          </>}
          {Number.isFinite(bar.volume) && <rect x={center - width / 2} width={width} y={280 - bar.volume / maxVolume * 35}
            height={bar.volume / maxVolume * 35} fill={color} opacity="0.45" />}
        </g>;
      })}
      <text x="50" y="302">{visible[0].date}</text>
      <text x="780" y="302">{visible[visible.length - 1].date}</text>
    </svg>
    <p>{candles ? "Chandeliers : les 120 dernières séances au maximum de la période choisie."
      : "Clôture en turquoise · MM20 en or · MM50 en violet · MM200 en rose."} Survolez ou sélectionnez une séance pour lire ses valeurs.</p>
  </div>;
}

function TechnicalTable({ analysis }) {
  const last = analysis.latest;
  const rsiState = !Number.isFinite(last.rsi14) ? "Historique insuffisant"
    : last.rsi14 >= 70 ? "Zone de surachat" : last.rsi14 <= 30 ? "Zone de survente" : "Zone neutre";
  const rows = [
    ...[20, 50, 100, 200].map((period) => [`MM${period}`, marketNumber(last[`mm${period}`]),
      `Moyenne des ${period} dernières clôtures. Une position au-dessus ou en dessous ne prédit pas la suite.`]),
    ["RSI 14", marketNumber(last.rsi14), `${rsiState}. Lissage de Wilder ; seuils 30 / 70, pas un ordre d'achat ou de vente.`],
    ["MACD 12 / 26", marketNumber(last.macd, 4), "Différence des moyennes exponentielles à 12 et 26 séances."],
    ["Signal MACD 9", marketNumber(last.macd_signal, 4), "Moyenne exponentielle à 9 observations du MACD."],
    ["Histogramme MACD", marketNumber(last.macd_histogram, 4), "Écart MACD moins signal ; décrit la dynamique, sans prédiction."],
    ["Bollinger 20", `${marketNumber(last.bollinger_lower)} / ${marketNumber(last.bollinger_upper)}`,
      "MM20 ± deux écarts-types de population ; une sortie n'est pas un signal certain."],
    ["ATR 14", marketNumber(last.atr14), "Amplitude vraie moyenne, lissage de Wilder ; exprimée dans la devise du cours."],
    ["Support / résistance 20", `${marketNumber(analysis.support_20d)} / ${marketNumber(analysis.resistance_20d)}`,
      "Simple plus bas / plus haut des vingt dernières séances ; pas une détection de niveaux confirmés."],
    ["Volume moyen 20", marketNumber(analysis.volume_average_20d, 0), "Moyenne des volumes de vingt séances complètes."],
  ];
  return <div className="numm-tech-table-wrap"><table className="numm-tech-table">
    <caption>Indicateurs techniques · dernière séance {analysis.as_of} · {analysis.currency}</caption>
    <thead><tr><th scope="col">Indicateur</th><th scope="col">Valeur</th><th scope="col">Lecture simple & méthode</th></tr></thead>
    <tbody>{rows.map(([name, value, explanation]) => <tr key={name}>
      <th scope="row">{name}</th><td>{value}</td><td>{explanation}</td>
    </tr>)}</tbody>
  </table></div>;
}

function Comparator({ period, refresh }) {
  const [symbols, setSymbols] = useState(STOCKS);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setResult(null); setError("");
    if (!symbols.length) return () => controller.abort();
    fetch(`${API_BASE_URL}/nummarius/compare?symbols=${symbols.join(",")}&period=${period}`, {
      credentials: "include", signal: controller.signal,
    }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Comparaison indisponible.");
      if (!Array.isArray(data.items)) throw new Error("Comparaison reçue incomplète.");
      if (!controller.signal.aborted) setResult(data);
    }).catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [symbols, period, refresh]);
  return <section className="numm-tech-card">
    <h3>Comparateur · jusqu'à quatre actions</h3>
    <fieldset className="numm-tech-choices"><legend>Actifs comparés</legend>
      {STOCKS.map((symbol) => <label key={symbol}><input type="checkbox" checked={symbols.includes(symbol)}
        onChange={() => setSymbols((current) => current.includes(symbol) ? current.filter((item) => item !== symbol) : [...current, symbol])} />{symbol}</label>)}
    </fieldset>
    {error && <p role="alert">{error}</p>}
    {!symbols.length && <p>Sélectionnez au moins une action.</p>}
    {!result && !error && symbols.length > 0 && <p role="status">Comparaison des sources…</p>}
    {result && <div className="numm-tech-table-wrap"><table className="numm-tech-table">
      <caption>Performances de prix hors dividendes et frais · horizons en séances · données différées</caption>
      <thead><tr><th scope="col">Action / source</th><th scope="col">Clôture</th><th scope="col">1 mois</th><th scope="col">1 an</th>
        <th scope="col">5 ans</th><th scope="col">RSI 14</th><th scope="col">Volatilité 20 j annualisée</th><th scope="col">MM200</th></tr></thead>
      <tbody>{result.items.map((item) => <tr key={item.symbol}>
        <th scope="row">{item.symbol}{item.analysis && <small>
          Séance {item.analysis.as_of} · reçu {item.analysis.fetched_at}
          {" · "}<a href={item.analysis.source_url} target="_blank" rel="noreferrer">Source</a>
          {item.analysis.age_calendar_days > 7 && " · Données anciennes"}
        </small>}</th>
        {item.status !== "available" ? <td colSpan={7}>{item.reason}</td> : <>
          <td>{marketNumber(item.analysis.latest.close)} {item.analysis.currency}</td>
          <td>{percent(item.analysis.performance_pct["1m"])}</td><td>{percent(item.analysis.performance_pct["1y"])}</td>
          <td>{percent(item.analysis.performance_pct["5y"])}</td><td>{marketNumber(item.analysis.latest.rsi14)}</td>
          <td>{percent(item.analysis.volatility_20d_annualized_pct)}</td><td>{trendText(item.analysis.trend)}</td>
        </>}
      </tr>)}</tbody>
    </table></div>}
    <p>Les dernières séances peuvent différer entre actifs. Aucun classement d'achat ni recommandation personnalisée.</p>
  </section>;
}

export default function NummariusAnalytics() {
  const [symbol, setSymbol] = useState("AAPL");
  const [period, setPeriod] = useState("1y");
  const [analysis, setAnalysis] = useState(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setAnalysis(null); setError("");
    fetch(`${API_BASE_URL}/nummarius/analysis/${symbol}?period=${period}`, {
      credentials: "include", signal: controller.signal,
    }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Analyse indisponible.");
      if (!data.latest || !Array.isArray(data.series) || !data.performance_pct || !Array.isArray(data.limitations)) {
        throw new Error("Analyse reçue incomplète ; aucun indicateur affiché.");
      }
      if (!controller.signal.aborted) setAnalysis(data);
    }).catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [symbol, period, refresh]);
  return <div className="numm-tech" data-testid="nummarius-analytics">
    <header className="numm-tech-hero">
      <div><p>PORTUS / ANALYSE TECHNIQUE</p><h2>Les chiffres avant les conclusions.</h2>
        <p>Calculs déterministes · quatre actions · lecture seule · aucun passage d'ordre.</p></div>
      <button type="button" onClick={() => setRefresh((value) => value + 1)}>Relire les données</button>
    </header>
    <div className="numm-tech-toolbar">
      <label>Action <select value={symbol} onChange={(event) => setSymbol(event.target.value)}>{STOCKS.map((item) => <option key={item}>{item}</option>)}</select></label>
      <div role="group" aria-label="Période de graphique">{PERIODS.map(([value, label]) => <button type="button" key={value}
        aria-pressed={period === value} onClick={() => setPeriod(value)}>{label}</button>)}</div>
    </div>
    {error && <p className="numm-tech-error" role="alert">{error} Aucun indicateur estimé en remplacement.</p>}
    {!analysis && !error && <p role="status">Lecture de l'historique et calcul des indicateurs…</p>}
    {analysis && <>
      <p className="numm-tech-provenance">
        <a href={analysis.source_url} target="_blank" rel="noreferrer">{analysis.source}</a>
        {" · "}{analysis.currency} · séance {analysis.as_of} · reçu {analysis.fetched_at}
        {" · "}{analysis.cached ? "cache (15 min maximum)" : "source relue"} · cours différés
      </p>
      <div className="numm-tech-metrics">
        {[
          ["Dernière clôture", `${marketNumber(analysis.latest.close)} ${analysis.currency}`, analysis.as_of],
          ["Variation 1 séance", percent(analysis.performance_pct["1d"]), "Pas une variation en temps réel"],
          ["Volatilité annualisée", percent(analysis.volatility_20d_annualized_pct), "Sur vingt rendements journaliers"],
          ["Baisse maximale", percent(analysis.max_drawdown_pct), `Sur tout l'historique disponible depuis ${analysis.history_start}`],
          ["Plus haut / plus bas", `${marketNumber(analysis.range_high)} / ${marketNumber(analysis.range_low)}`, "Sur la période affichée"],
          ["Tendance descriptive", trendText(analysis.trend), "Position de la clôture face à la MM200"],
        ].map(([label, value, detail]) => <section className="numm-tech-card" key={label}><h3>{label}</h3><strong>{value}</strong><small>{detail}</small></section>)}
      </div>
      <section className="numm-tech-card numm-tech-summary">
        <h3>Lecture simple de ΣIRIUS</h3>
        <p>{analysis.label} : {trendText(analysis.trend).toLowerCase()}. Performance sur 21 séances : {percent(analysis.performance_pct["1m"])}.
          {" "}Ces mesures décrivent le passé et n'expliquent pas, à elles seules, la cause d'une hausse ou d'une baisse.</p>
        {analysis.age_calendar_days > 7 && <p role="alert">Données anciennes : dernière séance il y a {analysis.age_calendar_days} jours. Ne pas les interpréter comme un cours actuel.</p>}
        <details><summary>Voir les données utilisées et les limites</summary>
          <p><a href={analysis.source_url} target="_blank" rel="noreferrer">{analysis.source}</a> · {analysis.currency} · {analysis.exchange} · {analysis.exchange_timezone}</p>
          <p>Dernière séance : {analysis.as_of} · récupération : {analysis.fetched_at} · {analysis.cached ? "cache" : "source relue"} (15 min maximum).</p>
          <p>{analysis.available_sessions} séances disponibles · {analysis.visible_sessions} affichées · {analysis.rejected_bars} observation(s) invalide(s) écartée(s).</p>
          <p>{analysis.incomplete_sessions_excluded} séance(s) en cours exclue(s). Les indicateurs portent sur les clôtures disponibles.</p>
          {analysis.splits?.length > 0 && <p>{analysis.splits.length} fractionnement(s) signalé(s) par la source dans l'historique ; vérifiez les ajustements avant interprétation.</p>}
          <ul>{analysis.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
        </details>
      </section>
      <PriceChart series={analysis.series} currency={analysis.currency} />
      <TechnicalTable analysis={analysis} />
    </>}
    <Comparator period={period} refresh={refresh} />
    <p className="numm-tech-disclaimer">Information descriptive, pas un conseil en investissement. Données différées susceptibles d'erreurs.
      Portefeuille, fondamentaux, actualités, alertes techniques et ordres automatiques ne font pas partie de ce premier tableau technique.</p>
  </div>;
}
