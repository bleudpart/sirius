# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
"""Cache local du carnet d'adresses (Outlook, Google).

Relire les centaines de contacts chez le fournisseur à chaque demande coûte plusieurs
secondes et échoue dès que le réseau flanche. Les contacts normalisés sont donc écrits
sur le poste et resservis tant qu'ils sont frais.
"""
import json
import re
import time
import unicodedata

from runtime_paths import data_file, write_json_atomic

CACHE_FILE = data_file("contacts_cache.json")
CACHE_TTL_SECONDS = 6 * 3600


def _load_all() -> dict:
    try:
        with open(CACHE_FILE, encoding="utf-8") as stream:
            data = json.load(stream)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _key(user_id: str, source: str) -> str:
    return f"{source}:{user_id}"


def read(user_id: str, source: str, ttl: int = CACHE_TTL_SECONDS):
    """Contacts en cache, ou None s'ils sont absents ou périmés."""
    entry = _load_all().get(_key(user_id, source))
    if not entry or time.time() - entry.get("saved_at", 0) > ttl:
        return None
    contacts = entry.get("contacts")
    return contacts if isinstance(contacts, list) else None


def write(user_id: str, source: str, contacts: list) -> None:
    data = _load_all()
    data[_key(user_id, source)] = {"saved_at": time.time(), "contacts": contacts}
    try:
        write_json_atomic(CACHE_FILE, data)
    except OSError:
        pass  # cache non critique : une écriture impossible ne doit jamais casser la recherche


def invalidate(user_id: str, source: str) -> None:
    data = _load_all()
    if data.pop(_key(user_id, source), None) is not None:
        try:
            write_json_atomic(CACHE_FILE, data)
        except OSError:
            pass


def fold(value: str) -> str:
    """Minuscules sans accents : la dictée vocale n'accentue pas les noms de façon fiable."""
    decomposed = unicodedata.normalize("NFD", value or "").casefold()
    return "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")


def phone_digits(value: str) -> str:
    """Numéro réduit à ses chiffres, au format national : « +33 6 77 66 64 34 » et
    « 06.77.66.64.34 » doivent se retrouver mutuellement."""
    digits = re.sub(r"\D", "", value or "")
    if digits.startswith("0033"):
        digits = digits[4:]
    elif digits.startswith("33") and len(digits) > 9:
        digits = digits[2:]
    return digits.lstrip("0")


def searchable(contact: dict) -> dict:
    """Index de recherche d'un contact : texte replié + numéros réduits aux chiffres."""
    text = fold(" ".join([
        contact.get("nom", ""), contact.get("prenom", ""), contact.get("nom_famille", ""),
        contact.get("entreprise", ""), contact.get("poste", ""),
        *(contact.get("emails") or []),
    ]))
    phones = [p for p in (phone_digits(t) for t in (contact.get("telephones") or [])) if p]
    return {"text": text, "phones": phones}


def matches(index: dict, tokens: list) -> bool:
    """Tous les mots cherchés doivent être présents, dans n'importe quel ordre. Un mot
    composé de chiffres est confronté aux numéros, jamais au texte."""
    for token in tokens:
        digits = phone_digits(token)
        if digits and len(digits) >= 4 and not re.search(r"[a-z]", token):
            if any(digits in phone for phone in index["phones"]):
                continue
            return False
        if token in index["text"]:
            continue
        words = [w for w in re.split(r"[^\w@.]+", index["text"]) if w]
        if any(len(w) >= 4 and token.startswith(w) for w in words):
            continue
        return False
    return True


def tokenize(query: str) -> list:
    return [t for t in re.split(r"[^\w@.+]+", fold(query)) if t]
