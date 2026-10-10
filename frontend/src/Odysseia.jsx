import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, BookOpen, GripHorizontal, Landmark, Link2, Minus, X } from "lucide-react";
import useWheelWindow from "@/useWheelWindow";
import { ODYSSEIA_HISTORY, ODYSSEIA_QUOTES, ODYSSEIA_SOURCES } from "@/odysseiaData";
import "@/ModulesMenu.css";
import "./Odysseia.css";

function inlineMarkdown(text, keyPrefix) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*")) return <em key={key}>{part.slice(1, -1)}</em>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={key}>{part.slice(1, -1)}</code>;
    return part;
  });
}

function markdownSlug(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseMarkdown(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  const headings = [];
  const slugs = new Map();
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) { index += 1; continue; }
    if (/^---+$/.test(line)) {
      blocks.push({ type: "rule", key: index });
      index += 1;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const depth = heading[1].length;
      const title = heading[2].replace(/\s+#+$/, "");
      const baseSlug = markdownSlug(title) || `section-${index}`;
      const count = slugs.get(baseSlug) || 0;
      slugs.set(baseSlug, count + 1);
      const id = count ? `${baseSlug}-${count + 1}` : baseSlug;
      blocks.push({ type: "heading", depth, title, id, key: index });
      if (depth === 1) headings.push({ title, id });
      index += 1;
      continue;
    }
    const list = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.+)$/);
    if (list) {
      const ordered = /^\d/.test(list[2]);
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^(\s*)([-*+]|\d+[.)])\s+(.+)$/);
        if (!item || /^\d/.test(item[2]) !== ordered) break;
        items.push({ text: item[3], indent: item[1].length, key: index });
        index += 1;
      }
      blocks.push({ type: ordered ? "ol" : "ul", items, key: items[0].key });
      continue;
    }
    const start = index;
    const paragraph = [];
    while (index < lines.length && lines[index].trim()) {
      const current = lines[index].trim();
      if (/^---+$/.test(current) || /^(#{1,6})\s+/.test(current) || /^\s*([-*+]|\d+[.)])\s+/.test(lines[index])) break;
      paragraph.push(current);
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join(" "), key: start });
    if (index === start) index += 1;
  }
  return { blocks, headings };
}

function MarkdownArticle({ markdown }) {
  const { blocks, headings } = useMemo(() => parseMarkdown(markdown), [markdown]);
  return (
    <div className="odysseia-article-layout" data-testid="odysseia-era">
      <nav className="odysseia-chapters" aria-label="Chapitres de l'ère mythologique grecque">
        <label htmlFor="odysseia-chapter-select">PARCOURIR LES CHAPITRES</label>
        <select id="odysseia-chapter-select" value="" onChange={(event) => {
          document.getElementById(event.target.value)?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}>
          <option value="" disabled>Choisir un chapitre…</option>
          {headings.map((heading) => <option key={heading.id} value={heading.id}>{heading.title}</option>)}
        </select>
      </nav>
      <article className="odysseia-article">
        <section className="odysseia-lead">
          <h2>Le ciel, les récits et le nom de SIRIUS</h2>
          {ODYSSEIA_HISTORY.map((item) => <div key={item.id}><h3>{item.title}</h3><p>{item.text}</p></div>)}
          <p className="odysseia-editorial">Repère de lecture : les mythes témoignent de traditions culturelles; ils ne constituent pas à eux seuls des preuves historiques d'événements surnaturels.</p>
        </section>
        {blocks.map((block) => {
          if (block.type === "rule") return <hr key={block.key} />;
          if (block.type === "heading") {
            const Tag = `h${Math.min(block.depth, 4)}`;
            return <Tag id={block.id} key={block.key}>{inlineMarkdown(block.title, `heading-${block.key}`)}</Tag>;
          }
          if (block.type === "ul" || block.type === "ol") {
            const Tag = block.type;
            return <Tag key={block.key}>{block.items.map((item) => <li key={item.key} style={{ marginLeft: `${Math.min(item.indent, 8) * 8}px` }}>{inlineMarkdown(item.text, `list-${item.key}`)}</li>)}</Tag>;
          }
          return <p key={block.key}>{inlineMarkdown(block.text, `paragraph-${block.key}`)}</p>;
        })}
      </article>
    </div>
  );
}

const ODYSSEIA_SECTIONS = [
  { id: "citations", label: "CITATIONS", subtitle: "Inspirées des mythes", Icon: BookOpen },
  { id: "ere", label: "ÈRE GRECQUE", subtitle: "Histoire mythologique", Icon: Landmark },
  { id: "sources", label: "SOURCES", subtitle: "Textes & références", Icon: Link2 },
];
const WHEEL_SIZE = 300;
const WHEEL_CENTER = WHEEL_SIZE / 2;
const WHEEL_OUTER = 142;
const WHEEL_INNER = 88;
const wheelPolar = (radius, degrees) => {
  const radians = (degrees * Math.PI) / 180;
  return [WHEEL_CENTER + radius * Math.cos(radians), WHEEL_CENTER + radius * Math.sin(radians)];
};
const wheelArc = (centerDegrees, halfDegrees) => {
  const [startX, startY] = wheelPolar(WHEEL_OUTER, centerDegrees - halfDegrees);
  const [endX, endY] = wheelPolar(WHEEL_OUTER, centerDegrees + halfDegrees);
  const [innerEndX, innerEndY] = wheelPolar(WHEEL_INNER, centerDegrees + halfDegrees);
  const [innerStartX, innerStartY] = wheelPolar(WHEEL_INNER, centerDegrees - halfDegrees);
  return `M${startX} ${startY} A${WHEEL_OUTER} ${WHEEL_OUTER} 0 0 1 ${endX} ${endY} L${innerEndX} ${innerEndY} A${WHEEL_INNER} ${WHEEL_INNER} 0 0 0 ${innerStartX} ${innerStartY}Z`;
};

function OdysseiaWindow({ onClose }) {
  const [active, setActive] = useState(0);
  const [rotation, setRotation] = useState(0);
  const [activeQuote, setActiveQuote] = useState(0);
  const [filter, setFilter] = useState("Toutes");
  const [eraMarkdown, setEraMarkdown] = useState("");
  const [eraError, setEraError] = useState("");
  const [eraLoading, setEraLoading] = useState(false);
  const [eraReload, setEraReload] = useState(0);
  const dialogRef = useRef(null);
  const activeQuoteRef = useRef(null);
  const { minimized, setMinimized, windowProps } = useWheelWindow("odysseia");
  const voices = useMemo(() => ["Toutes", ...new Set(ODYSSEIA_QUOTES.map(({ voice }) => voice))], []);
  const quotes = useMemo(
    () => ODYSSEIA_QUOTES.filter(({ voice }) => filter === "Toutes" || voice === filter),
    [filter],
  );
  const selected = quotes[Math.min(activeQuote, quotes.length - 1)];
  const section = ODYSSEIA_SECTIONS[active];
  const sectionId = section.id;
  const step = 360 / ODYSSEIA_SECTIONS.length;

  useEffect(() => {
    if (!minimized) dialogRef.current?.focus();
  }, [minimized]);

  useEffect(() => {
    if (sectionId === "citations") activeQuoteRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, [sectionId, activeQuote, filter]);

  useEffect(() => {
    if (sectionId !== "ere" || eraMarkdown) return undefined;
    const controller = new AbortController();
    setEraLoading(true);
    setEraError("");
    const articleUrl = `${process.env.PUBLIC_URL || ""}/odysseia-ere-mythologique-grecque.md`;
    fetch(articleUrl, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((text) => {
        if (!text.trim()) throw new Error("Le document reçu est vide.");
        setEraMarkdown(text);
      })
      .catch((error) => {
        if (error.name === "AbortError") return;
        console.error("Chargement du texte ODYSSEIA impossible :", error);
        setEraError("Le texte historique n'a pas pu être chargé. Vérifie ta connexion au fichier et réessaie.");
      })
      .finally(() => setEraLoading(false));
    return () => controller.abort();
  }, [sectionId, eraMarkdown, eraReload]);

  const selectSection = (index) => {
    const target = ((index % ODYSSEIA_SECTIONS.length) + ODYSSEIA_SECTIONS.length) % ODYSSEIA_SECTIONS.length;
    const delta = ((target - active + ODYSSEIA_SECTIONS.length + Math.floor(ODYSSEIA_SECTIONS.length / 2)) % ODYSSEIA_SECTIONS.length) - Math.floor(ODYSSEIA_SECTIONS.length / 2);
    setRotation((current) => current - delta * step);
    setActive(target);
  };
  const moveQuote = (offset) => setActiveQuote((index) => (index + offset + quotes.length) % quotes.length);

  const onKeyDown = (event) => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    if (event.key === "ArrowRight") { event.preventDefault(); selectSection(active + 1); }
    if (event.key === "ArrowLeft") { event.preventDefault(); selectSection(active - 1); }
    if (section.id === "citations" && event.key === "ArrowDown") { event.preventDefault(); moveQuote(1); }
    if (section.id === "citations" && event.key === "ArrowUp") { event.preventDefault(); moveQuote(-1); }
  };

  if (minimized) {
    return (
      <div className="modwheel-overlay is-minimized odysseia-overlay" data-testid="odysseia">
        <button type="button" className="modwheel-restore" onClick={() => setMinimized(false)} aria-label="Rouvrir ODYSSEIA">
          <span className="modwheel-sigma">Ω</span> ODYSSEIA
        </button>
      </div>
    );
  }

  return (
    <div className="modwheel-overlay odysseia-overlay" data-testid="odysseia" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }} onKeyDown={onKeyDown}>
      <div
        ref={dialogRef}
        className="modwheel infowheel odysseia-window"
        role="dialog"
        aria-modal="true"
        aria-label="ODYSSEIA — bibliothèque des mythes anciens"
        tabIndex={-1}
        {...windowProps}
      >
        <button className="modwheel-min" type="button" onClick={() => setMinimized(true)} aria-label="Réduire ODYSSEIA">
          <Minus size={16} />
        </button>
        <button className="modwheel-close" type="button" onClick={onClose} aria-label="Fermer ODYSSEIA" data-testid="odysseia-close">
          <X size={18} />
        </button>
        <span className="modwheel-grip" aria-hidden="true" title="Glisser pour déplacer la fenêtre"><GripHorizontal size={16} /></span>
        <h2 className="modwheel-heading">ODYSSEIA</h2>
        <div className="modwheel-dial">
          <div className="modwheel-ring" style={{ "--rot": `${rotation}deg` }}>
            <svg viewBox={`0 0 ${WHEEL_SIZE} ${WHEEL_SIZE}`} aria-hidden="true">
              <circle className="modwheel-orbit" cx={WHEEL_CENTER} cy={WHEEL_CENTER} r={WHEEL_OUTER + 8} />
              <circle className="modwheel-orbit modwheel-orbit-inner" cx={WHEEL_CENTER} cy={WHEEL_CENTER} r={WHEEL_INNER - 10} />
              {ODYSSEIA_SECTIONS.map((item, index) => (
                <path key={item.id} className={`modwheel-seg ${index === active ? "active" : ""}`} d={wheelArc(-90 + index * step, step / 2 - 2)} />
              ))}
            </svg>
            {ODYSSEIA_SECTIONS.map((item, index) => {
              const [x, y] = wheelPolar((WHEEL_OUTER + WHEEL_INNER) / 2, -90 + index * step);
              const SectionIcon = item.Icon;
              return (
                <button
                  type="button"
                  key={item.id}
                  className={`modwheel-cat infowheel-cat ${index === active ? "active" : ""}`}
                  style={{ left: `${(x / WHEEL_SIZE) * 100}%`, top: `${(y / WHEEL_SIZE) * 100}%`, "--counter": `${-rotation}deg` }}
                  onClick={() => selectSection(index)}
                  aria-pressed={index === active}
                  data-testid={`odysseia-wheel-section-${item.id}`}
                >
                  <SectionIcon size={17} />
                  <span>{item.label}</span>
                  <small>{item.subtitle}</small>
                </button>
              );
            })}
          </div>
          <div className="modwheel-core odysseia-wheel-core" aria-live="polite">
            <img src="/Designer%20(16).png" alt="" />
            <strong>ODYSSEIA</strong>
            <em>{section.label}</em>
          </div>
        </div>
        <div className="modwheel-panel infowheel-panel odysseia-panel">
          <div className="modwheel-title">
            BIBLIOTHÈQUE DES MYTHES ANCIENS
            <span>← → pour tourner la roue</span>
          </div>
          <div className="infowheel-content odysseia-content" key={section.id}>
            {section.id === "citations" && (
              <section className="odysseia-main" aria-label="Citations mythologiques">
                <div className="odysseia-title">
                  <div><span>ODYSSEIA</span><h2>Paroles et citations conservées</h2></div>
                  <label>Figure
                    <select value={filter} onChange={(event) => { setFilter(event.target.value); setActiveQuote(0); }} aria-label="Filtrer par figure">
                      {voices.map((voice) => <option key={voice} value={voice}>{voice}</option>)}
                    </select>
                  </label>
                </div>
                <div className="odysseia-citation-list" data-testid="odysseia-citation-list">
                  {quotes.map((quote, index) => (
                    <button
                      type="button"
                      key={`${quote.voice}-${quote.text}`}
                      className={`odysseia-citation ${selected?.text === quote.text ? "active" : ""}`}
                      onClick={() => setActiveQuote(index)}
                      ref={index === activeQuote ? activeQuoteRef : null}
                      data-testid={`odysseia-quote-${index}`}
                    >
                      <q>{quote.text}</q><span>{quote.attributionUnverified ? "Attribution à vérifier : " : "Inspirée par "}{quote.voice}</span>
                    </button>
                  ))}
                </div>
                {selected && <article className="odysseia-featured" aria-live="polite">
                  <span>{selected.attributionUnverified ? "ATTRIBUTION À VÉRIFIER" : "INSPIRATION"} — {selected.voice.toUpperCase()}</span>
                  <blockquote>« {selected.text} »</blockquote>
                  <p>{selected.attributionUnverified
                    ? "Ancienne citation du HUD conservée sans modification. L'attribution et la formulation historique n'ont pas été vérifiées."
                    : "Une création contemporaine qui reprend un thème associé à cette figure mythologique. Ce texte n'est pas présenté comme une citation historique."}</p>
                  <div className="odysseia-quote-nav">
                    <button type="button" onClick={() => moveQuote(-1)} aria-label="Citation précédente" data-testid="odysseia-quote-prev"><ArrowUp size={15} /> Précédente</button>
                    <span>{activeQuote + 1} / {quotes.length}</span>
                    <button type="button" onClick={() => moveQuote(1)} aria-label="Citation suivante" data-testid="odysseia-quote-next">Suivante <ArrowDown size={15} /></button>
                  </div>
                </article>}
              </section>
            )}
            {section.id === "ere" && (
              <section className="odysseia-history" aria-label="Histoire de l'ère mythologique grecque">
                {eraLoading && <p role="status">Chargement du texte complet…</p>}
                {eraError && <p role="alert">{eraError} <button type="button" onClick={() => { setEraError(""); setEraReload((count) => count + 1); }}>Réessayer</button></p>}
                {eraMarkdown && <MarkdownArticle markdown={eraMarkdown} />}
              </section>
            )}
            {section.id === "sources" && (
              <section className="odysseia-history" aria-labelledby="odysseia-sources-title">
                <div className="odysseia-title"><div><span>DOCUMENTATION</span><h2 id="odysseia-sources-title">Textes anciens et références</h2></div></div>
                <p>Les textes anciens ci-dessous servent à contextualiser les références littéraires. Les citations créées pour le module restent distinctes de ces sources.</p>
                <ul className="odysseia-sources">
                  {ODYSSEIA_SOURCES.map((source) => <li key={source.label}><a href={source.href} target="_blank" rel="noreferrer">{source.label}</a></li>)}
                </ul>
                <p className="odysseia-editorial">Les poèmes antiques sont des œuvres littéraires transmises par des manuscrits; leurs récits ne doivent pas être confondus avec des archives événementielles.</p>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Odysseia({ open, onClose }) {
  if (!open) return null;
  return createPortal(<OdysseiaWindow onClose={onClose} />, document.body);
}
