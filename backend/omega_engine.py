"""Safe diagnostics and recovery primitives for the SIRIUS Omega engine."""

from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
from threading import Lock
from uuid import uuid4

try:
    import psutil
except ImportError:  # Optional process metrics; diagnostics still work without it.
    psutil = None


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


class OmegaEngine:
    """Observes critical paths without modifying application source code."""

    REQUIRED_FILES = (
        "backend/server.py",
        "backend/omega_engine.py",
        "backend/sirius_brain.py",
        "backend/auth_api.py",
        "backend/media_intent.py",
        "frontend/package.json",
        "frontend/public/electron.js",
        "frontend/src/App.js",
        "frontend/src/fdeOmega.js",
        "frontend/src/lazyModules.js",
        "frontend/src/theme.js",
        "frontend/src/voice.js",
        "frontend/src/ws/media_control.js",
    )
    REQUIRED_PACKAGES = ("fastapi", "motor", "pydantic")
    SAFE_FIXES = {"retest_backend", "clear_runtime_reports"}
    SKILL_PROBES = (
        ("SME-Ω", "System Maintenance Engine", ("backend/omega_engine.py",)),
        ("FDE-Ω", "Frontend Design Engine", ("frontend/src/fdeOmega.js",)),
        ("AUDIO-Ω", "Audio Pipeline Master", ("frontend/src/voice.js",)),
        ("WS-Ω", "WebSocket Stability Core", ("frontend/src/ws/media_control.js",)),
        ("INTENT-Ω", "Intent Intelligence Engine", ("backend/sirius_brain.py", "backend/media_intent.py")),
        ("HUD-Ω", "HUD Design Master", ("frontend/src/theme.js",)),
        ("ARCH-Ω", "Architecture Manager", ("frontend/src/lazyModules.js",)),
        ("PERF-Ω", "Performance Booster", ("frontend/src/fdeOmega.js", "backend/omega_engine.py")),
        ("SEC-Ω", "Security & Hardening Engine", ("backend/auth_api.py",)),
        ("API-Ω", "Backend Optimization Engine", ("backend/server.py",)),
        ("MOD-Ω", "Module Integrity Guard", ("backend/omega_engine.py",)),
        ("EVOLVE-Ω", "Adaptive Evolution Engine", ("backend/server.py",)),
    )

    def __init__(self, project_dir: Path, history_limit: int = 100):
        self.project_dir = project_dir.resolve()
        self._history: deque[dict] = deque(maxlen=history_limit)
        self._runtime_reports: deque[dict] = deque(maxlen=history_limit)
        self._lock = Lock()
        self._frozen_paths: set[str] = set()
        self._integrity_baseline = self._capture_integrity()
        self._process = psutil.Process() if psutil else None
        # En développement (backend lancé directement, pas via l'exécutable empaqueté),
        # les fichiers source sont modifiés en continu par hot-reload — ce n'est pas une
        # anomalie. On ne réserve la sévérité "critique" (qui verrouille l'appli en mode
        # restreint) qu'à l'application empaquetée, où `SIRIUS_PACKAGED=1` est positionné
        # par desktop_backend.py : là, une dérive de fichier pendant l'exécution est
        # effectivement suspecte. En dev, on garde la détection (visible dans ARGUS) mais
        # sans bloquer ni alerter bruyamment l'utilisateur à chaque modification légitime.
        self._packaged = os.environ.get("SIRIUS_PACKAGED") == "1"

    def status(self) -> dict:
        with self._lock:
            frozen_paths = sorted(self._frozen_paths)
        return {
            "name": "SME_OMEGA",
            "version": 1,
            "mode": "safe-observe-repair",
            "active": True,
            "baseline_files": len(self._integrity_baseline),
            "frozen": bool(frozen_paths),
            "frozen_paths": frozen_paths,
            "metrics": self.metrics(),
            "skills": self.skills(),
            "capabilities": [
                "critical_path_integrity",
                "runtime_integrity_drift_detection",
                "dependency_diagnostics",
                "runtime_error_monitoring",
                "bounded_history",
                "allowlisted_recovery",
                "critical_path_freeze",
                "process_resource_metrics",
            ],
            "self_modifying": False,
        }

    def skills(self) -> list[dict]:
        result = []
        for skill_id, label, paths in self.SKILL_PROBES:
            missing = [path for path in paths if not (self.project_dir / path).is_file()]
            result.append(
                {
                    "id": skill_id,
                    "label": label,
                    "state": "degraded" if missing else "active",
                    "evidence": list(paths),
                    "missing": missing,
                }
            )
        return result

    def scan(self) -> dict:
        errors = []
        drift_paths = set()
        for relative_path in self.REQUIRED_FILES:
            path = self.project_dir / relative_path
            if not path.is_file():
                errors.append(
                    self._error(
                        "integrity",
                        "critical",
                        f"Fichier critique manquant : {relative_path}.",
                        "Restaurer le fichier depuis une version validée du projet.",
                        "manual_restore",
                    )
                )
                drift_paths.add(relative_path)
                continue
            expected_hash = self._integrity_baseline.get(relative_path)
            current_hash = self._file_hash(path)
            if expected_hash and current_hash and current_hash != expected_hash:
                errors.append(
                    self._error(
                        "integrity_drift",
                        "critical" if self._packaged else "auto",
                        f"Modification détectée pendant l'exécution : {relative_path}.",
                        "Vérifier la modification puis redémarrer SIRIUS pour accepter une version validée."
                        if self._packaged
                        else "Modification de développement (hot-reload) — sans risque, aucune action requise.",
                        "manual_restore",
                    )
                )
                drift_paths.add(relative_path)

        package_path = self.project_dir / "frontend" / "package.json"
        if package_path.is_file():
            try:
                package = json.loads(package_path.read_text(encoding="utf-8"))
                scripts = package.get("scripts") if isinstance(package, dict) else None
                for script in ("build", "test"):
                    if not isinstance(scripts, dict) or not scripts.get(script):
                        errors.append(
                            self._error(
                                "configuration",
                                "severe",
                                f"Script frontend requis absent : {script}.",
                                f"Restaurer le script npm '{script}' dans package.json.",
                                "manual_restore",
                            )
                        )
            except (OSError, UnicodeError, json.JSONDecodeError) as error:
                errors.append(
                    self._error(
                        "configuration",
                        "critical",
                        f"package.json illisible : {error}.",
                        "Restaurer un package.json valide depuis une version contrôlée.",
                        "manual_restore",
                    )
                )

        for package_name in self.REQUIRED_PACKAGES:
            if importlib.util.find_spec(package_name) is None:
                errors.append(
                    self._error(
                        "dependency",
                        "critical",
                        f"Dépendance Python absente : {package_name}.",
                        "Restaurer les dépendances backend déclarées.",
                        "retest_backend",
                    )
                )

        backend_dir = self.project_dir / "backend"
        if backend_dir.exists() and not os.access(backend_dir, os.R_OK | os.W_OK):
            errors.append(
                self._error(
                    "permissions",
                    "critical",
                    "Le dossier backend n'est pas accessible en lecture/écriture.",
                    "Rétablir les permissions du compte exécutant SIRIUS.",
                    "manual_restore",
                )
            )

        with self._lock:
            self._frozen_paths.update(drift_paths)
            errors.extend(dict(report) for report in self._runtime_reports)
            created_at = _timestamp()
            self._history.appendleft(
                {
                    "id": uuid4().hex,
                    "at": created_at,
                    "created_at": created_at,
                    "action": "scan",
                    "status": "alert" if errors else "healthy",
                    "severity": "severe" if errors else "auto",
                    "label": "DIAGNOSTIC OMEGA",
                    "detail": f"{len(errors)} anomalie(s) détectée(s)." if errors else "Aucune anomalie détectée.",
                    "count": len(errors),
                }
            )
            history = list(self._history)
        if not errors:
            errors = [
                self._error(
                    "none",
                    "auto",
                    "SME_OMEGA actif : chemins critiques et dépendances vérifiés.",
                    "Aucune intervention requise.",
                    "none",
                )
            ]
        return {
            "engine": self.status(),
            "errors": errors,
            "history": history,
            "metrics": self.metrics(),
        }

    def report(self, source: str, message: str, stack: str = "") -> dict:
        clean_message = " ".join((message or "").split())[:300]
        clean_source = " ".join((source or "runtime").split())[:40]
        severity = self._severity(clean_message)
        report = self._error(
            clean_source or "runtime",
            severity,
            clean_message or "Erreur d'exécution non détaillée.",
            "Relancer le diagnostic puis vérifier les journaux du module concerné.",
            "clear_runtime_reports",
        )
        report["stack"] = (stack or "")[:500]
        with self._lock:
            self._runtime_reports.appendleft(report)
            created_at = _timestamp()
            self._history.appendleft(
                {
                    "id": uuid4().hex,
                    "at": created_at,
                    "created_at": created_at,
                    "action": "runtime_report",
                    "status": severity,
                    "severity": severity,
                    "label": "ERREUR RUNTIME",
                    "detail": clean_message or "Erreur d'exécution non détaillée.",
                    "source": clean_source,
                }
            )
        return {"ok": True, **report}

    def fix(self, fix_id: str, confirmed: bool) -> dict:
        if not confirmed:
            return {"ok": False, "message": "Confirmation requise avant réparation."}
        if fix_id not in self.SAFE_FIXES:
            return {
                "ok": False,
                "message": "Réparation automatique refusée : action hors liste sécurisée.",
            }

        if fix_id == "clear_runtime_reports":
            with self._lock:
                count = len(self._runtime_reports)
                self._runtime_reports.clear()
            message = f"{count} rapport(s) d'exécution acquitté(s)."
        else:
            scan = self.scan()
            count = sum(error.get("errorType") != "none" for error in scan["errors"])
            message = (
                "Backend vérifié, aucune anomalie détectée."
                if count == 0
                else f"Backend vérifié, {count} anomalie(s) nécessitent une intervention."
            )

        with self._lock:
            created_at = _timestamp()
            self._history.appendleft(
                {
                    "id": uuid4().hex,
                    "at": created_at,
                    "created_at": created_at,
                    "action": fix_id,
                    "status": "completed",
                    "severity": "auto",
                    "label": "RÉPARATION OMEGA",
                    "detail": message,
                }
            )
        return {"ok": True, "message": message, "scan": self.scan()}

    def accept_path(self, relative_path: str) -> None:
        """Accepts only the authenticated path, preserving unrelated freezes."""

        if relative_path not in self.REQUIRED_FILES:
            raise ValueError("Chemin critique Omega non pris en charge.")
        digest = self._file_hash(self.project_dir / relative_path)
        if not digest:
            raise ValueError("Le chemin critique ne peut pas être validé.")
        with self._lock:
            self._integrity_baseline[relative_path] = digest
            self._frozen_paths.discard(relative_path)

    def metrics(self) -> dict:
        if not self._process:
            return {"available": False}
        try:
            memory = self._process.memory_info()
            return {
                "available": True,
                "cpu_percent": self._process.cpu_percent(interval=None),
                "memory_rss_mb": round(memory.rss / 1048576, 2),
                "threads": self._process.num_threads(),
            }
        except psutil.Error:
            return {"available": False}

    def _capture_integrity(self) -> dict[str, str]:
        baseline = {}
        for relative_path in self.REQUIRED_FILES:
            digest = self._file_hash(self.project_dir / relative_path)
            if digest:
                baseline[relative_path] = digest
        return baseline

    @staticmethod
    def _file_hash(path: Path) -> str:
        try:
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(65536), b""):
                    digest.update(chunk)
            return digest.hexdigest()
        except OSError:
            return ""

    @staticmethod
    def _severity(message: str) -> str:
        lowered = (message or "").lower()
        if any(token in lowered for token in ("crash", "corrupt", "fatal", "security")):
            return "critical"
        if any(token in lowered for token in ("error", "exception", "failed", "échec", "erreur")):
            return "severe"
        return "auto"

    @staticmethod
    def _error(
        error_type: str,
        severity: str,
        message: str,
        proposed_fix: str,
        fix_id: str,
    ) -> dict:
        return {
            "id": uuid4().hex,
            "errorType": error_type,
            "severity": severity,
            "message": message,
            "proposedFix": proposed_fix,
            "fixId": fix_id,
            "requiresConfirmation": fix_id not in {"none"},
            "repaired": False,
            "at": _timestamp(),
        }
