"""Verify that PyInstaller embedded the current React bundle and the web agent's Chromium."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "frontend" / "build" / "static" / "js"
PACKAGED = ROOT / "backend" / "dist" / "sirius-backend" / "_internal" / "frontend" / "build" / "static" / "js"
PACKAGED_BROWSERS = ROOT / "backend" / "dist" / "sirius-backend" / "_internal" / "playwright-browsers"
PACKAGED_VOICE_RUNTIME = (
    ROOT / "backend" / "dist" / "sirius-backend" / "_internal" / "voice-runtime"
)
VOICE_MODEL_NAME = "wespeaker_en_voxceleb_resnet34_LM.onnx"
VOICE_MODEL_SHA256 = "e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012"
VERSION_FILE = ROOT / "frontend" / "src" / "version.js"
PACKAGE_FILE = ROOT / "frontend" / "package.json"
REQUIRED_MARKERS = ("sirius-setup", "capture-interface")
# Le lanceur chrome.exe pese ~4 Mo : en dessous, la copie est tronquee ou factice.
MIN_CHROME_BYTES = 1_000_000


def expected_version() -> str:
    match = re.search(r'APP_VERSION\s*=\s*"([^"]+)"', VERSION_FILE.read_text(encoding="utf-8"))
    if not match:
        raise RuntimeError(f"APP_VERSION introuvable dans {VERSION_FILE}")
    return match.group(1)


def release_version() -> str:
    package = __import__("json").loads(PACKAGE_FILE.read_text(encoding="utf-8"))
    source = expected_version()
    if package.get("version") != source:
        raise RuntimeError(
            f"Release metadata mismatch: package.json={package.get('version')} "
            f"but version.js={source}. Run the synchronized version bump."
        )
    return source


def newest_bundle(directory: Path) -> Path:
    bundles = sorted(directory.glob("main.*.js"), key=lambda path: path.stat().st_mtime, reverse=True)
    if not bundles:
        raise RuntimeError(f"No main bundle found in {directory}")
    return bundles[0]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def packaged_chromium(browsers: Path = PACKAGED_BROWSERS) -> Path:
    """Return the packaged chrome.exe; the web agent cannot run in the installed app without it."""
    for executable in sorted(browsers.glob("chromium-*/**/chrome.exe")):
        if executable.stat().st_size >= MIN_CHROME_BYTES:
            return executable
    command = f'"{sys.executable}" -m playwright install chromium'
    raise RuntimeError(
        f"Chromium absent du paquet backend ({browsers}) : l'agent web ne marcherait pas dans "
        f"l'application installee. Lancer {command}, puis 'npm run backend:build'."
    )


def verify_packaged_voice_runtime(runtime: Path = PACKAGED_VOICE_RUNTIME) -> None:
    model = runtime / "model" / VOICE_MODEL_NAME
    ffmpeg = runtime / "ffmpeg" / "ffmpeg.exe"
    notice = runtime / "NOTICE.txt"
    license_file = runtime / "ffmpeg" / "LICENSE.txt"
    manifest_path = runtime / "manifest.json"
    missing = [path for path in (model, ffmpeg, notice, license_file, manifest_path) if not path.is_file()]
    if missing:
        raise RuntimeError(
            "Runtime de vérification vocale incomplet : "
            + ", ".join(str(path) for path in missing)
        )
    dlls = list((runtime / "ffmpeg").glob("*.dll"))
    if not dlls:
        raise RuntimeError("Les bibliothèques FFmpeg du runtime vocal sont absentes.")
    if digest(model) != VOICE_MODEL_SHA256:
        raise RuntimeError("Le SHA-256 du modèle vocal embarqué ne correspond pas à la version approuvée.")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("model_sha256") != VOICE_MODEL_SHA256:
        raise RuntimeError("Le manifeste du runtime vocal ne valide pas le modèle attendu.")


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
    version = release_version()
    if version not in bundle_text:
        raise RuntimeError(
            f"Packaged frontend carries a stale version: {version} absent du bundle. "
            "Relancer 'npm run build' avant l'empaquetage."
        )
    print(f"Packaged frontend verified: {packaged.name} v{version} sha256={packaged_hash}")
    # Le Chromium n'est embarque que par le build Windows (cache Playwright de la machine de build).
    if sys.platform == "win32":
        chrome = packaged_chromium()
        print(f"Packaged Chromium verified: {chrome.relative_to(PACKAGED_BROWSERS).as_posix()} ({chrome.stat().st_size} bytes)")
        verify_packaged_voice_runtime()
        print("Packaged local voice-identity runtime verified.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
