# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""PHOTO3D# — reconstruction 3D locale à partir d'une série de photos.

Pipeline 100% local (aucune API payante) :
  1. Chargement + normalisation des photos envoyées (turntable : l'utilisateur
     tourne autour de l'objet et prend une photo tous les N degrés).
  2. Segmentation du sujet par GrabCut (OpenCV) pour isoler la silhouette du fond.
  3. Sculpture par intersection de silhouettes ("visual hull" / voxel carving) :
     on suppose les prises de vue réparties uniformément à 360° autour de l'objet
     et on retire d'une grille de voxels tout ce qui se projette hors silhouette
     dans au moins une vue.
  4. Extraction de la coque de voxels restante en maillage cubique et export .obj
     (+ .mtl minimal) utilisable par n'importe quel visualiseur 3D (three.js, Blender…).

Le calcul est lancé en arrière-plan (ThreadPoolExecutor) et suivi via un job_id :
le frontend interroge /api/photo3d/jobs/{id} pour la barre de progression.
"""

from __future__ import annotations

import io
import logging
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np

try:
    import cv2
except Exception:  # pragma: no cover - opencv absent en environnement minimal
    cv2 = None

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from runtime_paths import data_dir

logger = logging.getLogger("sirius.photo3d")

MAX_PHOTOS = 40
MIN_PHOTOS = 3
VOXEL_RES = 72  # résolution de la grille de sculpture (voxels par axe)
MAX_UPLOAD_MB = 18

_OUTPUT_ROOT = data_dir() / "photo3d-jobs"
_OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)

_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="photo3d")


@dataclass
class Photo3DJob:
    id: str
    status: str = "en_attente"          # en_attente | en_cours | termine | erreur
    progress: int = 0                    # 0-100
    message: str = "En file d'attente…"
    n_photos: int = 0
    obj_filename: Optional[str] = None
    mtl_filename: Optional[str] = None
    error: Optional[str] = None
    created_at: float = field(default_factory=time.time)

    def to_public(self) -> dict:
        return {
            "job_id": self.id,
            "status": self.status,
            "progress": self.progress,
            "message": self.message,
            "n_photos": self.n_photos,
            "obj_url": f"/api/photo3d/jobs/{self.id}/model.obj" if self.obj_filename else None,
            "mtl_url": f"/api/photo3d/jobs/{self.id}/model.mtl" if self.mtl_filename else None,
        }


class JobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, Photo3DJob] = {}
        self._lock = threading.Lock()

    def create(self) -> Photo3DJob:
        job = Photo3DJob(id=uuid.uuid4().hex[:16])
        with self._lock:
            self._jobs[job.id] = job
        return job

    def get(self, job_id: str) -> Optional[Photo3DJob]:
        with self._lock:
            return self._jobs.get(job_id)

    def update(self, job_id: str, **kwargs) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job:
                for k, v in kwargs.items():
                    setattr(job, k, v)


JOBS = JobStore()


# =========================================================
# PIPELINE DE RECONSTRUCTION (100% local, sans API payante)
# =========================================================

def _segment_silhouette(image_bgr: np.ndarray) -> np.ndarray:
    """Isole le sujet du fond avec GrabCut. Retourne un masque booléen (True = sujet)."""
    h, w = image_bgr.shape[:2]
    mask = np.zeros((h, w), np.uint8)
    # Rectangle initial : on suppose le sujet centré, occupant ~80% du cadre
    margin_x, margin_y = int(w * 0.08), int(h * 0.08)
    rect = (margin_x, margin_y, w - 2 * margin_x, h - 2 * margin_y)
    bgd_model = np.zeros((1, 65), np.float64)
    fgd_model = np.zeros((1, 65), np.float64)
    try:
        cv2.grabCut(image_bgr, mask, rect, bgd_model, fgd_model, 5, cv2.GC_INIT_WITH_RECT)
        fg = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 1, 0).astype(np.uint8)
    except Exception as error:  # pragma: no cover - fallback robustesse
        logger.warning("[PHOTO3D] GrabCut échoué (%r), repli sur seuillage simple", error)
        gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
        _, fg = cv2.threshold(gray, 0, 1, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    # Nettoyage morphologique (comble les trous, enlève le bruit)
    kernel = np.ones((7, 7), np.uint8)
    fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, kernel)
    fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, kernel)
    return fg.astype(bool)


def _load_and_prepare(path: Path, target_size: int = 480) -> np.ndarray:
    data = np.fromfile(str(path), dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"Image illisible : {path.name}")
    h, w = img.shape[:2]
    scale = target_size / max(h, w)
    if scale < 1.0:
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    return img


def _voxel_carve(masks: list[np.ndarray], grid_res: int = VOXEL_RES) -> np.ndarray:
    """Sculpte une grille de voxels par intersection des silhouettes (visual hull).

    Hypothèse "turntable" : les N photos sont réparties uniformément sur 360°
    autour de l'objet, caméra fixe en hauteur, orbite circulaire.
    Retourne une grille booléenne (grid_res^3) : True = voxel occupé.
    """
    n = len(masks)
    occ = np.ones((grid_res, grid_res, grid_res), dtype=bool)
    # Grille de coordonnées centrée sur l'origine, cube [-1, 1]^3
    lin = np.linspace(-1.0, 1.0, grid_res)
    xs, ys, zs = np.meshgrid(lin, lin, lin, indexing="ij")  # xs=largeur, ys=hauteur, zs=profondeur

    radius = 1.8  # distance caméra (unités arbitraires normalisées)
    for i, mask in enumerate(masks):
        angle = 2 * np.pi * i / n
        cos_a, sin_a = np.cos(angle), np.sin(angle)
        # Projection orthographique simplifiée dans le plan de vue de la caméra i
        # (rotation autour de l'axe Y, la caméra regarde vers le centre)
        u = xs * cos_a - zs * sin_a       # axe horizontal de l'image
        v = ys                             # axe vertical de l'image
        depth_ok = (xs * sin_a + zs * cos_a) < radius  # devant la caméra

        mh, mw = mask.shape
        # Normalise u,v (dans [-1,1]) vers les coordonnées pixel du masque
        px = np.clip(((u * 0.9 + 1.0) / 2.0 * (mw - 1)).astype(np.int32), 0, mw - 1)
        py = np.clip(((-v * 0.9 + 1.0) / 2.0 * (mh - 1)).astype(np.int32), 0, mh - 1)
        proj_fg = mask[py, px]

        occ &= proj_fg & depth_ok
    return occ


def _voxels_to_obj(occ: np.ndarray, obj_path: Path, mtl_path: Path) -> None:
    """Convertit une grille de voxels occupés en maillage cubique .obj (+ .mtl)."""
    grid_res = occ.shape[0]
    step = 2.0 / grid_res
    verts: list[tuple[float, float, float]] = []
    faces: list[tuple[int, int, int, int]] = []

    # Ne garde que les voxels "de surface" (au moins un voisin vide) pour limiter la taille du maillage
    padded = np.pad(occ, 1, mode="constant", constant_values=False)
    neighbors_sum = (
        padded[0:-2, 1:-1, 1:-1].astype(np.int8)
        + padded[2:, 1:-1, 1:-1].astype(np.int8)
        + padded[1:-1, 0:-2, 1:-1].astype(np.int8)
        + padded[1:-1, 2:, 1:-1].astype(np.int8)
        + padded[1:-1, 1:-1, 0:-2].astype(np.int8)
        + padded[1:-1, 1:-1, 2:].astype(np.int8)
    )
    surface = occ & (neighbors_sum < 6)
    idx = np.argwhere(surface)
    if idx.shape[0] == 0:
        raise ValueError("Aucun volume détecté — vérifiez que le sujet est bien visible et centré sur chaque photo.")
    if idx.shape[0] > 60000:
        # Sous-échantillonne pour garder un fichier raisonnable
        keep = np.random.default_rng(0).choice(idx.shape[0], 60000, replace=False)
        idx = idx[keep]

    cube_offsets = np.array([
        [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
        [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
    ])
    cube_faces = [
        (0, 1, 2, 3), (4, 5, 6, 7), (0, 1, 5, 4),
        (2, 3, 7, 6), (1, 2, 6, 5), (0, 3, 7, 4),
    ]

    for (ix, iy, iz) in idx:
        base = len(verts)
        origin = np.array([ix, iy, iz]) * step - 1.0
        for off in cube_offsets:
            v = origin + off * step
            verts.append((float(v[0]), float(v[1]), float(v[2])))
        for (a, b, c, d) in cube_faces:
            faces.append((base + a + 1, base + b + 1, base + c + 1, base + d + 1))

    mtl_path.write_text(
        "newmtl sirius_material\n"
        "Ka 0.15 0.15 0.18\n"
        "Kd 0.75 0.68 0.45\n"
        "Ks 0.25 0.25 0.25\n"
        "Ns 32\n"
        "d 1.0\n",
        encoding="utf-8",
    )
    with obj_path.open("w", encoding="utf-8") as f:
        f.write("# ΣIRIUS PHOTO3D# — objet reconstruit localement à partir de photos\n")
        f.write(f"mtllib {mtl_path.name}\n")
        f.write("usemtl sirius_material\n")
        for v in verts:
            f.write(f"v {v[0]:.5f} {v[1]:.5f} {v[2]:.5f}\n")
        for face in faces:
            f.write("f " + " ".join(str(i) for i in face) + "\n")


def _run_job(job_id: str, image_paths: list[Path]) -> None:
    job_dir = _OUTPUT_ROOT / job_id
    try:
        JOBS.update(job_id, status="en_cours", progress=2, message="Chargement des photos…")
        if cv2 is None:
            raise RuntimeError("Le module OpenCV n'est pas disponible sur ce poste.")

        masks: list[np.ndarray] = []
        total = len(image_paths)
        for i, path in enumerate(image_paths):
            img = _load_and_prepare(path)
            mask = _segment_silhouette(img)
            masks.append(mask)
            progress = 5 + int(50 * (i + 1) / total)
            JOBS.update(job_id, progress=progress, message=f"Analyse de la photo {i + 1}/{total}…")

        JOBS.update(job_id, progress=60, message="Sculpture du volume 3D (voxel carving)…")
        occ = _voxel_carve(masks, grid_res=VOXEL_RES)

        JOBS.update(job_id, progress=85, message="Génération du maillage .obj…")
        obj_path = job_dir / "model.obj"
        mtl_path = job_dir / "model.mtl"
        _voxels_to_obj(occ, obj_path, mtl_path)

        JOBS.update(
            job_id,
            status="termine",
            progress=100,
            message="Modèle 3D prêt.",
            obj_filename="model.obj",
            mtl_filename="model.mtl",
        )
    except Exception as error:  # pylint: disable=broad-except
        logger.error("[PHOTO3D] job %s échoué : %r", job_id, error)
        JOBS.update(job_id, status="erreur", message=str(error), error=str(error))
    finally:
        # Nettoie les photos sources, on ne garde que le modèle généré
        for path in image_paths:
            try:
                path.unlink(missing_ok=True)
            except Exception:
                pass


# =========================================================
# ROUTES API
# =========================================================

class Photo3DStatusResponse(BaseModel):
    job_id: str
    status: str
    progress: int
    message: str


def make_photo3d_router(rate_ok) -> APIRouter:
    router = APIRouter(prefix="/photo3d", tags=["photo3d"])

    @router.post("/jobs")
    async def create_job(request: Request, files: list[UploadFile] = File(...)):
        if not rate_ok(request.client.host if request.client else "?", limit=5):
            raise HTTPException(status_code=429, detail="Trop de requêtes, patientez un instant.")
        if len(files) < MIN_PHOTOS:
            raise HTTPException(status_code=400, detail=f"Il faut au moins {MIN_PHOTOS} photos (idéalement 12 à 24, prises tout autour de l'objet).")
        if len(files) > MAX_PHOTOS:
            raise HTTPException(status_code=400, detail=f"Maximum {MAX_PHOTOS} photos par modèle.")

        job = JOBS.create()
        job_dir = _OUTPUT_ROOT / job.id
        job_dir.mkdir(parents=True, exist_ok=True)

        image_paths: list[Path] = []
        for i, upload in enumerate(files):
            content = await upload.read()
            if len(content) > MAX_UPLOAD_MB * 1024 * 1024:
                raise HTTPException(status_code=400, detail=f"Photo trop lourde (> {MAX_UPLOAD_MB} Mo) : {upload.filename}")
            suffix = Path(upload.filename or f"photo{i}.jpg").suffix or ".jpg"
            dest = job_dir / f"src_{i:03d}{suffix}"
            dest.write_bytes(content)
            image_paths.append(dest)

        JOBS.update(job.id, n_photos=len(image_paths))
        _EXECUTOR.submit(_run_job, job.id, image_paths)
        return job.to_public()

    @router.get("/jobs/{job_id}")
    async def get_job(job_id: str):
        job = JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job introuvable.")
        return job.to_public()

    @router.get("/jobs/{job_id}/model.obj")
    async def get_model_obj(job_id: str):
        job = JOBS.get(job_id)
        if not job or not job.obj_filename:
            raise HTTPException(status_code=404, detail="Modèle non disponible.")
        path = _OUTPUT_ROOT / job_id / job.obj_filename
        if not path.is_file():
            raise HTTPException(status_code=404, detail="Fichier introuvable.")
        return FileResponse(path, media_type="text/plain", filename="sirius-model.obj")

    @router.get("/jobs/{job_id}/model.mtl")
    async def get_model_mtl(job_id: str):
        job = JOBS.get(job_id)
        if not job or not job.mtl_filename:
            raise HTTPException(status_code=404, detail="Matériau non disponible.")
        path = _OUTPUT_ROOT / job_id / job.mtl_filename
        if not path.is_file():
            raise HTTPException(status_code=404, detail="Fichier introuvable.")
        return FileResponse(path, media_type="text/plain", filename="sirius-model.mtl")

    return router
