"""Analyse locale de documents texte sans envoi vers un service externe."""

from collections import Counter
import re


class DocAnalyzer:
    _STOP_WORDS = {
        "avec", "aussi", "dans", "dont", "elle", "elles", "entre", "etre", "leurs",
        "mais", "nous", "pour", "plus", "sans", "sont", "sous", "sur", "tous",
        "tout", "une", "vous", "votre", "avoir", "cette", "comme", "dans", "des",
        "du", "est", "et", "il", "la", "le", "les", "ne", "pas", "par", "que",
        "qui", "se", "son", "un", "une", "the", "this", "that", "with", "from",
    }

    def analyze(self, title: str, content: str) -> dict:
        clean_title = " ".join((title or "Document").split())[:180]
        clean_content = (content or "").strip()
        if not clean_content:
            raise ValueError("Le document est vide.")
        if len(clean_content) > 120000:
            raise ValueError("Le document depasse 120 000 caracteres.")

        lines = [line.strip() for line in clean_content.splitlines() if line.strip()]
        sentences = [
            sentence.strip()
            for sentence in re.split(r"(?<=[.!?])\s+", clean_content)
            if len(sentence.strip()) > 24
        ]
        headings = [
            re.sub(r"^#{1,6}\s*", "", line).strip()[:160]
            for line in lines
            if re.match(r"^#{1,6}\s+\S", line)
            or (line.isupper() and 3 <= len(line) <= 100)
        ][:12]
        action_items = [
            re.sub(r"^(?:[-*]\s*(?:\[[ xX]\]\s*)?|(?:todo|a faire|action)\s*[:\-]?\s*)", "", line, flags=re.I).strip()[:240]
            for line in lines
            if re.match(r"^(?:[-*]\s*(?:\[[ xX]\]\s*)?|(?:todo|a faire|action)\b)", line, flags=re.I)
        ][:20]
        words = [
            word.lower()
            for word in re.findall(r"[A-Za-zÀ-ÖØ-öø-ÿ0-9'-]{4,}", clean_content)
            if word.lower() not in self._STOP_WORDS and not word.isdigit()
        ]
        keywords = [
            {"term": word, "count": count}
            for word, count in Counter(words).most_common(12)
        ]
        summary = " ".join(sentences[:3])[:1200]
        if not summary:
            summary = " ".join(lines[:3])[:1200]

        return {
            "title": clean_title,
            "summary": summary,
            "headings": headings,
            "action_items": action_items,
            "keywords": keywords,
            "statistics": {
                "characters": len(clean_content),
                "words": len(re.findall(r"\S+", clean_content)),
                "lines": len(lines),
                "sentences": len(sentences),
            },
        }

