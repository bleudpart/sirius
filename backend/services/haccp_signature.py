"""Validation des signatures manuscrites des relevés HACCP."""

import base64
import binascii
from io import BytesIO

from PIL import Image, ImageChops, UnidentifiedImageError


SIGNATURE_PREFIX = "data:image/png;base64,"
MAX_SIGNATURE_BYTES = 192_000
MAX_SIGNATURE_PIXELS = 2_000_000


def decode_signature(value: str) -> bytes:
    if not isinstance(value, str) or not value.startswith(SIGNATURE_PREFIX):
        raise ValueError("Une signature manuscrite au format PNG est requise.")
    encoded = value[len(SIGNATURE_PREFIX):]
    if len(encoded) > ((MAX_SIGNATURE_BYTES + 2) // 3) * 4:
        raise ValueError("La signature est trop volumineuse.")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("La signature est illisible.") from error
    if not raw or len(raw) > MAX_SIGNATURE_BYTES:
        raise ValueError("La signature est vide ou trop volumineuse.")
    try:
        with Image.open(BytesIO(raw)) as image:
            if image.format != "PNG" or image.width * image.height > MAX_SIGNATURE_PIXELS:
                raise ValueError("Le format ou les dimensions de la signature sont invalides.")
            image.load()
            drawing = image.convert("RGBA")
            white = Image.new("RGBA", drawing.size, "white")
            white.alpha_composite(drawing)
            difference = ImageChops.difference(white.convert("RGB"), Image.new("RGB", drawing.size, "white"))
            if difference.getbbox() is None:
                raise ValueError("Signez avant d'enregistrer le relevé.")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as error:
        raise ValueError("La signature PNG est illisible.") from error
    return raw
