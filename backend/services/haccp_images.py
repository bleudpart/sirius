"""Validation commune aux images recues par l'API et aux exemples hors ligne."""
import io

from PIL import Image, UnidentifiedImageError

MAX_IMAGE_BYTES = 20 * 1024 * 1024
IMAGE_FORMATS = {"image/jpeg": ("JPEG", ".jpg"), "image/png": ("PNG", ".png"), "image/webp": ("WEBP", ".webp")}


class ImageValidationError(ValueError):
    pass


def validate_source_image(content: bytes, mime_type: str) -> None:
    if mime_type not in IMAGE_FORMATS or not content:
        raise ImageValidationError("Image absente ou format non pris en charge.")
    if len(content) > MAX_IMAGE_BYTES:
        raise ImageValidationError("L'image ne doit pas depasser 20 Mo.")
    try:
        with Image.open(io.BytesIO(content)) as image:
            if image.format != IMAGE_FORMATS[mime_type][0]:
                raise ImageValidationError("Le format reel de l'image ne correspond pas au type annonce.")
            if image.width * image.height > 25_000_000:
                raise ImageValidationError("Image trop grande : maximum 25 millions de pixels.")
            image.verify()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as error:
        if isinstance(error, ImageValidationError):
            raise
        raise ImageValidationError("Le fichier ne contient pas une image valide et lisible.") from error
