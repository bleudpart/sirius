// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useRef, useState } from "react";
import { X, Image as ImageIcon, Film, Cog, CheckCircle2, AlertTriangle, Loader2, FolderCheck, Mail } from "lucide-react";

let zCounter = 90;

const TYPE_ICON = { image: ImageIcon, video: Film, outlook: Mail };

// Fenêtre de tâche contrôlée par SIRIUS : ouverture auto, étapes en direct, résultat intégré
function TaskWindow({ task, onClose }) {
  const ref = useRef(null);
  const [z, setZ] = useState(() => ++zCounter);
  const bringFront = () => setZ(++zCounter);
  const Icon = TYPE_ICON[task.type] || Cog;

  const onBarDown = (e) => {
    if (e.target.closest("button")) return;
    const el = ref.current;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    el.classList.add("dragging");
    bringFront();
    const move = (ev) => {
      el.style.left = Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - 140) + "px";
      el.style.top = Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - 60) + "px";
    };
    const up = () => {
      el.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  };

  const onResizeDown = (e) => {
    const el = ref.current;
    const r = el.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const sw = r.width, sh = r.height;
    el.classList.add("dragging");
    bringFront();
    const move = (ev) => {
      el.style.width = Math.max(272, sw + ev.clientX - sx) + "px";
      el.style.height = Math.max(192, sh + ev.clientY - sy) + "px";
    };
    const up = () => {
      el.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
    e.stopPropagation();
  };

  const badge = task.status === "done" ? "TERMINÉ" : task.status === "error" ? "ERREUR" : "EN COURS";

  return (
    <div
      ref={ref}
      className="web-window task-window"
      style={{ left: task.x, top: task.y, zIndex: z }}
      onPointerDown={bringFront}
      data-testid={`task-window-${task.id}`}
    >
      <div className="ww-bar" onPointerDown={onBarDown} title="Glisser pour déplacer" data-testid={`task-window-bar-${task.id}`}>
        <Icon size={13} />
        <div className="ww-titles">
          <span className="ww-title">{task.titre}</span>
          <span className="ww-url">TÂCHE SIRIUS · {task.type.toUpperCase()}</span>
        </div>
        <span className={`tw-badge tw-${task.status}`} data-testid={`task-window-status-${task.id}`}>
          {task.status === "running" && <Loader2 size={10} className="tw-spin" />}
          {task.status === "done" && <CheckCircle2 size={10} />}
          {task.status === "error" && <AlertTriangle size={10} />}
          {badge}
        </span>
        <button onClick={() => onClose(task.id)} title="Fermer" data-testid={`task-window-close-${task.id}`}>
          <X size={13} />
        </button>
      </div>

      <div className={`tw-steps ${task.result ? "tw-steps-mini" : ""}`} data-testid={`task-window-steps-${task.id}`}>
        {task.steps.map((s, i) => (
          <div key={i} className={`tw-step tw-step-${s.state}`}>
            <i />
            <span>{s.label}</span>
            {s.state === "active" && <em className="tw-cursor">▊</em>}
          </div>
        ))}
      </div>

      {task.result && (
        <div className="tw-result" data-testid={`task-window-result-${task.id}`}>
          {task.result.kind === "image" && (
            <img src={task.result.src} alt={task.result.legende || task.titre} data-testid={`task-window-image-${task.id}`} />
          )}
          {task.result.kind === "video" && (
            <video src={task.result.src} controls autoPlay loop data-testid={`task-window-video-${task.id}`} />
          )}
          {task.result.kind === "text" && (
            <pre className="tw-text">{task.result.texte}</pre>
          )}
          {task.result.legende && <div className="tw-caption">{task.result.legende}</div>}
        </div>
      )}

      {task.archive && (
        <div className="tw-archive" data-testid={`task-window-archive-${task.id}`}>
          <FolderCheck size={11} /> Archivé : {task.archive}
        </div>
      )}

      <div className="ww-resize" onPointerDown={onResizeDown} title="Redimensionner" data-testid={`task-window-resize-${task.id}`} />
    </div>
  );
}

export default function TaskWindows({ tasks, onClose }) {
  return tasks.map((t) => <TaskWindow key={t.id} task={t} onClose={onClose} />);
}
