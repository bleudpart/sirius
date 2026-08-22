"""Revue statique locale de code, sans executer le contenu fourni."""

import re


class CodeAssist:
    _LANGUAGES = {"javascript", "json", "python", "text", "typescript"}

    def analyze(self, code: str, language: str = "text") -> dict:
        source = code or ""
        if not source.strip():
            raise ValueError("Le code est vide.")
        if len(source) > 120000:
            raise ValueError("Le code depasse 120 000 caracteres.")
        normalized_language = (language or "text").lower().strip()
        if normalized_language not in self._LANGUAGES:
            normalized_language = "text"

        diagnostics = []
        for number, line in enumerate(source.splitlines(), start=1):
            stripped = line.strip()
            if re.search(r"\beval\s*\(", line):
                diagnostics.append(self._issue(number, "high", "unsafe-eval", "eval() execute du code dynamique.", "Remplacez eval() par une logique de validation explicite."))
            if re.search(r"\bexec\s*\(", line):
                diagnostics.append(self._issue(number, "high", "unsafe-exec", "exec() execute du code dynamique.", "Supprimez exec() ou utilisez un interpreteur fortement restreint."))
            if normalized_language == "python" and re.match(r"^except\s*:", stripped):
                diagnostics.append(self._issue(number, "medium", "broad-except", "Exception capturee sans type.", "Capturez une exception precise et journalisez le contexte utile."))
            if normalized_language in {"javascript", "typescript"} and "console.log(" in line:
                diagnostics.append(self._issue(number, "low", "console-log", "Trace console laissee dans le code.", "Remplacez-la par le journal applicatif ou retirez-la avant livraison."))
            if re.search(r"\b(?:TODO|FIXME)\b", line, flags=re.I):
                diagnostics.append(self._issue(number, "low", "unfinished-work", "Marqueur de travail incomplet detecte.", "Transformez ce point en tache suivie ou terminez-le."))
            if normalized_language == "python" and re.search(r"\brequests\.(?:get|post|put|delete|request)\(", line):
                if "timeout=" not in line:
                    diagnostics.append(self._issue(number, "medium", "http-timeout", "Appel HTTP sans timeout visible.", "Ajoutez un timeout explicite et gerez l'echec reseau."))

        counts = {"high": 0, "medium": 0, "low": 0}
        for item in diagnostics:
            counts[item["severity"]] += 1
        return {
            "language": normalized_language,
            "line_count": len(source.splitlines()),
            "diagnostics": diagnostics,
            "summary": {
                "total": len(diagnostics),
                **counts,
                "status": "clean" if not diagnostics else "attention",
            },
        }

    @staticmethod
    def _issue(line: int, severity: str, rule: str, message: str, recommendation: str) -> dict:
        return {
            "line": line,
            "severity": severity,
            "rule": rule,
            "message": message,
            "recommendation": recommendation,
        }

