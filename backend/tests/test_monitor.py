import importlib.util
import json
import os
import shutil
import subprocess
import threading
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "deploy" / "hetzner" / "monitor.py"
spec = importlib.util.spec_from_file_location("sirius_monitor", SCRIPT)
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


def test_public_checks_use_real_http_responses(monkeypatch):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            responses = {
                "/sha": "a" * 40 + "\n",
                "/api/health": json.dumps({"status": "ok"}),
                "/health": json.dumps({
                    "status": "ok",
                    "checks": {"database": "mongodb", "mongo": "ok", "mongo_required": True},
                }),
            }
            if self.path not in responses:
                self.send_error(404)
                return
            body = responses[self.path].encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    try:
        base = f"http://127.0.0.1:{server.server_port}"
        monkeypatch.setattr(monitor, "SITE_URL", base + "/sha")
        monkeypatch.setattr(monitor, "API_URL", base + "/api/health")
        monkeypatch.setattr(monitor, "HEALTH_URL", base + "/health")
        monitor.check_site()
        monitor.check_api()
        with pytest.raises(monitor.CheckError, match="HTTP 404"):
            monitor.fetch(base + "/missing")
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.mark.parametrize("version", ["", "a" * 39, "g" * 40, "<html>" + "a" * 40])
def test_site_rejects_missing_or_invalid_version(monkeypatch, version):
    monkeypatch.setattr(monitor, "fetch", lambda _url: version)
    with pytest.raises(monitor.CheckError, match="version"):
        monitor.check_site()


@pytest.mark.parametrize(
    "simple, detailed",
    [
        ({"status": "error"}, {"status": "ok", "checks": {"database": "mongodb", "mongo": "ok", "mongo_required": True}}),
        ({"status": "ok"}, {"status": "degraded", "checks": {"database": "mongodb", "mongo": "down", "mongo_required": True}}),
        ({"status": "ok"}, {"status": "ok", "checks": {"database": "sqlite", "mongo": "unused", "mongo_required": True}}),
        ({"status": "ok"}, {"status": "ok", "checks": {"database": "mongodb", "mongo": "down", "mongo_required": True}}),
        ({"status": "ok"}, {"status": "ok", "checks": {"database": "mongodb", "mongo": "ok", "mongo_required": False}}),
        ({"status": "ok"}, {"status": "ok", "checks": {"database": "mongodb", "mongo": "ok"}}),
        ({"status": "ok"}, {"status": "ok", "checks": None}),
    ],
)
def test_api_detects_degradation_and_silent_local_database_fallback(monkeypatch, simple, detailed):
    monkeypatch.setattr(monitor, "fetch_json", lambda url: simple if url == monitor.API_URL else detailed)
    with pytest.raises(monitor.CheckError):
        monitor.check_api()


@pytest.mark.parametrize("body", ["not JSON", "[]", "null"])
def test_health_must_be_a_json_object(monkeypatch, body):
    monkeypatch.setattr(monitor, "fetch", lambda _url: body)
    with pytest.raises(monitor.CheckError, match="JSON"):
        monitor.fetch_json(monitor.HEALTH_URL)


def test_network_errors_are_reported_without_echoing_details(monkeypatch):
    def unavailable(*_args, **_kwargs):
        raise urllib.error.URLError("private-network-detail")

    monkeypatch.setattr(monitor.urllib.request, "urlopen", unavailable)
    with pytest.raises(monitor.CheckError, match="réseau inaccessible") as error:
        monitor.fetch(monitor.API_URL)
    assert "private-network-detail" not in str(error.value)


def test_public_checks_retry_transient_failures(monkeypatch, capsys):
    calls = []
    sleeps = []

    def flaky():
        calls.append(True)
        if len(calls) < 3:
            raise monitor.CheckError("incident temporaire")

    monkeypatch.setattr(monitor, "check_site", flaky)
    monkeypatch.setattr(monitor.time, "sleep", sleeps.append)
    assert monitor.main(["site"]) == 0
    assert len(calls) == 3
    assert sleeps == [5, 5]
    assert "site: OK" in capsys.readouterr().out


def test_local_api_readiness_checks_the_same_required_fields(monkeypatch):
    requests = []

    def response(url):
        requests.append(url)
        if url == monitor.LOCAL_API_URL:
            return {"status": "ok"}
        return {
            "status": "ok",
            "checks": {"database": "mongodb", "mongo": "ok", "mongo_required": True},
        }

    monkeypatch.setattr(monitor, "fetch_json", response)
    assert monitor.main(["api-local"]) == 0
    assert requests == [monitor.LOCAL_API_URL, monitor.LOCAL_HEALTH_URL]


def test_public_check_fails_after_three_attempts(monkeypatch):
    calls = []
    monkeypatch.setattr(
        monitor, "check_api",
        lambda: (calls.append(True), (_ for _ in ()).throw(monitor.CheckError("panne"))),
    )
    monkeypatch.setattr(monitor.time, "sleep", lambda _seconds: None)
    assert monitor.main(["api"]) == 1
    assert len(calls) == 3


def test_disk_checks_both_filesystems_and_exact_thresholds(monkeypatch):
    gib = 1024 ** 3
    sizes = {
        "/var/lib/sirius": SimpleNamespace(total=100 * gib, free=16 * gib),
        "/var/www/sirius": SimpleNamespace(total=100 * gib, free=16 * gib),
    }
    monkeypatch.setattr(monitor.shutil, "disk_usage", sizes.__getitem__)
    monitor.check_disk()
    sizes["/var/lib/sirius"].free = 15 * gib
    with pytest.raises(monitor.CheckError, match="données insuffisant"):
        monitor.check_disk()
    sizes["/var/lib/sirius"].free = 16 * gib
    sizes["/var/www/sirius"] = SimpleNamespace(total=10 * gib, free=gib)
    with pytest.raises(monitor.CheckError, match="site insuffisant"):
        monitor.check_disk()


def test_disk_access_failure_is_not_treated_as_healthy(monkeypatch):
    def denied(_path):
        raise PermissionError("private-path")

    monkeypatch.setattr(monitor.shutil, "disk_usage", denied)
    with pytest.raises(monitor.CheckError, match="impossible à vérifier") as error:
        monitor.check_disk()
    assert "private-path" not in str(error.value)


def backup_commands(monkeypatch, *, timer=0, result="success", timestamp="valid", epoch=1000):
    def command(*args):
        if args[:2] == ("systemctl", "is-active"):
            return SimpleNamespace(returncode=timer, stdout="")
        if args[:2] == ("systemctl", "show"):
            return SimpleNamespace(
                returncode=0,
                stdout=f"Result={result}\nExecMainExitTimestamp={timestamp}\n",
            )
        assert args == ("date", "-d", timestamp, "+%s")
        return SimpleNamespace(returncode=0, stdout=str(epoch))

    monkeypatch.setattr(monitor, "run_command", command)


def test_backup_accepts_recent_success_and_rejects_late_or_future_timestamps(monkeypatch):
    backup_commands(monkeypatch)
    monkeypatch.setattr(monitor.time, "time", lambda: 1000 + monitor.MAX_BACKUP_AGE_SECONDS)
    monitor.check_backup()
    monkeypatch.setattr(monitor.time, "time", lambda: 1001 + monitor.MAX_BACKUP_AGE_SECONDS)
    with pytest.raises(monitor.CheckError, match="trop ancienne"):
        monitor.check_backup()
    monkeypatch.setattr(monitor.time, "time", lambda: 699)
    with pytest.raises(monitor.CheckError, match="dans le futur"):
        monitor.check_backup()


@pytest.mark.parametrize(
    "values, message",
    [
        ({"timer": 3}, "minuteur"),
        ({"result": "exit-code"}, "n'a pas réussi"),
        ({"timestamp": "n/a"}, "aucune sauvegarde"),
    ],
)
def test_backup_requires_timer_success_and_a_recorded_completion(monkeypatch, values, message):
    backup_commands(monkeypatch, **values)
    with pytest.raises(monitor.CheckError, match=message):
        monitor.check_backup()


def test_system_command_timeout_is_explicit(monkeypatch):
    def timed_out(*_args, **_kwargs):
        raise subprocess.TimeoutExpired(cmd="systemctl", timeout=15)

    monkeypatch.setattr(monitor.subprocess, "run", timed_out)
    with pytest.raises(monitor.CheckError, match="TimeoutExpired"):
        monitor.run_command("systemctl", "show")


def test_monitoring_workflow_covers_all_categories_and_marks_failure():
    path = ROOT / ".github" / "workflows" / "sirius-monitor.yml"
    workflow = yaml.load(path.read_text(encoding="utf-8"), Loader=yaml.BaseLoader)
    assert workflow["on"]["schedule"] == [{"cron": "*/15 * * * *"}]
    assert workflow["on"]["workflow_run"]["workflows"] == ["Deploy Hetzner"]
    assert workflow["on"]["workflow_run"]["types"] == ["completed"]
    assert workflow["on"]["workflow_run"]["branches"] == ["master"]
    assert workflow["permissions"] == {"actions": "read", "contents": "read", "issues": "write"}
    steps = workflow["jobs"]["monitor"]["steps"]
    checks = {step["id"]: step for step in steps if "id" in step}
    assert set(checks) == {"site", "api", "disk", "backup", "hostkey", "deployment"}
    assert all(step["continue-on-error"] == "true" for step in checks.values())
    assert checks["site"]["run"].endswith("monitor.py site")
    assert checks["api"]["run"].endswith("monitor.py api")
    assert checks["hostkey"]["run"] == "bash deploy/hetzner/setup-ssh.sh"
    assert checks["hostkey"]["env"]["HETZNER_HOST_FINGERPRINT"] == "${{ secrets.HETZNER_HOST_FINGERPRINT }}"
    assert all(checks["disk"]["env"][secret] == f"${{{{ secrets.{secret} }}}}"
               for secret in ("HETZNER_HOST", "HETZNER_USER"))
    assert all(checks["backup"]["env"][secret] == f"${{{{ secrets.{secret} }}}}"
               for secret in ("HETZNER_HOST", "HETZNER_USER"))
    assert "steps.hostkey.outcome == 'success'" in checks["disk"]["if"]
    assert "steps.hostkey.outcome == 'success'" in checks["backup"]["if"]
    assert checks["disk"]["run"].strip().endswith("monitor.py disk")
    assert checks["backup"]["run"].strip().endswith("monitor.py backup")
    for check in (checks["disk"], checks["backup"]):
        assert "bash deploy/hetzner/retry-ssh.sh timeout 90s ssh" in check["run"]
        for option in (
            "IdentitiesOnly=yes", "StrictHostKeyChecking=yes",
            "UserKnownHostsFile=$HETZNER_SSH_KNOWN_HOSTS_FILE",
            "GlobalKnownHostsFile=/dev/null", "UpdateHostKeys=no",
        ):
            assert option in check["run"]
    assert "latestDeployment(github, context)" in checks["deployment"]["with"]["script"]
    assert not any(step.get("uses", "").startswith(("appleboy/ssh-action@", "appleboy/scp-action@"))
                   for step in steps)
    alerts = next(step for step in steps if step.get("name") == "Update alerts")
    assert alerts["env"]["SIRIUS_SMS_ENABLED"] == "${{ vars.SIRIUS_SMS_ENABLED }}"
    assert "workflow_dispatch" in alerts["env"]["SIRIUS_SMS_TEST"]
    assert "'blocked'" in alerts["env"]["DISK_OUTCOME"]
    assert "'blocked'" in alerts["env"]["BACKUP_OUTCOME"]
    assert alerts["env"]["DEPLOYMENT_OUTCOME"] == "${{ steps.deployment.outcome }}"
    assert alerts["env"]["DEPLOYMENT_STATUS"] == "${{ steps.deployment.outputs.outcome }}"
    assert "process.env.DEPLOYMENT_STATUS === 'pending'" in alerts["with"]["script"]
    assert workflow["on"]["workflow_dispatch"]["inputs"]["test_sms"]["default"] == "false"
    warning = next(step for step in steps if step.get("name") == "Report backup warning")
    assert "steps.hostkey.outcome == 'success'" in warning["if"]
    assert "steps.backup.outcome != 'success'" in warning["if"]
    hostkey_warning = next(step for step in steps if step.get("name") == "Report SSH identity warning")
    assert "steps.hostkey.outcome != 'success'" in hostkey_warning["if"]
    deployment_warning = next(step for step in steps if step.get("name") == "Report deployment warning")
    assert "steps.deployment.outcome != 'success'" in deployment_warning["if"]
    failure = next(step for step in steps if step.get("name") == "Fail when an availability check failed")
    assert "steps.backup.outcome" not in failure["if"]
    assert all(f"steps.{name}.outcome" in failure["if"] for name in ("site", "api", "disk", "hostkey"))
    audit_path = ROOT / ".github" / "workflows" / "sirius-audit.yml"
    audit = yaml.load(audit_path.read_text(encoding="utf-8"), Loader=yaml.BaseLoader)
    monitoring_tests = next(step["run"] for step in audit["jobs"]["audit"]["steps"]
                            if step.get("name") == "Monitoring alert tests")
    assert "monitor-deployment.test.cjs" in monitoring_tests
