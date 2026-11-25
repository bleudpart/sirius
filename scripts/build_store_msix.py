"""Construit le paquet MSIX Microsoft Store de ΣIRIUS à partir du build Electron.

Le modèle (manifeste, icônes, Resources.pri) vient de frontend/store-msix ; il garde
l'identité réservée dans Partner Center. Le paquet n'est pas signé : le Store le re-signe.
"""

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.parse
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "frontend" / "store-msix"
APP_PREFIX = "VFS/UserProgramFiles/SIRIUS/"
IDENTITY = {
    "Name": "DanielPartel.IRIUS",
    "Publisher": "CN=F91D6937-239B-472C-9E4C-8FCE33907EAB",
    "ProcessorArchitecture": "x64",
}
TEMPLATE_VERSION = 'Version="0.0.0.0"'
# Les paquets Store ne peuvent pas demander d'élévation.
EXCLUDED = {"resources/elevate.exe"}
REQUIRED = (
    APP_PREFIX + "SIRIUS.exe",
    APP_PREFIX + "resources/app.asar",
    APP_PREFIX + "resources/backend/sirius-backend.exe",
    "AppxManifest.xml",
    "Resources.pri",
)
MAKEAPPX_EXTRAS = {"[content_types].xml", "appxblockmap.xml", "appxmetadata/codeintegrity.cat"}


def store_version(npm_version):
    if not re.fullmatch(r"\d+\.\d+\.\d+", npm_version):
        raise ValueError(f"Version npm invalide pour le Store : {npm_version}")
    return npm_version + ".0"


def render_manifest(template_text, version):
    if template_text.count(TEMPLATE_VERSION) != 1:
        raise ValueError("Le modèle doit contenir une seule fois Version=\"0.0.0.0\".")
    return template_text.replace(TEMPLATE_VERSION, f'Version="{version}"')


def collect_files(build_dir, template_dir, manifest_path):
    mapping = {"AppxManifest.xml": manifest_path}
    for source in sorted(template_dir.rglob("*")):
        if source.is_file() and source.name != "AppxManifest.xml":
            mapping[source.relative_to(template_dir).as_posix()] = source
    for directory, dirs, filenames in os.walk(build_dir, followlinks=False):
        for name in dirs + filenames:
            if (Path(directory) / name).is_symlink():
                raise RuntimeError(f"Lien symbolique refusé : {Path(directory) / name}")
        for filename in filenames:
            source = Path(directory) / filename
            relative = source.relative_to(build_dir).as_posix()
            if relative.lower() in EXCLUDED:
                continue
            mapping[APP_PREFIX + relative] = source
    folded = {}
    for target in mapping:
        if target.casefold() in folded:
            raise RuntimeError(f"Chemin dupliqué dans le paquet : {target}")
        folded[target.casefold()] = target
    missing = [name for name in REQUIRED if name not in mapping]
    if missing:
        raise RuntimeError("Fichiers requis absents : " + ", ".join(missing))
    return mapping


def file_version(path):
    """Version de fichier Windows (FileVersion fixe) d'un exécutable."""
    version = ctypes.windll.version
    size = version.GetFileVersionInfoSizeW(str(path), None)
    if not size:
        raise RuntimeError(f"Pas d'informations de version dans {path}")
    buffer = ctypes.create_string_buffer(size)
    if not version.GetFileVersionInfoW(str(path), 0, size, buffer):
        raise RuntimeError(f"Lecture de version impossible : {path}")
    pointer = ctypes.c_void_p()
    length = ctypes.c_uint()
    if not version.VerQueryValueW(buffer, "\\", ctypes.byref(pointer), ctypes.byref(length)):
        raise RuntimeError(f"Version fixe absente : {path}")
    fixed = ctypes.cast(pointer, ctypes.POINTER(ctypes.c_uint32 * 13)).contents
    ms, ls = fixed[2], fixed[3]
    return f"{ms >> 16}.{ms & 0xFFFF}.{ls >> 16}.{ls & 0xFFFF}"


def find_makeappx():
    explicit = os.environ.get("MAKEAPPX")
    candidates = [Path(explicit)] if explicit else []
    kits = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Windows Kits" / "10" / "bin"
    candidates += sorted(kits.glob("10.*/x64/makeappx.exe"), reverse=True)
    cache = Path(os.environ.get("LOCALAPPDATA", "")) / "electron-builder" / "Cache" / "winCodeSign"
    candidates += sorted(cache.glob("*/windows-10/x64/makeappx.exe"), reverse=True)
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise RuntimeError("makeappx.exe introuvable : installer le SDK Windows ou définir MAKEAPPX.")


def sha256(stream):
    digest = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(block)
    return digest.hexdigest().upper()


def verify_package(package, mapping, version):
    with zipfile.ZipFile(package) as archive:
        packed = {
            urllib.parse.unquote(name).casefold(): name
            for name in archive.namelist()
            if not name.endswith("/")
        }
        expected = {name.casefold(): source for name, source in mapping.items()}
        missing = set(expected) - set(packed)
        extras = set(packed) - set(expected) - MAKEAPPX_EXTRAS
        if missing or extras:
            raise RuntimeError(f"Contenu inattendu : manquants={sorted(missing)[:5]} en trop={sorted(extras)[:5]}")
        for name, source in expected.items():
            with source.open("rb") as original, archive.open(packed[name]) as inside:
                if sha256(original) != sha256(inside):
                    raise RuntimeError(f"Contenu différent dans le paquet : {name}")
        root = ET.fromstring(archive.read(packed["appxmanifest.xml"]))
    identity = next(node for node in root.iter() if node.tag.endswith("}Identity"))
    if identity.attrib != {**IDENTITY, "Version": version}:
        raise RuntimeError(f"Identité du paquet inattendue : {identity.attrib}")


def build(build_dir, output_dir, makeappx=None):
    npm_version = json.loads((ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))["version"]
    version = store_version(npm_version)
    exe_version = file_version(build_dir / "SIRIUS.exe")
    if exe_version != version:
        raise RuntimeError(f"SIRIUS.exe est en {exe_version}, attendu {version} : relancer npm run electron:build.")
    makeappx = makeappx or find_makeappx()
    output_dir.mkdir(parents=True, exist_ok=True)
    package = output_dir / f"SIRIUS-{version}-store.msix"
    if package.exists():
        package.unlink()
    with tempfile.TemporaryDirectory() as work:
        work = Path(work)
        manifest = work / "AppxManifest.xml"
        manifest.write_text(
            render_manifest((TEMPLATE / "AppxManifest.xml").read_text(encoding="utf-8-sig"), version),
            encoding="utf-8-sig",
        )
        mapping = collect_files(build_dir, TEMPLATE, manifest)
        lines = ["[Files]"]
        for target, source in sorted(mapping.items()):
            if '"' in str(source) or '"' in target:
                raise RuntimeError(f"Guillemet interdit dans un chemin : {target}")
            lines.append(f'"{source}" "{target.replace("/", chr(92))}"')
        mapping_file = work / "mapping.txt"
        mapping_file.write_text("\r\n".join(lines) + "\r\n", encoding="utf-16")
        result = subprocess.run(
            [str(makeappx), "pack", "/f", str(mapping_file), "/p", str(package), "/o"],
            capture_output=True,
            text=True,
            errors="replace",
            check=False,
        )
        if result.returncode:
            raise RuntimeError(f"MakeAppx a échoué ({result.returncode}) :\n{result.stdout[-3000:]}{result.stderr[-3000:]}")
        verify_package(package, mapping, version)
    with package.open("rb") as stream:
        digest = sha256(stream)
    print(f"Paquet Store : {package}")
    print(f"Version : {version} ; fichiers vérifiés : {len(mapping)}")
    print(f"SHA-256 : {digest}")
    return package


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-dir", type=Path, default=ROOT / "frontend" / "dist" / "win-unpacked")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "frontend" / "dist")
    parser.add_argument("--makeappx", type=Path)
    args = parser.parse_args()
    build(args.build_dir.resolve(), args.output_dir.resolve(), args.makeappx)


if __name__ == "__main__":
    main()
