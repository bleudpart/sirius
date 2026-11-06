#!/usr/bin/env python3
"""Vérifications de disponibilité publiques et du serveur Hetzner."""

import argparse
import http.client
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request


SITE_URL = "https://sirius-assistant.fr/deploy-sha.txt"
API_URL = "https://api.sirius-assistant.fr/api/health"
HEALTH_URL = "https://api.sirius-assistant.fr/health"
LOCAL_API_URL = "http://127.0.0.1:8001/api/health"
LOCAL_HEALTH_URL = "http://127.0.0.1:8001/health"
MAX_RESPONSE_BYTES = 128 * 1024
MAX_DISK_PERCENT = 85
MIN_FREE_BYTES = 1024 ** 3
MAX_BACKUP_AGE_SECONDS = 36 * 60 * 60
MAX_CLOCK_SKEW_SECONDS = 5 * 60


class CheckError(Exception):
    pass


def fetch(url):
    request = urllib.request.Request(
        url, headers={"User-Agent": "SIRIUS-monitor/1.0", "Cache-Control": "no-cache"}
    )
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            if response.status != 200:
                raise CheckError(f"réponse HTTP {response.status}")
            content = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        raise CheckError(f"réponse HTTP {error.code}") from error
    except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException) as error:
        raise CheckError(f"réseau inaccessible ({type(error).__name__})") from error
    if len(content) > MAX_RESPONSE_BYTES:
        raise CheckError("réponse trop volumineuse")
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError as error:
        raise CheckError("réponse non UTF-8") from error


def fetch_json(url):
    try:
        value = json.loads(fetch(url))
    except json.JSONDecodeError as error:
        raise CheckError("réponse JSON invalide") from error
    if not isinstance(value, dict):
        raise CheckError("réponse JSON inattendue")
    return value


def check_site():
    if not re.fullmatch(r"[a-f0-9]{40}\s*", fetch(SITE_URL)):
        raise CheckError("le site ne fournit pas une version publiée valide")


def check_api(api_url=None, health_url=None):
    if fetch_json(api_url or API_URL).get("status") != "ok":
        raise CheckError("l'API ne répond pas normalement")
    health = fetch_json(health_url or HEALTH_URL)
    checks = health.get("checks")
    if health.get("status") != "ok" or not isinstance(checks, dict):
        raise CheckError("l'état détaillé de l'API est dégradé ou invalide")
    if checks.get("database") != "mongodb" or checks.get("mongo") != "ok":
        raise CheckError("la base MongoDB attendue est indisponible ou non utilisée")
    if checks.get("mongo_required") is not True:
        raise CheckError("la protection contre le repli sur une base locale est inactive")


def check_disk():
    for label, path in (("données", "/var/lib/sirius"), ("site", "/var/www/sirius")):
        try:
            usage = shutil.disk_usage(path)
        except OSError as error:
            raise CheckError(f"espace disque {label} impossible à vérifier ({type(error).__name__})") from error
        if usage.total <= 0 or usage.free < 0 or usage.free > usage.total:
            raise CheckError(f"mesure disque {label} invalide")
        used_percent = 100 * (usage.total - usage.free) / usage.total
        if used_percent >= MAX_DISK_PERCENT or usage.free <= MIN_FREE_BYTES:
            raise CheckError(f"espace disque {label} insuffisant")


def run_command(*arguments):
    environment = os.environ.copy()
    environment["LC_ALL"] = "C"
    try:
        return subprocess.run(
            arguments, capture_output=True, text=True, timeout=15, env=environment
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise CheckError(f"commande de surveillance indisponible ({type(error).__name__})") from error


def check_backup():
    timer = run_command("systemctl", "is-active", "--quiet", "sirius-backup.timer")
    if timer.returncode != 0:
        raise CheckError("le minuteur de sauvegarde est absent ou inactif")

    service = run_command(
        "systemctl", "show", "sirius-backup.service", "--no-pager",
        "--property=Result", "--property=ExecMainExitTimestamp",
    )
    if service.returncode != 0:
        raise CheckError("l'état de la sauvegarde est inaccessible")
    properties = dict(line.split("=", 1) for line in service.stdout.splitlines() if "=" in line)
    if properties.get("Result") != "success":
        raise CheckError("la dernière sauvegarde n'a pas réussi")
    timestamp = properties.get("ExecMainExitTimestamp", "")
    if not timestamp or timestamp == "n/a":
        raise CheckError("aucune sauvegarde terminée n'a été trouvée")
    parsed = run_command("date", "-d", timestamp, "+%s")
    if parsed.returncode != 0:
        raise CheckError("date de sauvegarde invalide")
    try:
        age = time.time() - int(parsed.stdout.strip())
    except ValueError as error:
        raise CheckError("date de sauvegarde invalide") from error
    if age < -MAX_CLOCK_SKEW_SECONDS:
        raise CheckError("date de sauvegarde dans le futur")
    if age > MAX_BACKUP_AGE_SECONDS:
        raise CheckError("la dernière sauvegarde est trop ancienne")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("check", choices=("site", "api", "api-local", "disk", "backup"))
    args = parser.parse_args(argv)
    checks = {
        "site": check_site,
        "api": check_api,
        "api-local": lambda: check_api(LOCAL_API_URL, LOCAL_HEALTH_URL),
        "disk": check_disk,
        "backup": check_backup,
    }
    attempts = 3 if args.check in {"site", "api", "api-local"} else 1
    for attempt in range(1, attempts + 1):
        try:
            checks[args.check]()
        except CheckError as error:
            print(f"{args.check}: échec ({attempt}/{attempts}) : {error}", file=sys.stderr)
            if attempt < attempts:
                time.sleep(5)
        else:
            print(f"{args.check}: OK")
            return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
