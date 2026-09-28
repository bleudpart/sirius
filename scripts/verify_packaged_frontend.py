"""Verify that PyInstaller embedded the current React production bundle."""

from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "frontend" / "build" / "static" / "js"
PACKAGED = ROOT / "backend" / "dist" / "sirius-backend" / "_internal" / "frontend" / "build" / "static" / "js"
VERSION_FILE = ROOT / "frontend" / "src" / "version.js"
REQUIRED_MARKERS = ("sirius-setup", "capture-interface")


def expected_version() -> str:
    match = re.search(r'APP_VERSION\s*=\s*"([^"]+)"', VERSION_FILE.read_text(encoding="utf-8"))
    if not match:
        raise RuntimeError(f"APP_VERSION introuvable dans {VERSION_FILE}")
    return match.group(1)


def newest_bundle(directory: Path) -> Path:
    bundles = sorted(directory.glob("main.*.js"), key=lambda path: path.stat().st_mtime, reverse=True)
    if not bundles:
        raise RuntimeError(f"No main bundle found in {directory}")
    return bundles[0]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    source = newest_bundle(SOURCE)
    packaged = newest_bundle(PACKAGED)
    source_hash = digest(source)
    packaged_hash = digest(packaged)
    if source_hash != packaged_hash:
        raise RuntimeError(
            "Packaged frontend is stale: "
            f"source={source.name} ({source_hash[:12]}), "
            f"packaged={packaged.name} ({packaged_hash[:12]})"
        )
    bundle_text = packaged.read_text(encoding="utf-8")
    missing = [marker for marker in REQUIRED_MARKERS if marker not in bundle_text]
    if missing:
        raise RuntimeError(f"Packaged frontend is missing required markers: {', '.join(missing)}")
    # Le test de hachage ci-dessus compare le paquet a frontend/build : il ne voit pas un
    # frontend/build lui-meme perime. La version embarquee doit donc etre verifiee a part.
    version = expected_version()
    if version not in bundle_text:
        raise RuntimeError(
            f"Packaged frontend carries a stale version: {version} absent du bundle. "
            "Relancer 'npm run build' avant l'empaquetage."
        )
    print(f"Packaged frontend verified: {packaged.name} v{version} sha256={packaged_hash}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
