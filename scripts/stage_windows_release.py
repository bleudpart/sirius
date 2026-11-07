"""Validate signed artifacts and updater metadata before staging a release."""

import argparse
import base64
import hashlib
import json
from pathlib import Path
import shutil

import yaml


def digest(path, algorithm):
    result = hashlib.new(algorithm)
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.digest()


def stage_release(source, destination, version, report):
    if destination.exists():
        raise ValueError("Le dossier de publication existe deja.")
    setup_name = f"sirius-setup-{version}.exe"
    portable_name = f"SIRIUS-Portable-{version}.exe"
    metadata = yaml.safe_load((source / "latest.yml").read_text(encoding="utf-8-sig"))
    if not isinstance(metadata, dict) or str(metadata.get("version")) != version:
        raise ValueError("Version de latest.yml incoherente.")
    entries = metadata.get("files")
    if not isinstance(entries, list) or len(entries) != 1 or not isinstance(entries[0], dict) or entries[0].get("url") != setup_name:
        raise ValueError("latest.yml doit referencer uniquement l'installateur NSIS attendu.")
    setup = source / setup_name
    sha512 = base64.b64encode(digest(setup, "sha512")).decode("ascii")
    if entries[0].get("sha512") != sha512 or entries[0].get("size") != setup.stat().st_size:
        raise ValueError("Hash ou taille NSIS incoherent : ne pas signer apres generation de latest.yml.")
    if metadata.get("path") != setup_name or metadata.get("sha512") != sha512:
        raise ValueError("Metadonnees de mise a jour historiques incoherentes.")
    binaries = sorted(path for path in source.iterdir() if path.suffix.lower() in {".exe", ".msi"} and path.is_file())
    if any(path.suffix.lower() == ".exe" and path.name not in {setup_name, portable_name} for path in binaries):
        raise ValueError("Un executable d'une autre version est present dans dist.")
    if not (source / portable_name).is_file():
        raise ValueError("Portable attendu absent.")
    signature_report = json.loads(report.read_text(encoding="utf-8-sig"))
    records = signature_report.get("signatures")
    if not isinstance(records, list) or not records or signature_report.get("verified_files") != len(records):
        raise ValueError("Rapport de signatures incomplet.")
    if any(not isinstance(row, dict) or row.get("status") != "Valid" or row.get("timestamp") is not True for row in records):
        raise ValueError("Une signature ou un horodatage est invalide.")
    by_name = {row["file"]: row for row in records}
    for binary in binaries:
        if binary.stat().st_size >= 2 * 1024**3:
            raise ValueError(f"Artefact trop volumineux pour GitHub Releases : {binary.name}")
        if by_name.get(binary.name, {}).get("sha256") != digest(binary, "sha256").hex():
            raise ValueError(f"Artefact absent du rapport ou modifie : {binary.name}")
    assets = binaries + [source / f"{setup_name}.blockmap", source / "latest.yml"]
    for asset in assets:
        if not asset.is_file():
            raise ValueError(f"Artefact manquant : {asset.name}")
    incoming_checksums = source / "SHA256SUMS.txt"
    if incoming_checksums.is_file():
        expected_names = {asset.name for asset in assets} | {"windows-signatures.json"}
        seen = set()
        for line in incoming_checksums.read_text(encoding="ascii").splitlines():
            checksum, name = line.split("  ")
            if name not in expected_names or name in seen:
                raise ValueError("Manifeste SHA256 invalide.")
            actual = report if name == "windows-signatures.json" else source / name
            if checksum != digest(actual, "sha256").hex():
                raise ValueError(f"Artefact telecharge modifie : {name}")
            seen.add(name)
        if seen != expected_names:
            raise ValueError("Manifeste SHA256 incomplet.")
    destination.mkdir(parents=True)
    for asset in assets:
        shutil.copy2(asset, destination / asset.name)
    shutil.copy2(report, destination / "windows-signatures.json")
    checksums = [
        f"{digest(asset, 'sha256').hex()}  {asset.name}"
        for asset in sorted(destination.iterdir())
    ]
    (destination / "SHA256SUMS.txt").write_text("\n".join(checksums) + "\n", encoding="ascii")
    return destination


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    stage_release(args.source, args.destination, args.version, args.report)
