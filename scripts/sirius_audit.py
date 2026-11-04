"""Audit deterministe SIRIUS : failles connues, contrats de cles et fluidite."""

from __future__ import annotations

import argparse
import ast
import gzip
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
REPORT = ROOT / "audit-report.json"
# Formats complets des jetons : un prefixe seul (ex. "gsk_..." dans une aide) n'est pas un secret.
SECRET_TOKEN_PATTERNS = {
    "GitHub token": r"gh[pousr]_[A-Za-z0-9]{36}",
    "GitHub fine-grained token": r"github_pat_[A-Za-z0-9_]{40,}",
    "Groq key": r"gsk_[A-Za-z0-9]{40,}",
    "OpenAI/Anthropic key": r"sk-[A-Za-z0-9_-]{32,}",
    "Google API key": r"AIza[0-9A-Za-z_-]{35}",
}
SECRET_BOUNDARY = r"(^|[^A-Za-z0-9_-])"
SECRET_GREP_PATTERN = SECRET_BOUNDARY + "(" + "|".join(SECRET_TOKEN_PATTERNS.values()) + ")"
SECRET_PATTERNS = {
    label: re.compile(r"(?<![A-Za-z0-9_-])" + pattern) for label, pattern in SECRET_TOKEN_PATTERNS.items()
}
KEY_NAMES = {"groq_key", "groq", "serp", "fal", "gmaps", "alphavantage"}


def run(command: list[str], cwd: Path = ROOT) -> tuple[bool, str]:
    result = subprocess.run(command, cwd=cwd, text=True, capture_output=True)
    return result.returncode == 0, (result.stdout + result.stderr)[-4000:]


def find_secrets_in_text(text: str) -> list[tuple[int, str]]:
    return [
        (number, label)
        for number, line in enumerate(text.splitlines(), start=1)
        for label, pattern in SECRET_PATTERNS.items()
        if pattern.search(line)
    ]


def check_tracked_secrets(root: Path = ROOT) -> list[str]:
    # git grep : 0 = correspondance, 1 = aucune, autre = erreur (ne doit jamais passer pour un succes).
    result = subprocess.run(
        ["git", "grep", "-lIz", "-E", SECRET_GREP_PATTERN],
        cwd=root, capture_output=True,
    )
    if result.returncode == 1:
        return []
    if result.returncode != 0:
        error = result.stderr.decode("utf-8", errors="replace").strip()[-500:]
        return [f"Secret scan failed (git grep exit {result.returncode}): {error}"]
    issues = []
    for raw_path in filter(None, result.stdout.split(b"\0")):
        path = raw_path.decode("utf-8", errors="replace")
        text = (root / path).read_text(encoding="utf-8", errors="replace")
        findings = find_secrets_in_text(text)
        # Les valeurs ne sont jamais recopiees : le rapport est publie dans les journaux CI.
        issues.extend(f"Secret-like token in {path}:{number} ({label})" for number, label in findings)
        if not findings:
            issues.append(f"Secret-like token in {path} (git grep match)")
    return issues


def check_key_contract() -> list[str]:
    setup = (FRONTEND / "src" / "SiriusSetup.jsx").read_text(encoding="utf-8")
    server = (ROOT / "backend" / "server.py").read_text(encoding="utf-8")
    missing = [name for name in KEY_NAMES if name not in setup]
    issues = [f"Key field missing from SiriusSetup.jsx: {name}" for name in missing]
    status = next((node for node in ast.parse(server).body
                   if isinstance(node, ast.AsyncFunctionDef) and node.name == "chat_status"), None)
    result = next((node.value for node in status.body if isinstance(node, ast.Return)), None) if status else None

    def boolean_value(node: ast.expr) -> bool:
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            return node.func.id in {"bool", "owner_allowed"}
        if isinstance(node, ast.BoolOp):
            return all(boolean_value(value) for value in node.values)
        return isinstance(node, ast.Constant) and isinstance(node.value, bool)

    if (not isinstance(result, ast.Dict)
            or {key.value for key in result.keys if isinstance(key, ast.Constant)} != {"groq_env", "gmaps_env"}
            or not all(boolean_value(value) for value in result.values)):
        issues.append("chat/status must expose key availability only as booleans")
    sources = (p for p in (FRONTEND / "src").rglob("*.js") if not p.name.endswith(".test.js"))
    if "localStorage.getItem(\"sirius_keys\")" in "\n".join(p.read_text(encoding="utf-8") for p in sources):
        issues.append("API keys still read from localStorage")
    return issues


def check_static_contracts() -> list[str]:
    issues = []
    server = (ROOT / "backend" / "server.py").read_text(encoding="utf-8")
    pantheon = (ROOT / "backend" / "routes" / "pantheon_oracle.py").read_text(encoding="utf-8")
    if '"user_id": uid' not in server:
        issues.append("File scope is not strict per user")
    if "_decode_token(token, expected_type=\"access\")" not in server:
        issues.append("WebSocket access token validation missing")
    if "def make_pantheon_oracle_router(db, rate_ok, require_user)" not in pantheon:
        issues.append("Pantheon router auth contract missing")
    return issues


def check_bundle() -> list[str]:
    files = sorted((FRONTEND / "build" / "static" / "js").glob("main.*.js"))
    if not files:
        return ["Frontend production bundle not found"]
    bundle = files[-1]
    compressed = len(gzip.compress(bundle.read_bytes(), compresslevel=9))
    return [f"Main bundle gzip size is {compressed} bytes (limit 600000)"] if compressed > 600000 else []


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-build", action="store_true")
    args = parser.parse_args()
    checks: dict[str, list[str]] = {
        "tracked_secrets": check_tracked_secrets(),
        "key_contract": check_key_contract(),
        "static_security_contracts": check_static_contracts(),
    }
    if not args.skip_build:
        npm_command = "npm.cmd" if sys.platform == "win32" else "npm"
        ok, output = run([npm_command, "run", "build"], FRONTEND)
        if not ok:
            checks["frontend_build"] = [output]
    checks["bundle_performance"] = check_bundle()
    failures = {name: errors for name, errors in checks.items() if errors}
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "status": "fail" if failures else "pass",
        "checks": checks,
        "failures": failures,
    }
    REPORT.write_text(json.dumps(report, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())