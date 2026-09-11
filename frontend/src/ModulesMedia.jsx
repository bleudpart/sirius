import { useCallback, useEffect, useState } from "react";
import { Clapperboard, ExternalLink, Headphones, Loader2, RefreshCw } from "lucide-react";
import { getHudMediaActionLabel, openHudMediaModule } from "./hud_media";
import "./media-modules.css";

const BACKEND_URL = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "");
const MEDIA_MODULES_ENDPOINT = `${BACKEND_URL}/modules/media`;

function hasExpectedModuleShape(mediaModule) {
  return Boolean(
    mediaModule
      && typeof mediaModule.id === "string"
      && typeof mediaModule.name === "string"
      && typeof mediaModule.description === "string"
      && typeof mediaModule.url === "string"
      && ["audio", "video"].includes(mediaModule.media_type)
  );
}

export default function ModulesMedia({ onOpenModule }) {
  const [modules, setModules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadModules = useCallback(async (signal) => {
    setLoading(true);
    setError("");

    try {
      const response = await fetch(MEDIA_MODULES_ENDPOINT, { signal });
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        throw new Error("Le catalogue multimédia a renvoyé une réponse invalide.");
      }
      const payload = await response.json().catch(() => {
        throw new Error("Le catalogue multimédia a renvoyé une réponse invalide.");
      });

      if (!response.ok) {
        throw new Error(payload.detail || "Le catalogue multimédia est indisponible.");
      }
      if (!Array.isArray(payload.modules) || !payload.modules.every(hasExpectedModuleShape)) {
        throw new Error("Le catalogue multimédia reçu est invalide.");
      }

      setModules(payload.modules);
    } catch (requestError) {
      if (requestError instanceof Error && requestError.name === "AbortError") {
        return;
      }
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Le catalogue multimédia est indisponible."
      );
    } finally {
      if (!signal || !signal.aborted) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadModules(controller.signal);

    return () => controller.abort();
  }, [loadModules]);

  const openModule = (mediaModule) => {
    try {
      openHudMediaModule(mediaModule);
      onOpenModule?.(mediaModule);
    } catch (openError) {
      setError(
        openError instanceof Error
          ? openError.message
          : "La plateforme multimédia ne peut pas être ouverte."
      );
    }
  };

  return (
    <section className="media-modules" aria-labelledby="media-modules-title" data-testid="media-modules">
      <header className="media-modules-head">
        <div>
          <span className="media-modules-kicker">ΣIRIUS MEDIA</span>
          <h2 id="media-modules-title">Modules multimédia</h2>
          <p>Accédez à vos plateformes dans une fenêtre externe compatible avec leurs politiques de sécurité.</p>
        </div>
        <button
          type="button"
          className="media-modules-refresh"
          onClick={() => loadModules()}
          disabled={loading}
          title="Actualiser les modules multimédia"
          data-testid="media-modules-refresh"
        >
          {loading ? <Loader2 size={15} className="media-modules-spin" /> : <RefreshCw size={15} />}
          ACTUALISER
        </button>
      </header>

      {error && (
        <div className="media-modules-error" role="alert" data-testid="media-modules-error">
          {error}
        </div>
      )}

      {loading && (
        <div className="media-modules-loading" data-testid="media-modules-loading">
          <Loader2 size={20} className="media-modules-spin" />
          Chargement du catalogue multimédia...
        </div>
      )}

      {!loading && !error && modules.length === 0 && (
        <div className="media-modules-empty" data-testid="media-modules-empty">
          Aucun module multimédia n'est disponible.
        </div>
      )}

      {!loading && modules.length > 0 && (
        <div className="media-modules-grid" data-testid="media-modules-list">
          {modules.map((mediaModule) => {
            const isVideo = mediaModule.media_type === "video";
            const Icon = isVideo ? Clapperboard : Headphones;

            return (
              <article
                className={`media-module-card ${isVideo ? "is-video" : "is-audio"}`}
                key={mediaModule.id}
                data-testid={`media-module-${mediaModule.id}`}
              >
                <div className={`media-module-icon ${isVideo ? "is-video" : "is-audio"}`}>
                  <Icon size={20} />
                </div>
                <div className="media-module-content">
                  <span className="media-module-type">{isVideo ? "VIDÉO" : "AUDIO"}</span>
                  <h3>{mediaModule.name}</h3>
                  <p>{mediaModule.description}</p>
                </div>
                <button
                  type="button"
                  className="media-module-open"
                  onClick={() => openModule(mediaModule)}
                  disabled={!mediaModule.available}
                  data-testid={`media-module-open-${mediaModule.id}`}
                >
                  <ExternalLink size={14} />
                  {getHudMediaActionLabel(mediaModule)}
                </button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
