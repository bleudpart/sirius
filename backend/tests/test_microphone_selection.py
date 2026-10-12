import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "select_microphone.py"
spec = importlib.util.spec_from_file_location("select_microphone", SCRIPT)
assert spec and spec.loader
microphones = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = microphones
spec.loader.exec_module(microphones)


class FakeAudio:
    terminated = False

    def get_device_count(self):
        return 3

    def get_device_info_by_index(self, index):
        return {"name": ["Speakers", "Microphone USB", "Microphone intégré"][index],
                "maxInputChannels": [0, 1, 2][index], "defaultSampleRate": 48000, "hostApi": 0}

    def get_host_api_info_by_index(self, index):
        return {"name": "WASAPI"}

    def get_default_input_device_info(self):
        return {"index": 2}

    def terminate(self):
        self.terminated = True


def test_lists_only_inputs_and_selects_actual_default():
    audio = FakeAudio()
    devices = microphones.list_microphones(audio)
    assert [device.index for device in devices] == [1, 2]
    selected = microphones.select_microphone(devices, default_index=microphones.default_input_index(audio))
    assert selected.index == 2
    assert microphones.select_microphone(devices, name="USB").index == 1
    assert microphones.select_microphone(devices, index=1).index == 1


@pytest.mark.parametrize("options", [{"index": 0}, {"index": -1}, {"name": "absent"}, {"name": ""},
                                    {"name": "Microphone"}, {}, {"index": 1, "name": "USB"}])
def test_invalid_or_ambiguous_choices_are_reported(options):
    with pytest.raises(ValueError):
        microphones.select_microphone(microphones.list_microphones(FakeAudio()), **options)


def test_selection_resolves_a_changed_index_from_the_name():
    device = microphones.Microphone(7, "Microphone USB", "WASAPI", 1, 48000)
    assert microphones.select_microphone([device], name="USB").index == 7
    with pytest.raises(ValueError):
        microphones.select_microphone([device], index=1)


def test_empty_device_list_is_not_a_successful_selection():
    with pytest.raises(ValueError, match="Aucun microphone"):
        microphones.select_microphone([])


@pytest.mark.parametrize("arguments,expected", [(["--json", "--name", "USB"], 0), (["--index", "0"], 1)])
def test_cli_releases_pyaudio_even_after_invalid_selection(monkeypatch, capsys, arguments, expected):
    audio = FakeAudio()
    monkeypatch.setattr(microphones.importlib, "import_module", lambda name: SimpleNamespace(PyAudio=lambda: audio))
    assert microphones.main(arguments) == expected
    output = capsys.readouterr()
    if expected == 0:
        import json
        assert json.loads(output.out)["selected_index"] == 1
    else:
        assert "n'est pas un microphone" in output.err
    assert audio.terminated


def test_cli_reports_no_inputs_even_in_json_mode(monkeypatch, capsys):
    audio = FakeAudio()
    monkeypatch.setattr(audio, "get_device_count", lambda: 0)
    monkeypatch.setattr(microphones.importlib, "import_module", lambda name: SimpleNamespace(PyAudio=lambda: audio))
    assert microphones.main(["--json", "--list-only"]) == 1
    output = capsys.readouterr()
    assert not output.out
    assert "Aucun microphone" in output.err
    assert audio.terminated
