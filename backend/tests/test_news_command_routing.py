import json
from pathlib import Path

import pytest

from sirius_brain import _general_news_scope, _news_retry_scope, _with_follow_up_topic


EXAMPLES = json.loads((
    Path(__file__).resolve().parents[2] / "frontend" / "src" / "__fixtures__" / "newsCommands.json"
).read_text(encoding="utf-8"))


@pytest.mark.parametrize("command,scope", EXAMPLES["direct"])
def test_natural_news_requests_match_frontend_contract(command, scope):
    assert _general_news_scope(command) == scope


@pytest.mark.parametrize("command,previous_scope,scope", EXAMPLES["followups"])
def test_news_retries_match_frontend_contract(command, previous_scope, scope):
    assert _news_retry_scope(command, previous_scope) == scope


@pytest.mark.parametrize("command,previous_scope,scope", [
    example for example in EXAMPLES["followups"] if example[2]
])
def test_retries_inherit_only_the_current_news_conversation(command, previous_scope, scope):
    previous = {"all": "journal", "france": "les actus françaises", "international": "les infos internationales"}
    history = [
        {"role": "user", "content": previous[previous_scope]},
        {"role": "assistant", "content": "Bulletin sourcé."},
    ]
    assert _general_news_scope(_with_follow_up_topic(command, history)) == scope
    history.append({"role": "user", "content": "Aide-moi à organiser mon projet"})
    assert _with_follow_up_topic(command, history) == command
    assert _with_follow_up_topic(command, []) == command


def test_successive_scope_changes_keep_news_context_without_old_answer_facts():
    history = [
        {"role": "user", "content": "Affiche le journal"},
        {"role": "assistant", "content": "Fait hors source à ne jamais reprendre."},
        {"role": "user", "content": "internationale"},
        {"role": "assistant", "content": "Bulletin international."},
        {"role": "user", "content": "non recommence"},
    ]
    assert _general_news_scope(_with_follow_up_topic("réessaie", history)) == "international"
    assert _general_news_scope(_with_follow_up_topic("générale", history)) == "all"
    assert "hors source" not in _with_follow_up_topic("générale", history)
    assert _with_follow_up_topic("et l'économie ?", history) == "et l'économie ?"
