import json
import runpy
import sys
from pathlib import Path
from types import ModuleType

import pytest


SPEC = Path(__file__).resolve().parents[1] / "sirius-backend.spec"
RUNTIMES = ("msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll")


def _install_chromium(tmp_path, revision, with_executable=True):
    folder = tmp_path / "ms-playwright" / f"chromium-{revision}"
    (folder / "chrome-win64").mkdir(parents=True)
    if with_executable:
        (folder / "chrome-win64" / "chrome.exe").write_bytes(b"chrome")


def _declare_playwright(monkeypatch, tmp_path, revision):
    """Simule la bibliotheque Playwright du build ; revision=None la rend illisible."""
    if revision is None:
        monkeypatch.setitem(sys.modules, "playwright", None)
        return
    package = tmp_path / "site-packages" / "playwright"
    manifest = package / "driver" / "package" / "browsers.json"
    manifest.parent.mkdir(parents=True)
    browsers = [
        {"name": "chromium-headless-shell", "revision": "9999"},
        {"name": "chromium", "revision": revision},
    ]
    manifest.write_text(json.dumps({"browsers": browsers}), encoding="utf-8")
    module = ModuleType("playwright")
    module.__file__ = str(package / "__init__.py")
    monkeypatch.setitem(sys.modules, "playwright", module)


def _run_spec(monkeypatch, tmp_path, runtimes, chromium=("1234",), playwright_revision="1234"):
    system_root = tmp_path / "Windows"
    runtime_dir = system_root / "System32"
    runtime_dir.mkdir(parents=True)
    for name in runtimes:
        (runtime_dir / name).write_bytes(b"runtime")
    for revision in chromium:
        _install_chromium(tmp_path, revision)
    _declare_playwright(monkeypatch, tmp_path, playwright_revision)
    monkeypatch.setenv("SystemRoot", str(system_root))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setattr(sys, "platform", "win32")
    hooks = ModuleType("PyInstaller.utils.hooks")
    hooks.collect_data_files = lambda *args, **kwargs: []
    hooks.collect_submodules = lambda *args, **kwargs: []
    monkeypatch.setitem(sys.modules, "PyInstaller.utils.hooks", hooks)
    captured = {}

    class AnalysisReached(Exception):
        pass

    def analysis(*args, **kwargs):
        captured.update(kwargs)
        raise AnalysisReached

    try:
        runpy.run_path(
            str(SPEC),
            init_globals={"SPECPATH": str(SPEC.parent), "Analysis": analysis},
        )
    except AnalysisReached:
        pass
    return captured, runtime_dir


def test_spec_prioritizes_coherent_system_visual_cpp_runtimes(monkeypatch, tmp_path):
    names = ("msvcp140.dll", "msvcp140_1.dll", "vcruntime140.dll", "vcruntime140_1.dll")
    captured, runtime_dir = _run_spec(monkeypatch, tmp_path, names)

    assert set(captured["binaries"]) == {(str(runtime_dir / name), ".") for name in names}


@pytest.mark.parametrize("missing", ["msvcp140.dll", "vcruntime140_1.dll"])
def test_spec_refuses_missing_visual_cpp_runtime(monkeypatch, tmp_path, missing):
    names = {"msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"} - {missing}

    with pytest.raises(SystemExit, match="Visual C\\+\\+"):
        _run_spec(monkeypatch, tmp_path, names)


def test_spec_bundles_only_the_chromium_revision_playwright_expects(monkeypatch, tmp_path):
    captured, _ = _run_spec(monkeypatch, tmp_path, RUNTIMES, chromium=("1100", "1234"))

    cache = tmp_path / "ms-playwright"
    assert (str(cache / "chromium-1234"), "playwright-browsers/chromium-1234") in captured["datas"]
    assert not any("chromium-1100" in source for source, _target in captured["datas"])


def test_spec_refuses_to_build_without_chromium(monkeypatch, tmp_path):
    with pytest.raises(SystemExit, match="playwright install chromium"):
        _run_spec(monkeypatch, tmp_path, RUNTIMES, chromium=())


def test_spec_refuses_a_chromium_revision_playwright_cannot_launch(monkeypatch, tmp_path):
    with pytest.raises(SystemExit, match="attendue : 1234 ; presents : chromium-1100"):
        _run_spec(monkeypatch, tmp_path, RUNTIMES, chromium=("1100",))


def test_spec_refuses_a_chromium_folder_without_chrome_exe(monkeypatch, tmp_path):
    _install_chromium(tmp_path, "1234", with_executable=False)

    with pytest.raises(SystemExit, match="Chromium introuvable"):
        _run_spec(monkeypatch, tmp_path, RUNTIMES, chromium=())


def test_spec_accepts_any_installed_chromium_when_playwright_is_unreadable(monkeypatch, tmp_path):
    captured, _ = _run_spec(monkeypatch, tmp_path, RUNTIMES, chromium=("1100",), playwright_revision=None)

    cache = tmp_path / "ms-playwright"
    assert (str(cache / "chromium-1100"), "playwright-browsers/chromium-1100") in captured["datas"]
