import pytest
from fastapi import HTTPException

from local_reflection import ReflectedResponseError, reflect_api_error, reflect_text


def test_local_repairs_only_presentation_then_rechecks():
    text, report = reflect_text("\ufeff  Proposition.\r\nDétails.  \r\n")
    assert text == "Proposition.\nDétails."
    assert report["state"] == "REPAIRED"
    assert report["passes"] == 2 and report["extra_api_calls"] == 0
    again, second = reflect_text(text)
    assert again == text and second["state"] == "CHECKED" and second["passes"] == 1
    assert "exactitude" in report["scope"]


@pytest.mark.parametrize("value", [None, {}, "", " \r\n", "x" * 12001, "ok\x00bad",
                                    "\x0bresponse", "response\x0c", "````python\nx\n```",
                                    "~~~python\nx", "```python\nx\n~~~",
                                    "<think>raisonnement privé</think>", "<tool_call>send</tool_call>",
                                    "```python\nprint('unfinished')"])
def test_unrepairable_content_is_blocked_not_invented_or_truncated(value):
    with pytest.raises(ReflectedResponseError) as blocked:
        reflect_text(value)
    report = blocked.value.reflection
    assert blocked.value.status_code == 502
    assert report["state"] == "BLOCKED" and report["issues"]
    assert report["extra_api_calls"] == 0 and report["passes"] <= 2


def test_balanced_code_and_unicode_are_preserved_at_exact_length_limit():
    for value in ("```python\nprint('ok')\n```", "~~~text\nok\n~~~~",
                  "```python\ntext = '''first  \nsecond'''\n```",
                  "Échéance : demain.\tÀ vérifier.", "x" * 12000):
        text, report = reflect_text(value)
        assert text == value and report["state"] == "CHECKED"


@pytest.mark.parametrize("status,category", [(401, "authorization"), (403, "authorization"), (429, "quota"),
                                            (422, "request_or_state"), (409, "request_or_state"),
                                            (503, "unconfirmed")])
def test_api_diagnostics_never_change_inputs_reveal_secrets_or_retry(status, category):
    report = reflect_api_error(HTTPException(status, "private error content fixture"))
    assert report["category"] == category
    assert report["http_status"] == status
    assert report["automatic_retry"] is False and report["extra_api_calls"] == 0
    assert "private error" not in str(report)
    assert reflect_api_error(TimeoutError())["category"] == "unconfirmed"
