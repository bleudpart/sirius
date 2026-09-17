"""Entry point for the Windows backend sidecar managed by Electron."""

import os
import secrets
from pathlib import Path


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


def main() -> None:
    _prepare_runtime()
    import uvicorn
    from server import app

    uvicorn.run(
        app,
        host="127.0.0.1",
        port=int(os.getenv("SIRIUS_BACKEND_PORT", "8001")),
        reload=False,
        proxy_headers=False,
        access_log=True,
        # The packaged sidecar has no console stream; Uvicorn's default
        # formatter calls isatty() on that missing stream and aborts startup.
        log_config=None,
    )


if __name__ == "__main__":
    main()
