from pathlib import Path
import os

from PyInstaller.utils.hooks import collect_data_files, collect_submodules


backend_dir = Path(SPECPATH)
project_dir = backend_dir.parent
hiddenimports = []
for package in ("media", "productivite", "providers", "routers", "routes"):
    hiddenimports.extend(collect_submodules(package))
hiddenimports.extend(collect_submodules("fal_client"))
# Embeddings locaux : fastembed est importé paresseusement (fonction), on force sa collecte.
hiddenimports.extend(collect_submodules("fastembed"))
# PLANS# : export DXF (import paresseux dans floorplan.py).
hiddenimports.extend(collect_submodules("ezdxf"))

datas = [
    (str(project_dir / "frontend" / "build"), "frontend/build"),
]
datas.extend(collect_data_files("fastembed"))
datas.extend(collect_data_files("ezdxf"))
static_dir = backend_dir / "static"
if static_dir.exists():
    datas.append((str(static_dir), "static"))

# Le webagent (recherche invisible via Playwright) a besoin d'un vrai Chromium
# sur le poste client, sans dépendre d'un téléchargement réseau au premier lancement.
# On embarque uniquement le dossier "chromium-*" (pas ffmpeg/headless-shell/winldd,
# inutilisés par webagent.py) depuis le cache local où `playwright install chromium`
# l'a déposé sur la machine de build.
playwright_cache = Path(os.environ.get("LOCALAPPDATA", "")) / "ms-playwright"
for entry in sorted(playwright_cache.glob("chromium-*")) if playwright_cache.exists() else []:
    if entry.is_dir() and "headless_shell" not in entry.name:
        datas.append((str(entry), f"playwright-browsers/{entry.name}"))

analysis = Analysis(
    [str(backend_dir / "desktop_backend.py")],
    pathex=[str(backend_dir)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "av",
        "black",
        "cv2",
        "flake8",
        "matplotlib",
        "mypy",
        "pandas",
        "pygame",
        "pytest",
        "scipy",
        "sympy",
        "torch",
        "torchaudio",
        "torchvision",
        "transformers",
    ],
    noarchive=False,
)
pyz = PYZ(analysis.pure)
exe = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="sirius-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
)
collection = COLLECT(
    exe,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="sirius-backend",
)
