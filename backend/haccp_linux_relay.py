#!/usr/bin/env python3
"""Linux/CUPS client for the authenticated ΣIRIUS HACCP print queue."""

import argparse
import getpass
import json
import logging
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from typing import Any


API_BASE_URL = "https://api.sirius-assistant.fr"
CONFIG_FILE = Path.home() / ".config" / "sirius" / "haccp-print-relay.json"
JOURNAL_FILE = Path.home() / ".local" / "share" / "sirius" / "haccp-print-journal.sqlite3"
POLL_SECONDS = 5
REQUEST_TIMEOUT_SECONDS = 20
PRINT_TIMEOUT_SECONDS = 30
MAX_HTML_LENGTH = 100_000
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
FORBIDDEN_HTML_RE = re.compile(
    r"<\s*\/?\s*(?:!doctype|html|head|body|script|meta|base|link|iframe|frame|frameset|object|embed|applet|portal)\b",
    re.I,
)
EVENT_HANDLER_RE = re.compile(r"<[^>]*\son[a-z]+\s*=", re.I)
LOGGER = logging.getLogger("sirius-haccp-relay")


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


HTTP = urllib.request.build_opener(NoRedirectHandler())


class RelayError(RuntimeError):
    pass


def request_json(method: str, path: str, token: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    parsed_url = urlsplit(API_BASE_URL)
    if parsed_url.scheme != "https" or parsed_url.netloc != "api.sirius-assistant.fr":
        raise RelayError("Adresse ΣIRIUS invalide : le jeton du relais ne peut être envoyé qu’au serveur HTTPS officiel.")
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        API_BASE_URL + "/api/haccp/impression/relais" + path,
        data=data,
        method=method,
        headers={
            "Accept": "application/json",
            "X-Sirius-Print-Relay": token,
            **({"Content-Type": "application/json"} if data is not None else {}),
        },
    )
    try:
        with HTTP.open(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read().decode("utf-8"))
            detail = payload.get("detail", "requête refusée")
        except (ValueError, AttributeError):
            detail = "requête refusée"
        raise RelayError(f"ΣIRIUS a refusé la requête (HTTP {error.code}) : {detail}") from error
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        raise RelayError(f"ΣIRIUS est injoignable ou sa réponse est illisible : {error}") from error
    if not isinstance(result, dict):
        raise RelayError("Réponse ΣIRIUS invalide.")
    return result


def save_config(token: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9_-]{40,60}", token):
        raise RelayError("Jeton invalide. Recopiez le jeton complet fourni par ΣIRIUS.")
    CONFIG_FILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    CONFIG_FILE.parent.chmod(0o700)
    temp_path: Path | None = None
    try:
        fd, temp_name = tempfile.mkstemp(prefix=".haccp-relay-", dir=CONFIG_FILE.parent)
        temp_path = Path(temp_name)
        if hasattr(os, "fchmod"):
            os.fchmod(fd, 0o600)
        else:
            os.chmod(temp_path, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            json.dump({"token": token}, file)
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp_path, CONFIG_FILE)
        CONFIG_FILE.chmod(0o600)
    except OSError as error:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)
        raise RelayError(f"Impossible d’enregistrer l’autorisation du relais : {error}") from error


def load_config() -> dict[str, str]:
    try:
        data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RelayError("Autorisation absente ou illisible. Lancez le programme avec --configure.") from error
    if not isinstance(data, dict) or set(data) != {"token"}:
        raise RelayError("Fichier d’autorisation invalide. Relancez --configure.")
    token = data["token"]
    if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{40,60}", token):
        raise RelayError("Jeton de relais invalide. Relancez --configure.")
    if os.name == "posix" and CONFIG_FILE.stat().st_mode & 0o077:
        raise RelayError("Permissions trop ouvertes sur le jeton. Restreignez le fichier avant de continuer.")
    return {"token": token}


def configure() -> None:
    token = getpass.getpass("Collez le jeton d’appairage (la saisie reste masquée) : ").strip()
    result = request_json("GET", "/config", token)
    required = {"relay_id", "device_name", "width_mm", "height_mm"}
    if set(result) != required:
        raise RelayError("Configuration reçue de ΣIRIUS invalide.")
    save_config(token)
    print(
        f"Relais associé : {result['device_name']} — "
        f"{result['width_mm']} × {result['height_mm']} mm. Jeton enregistré avec permissions privées."
    )
    print("La file CUPS et l’imprimante doivent encore être configurées et testées sur place.")


class PrintJournal:
    def __init__(self, path: Path = JOURNAL_FILE):
        self.path = path
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path.parent.chmod(0o700)
        with self.connect() as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS jobs ("
                "job_id TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL, detail TEXT)"
            )
            db.execute(
                "UPDATE jobs SET state='uncertain', updated_at=?, "
                "detail='Relais interrompu pendant une impression.' WHERE state='submitted'",
                (self.now(),),
            )

    @staticmethod
    def now() -> str:
        return datetime.now(timezone.utc).isoformat()

    def connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=10)
        db.execute("PRAGMA journal_mode=WAL")
        return db

    def state(self, job_id: str) -> str | None:
        with self.connect() as db:
            row = db.execute("SELECT state FROM jobs WHERE job_id=?", (job_id,)).fetchone()
        return row[0] if row else None

    def begin(self, job_id: str) -> bool:
        with self.connect() as db:
            cursor = db.execute(
                "INSERT OR IGNORE INTO jobs(job_id, state, updated_at) VALUES (?, 'submitted', ?)",
                (job_id, self.now()),
            )
        return cursor.rowcount == 1

    def finish(self, job_id: str, state: str, detail: str | None = None) -> None:
        with self.connect() as db:
            cursor = db.execute(
                "UPDATE jobs SET state=?, updated_at=?, detail=? WHERE job_id=?",
                (state, self.now(), (detail or "")[:500] or None, job_id),
            )
        if cursor.rowcount != 1:
            raise RelayError("Journal local incohérent : aucun nouvel envoi ne sera tenté.")


def build_document(job: dict[str, Any]) -> str:
    required = {"id", "html", "widthMm", "heightMm"}
    if not isinstance(job, dict) or set(job) != required:
        raise RelayError("Travail d’impression invalide.")
    if not isinstance(job["id"], str) or not UUID_RE.fullmatch(job["id"]):
        raise RelayError("Identifiant de travail invalide.")
    fragment = job["html"]
    width = job["widthMm"]
    height = job["heightMm"]
    if not isinstance(fragment, str) or not fragment.strip() or len(fragment) > MAX_HTML_LENGTH:
        raise RelayError("Contenu d’étiquette vide ou trop long.")
    if FORBIDDEN_HTML_RE.search(fragment) or EVENT_HANDLER_RE.search(fragment):
        raise RelayError("Contenu HTML d’étiquette refusé.")
    if type(width) is not int or not 20 <= width <= 150 or type(height) is not int or not 20 <= height <= 300:
        raise RelayError("Dimensions d’étiquette invalides.")
    nonce = secrets.token_urlsafe(16)
    return (
        '<!doctype html><html lang="fr"><head><meta charset="utf-8">'
        f'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
        f'img-src data:; style-src \'unsafe-inline\'; script-src \'nonce-{nonce}\'; '
        'base-uri \'none\'; form-action \'none\'">'
        f"<style>@page{{size:{width}mm {height}mm;margin:0}}"
        f"html,body{{margin:0;padding:0;width:{width}mm;height:{height}mm;overflow:hidden}}"
        f".sirius-label{{position:relative;box-sizing:border-box;width:{width}mm;height:{height}mm;overflow:hidden}}</style>"
        f'</head><body><main id="sirius-label" class="sirius-label">{fragment}</main>'
        f'<script nonce="{nonce}">(()=>{{const label=document.getElementById("sirius-label");'
        'const body=document.body;document.documentElement.setAttribute("data-sirius-measure",'
        '[label.scrollWidth,label.scrollHeight,body.scrollWidth,body.scrollHeight].join(","));})();</script>'
        '</body></html>'
    )


def check_measurement(output: str, width_mm: int, height_mm: int) -> None:
    match = re.search(r'data-sirius-measure="(\d+),(\d+),(\d+),(\d+)"', output)
    if not match:
        raise RelayError("Mesure du contenu d’étiquette impossible ; impression annulée.")
    label_width, label_height, body_width, body_height = (int(value) for value in match.groups())
    max_width = width_mm * 96 / 25.4
    max_height = height_mm * 96 / 25.4
    if max(label_width, body_width) > max_width + 2 or max(label_height, body_height) > max_height + 2:
        raise RelayError(
            f"Étiquette trop grande pour {width_mm} × {height_mm} mm ; impression annulée."
        )


def spool(job: dict[str, Any], config: dict[str, Any]) -> None:
    document = build_document(job)
    width, height = job["widthMm"], job["heightMm"]
    printer = config.get("device_name")
    if not isinstance(printer, str) or not printer.strip() or any(ord(char) < 32 for char in printer):
        raise RelayError("Nom de file CUPS invalide.")
    chromium = shutil.which("chromium") or shutil.which("chromium-browser")
    lp = shutil.which("lp")
    if not chromium or not lp:
        raise RelayError("Chromium ou CUPS absent. Installez-les avant d’activer l’impression.")
    with tempfile.TemporaryDirectory(prefix="sirius-haccp-") as directory:
        html_path = Path(directory) / "label.html"
        pdf_path = Path(directory) / "label.pdf"
        html_path.write_text(document, encoding="utf-8")
        try:
            measured = subprocess.run(
                [chromium, "--headless", "--disable-gpu", "--disable-background-networking",
                 "--disable-extensions", "--no-first-run", "--no-pdf-header-footer",
                 f"--user-data-dir={Path(directory) / 'profile-measure'}",
                 "--virtual-time-budget=1000", "--dump-dom", html_path.as_uri()],
                check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=PRINT_TIMEOUT_SECONDS,
                text=True, encoding="utf-8",
            )
            check_measurement(measured.stdout, width, height)
            subprocess.run(
                [chromium, "--headless", "--disable-gpu", "--disable-background-networking",
                 "--disable-extensions", "--no-first-run", "--no-pdf-header-footer",
                 f"--user-data-dir={Path(directory) / 'profile-print'}",
                 f"--print-to-pdf={pdf_path}", html_path.as_uri()],
                check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=PRINT_TIMEOUT_SECONDS,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise RelayError(f"Création du document d’impression impossible : {error}") from error
        if not pdf_path.is_file() or pdf_path.stat().st_size == 0:
            raise RelayError("Chromium n’a produit aucun document imprimable.")
        try:
            subprocess.run(
                [lp, "-d", printer, "-o", f"media=Custom.{width}x{height}mm", str(pdf_path)],
                check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=PRINT_TIMEOUT_SECONDS,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise RelayError(f"CUPS n’a pas accepté l’étiquette : {error}") from error


def process_job(job: dict[str, Any], config: dict[str, Any], journal: PrintJournal) -> None:
    job_id = job.get("id") if isinstance(job, dict) else None
    if not isinstance(job_id, str) or not UUID_RE.fullmatch(job_id):
        raise RelayError("Travail reçu sans identifiant valide ; aucune impression lancée.")
    state = journal.state(job_id)
    if state is not None:
        status = "accepted" if state == "accepted" else "uncertain"
        detail = "Travail déjà traité localement ; aucune réimpression automatique."
        LOGGER.warning("Travail %s déjà présent dans le journal (%s).", job_id, state)
    elif not journal.begin(job_id):
        status = "uncertain"
        detail = "Travail déjà soumis localement ; aucune réimpression automatique."
    else:
        try:
            config_response = request_json("GET", "/config", config["token"])
            if (job.get("widthMm"), job.get("heightMm")) != (
                config_response.get("width_mm"), config_response.get("height_mm"),
            ):
                raise RelayError("Dimensions du travail différentes de celles configurées.")
            spool(job, config_response)
        except RelayError as error:
            journal.finish(job_id, "uncertain", str(error))
            status = "uncertain"
            detail = f"Résultat incertain : {error}. Vérifiez le papier, sans réimpression automatique."
            LOGGER.error("Impression %s incertaine : %s", job_id, error)
        else:
            journal.finish(job_id, "accepted")
            status = "accepted"
            detail = "Accepté par CUPS ; vérifiez la sortie papier."
    request_json(
        "POST", f"/demandes/{job_id}/confirmation", config["token"],
        {"status": status, "detail": detail[:500]},
    )


def run_once(config: dict[str, str], journal: PrintJournal) -> None:
    request_json("GET", "/config", config["token"])
    result = request_json("POST", "/prochaine", config["token"], {})
    job = result.get("job")
    if job is not None:
        process_job(job, config, journal)


def run() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    config = load_config()
    journal = PrintJournal()
    LOGGER.info("Relais HACCP Linux démarré ; les travaux incertains ne seront jamais réimprimés automatiquement.")
    while True:
        try:
            run_once(config, journal)
        except RelayError as error:
            LOGGER.error("%s", error)
        time.sleep(POLL_SECONDS)


def main() -> int:
    parser = argparse.ArgumentParser(description="Relais d’impression HACCP ΣIRIUS pour Raspberry Pi")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--configure", action="store_true", help="Enregistrer le jeton d’appairage sans l’afficher")
    group.add_argument("--run", action="store_true", help="Démarrer le service de relais")
    args = parser.parse_args()
    try:
        if args.configure:
            configure()
        else:
            run()
    except RelayError as error:
        parser.exit(1, f"Erreur : {error}\n")
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
