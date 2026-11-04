import importlib.util
import subprocess
from pathlib import Path

import pytest

AUDIT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "sirius_audit.py"
spec = importlib.util.spec_from_file_location("sirius_audit", AUDIT_PATH)
sirius_audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sirius_audit)

# Jetons factices composes a l'execution pour ne pas declencher l'audit sur ce fichier.
FAKE_GITHUB = "gh" + "p_" + "A1b2C3d4" * 4 + "E5f6"
FAKE_GROQ = "gs" + "k_" + "Q9w8E7r6" * 6 + "T5y4"


def _git_repo(tmp_path: Path, files: dict[str, str]) -> Path:
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    for name, content in files.items():
        (tmp_path / name).write_text(content, encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
    return tmp_path


def test_jeton_reel_suivi_est_signale_sans_recopier_la_valeur(tmp_path):
    repo = _git_repo(tmp_path, {
        "config.py": f'TOKEN = "{FAKE_GITHUB}"\n',
        "notes.txt": f"ligne\ncle={FAKE_GROQ}\n",
    })

    issues = sirius_audit.check_tracked_secrets(repo)

    assert "Secret-like token in config.py:1 (GitHub token)" in issues
    assert "Secret-like token in notes.txt:2 (Groq key)" in issues
    assert not any(FAKE_GITHUB in issue or FAKE_GROQ in issue for issue in issues)


@pytest.mark.parametrize("content", [
    "set GH_TOKEN=ghp_votre_token\n",
    'placeholder: "gsk_..."\n',
    '{"groq": "gsk_TESTKEY123", "openai": "sk-test"}\n',
    "Groq key gsk_NKnkx0...Eu5H6\n",
    "task-" + "a" * 40 + "\n",
])
def test_exemples_et_prefixes_seuls_ne_sont_pas_des_secrets(tmp_path, content):
    repo = _git_repo(tmp_path, {"exemple.txt": content})

    assert sirius_audit.check_tracked_secrets(repo) == []


def test_echec_de_git_grep_fait_echouer_le_controle(tmp_path):
    issues = sirius_audit.check_tracked_secrets(tmp_path)

    assert len(issues) == 1
    assert issues[0].startswith("Secret scan failed (git grep exit")


def test_depot_sirius_ne_contient_aucun_jeton_suivi():
    assert sirius_audit.check_tracked_secrets() == []
