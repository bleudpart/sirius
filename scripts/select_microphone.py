"""List PyAudio input devices and select a current index without recording audio."""

from __future__ import annotations

import argparse
import importlib
import json
import sys
from dataclasses import asdict, dataclass
from numbers import Real
from typing import Mapping, Protocol, Sequence, cast


class AudioDevices(Protocol):
    def get_device_count(self) -> int: ...
    def get_device_info_by_index(self, index: int) -> Mapping[str, object]: ...
    def get_default_input_device_info(self) -> Mapping[str, object]: ...
    def get_host_api_info_by_index(self, index: int) -> Mapping[str, object]: ...
    def terminate(self) -> None: ...


@dataclass(frozen=True)
class Microphone:
    index: int
    name: str
    host_api: str
    channels: int
    sample_rate: float


def numeric(value: object, field: str) -> float:
    if not isinstance(value, Real):
        raise ValueError(f"Information PyAudio invalide : {field}.")
    return float(value)


def list_microphones(audio: AudioDevices) -> list[Microphone]:
    devices = []
    for index in range(audio.get_device_count()):
        info = audio.get_device_info_by_index(index)
        channels = int(numeric(info["maxInputChannels"], "maxInputChannels"))
        if channels <= 0:
            continue
        host = audio.get_host_api_info_by_index(int(numeric(info["hostApi"], "hostApi")))
        devices.append(Microphone(
            index=index, name=str(info["name"]), host_api=str(host["name"]),
            channels=channels, sample_rate=numeric(info["defaultSampleRate"], "defaultSampleRate"),
        ))
    return devices


def default_input_index(audio: AudioDevices) -> int | None:
    try:
        info = audio.get_default_input_device_info()
    except OSError:
        return None
    return int(numeric(info["index"], "index"))


def select_microphone(
    devices: Sequence[Microphone], *, index: int | None = None,
    name: str | None = None, default_index: int | None = None,
) -> Microphone:
    if not devices:
        raise ValueError("Aucun microphone d'entrée détecté par PyAudio.")
    if index is not None and name is not None:
        raise ValueError("Choisissez --index ou --name, pas les deux.")
    if index is not None:
        matches = [device for device in devices if device.index == index]
        if not matches:
            raise ValueError(f"L'index {index} n'est pas un microphone disponible. Relancez la liste.")
        return matches[0]
    if name is not None:
        if not name.strip():
            raise ValueError("Le nom du microphone ne peut pas être vide.")
        matches = [device for device in devices if name.casefold().strip() in device.name.casefold()]
        if len(matches) == 1:
            return matches[0]
        if not matches:
            raise ValueError(f"Aucun microphone ne correspond à {name!r}.")
        indexes = ", ".join(str(device.index) for device in matches)
        raise ValueError(f"Plusieurs microphones correspondent à {name!r} (index {indexes}). Précisez --index.")
    default = next((device for device in devices if device.index == default_index), None)
    if default is not None:
        return default
    if len(devices) == 1:
        return devices[0]
    raise ValueError("Aucun microphone par défaut disponible. Choisissez --index, --name ou --interactive.")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--index", type=int, help="Index actuel du microphone.")
    mode.add_argument("--name", help="Partie unique du nom ; résolue à chaque lancement.")
    mode.add_argument("--interactive", action="store_true", help="Demander l'index après la liste.")
    mode.add_argument("--list-only", action="store_true", help="Lister sans sélectionner.")
    parser.add_argument("--json", action="store_true", help="Résultat JSON pour un autre programme.")
    args = parser.parse_args(argv)
    if args.json and args.interactive:
        parser.error("--json ne peut pas être combiné avec --interactive.")
    try:
        module = importlib.import_module("pyaudio")
    except ModuleNotFoundError as error:
        if error.name != "pyaudio":
            raise
        print("PyAudio absent. Installez : python -m pip install -r scripts\\requirements-microphones.txt", file=sys.stderr)
        return 1
    try:
        audio = cast(AudioDevices, module.PyAudio())
    except OSError as error:
        print(f"Initialisation PyAudio impossible : {error}", file=sys.stderr)
        return 1
    try:
        devices = list_microphones(audio)
        if not devices:
            raise ValueError("Aucun microphone d'entrée détecté par PyAudio.")
        default_index = default_input_index(audio)
        if not args.json:
            for device in devices:
                marker = " [par défaut]" if device.index == default_index else ""
                print(f"{device.index}: {device.name} ({device.host_api}, {device.channels} canaux, "
                      f"{device.sample_rate:g} Hz){marker}")
            if default_index is None:
                print("Aucun microphone d'entrée par défaut signalé par PyAudio.")
        selected = None
        if not args.list_only:
            index = args.index
            if args.interactive:
                answer = input("Index du microphone (Entrée = défaut) : ").strip()
                index = int(answer) if answer else None
            selected = select_microphone(devices, index=index, name=args.name, default_index=default_index)
        if args.json:
            print(json.dumps({
                "microphones": [asdict(device) for device in devices],
                "default_index": default_index,
                "selected_index": selected.index if selected else None,
            }, ensure_ascii=True))
        elif selected is not None:
            print(f"Microphone sélectionné : {selected.name} — input_device_index={selected.index}")
        return 0
    except (OSError, ValueError, EOFError) as error:
        print(f"Erreur de sélection du microphone : {error}", file=sys.stderr)
        return 1
    finally:
        audio.terminate()


if __name__ == "__main__":
    raise SystemExit(main())
