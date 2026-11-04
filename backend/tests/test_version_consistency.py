import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def _read_frontend_version() -> str:
    content = (ROOT / "frontend" / "src" / "version.js").read_text(encoding="utf-8")
    match = re.search(r'APP_VERSION\s*=\s*"([^"]+)"', content)
    if not match:
        raise AssertionError("APP_VERSION not found in frontend version.js")
    return match.group(1)


def _read_backend_version() -> str:
    content = (ROOT / "backend" / "version_info.py").read_text(encoding="utf-8")
    match = re.search(r'APP_VERSION\s*=\s*"([^"]+)"', content)
    if not match:
        raise AssertionError("APP_VERSION not found in backend/version_info.py")
    return match.group(1)


def test_release_versions_are_consistent_across_project():
    package_version = json.loads((ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))["version"]
    lock = json.loads((ROOT / "frontend" / "package-lock.json").read_text(encoding="utf-8"))
    frontend_version = _read_frontend_version()
    backend_version = _read_backend_version()
    gradle = (ROOT / "frontend" / "android" / "app" / "build.gradle").read_text(encoding="utf-8")
    android_version = re.search(r'^\s*versionName\s+"([^"]+)"', gradle, re.MULTILINE)
    assert android_version, "versionName not found in Android build.gradle"

    assert {package_version, lock["version"], lock["packages"][""]["version"],
            frontend_version, backend_version, android_version.group(1)} == {package_version}
    assert (ROOT / f"GUIDE-SIRIUS-{package_version}.txt").is_file()
