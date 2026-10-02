import { Component } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

import { reportFdeCrash } from "@/fdeOmega";
import { BACKEND_BASE_URL } from "@/lib/api";

export default class FdeErrorBoundary extends Component {
  state = { error: null, retrying: false, retryError: "" };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    reportFdeCrash(error, info?.componentStack || "");
  }

  retry = async () => {
    if (this.state.retrying) return;
    if (!/ChunkLoadError|Loading (CSS )?chunk|Failed to fetch dynamically imported module/i.test(this.state.error?.message || "")) {
      window.location.reload();
      return;
    }
    this.setState({ retrying: true, retryError: "" });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${BACKEND_BASE_URL}/health`, { signal: controller.signal });
      if (!response.ok) throw new Error(`Serveur indisponible (HTTP ${response.status}).`);
      const health = await response.json();
      if (health.status !== "ok") throw new Error("Le serveur est dégradé ou sa sonde est invalide.");
      window.location.reload();
    } catch (error) {
      this.setState({
        retrying: false,
        retryError: error.name === "AbortError"
          ? "Le serveur local ne répond pas encore. Réessayez dans un instant."
          : `Le serveur local ne répond pas encore : ${error.message}`,
      });
    } finally {
      clearTimeout(timeout);
    }
  };

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.module) {
      return (
        <div className="fde-module-error" role="alert">
          <AlertTriangle size={16} />
          <span>MODULE ISOLÉ PAR FDE_OMEGA</span>
          <button type="button" disabled={this.state.retrying} onClick={this.retry}>
            <RotateCcw size={13} /> {this.state.retrying ? "VÉRIFICATION…" : "RÉESSAYER"}
          </button>
          {this.state.retryError && <span role="status">{this.state.retryError}</span>}
        </div>
      );
    }
    return (
      <main className="fde-crash-boundary" role="alert" data-testid="fde-crash-boundary">
        <AlertTriangle size={28} />
        <h1>ΣIRIUS — INTERFACE PROTÉGÉE</h1>
        <p>FDE_OMEGA a isolé un composant instable avant qu’il ne bloque toute l’application.</p>
        {this.state.retryError && <p role="status">{this.state.retryError}</p>}
        <button type="button" disabled={this.state.retrying} onClick={this.retry}>
          <RotateCcw size={15} /> RECHARGER L’INTERFACE
        </button>
      </main>
    );
  }
}
