"""French speech text shared by provider adapters; displayed text stays untouched.

Normalization is idempotent across local and cloud relays. Provider language metadata
describes the requested synthesis, not an acoustic pronunciation guarantee. Custom
backends and relays retain their own response metadata; their actual voice is unknown
unless reported upstream. Native client TTS must apply its own French voice selection.
"""

import re
import unicodedata

SPEECH_LANGUAGE = "fr-FR"
SPEECH_TEXT_VERSION = 3
_SIGMA_NAME = re.compile(r"Σ\s?IRIUS", re.IGNORECASE)
_MAIL_WORD = re.compile(
    r"(?<![\w@.+-])(?:e[-\u2010\u2011 ]?)?mail(s?)(?![\w@+-]|\.[^\W\d_])",
    re.IGNORECASE,
)


def speakable_text(text: str) -> str:
    """Keep French words intact, including « moi »; no phonetic substitutions."""
    text = unicodedata.normalize("NFC", text or "")
    text = re.sub(
        r"\b(qu|[cdjlmnst])[\s\u200b\u200c\u200d\u2060\ufeff]*"
        r"['’‘ʼ＇][\s\u200b\u200c\u200d\u2060\ufeff]*(?=[^\W\d_])",
        r"\1'", text, flags=re.I,
    )
    text = re.sub(r"\bL'(?=[^\W\d_])", "l'", text)
    text = _SIGMA_NAME.sub("Sirius", text)
    text = _MAIL_WORD.sub(lambda match: "courriel" + match.group(1).lower(), text)
    text = re.sub(r"\bCEST\b", "heure d'été d'Europe centrale", text)
    text = re.sub(r"\bCET\b", "heure d'Europe centrale", text)
    text = re.sub(r"\b(?:versus|vs\.?)(?!\s+Code\b)(?=\s|$|[,:;!?])", "contre", text, flags=re.I)
    return re.sub(r"\s+", " ", text).strip()
