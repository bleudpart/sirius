import importlib.util
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "verify_packaged_frontend.py"
spec = importlib.util.spec_from_file_location("verify_packaged_frontend", SCRIPT)
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


def _chrome(browsers, revision="1234", size=verify.MIN_CHROME_BYTES):
    executable = browsers / f"chromium-{revision}" / "chrome-win64" / "chrome.exe"
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"x" * size)
    return executable


def test_packaged_chromium_returns_the_embedded_executable(tmp_path):
    executable = _chrome(tmp_path)

    assert verify.packaged_chromium(tmp_path) == executable


def test_packaged_chromium_refuses_a_package_without_browsers_folder(tmp_path):
    with pytest.raises(RuntimeError, match="playwright install chromium"):
        verify.packaged_chromium(tmp_path / "playwright-browsers")


def test_packaged_chromium_refuses_a_folder_without_chrome_exe(tmp_path):
    (tmp_path / "chromium-1234" / "chrome-win64").mkdir(parents=True)

    with pytest.raises(RuntimeError, match="Chromium absent"):
        verify.packaged_chromium(tmp_path)


def test_packaged_chromium_refuses_a_truncated_executable(tmp_path):
    _chrome(tmp_path, size=verify.MIN_CHROME_BYTES - 1)

    with pytest.raises(RuntimeError, match="Chromium absent"):
        verify.packaged_chromium(tmp_path)
