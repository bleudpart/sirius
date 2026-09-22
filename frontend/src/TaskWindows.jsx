// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useEffect, useRef, useState } from "react";
import { X, CheckCircle2, AlertTriangle, Loader2, FolderCheck, ListTodo } from "lucide-react";

export default function TaskWindows({ tasks, onClose }) {
  const visibleTasks = [...tasks].reverse().slice(0, 12);
  const panelRef = useRef(null);
  const hideTimerRef = useRef(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
  }, []);

  useEffect(() => {
    if (!tasks.length) {
      setIsVisible(false);
      return undefined;
    }

    const hasRunningTask = tasks.some((task) => task.status === "running");
    if (hasRunningTask) {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      setIsVisible(true);
      return undefined;
    }

    setIsVisible(true);
    hideTimerRef.current = setTimeout(() => setIsVisible(false), 4500);
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [tasks]);

  const startDrag = (event) => {
    if (event.target.closest("button")) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    panel.classList.add("dragging");
    const move = (pointerEvent) => {
      panel.style.left = `${Math.min(Math.max(8, pointerEvent.clientX - offsetX), window.innerWidth - rect.width - 8)}px`;
      panel.style.top = `${Math.min(Math.max(58, pointerEvent.clientY - offsetY), window.innerHeight - rect.height - 8)}px`;
      panel.style.transform = "none";
    };
    const stop = () => {
      panel.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    event.preventDefault();
  };

  const startResize = (event) => {
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = rect.width;
    const startHeight = rect.height;
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.transform = "none";
    panel.classList.add("dragging");
    const move = (pointerEvent) => {
      const maxWidth = window.innerWidth - rect.left - 8;
      const maxHeight = window.innerHeight - rect.top - 8;
      panel.style.width = `${Math.min(maxWidth, Math.max(320, startWidth + pointerEvent.clientX - startX))}px`;
      panel.style.height = `${Math.min(maxHeight, Math.max(180, startHeight + pointerEvent.clientY - startY))}px`;
    };
    const stop = () => {
      panel.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    event.preventDefault();
    event.stopPropagation();
  };

  const closeActivity = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setIsVisible(false);
    tasks.forEach((task) => onClose(task.id));
  };

  if (!isVisible || !tasks.length) return null;

  return (
    <section ref={panelRef} className="web-window task-window task-console" data-testid="task-console">
      <header className="ww-bar" onPointerDown={startDrag} title="Glisser pour déplacer la console">
        <ListTodo size={13} />
        <div className="ww-titles">
          <span className="ww-title">ACTIVITÉ ΣIRIUS</span>
          <span className="ww-url">{tasks.filter((task) => task.status === "running").length} TÂCHE(S) EN COURS · {tasks.length} SUIVIE(S)</span>
        </div>
        <button onClick={closeActivity} title="Masquer l'activité" data-testid="task-console-close" disabled={!tasks.length}>
          <X size={13} />
        </button>
      </header>
      <div className="task-console-list">
        {!visibleTasks.length && <p className="task-console-empty">Aucune tâche en cours. Les analyses, recherches et résultats de Sirius apparaîtront ici.</p>}
        {visibleTasks.map((task) => {
          const badge = task.status === "done" ? "TERMINÉ" : task.status === "error" ? "ERREUR" : "EN COURS";
          return (
            <article className={`task-console-row task-${task.status}`} key={task.id} data-testid={`task-window-${task.id}`}>
              <div className="task-console-head">
                <strong>{task.titre}</strong>
                <span className={`tw-badge tw-${task.status}`} data-testid={`task-window-status-${task.id}`}>
                  {task.status === "running" && <Loader2 size={10} className="tw-spin" />}
                  {task.status === "done" && <CheckCircle2 size={10} />}
                  {task.status === "error" && <AlertTriangle size={10} />}
                  {badge}
                </span>
                <button onClick={() => onClose(task.id)} title="Retirer du suivi" data-testid={`task-window-close-${task.id}`}><X size={12} /></button>
              </div>
              {task.steps.slice(-3).map((step, index) => <div className={`tw-step tw-step-${step.state}`} key={index}><i /><span>{step.label}</span></div>)}
              {task.result?.texte && <p className="task-console-result">{task.result.texte}</p>}
              {task.result?.legende && <p className="task-console-caption">{task.result.legende}</p>}
              {task.archive && <p className="task-console-caption"><FolderCheck size={11} /> Archivé : {task.archive}</p>}
            </article>
          );
        })}
      </div>
      <div className="ww-resize task-console-resize" onPointerDown={startResize} title="Redimensionner" data-testid="task-console-resize" />
    </section>
  );
}
