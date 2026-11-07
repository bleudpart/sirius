"""Prepare pinned, local voice-identity assets for the Windows desktop build."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import tempfile
from urllib.parse import urlparse
from urllib.request import Request, urlopen
import zipfile


ROOT = Path(__file__).resolve().parents[1]
BUILD_DIR = ROOT / "backend" / "build"
CACHE_DIR = BUILD_DIR / "voice-identity-downloads"
ASSET_DIR = BUILD_DIR / "voice-identity-assets"

MODEL_NAME = "wespeaker_en_voxceleb_resnet34_LM.onnx"
MODEL_SHA256 = "e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012"
MODEL_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    f"speaker-recongition-models/{MODEL_NAME}"
)

FFMPEG_ARCHIVE = "ffmpeg-n8.1-latest-win64-lgpl-shared-8.1.zip"
FFMPEG_SHA256 = "9cb911fca6cebcbcada70db1cc78f174de719683498146960d8797aa53a704c0"
FFMPEG_URL = f"https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/latest/{FFMPEG_ARCHIVE}"
FFMPEG_PREFIX = "ffmpeg-n8.1-latest-win64-lgpl-shared-8.1/"
MAX_MODEL_BYTES = 100 * 1024 * 1024
MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
MAX_EXTRACTED_BYTES = 250 * 1024 * 1024


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _download_verified(url: str, destination: Path, expected_sha256: str, max_bytes: int) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file() and sha256_file(destination) == expected_sha256:
        return destination

    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=f".{destination.name}.", suffix=".part", dir=destination.parent, delete=False
        ) as temporary:
            temporary_path = Path(temporary.name)
            request = Request(url, headers={"User-Agent": "SIRIUS-voice-runtime-build"})
            with urlopen(request, timeout=60) as response:
                final = urlparse(response.geturl())
                allowed_host = final.hostname in {
                    "github.com",
                    "objects.githubusercontent.com",
                    "release-assets.githubusercontent.com",
                } or bool(final.hostname and final.hostname.endswith(".githubusercontent.com"))
                if final.scheme != "https" or not allowed_host:
                    raise RuntimeError("La redirection du téléchargement vocal n'est pas approuvée.")
                content_length = response.headers.get("Content-Length")
                if content_length and int(content_length) > max_bytes:
                    raise RuntimeError(f"Actif vocal trop volumineux : {destination.name}")
                digest = hashlib.sha256()
                total = 0
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > max_bytes:
                        raise RuntimeError(f"Actif vocal trop volumineux : {destination.name}")
                    digest.update(chunk)
                    temporary.write(chunk)
        if digest.hexdigest() != expected_sha256:
            raise RuntimeError(f"SHA-256 inattendu pour {destination.name}; actif refusé.")
        os.replace(temporary_path, destination)
        temporary_path = None
        return destination
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def _safe_zip_member(info: zipfile.ZipInfo) -> PurePosixPath:
    name = info.filename
    path = PurePosixPath(name)
    if "\\" in name or path.is_absolute() or ".." in path.parts:
        raise RuntimeError(f"Chemin inattendu dans l'archive FFmpeg : {name}")
    if stat.S_ISLNK(info.external_attr >> 16):
        raise RuntimeError(f"Lien symbolique inattendu dans l'archive FFmpeg : {name}")
    return path


def extract_ffmpeg_archive(archive: Path, destination: Path) -> list[Path]:
    """Extract only the FFmpeg program, its shared libraries, and its LGPL notice."""
    extracted: list[Path] = []
    total_size = 0
    with zipfile.ZipFile(archive) as source:
        selected = []
        for info in source.infolist():
            path = _safe_zip_member(info)
            if info.is_dir() or not path.as_posix().startswith(FFMPEG_PREFIX):
                continue
            relative = PurePosixPath(*path.parts[1:])
            if relative.parts[0] == "bin" and len(relative.parts) == 2:
                if relative.name.lower() == "ffmpeg.exe" or relative.suffix.lower() == ".dll":
                    selected.append((info, PurePosixPath("ffmpeg") / relative.name))
            elif relative.as_posix().lower() == "license.txt":
                selected.append((info, PurePosixPath("ffmpeg") / "LICENSE.txt"))

        if not any(target.name.lower() == "ffmpeg.exe" for _, target in selected):
            raise RuntimeError("L'archive FFmpeg ne contient pas ffmpeg.exe.")
        if not any(target.name.lower() == "license.txt" for _, target in selected):
            raise RuntimeError("L'archive FFmpeg ne contient pas sa licence LGPL.")
        if not any(target.suffix.lower() == ".dll" for _, target in selected):
            raise RuntimeError("L'archive FFmpeg ne contient pas ses bibliothèques partagées.")

        for info, relative in selected:
            total_size += info.file_size
            if total_size > MAX_EXTRACTED_BYTES:
                raise RuntimeError("Taille extraite FFmpeg supérieure à la limite prévue.")
            target = destination.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.open(info) as source_file, target.open("wb") as target_file:
                shutil.copyfileobj(source_file, target_file)
            if target.stat().st_size != info.file_size:
                raise RuntimeError(f"Extraction FFmpeg incomplète : {relative.as_posix()}")
            extracted.append(target)
    return extracted


def prepare_assets() -> dict:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    model_cache = _download_verified(
        MODEL_URL, CACHE_DIR / MODEL_NAME, MODEL_SHA256, MAX_MODEL_BYTES
    )
    ffmpeg_cache = _download_verified(
        FFMPEG_URL, CACHE_DIR / FFMPEG_ARCHIVE, FFMPEG_SHA256, MAX_ARCHIVE_BYTES
    )

    with tempfile.TemporaryDirectory(prefix="sirius-voice-assets-", dir=BUILD_DIR) as temporary:
        stage = Path(temporary)
        model_target = stage / "model" / MODEL_NAME
        model_target.parent.mkdir(parents=True)
        shutil.copyfile(model_cache, model_target)
        extracted = extract_ffmpeg_archive(ffmpeg_cache, stage)
        notice = (
            "SIRIUS voice-identity runtime\n"
            "\n"
            f"WeSpeaker model: {MODEL_NAME}\n"
            "Source: https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models\n"
            f"SHA-256: {MODEL_SHA256}\n"
            "Model weights are distributed under Creative Commons Attribution 4.0 "
            "(CC BY 4.0): https://creativecommons.org/licenses/by/4.0/\n"
            "Upstream attribution: WeSpeaker, VoxCeleb2 Dev; see the model card and "
            "upstream repository for attribution details.\n"
            "\n"
            f"FFmpeg archive: {FFMPEG_ARCHIVE}\n"
            "Source: https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases\n"
            f"Archive SHA-256: {FFMPEG_SHA256}\n"
            "The LGPL v3 license text is included beside ffmpeg.exe. Corresponding "
            "source and build information are available from the upstream build "
            "repository and FFmpeg 8.1 source: https://ffmpeg.org/download.html\n"
            "\n"
            "Raw voice recordings are processed in memory and are not written by this "
            "runtime. A speaker embedding is stored only after the user gives consent.\n"
        )
        (stage / "NOTICE.txt").write_text(notice, encoding="utf-8")
        manifest = {
            "model": MODEL_NAME,
            "model_sha256": MODEL_SHA256,
            "ffmpeg_archive": FFMPEG_ARCHIVE,
            "ffmpeg_archive_sha256": FFMPEG_SHA256,
            "files": sorted(
                path.relative_to(stage).as_posix()
                for path in stage.rglob("*")
                if path.is_file()
            ) + ["manifest.json"],
        }
        (stage / "manifest.json").write_text(
            json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
        )
        for source in stage.rglob("*"):
            if source.is_file():
                relative = source.relative_to(stage)
                target = ASSET_DIR / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)

    return manifest


if __name__ == "__main__":
    try:
        result = prepare_assets()
        print(
            "Actifs vocaux locaux préparés et vérifiés : "
            f"modèle SHA-256 {result['model_sha256']}; "
            f"FFmpeg SHA-256 {result['ffmpeg_archive_sha256']}."
        )
    except (OSError, RuntimeError, zipfile.BadZipFile, ValueError) as error:
        raise SystemExit(f"Préparation du moteur vocal impossible : {error}") from error
