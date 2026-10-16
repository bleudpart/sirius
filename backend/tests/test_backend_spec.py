import runpy
import sys
from pathlib import Path
from types import ModuleType

import pytest


SPEC = Path(__file__).resolve().parents[1] / "sirius-backend.spec"


def _run_spec(monkeypatch, tmp_path, runtimes):
    system_root = tmp_path / "Windows"
    runtime_dir = system_root / "System32"
    runtime_dir.mkdir(parents=True)
    for name in runtimes:
        (runtime_dir / name).write_bytes(b"runtime")
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
