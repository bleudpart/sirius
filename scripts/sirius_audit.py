"""Audit deterministe SIRIUS : failles connues, contrats de cles et fluidite."""

from __future__ import annotations

import argparse
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
SECRET_PATTERNS = (
    re.compile(r"(?:ghp_|github_pat_|gsk_|sk-[A-Za-z0-9]{20,})"),
    re.compile(r"(?i)(?:api[_-]?key|secret|token|password)\s*[:=]\s*[\"'][^\"']{12,}[\"']"),
)
KEY_NAMES = {"groq_key", "groq", "serp", "fal", "gmaps", "alphavantage"}


def run(command: list[str], cwd: Path = ROOT) -> tuple[bool, str]:
    result = subprocess.run(command, cwd=cwd, text=True, capture_output=True)
    return result.returncode == 0, (result.stdout + result.stderr)[-4000:]


def check_tracked_secrets() -> list[str]:
    ok, output = run(["git", "grep", "-nI", "-E", "ghp_|github_pat_|gsk_|sk-[A-Za-z0-9]{20,}"])
    return [] if ok or not output.strip() else ["Secret-like token found in tracked files"]


def check_key_contract() -> list[str]:
    setup = (FRONTEND / "src" / "SiriusSetup.jsx").read_text(encoding="utf-8")
    server = (ROOT / "backend" / "server.py").read_text(encoding="utf-8")
    missing = [name for name in KEY_NAMES if name not in setup]
    issues = [f"Key field missing from SiriusSetup.jsx: {name}" for name in missing]
    if "return {\"groq_env\": bool(_sb.ENV_K3_KEY), \"gmaps_env\": bool(gmaps_env)}" not in server:
        issues.append("chat/status must expose key availability only as booleans")
    if "localStorage.getItem(\"sirius_keys\")" in "\n".join(p.read_text(encoding="utf-8") for p in (FRONTEND / "src").rglob("*.js")):
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
        ok, output = run(["npm", "run", "build"], FRONTEND)
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