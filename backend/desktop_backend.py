"""Entry point for the Windows backend sidecar managed by Electron."""

import os
import secrets
import socket
import subprocess
import sys
from pathlib import Path

from runtime_paths import project_dir


def _windows_sirius_processes() -> list[int]:
    """Retourne les PIDs des processus SIRIUS déjà en cours sur Windows."""
    if os.name != "nt":
        return []
    command = (
        "Get-CimInstance Win32_Process | Where-Object { "
        "($_.Name -match 'sirius-backend') -or ($_.Name -match 'SIRIUS') -or "
        "($_.CommandLine -match 'sirius-backend') -or ($_.CommandLine -match 'ΣIRIUS') } "
        "| Select-Object -ExpandProperty ProcessId"
    )
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", command],
            capture_output=True,
            text=True,
            check=False,
        )
    except (FileNotFoundError, OSError):
        return []
    if result.returncode != 0:
        return []
    ids = []
    for line in result.stdout.splitlines():
        cleaned = line.strip()
        if not cleaned:
            continue
        try:
            ids.append(int(cleaned))
        except ValueError:
            continue
    return ids


def _send_terminate(pid: int) -> None:
    try:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], check=False, capture_output=True)
    except OSError:
        pass


def _windows_port_owner_pid(host: str, port: int) -> int | None:
    """Retourne le PID du processus qui possède actuellement le port TCP, si présent."""
    if os.name != "nt":
        return None
    command = (
        "Get-NetTCPConnection -LocalPort {port} -ErrorAction SilentlyContinue | "
        "Where-Object {{ $_.State -ne 'Closed' }} | "
        "Select-Object -ExpandProperty OwningProcess"
    ).format(port=port)
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", command],
            capture_output=True,
            text=True,
            check=False,
        )
    except (FileNotFoundError, OSError):
        return None
    if result.returncode != 0:
        return None
    for line in result.stdout.splitlines():
        cleaned = line.strip()
        if not cleaned:
            continue
        try:
            pid = int(cleaned)
        except ValueError:
            continue
        if pid and pid != os.getpid():
            return pid
    return None


def _cleanup_stale_sirius_processes(host: str = "127.0.0.1", port: int = 8001) -> None:
    """Tue les restes de l'ancien backend SIRIUS pour éviter les conflits de port."""
    seen: set[int] = set()
    for pid in sorted(set(_windows_sirius_processes())):
        if pid == os.getpid():
            continue
        seen.add(pid)

    owner_pid = _windows_port_owner_pid(host, port)
    if owner_pid is not None:
        seen.add(owner_pid)

    for pid in sorted(seen):
        _send_terminate(pid)


def _port_in_use(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
        except OSError:
            return True
        return False


def _prepare_runtime() -> None:
    default_data_dir = Path(os.getenv("LOCALAPPDATA", Path.home())) / "ΣIRIUS"
    data_dir = Path(os.getenv("SIRIUS_DATA_DIR", default_data_dir)).expanduser().resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    os.environ["SIRIUS_DATA_DIR"] = str(data_dir)
    os.environ["SIRIUS_PACKAGED"] = "1"

    secret_file = data_dir / "auth-secret"
    try:
        secret = secret_file.read_text(encoding="ascii").strip()
    except FileNotFoundError:
        secret = secrets.token_urlsafe(64)
        try:
            descriptor = os.open(secret_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            secret = secret_file.read_text(encoding="ascii").strip()
        else:
            with os.fdopen(descriptor, "w", encoding="ascii") as stream:
                stream.write(secret)
    if not secret:
        raise RuntimeError("Le secret de session ΣIRIUS est vide.")
    os.environ.setdefault("SIRIUS_AUTH_SECRET", secret)

    # Le webagent (recherche invisible via Playwright) doit trouver Chromium
    # à l'intérieur du bundle PyInstaller, sans compter sur un téléchargement
    # réseau sur le poste client (voir sirius-backend.spec pour les binaires).
    if getattr(sys, "frozen", False):
        bundled_browsers = project_dir() / "playwright-browsers"
        if bundled_browsers.exists():
            os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(bundled_browsers))


def main() -> None:
    _prepare_runtime()
    port = int(os.getenv("SIRIUS_BACKEND_PORT", "8001"))
    if _port_in_use("127.0.0.1", port):
        _cleanup_stale_sirius_processes("127.0.0.1", port)
        if _port_in_use("127.0.0.1", port):
            raise RuntimeError(
                f"Le port 127.0.0.1:{port} est déjà occupé. Fermeture du backend SIRIUS précédent requis."
            )

    import uvicorn
    from server import app

    uvicorn.run(
        app,
        host="127.0.0.1",
        port=port,
        reload=False,
        proxy_headers=False,
        access_log=True,
        # The packaged sidecar has no console stream; Uvicorn's default
        # formatter calls isatty() on that missing stream and aborts startup.
        log_config=None,
    )


if __name__ == "__main__":
    main()
