import { Component } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

import { reportFdeCrash } from "@/fdeOmega";

export default class FdeErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    reportFdeCrash(error, info?.componentStack || "");
  }

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.module) {
      return (
        <div className="fde-module-error" role="alert">
          <AlertTriangle size={16} />
          <span>MODULE ISOLÉ PAR FDE_OMEGA</span>
          <button type="button" onClick={() => window.location.reload()}>
            <RotateCcw size={13} /> RÉESSAYER
          </button>
        </div>
      );
    }
    return (
      <main className="fde-crash-boundary" role="alert" data-testid="fde-crash-boundary">
        <AlertTriangle size={28} />
        <h1>SIRIUS — INTERFACE PROTÉGÉE</h1>
        <p>FDE_OMEGA a isolé un composant instable avant qu’il ne bloque toute l’application.</p>
        <button type="button" onClick={() => window.location.reload()}>
          <RotateCcw size={15} /> RECHARGER L’INTERFACE
        </button>
      </main>
    );
  }
}
