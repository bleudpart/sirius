from pathlib import Path
import json
import os
import sys

from PyInstaller.utils.hooks import collect_data_files, collect_submodules


def _expected_chromium_revision():
    """Révision de Chromium que la bibliothèque Playwright du build ira chercher (None si illisible)."""
    try:
        import playwright

        manifest = Path(playwright.__file__).parent / "driver" / "package" / "browsers.json"
        browsers = json.loads(manifest.read_text(encoding="utf-8"))["browsers"]
        return next(item["revision"] for item in browsers if item["name"] == "chromium")
    except Exception:
        # Lecture facultative : sans elle on se rabat sur n'importe quel Chromium installé.
        return None


def _bundled_chromium():
    """Dossiers Chromium à embarquer ; arrête le build s'il n'y en a aucun d'utilisable.

    Le webagent (recherche invisible via Playwright) a besoin d'un vrai Chromium sur le poste
    client, sans téléchargement réseau au premier lancement. On embarque seulement le dossier
    "chromium-<révision>" (ni ffmpeg, ni headless-shell, ni winldd : inutilisés par webagent.py)
    depuis le cache où `playwright install chromium` l'a déposé sur la machine de build.
    Un paquet sans lui se construisait pourtant sans erreur et l'agent web était mort chez le
    client (1.0.69 : -144 Mo sur un PC neuf) : mieux vaut refuser de construire.
    """
    cache = Path(os.environ.get("LOCALAPPDATA", "")) / "ms-playwright"
    revision = _expected_chromium_revision()
    # Seule la révision attendue par Playwright est lançable : une autre ne servirait à rien.
    wanted = f"chromium-{revision}" if revision else "chromium-[0-9]*"
    found = []
    if cache.is_dir():
        found = [
            entry
            for entry in sorted(cache.glob(wanted))
            if entry.is_dir() and any(entry.rglob("chrome.exe"))
        ]
    if not found:
        present = sorted(entry.name for entry in cache.glob("chromium-*")) if cache.is_dir() else []
        raise SystemExit(
            f"Chromium introuvable dans {cache} (revision attendue : {revision or 'toute'} ; "
            f"presents : {', '.join(present) or 'aucun'}). L'agent web ne marcherait pas dans l'application "
            f'installee. Lancer : "{sys.executable}" -m playwright install chromium, puis relancer le build.'
        )
    return [(str(entry), f"playwright-browsers/{entry.name}") for entry in found]


backend_dir = Path(SPECPATH)
project_dir = backend_dir.parent
binaries = []
if sys.platform == "win32":
    runtime_dir = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
    required_runtimes = ("msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll")
    if any(not (runtime_dir / name).is_file() for name in required_runtimes):
        raise SystemExit("Installer le redistribuable Microsoft Visual C++ x64 recent avant le build.")
    # Priorite au meme runtime systeme, pas aux vieilles copies livrees par certaines dependances.
    for pattern in ("msvcp140*.dll", "vcruntime140*.dll"):
        binaries.extend((str(path), ".") for path in sorted(runtime_dir.glob(pattern)))
    # Contrôle fait ici, avant les longues collectes de modules : l'échec est immédiat.
    chromium_datas = _bundled_chromium()
else:
    chromium_datas = []
hiddenimports = []
for package in ("media", "productivite", "providers", "routers", "routes"):
    hiddenimports.extend(collect_submodules(package))
hiddenimports.extend(collect_submodules("fal_client"))
# Embeddings locaux : fastembed est importé paresseusement (fonction), on force sa collecte.
hiddenimports.extend(collect_submodules("fastembed"))
# PLANS# : export DXF (import paresseux dans floorplan.py).
hiddenimports.extend(
    collect_submodules(
        "ezdxf",
        filter=lambda module: not module.startswith("ezdxf.addons.browser"),
    )
)

frontend_build = project_dir / "frontend" / "build"
if not (frontend_build / "index.html").is_file():
    raise SystemExit(f"Build React introuvable ({frontend_build}) : lancer 'npm run build' avant le build backend.")
# Fichier par fichier, sans les source maps (.map, ~17 Mo) : elles ne servent qu'aux outils de
# développement. Le JavaScript embarqué reste identique octet pour octet au build React.
datas = [
    (str(path), (Path("frontend/build") / path.relative_to(frontend_build).parent).as_posix())
    for path in sorted(frontend_build.rglob("*"))
    if path.is_file() and path.suffix != ".map"
]
datas.extend(collect_data_files("fastembed"))
datas.extend(collect_data_files("ezdxf"))
static_dir = backend_dir / "static"
if static_dir.exists():
    datas.append((str(static_dir), "static"))

# Never ship owner credentials: refuse to build if any project data entry contains a .env file.
for source, _target in datas:
    source_path = Path(source)
    if project_dir not in source_path.parents:
        continue
    leaked = [source_path] if source_path.is_file() else list(source_path.rglob(".env*"))
    leaked = [path for path in leaked if path.name.startswith(".env")]
    if leaked:
        raise SystemExit("Fichier .env interdit dans le paquet : " + ", ".join(str(path) for path in leaked))

# Chromium du webagent, déjà contrôlé plus haut par _bundled_chromium().
datas.extend(chromium_datas)

analysis = Analysis(
    [str(backend_dir / "desktop_backend.py")],
    pathex=[str(backend_dir)],
    binaries=binaries,
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
        # cffi references these in a never-called static-analysis workaround.
        "pycparser.lextab",
        "pycparser.yacctab",
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
worker_analysis = Analysis(
    [str(backend_dir / "voice_identity_worker.py")],
    pathex=[str(backend_dir)],
    binaries=binaries,
    datas=[],
    hiddenimports=collect_submodules("sherpa_onnx"),
    excludes=["torch", "torchaudio", "torchvision", "transformers", "scipy", "matplotlib"],
    noarchive=False,
)
worker_pyz = PYZ(worker_analysis.pure)
worker_exe = EXE(
    worker_pyz,
    worker_analysis.scripts,
    [],
    exclude_binaries=True,
    name="sirius-voice-worker",
    debug=False,
    strip=False,
    upx=True,
    console=True,
)
collection = COLLECT(
    exe,
    worker_exe,
    analysis.binaries,
    analysis.datas,
    worker_analysis.binaries,
    worker_analysis.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="sirius-backend",
)
