from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules


backend_dir = Path(SPECPATH)
project_dir = backend_dir.parent
hiddenimports = []
for package in ("media", "productivite", "providers", "routers", "routes"):
    hiddenimports.extend(collect_submodules(package))
hiddenimports.extend(collect_submodules("fal_client"))

datas = [
    (str(project_dir / "frontend" / "build"), "frontend/build"),
]
static_dir = backend_dir / "static"
if static_dir.exists():
    datas.append((str(static_dir), "static"))

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
        "huggingface_hub",
        "matplotlib",
        "mypy",
        "onnxruntime",
        "pandas",
        "pygame",
        "pytest",
        "scipy",
        "sympy",
        "tokenizers",
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
