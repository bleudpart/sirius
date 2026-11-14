"""Entry point for the Windows backend sidecar managed by Electron."""

import os
import secrets
import socket
import sys
from pathlib import Path

import psutil


# Le Microsoft Store interdit de lancer powershell.exe ou taskkill.exe : tout passe par psutil.
def _protected_pids() -> set[int]:
    """Le processus courant et ses parents (dont l'Electron qui l'a lancé) ne sont jamais tués."""
    protected = {os.getpid()}
    try:
        protected.update(parent.pid for parent in psutil.Process(os.getpid()).parents())
    except psutil.Error:
        pass
    return protected


def _windows_sirius_processes() -> list[int]:
    """Retourne les PIDs des processus SIRIUS déjà en cours sur Windows."""
    if os.name != "nt":
        return []
    protected = _protected_pids()
    ids = []
    for proc in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            name = (proc.info.get("name") or "").lower()
            cmdline = " ".join(proc.info.get("cmdline") or []).lower()
        except psutil.Error:
            continue
        if proc.pid in protected:
            continue
        if name.startswith("sirius-") or "sirius-backend" in cmdline:
            ids.append(proc.pid)
    return ids


def _send_terminate(pid: int) -> None:
    try:
        proc = psutil.Process(pid)
        targets = proc.children(recursive=True) + [proc]
    except psutil.Error:
        return
    for target in targets:
        try:
            target.kill()
        except psutil.Error:
            pass
    psutil.wait_procs(targets, timeout=5)


def _windows_port_owner_pid(host: str, port: int) -> int | None:
    """Retourne le PID du processus qui possède actuellement le port TCP, si présent."""
    if os.name != "nt":
        return None
    try:
        connections = psutil.net_connections(kind="tcp")
    except psutil.Error:
        return None
    protected = _protected_pids()
    for conn in connections:
        if not conn.laddr or conn.laddr.port != port or conn.status == psutil.CONN_CLOSE:
            continue
        if conn.pid and conn.pid not in protected:
            return conn.pid
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

    # Chromium embarqué par sirius-backend.spec sous playwright-browsers/.
    bundle_dir = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    browsers_dir = bundle_dir / "playwright-browsers"
    if browsers_dir.is_dir():
        os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(browsers_dir))

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


def main() -> None:
    _prepare_runtime()
    port = int(os.getenv("SIRIUS_BACKEND_PORT", "8001"))
    if _port_in_use("127.0.0.1", port):
        _cleanup_stale_sirius_processes("127.0.0.1", port)
        if _port_in_use("127.0.0.1", port):
            raise RuntimeError(
                f"Le port 127.0.0.1:{port} est déjà occupé. Fermeture du backend ΣIRIUS précédent requis."
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
