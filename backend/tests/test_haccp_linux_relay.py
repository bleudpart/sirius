import os
import sqlite3
from unittest.mock import Mock

import pytest

import haccp_linux_relay as relay


def test_build_document_accepts_server_label_and_sets_exact_page_size():
    document = relay.build_document({
        "id": "c76e3188-786b-41a8-88e8-c50e9551f108",
        "html": "<article>Saumon</article>", "widthMm": 62, "heightMm": 50,
    })
    assert "@page{size:62mm 50mm;margin:0}" in document
    assert "default-src 'none'" in document
    assert "<article>Saumon</article>" in document


def test_measurement_rejects_content_that_would_be_clipped():
    relay.check_measurement('data-sirius-measure="234,188,234,188"', 62, 50)
    with pytest.raises(relay.RelayError, match="trop grande"):
        relay.check_measurement('data-sirius-measure="234,195,234,195"', 62, 50)


@pytest.mark.parametrize("fragment", [
    "<script>alert(1)</script>", '<img src="x" onerror="alert(1)">', "<iframe></iframe>",
])
def test_build_document_refuses_active_or_external_document_markup(fragment):
    with pytest.raises(relay.RelayError):
        relay.build_document({
            "id": "c76e3188-786b-41a8-88e8-c50e9551f108",
            "html": fragment, "widthMm": 62, "heightMm": 50,
        })


def test_print_journal_recovers_interrupted_submission_as_uncertain(tmp_path):
    journal = relay.PrintJournal(tmp_path / "journal.sqlite3")
    job_id = "c76e3188-786b-41a8-88e8-c50e9551f108"
    assert journal.begin(job_id)
    with sqlite3.connect(journal.path) as db:
        assert db.execute("SELECT state FROM jobs WHERE job_id=?", (job_id,)).fetchone()[0] == "submitted"

    restarted = relay.PrintJournal(journal.path)
    assert restarted.state(job_id) == "uncertain"
    assert not restarted.begin(job_id)


def test_config_file_is_restricted_and_does_not_store_account_password(tmp_path, monkeypatch):
    config_path = tmp_path / "config" / "relay.json"
    monkeypatch.setattr(relay, "CONFIG_FILE", config_path)
    token = "A" * 43
    relay.save_config(token)
    assert relay.load_config() == {"token": token}
    assert config_path.read_text(encoding="utf-8") == '{"token": "' + token + '"}\n'
    if os.name == "posix":
        assert config_path.stat().st_mode & 0o077 == 0


def test_job_is_submitted_once_and_acked_only_after_spool_acceptance(tmp_path, monkeypatch):
    job = {
        "id": "c76e3188-786b-41a8-88e8-c50e9551f108",
        "html": "<article>Saumon</article>", "widthMm": 62, "heightMm": 50,
    }
    config = {"token": "A" * 43}
    journal = relay.PrintJournal(tmp_path / "journal.sqlite3")
    spool = Mock()
    requests = []

    def request(method, path, token, body=None):
        requests.append((method, path, body))
        return {"device_name": "Brother", "width_mm": 62, "height_mm": 50}

    monkeypatch.setattr(relay, "spool", spool)
    monkeypatch.setattr(relay, "request_json", request)
    relay.process_job(job, config, journal)
    relay.process_job(job, config, journal)

    assert spool.call_count == 1
    assert [request[2]["status"] for request in requests if request[0] == "POST"] == ["accepted", "accepted"]
    assert journal.state(job["id"]) == "accepted"


def test_uncertain_job_is_acknowledged_but_never_spooled_again(tmp_path, monkeypatch):
    job = {
        "id": "c76e3188-786b-41a8-88e8-c50e9551f108",
        "html": "<article>Saumon</article>", "widthMm": 62, "heightMm": 50,
    }
    config = {"token": "A" * 43}
    journal = relay.PrintJournal(tmp_path / "journal.sqlite3")
    spool = Mock(side_effect=relay.RelayError("CUPS indisponible"))
    requests = []

    def request(method, path, token, body=None):
        requests.append((method, path, body))
        return {"device_name": "Brother", "width_mm": 62, "height_mm": 50}

    monkeypatch.setattr(relay, "spool", spool)
    monkeypatch.setattr(relay, "request_json", request)
    relay.process_job(job, config, journal)
    relay.process_job(job, config, journal)

    assert spool.call_count == 1
    assert [request[2]["status"] for request in requests if request[0] == "POST"] == ["uncertain", "uncertain"]
    assert journal.state(job["id"]) == "uncertain"
