import os
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"
SSH_SETUP = ROOT / "deploy" / "hetzner" / "setup-ssh.sh"
SSH_RETRY = ROOT / "deploy" / "hetzner" / "retry-ssh.sh"


def load_workflow(name):
    return yaml.load((WORKFLOWS / name).read_text(encoding="utf-8"), Loader=yaml.BaseLoader)


def test_deployment_requires_the_reusable_audit_and_valid_secrets():
    deploy = load_workflow("deploy-hetzner.yml")
    audit = load_workflow("sirius-audit.yml")
    assert "workflow_call" in audit["on"]
    assert deploy["jobs"]["audit"]["uses"] == "./.github/workflows/sirius-audit.yml"
    assert set(deploy["jobs"]["deploy"]["needs"]) == {"audit", "check-hetzner-secret"}
    assert "if" not in deploy["jobs"]["deploy"]
    assert deploy["jobs"]["deploy"]["permissions"] == {"contents": "read"}
    assert deploy["jobs"]["audit"]["permissions"] == {
        "contents": "read", "issues": "write", "pull-requests": "read",
    }
    assert audit["concurrency"]["group"] != deploy["concurrency"]["group"]
    assert "${{ github.workflow }}" in audit["concurrency"]["group"]
    assert set(audit["on"]["push"]["paths-ignore"]) == set(deploy["on"]["push"]["paths"])
    for job in (audit["jobs"]["audit"], deploy["jobs"]["deploy"]):
        node = next(step for step in job["steps"] if step.get("uses", "").startswith("actions/setup-node@"))
        assert node["with"]["node-version"] == "22"

    commands = next(
        step["run"] for step in audit["jobs"]["audit"]["steps"]
        if step.get("name") == "Backend syntax and focused tests"
    )
    for test in ("test_haccp_kitchen.py", "test_backup_recovery.py", "test_deploy_guard.py",
                 "test_monitor.py", "test_database_failover.py", "test_resilience.py"):
        assert test in commands
    assert any(step.get("name") == "Install restic for backup and restore tests"
               for step in audit["jobs"]["audit"]["steps"])
    assert any(step.get("name") == "Monitoring alert tests" for step in audit["jobs"]["audit"]["steps"])
    ssh_setup = next(step for step in deploy["jobs"]["deploy"]["steps"]
                     if step.get("name") == "Configure pinned Hetzner SSH")
    assert ssh_setup["run"] == "bash deploy/hetzner/setup-ssh.sh"
    assert ssh_setup["env"]["HETZNER_HOST_FINGERPRINT"] == "${{ secrets.HETZNER_HOST_FINGERPRINT }}"
    assert not any(step.get("uses", "").startswith(("appleboy/ssh-action@", "appleboy/scp-action@"))
                   for step in deploy["jobs"]["deploy"]["steps"])
    transfer = next(step["run"] for step in deploy["jobs"]["deploy"]["steps"]
                    if step.get("name") == "Transfer website")
    assert "scp" in transfer
    assert transfer.count("bash deploy/hetzner/retry-ssh.sh timeout ") == 2
    remote = next(
        step["run"] for step in deploy["jobs"]["deploy"]["steps"]
        if step.get("name") == "Deploy on Hetzner VPS"
    )
    for command in (transfer, remote):
        for option in (
            "IdentitiesOnly=yes", "StrictHostKeyChecking=yes",
            "UserKnownHostsFile=$HETZNER_SSH_KNOWN_HOSTS_FILE",
            "GlobalKnownHostsFile=/dev/null", "UpdateHostKeys=no",
        ):
            assert option in command
    assert "bash -s -- '$GITHUB_SHA'" in remote
    assert "HETZNER_HOST_FINGERPRINT" in deploy["jobs"]["check-hetzner-secret"]["steps"][0]["env"]
    steps = deploy["jobs"]["deploy"]["steps"]
    deploy_step = next(step for step in steps if step.get("name") == "Deploy on Hetzner VPS")
    assert "continue-on-error" not in deploy_step
    assert "90-sirius-managed-database.conf" in remote
    assert 'deploy.sh "" "$sha"' in remote
    assert "monitor.py api-local" in remote


@pytest.mark.parametrize("missing", [
    "HETZNER_HOST", "HETZNER_USER", "HETZNER_SSH_KEY", "HETZNER_HOST_FINGERPRINT",
])
def test_missing_deployment_secret_fails_without_exposing_other_values(missing):
    bash = shutil.which("bash")
    if not bash and os.name == "nt":
        candidate = Path(r"C:\Program Files\Git\bin\bash.exe")
        bash = str(candidate) if candidate.is_file() else None
    if not bash:
        pytest.skip("Bash requis pour tester le contrôle des secrets")
    deploy = load_workflow("deploy-hetzner.yml")
    script = deploy["jobs"]["check-hetzner-secret"]["steps"][0]["run"]
    environment = os.environ.copy()
    environment.update({name: "valeur-fictive-privee" for name in
                        ("HETZNER_HOST", "HETZNER_USER", "HETZNER_SSH_KEY", "HETZNER_HOST_FINGERPRINT")})
    environment[missing] = ""
    result = subprocess.run([bash, "-c", script], env=environment, capture_output=True, text=True)
    assert result.returncode != 0
    assert missing in result.stdout
    assert "valeur-fictive-privee" not in result.stdout + result.stderr


def test_all_deployment_secrets_allow_the_check():
    bash = shutil.which("bash")
    if not bash and os.name == "nt":
        candidate = Path(r"C:\Program Files\Git\bin\bash.exe")
        bash = str(candidate) if candidate.is_file() else None
    if not bash:
        pytest.skip("Bash requis pour tester le contrôle des secrets")
    script = load_workflow("deploy-hetzner.yml")["jobs"]["check-hetzner-secret"]["steps"][0]["run"]
    environment = os.environ.copy()
    environment.update({name: "valeur-fictive-privee" for name in
                        ("HETZNER_HOST", "HETZNER_USER", "HETZNER_SSH_KEY", "HETZNER_HOST_FINGERPRINT")})
    result = subprocess.run([bash, "-c", script], env=environment, capture_output=True, text=True)
    assert result.returncode == 0
    assert "valeur-fictive-privee" not in result.stdout + result.stderr


@pytest.mark.parametrize("fingerprint", ["", "SHA256:invalid!"])
def test_native_ssh_setup_rejects_missing_or_invalid_fingerprint(fingerprint):
    bash = shutil.which("bash")
    if not bash and os.name == "nt":
        candidate = Path(r"C:\Program Files\Git\bin\bash.exe")
        bash = str(candidate) if candidate.is_file() else None
    if not bash:
        pytest.skip("Bash requis pour tester la configuration SSH")
    environment = os.environ.copy()
    environment.update({
        "HETZNER_HOST": "server.example",
        "HETZNER_USER": "deploy",
        "HETZNER_SSH_KEY": "test-private-key",
        "HETZNER_HOST_FINGERPRINT": fingerprint,
    })
    result = subprocess.run(
        [bash, str(SSH_SETUP)], env=environment, capture_output=True, text=True,
    )
    assert result.returncode != 0
    assert "HETZNER_HOST_FINGERPRINT" in result.stdout
    assert "test-private-key" not in result.stdout + result.stderr


@pytest.mark.parametrize(
    ("failures", "attempts", "returncode"), [(0, 1, 0), (1, 2, 0), (2, 2, 42)],
)
def test_ssh_retry_is_bounded_and_propagates_failures(failures, attempts, returncode):
    bash = shutil.which("bash")
    if not bash and os.name == "nt":
        candidate = Path(r"C:\Program Files\Git\bin\bash.exe")
        bash = str(candidate) if candidate.is_file() else None
    if not bash:
        pytest.skip("Bash requis pour tester les tentatives SSH")
    wrapper = """
sleep() { :; }
export -f sleep
flaky() {
  attempts=$(( ${attempts:-0} + 1 ))
  echo "attempt:$attempts"
  [[ "$attempts" -gt "$RETRY_TEST_FAILURES" ]] || return 42
}
export -f flaky
exec "$1" "$2" flaky
"""
    environment = os.environ.copy()
    environment["RETRY_TEST_FAILURES"] = str(failures)
    result = subprocess.run(
        [bash, "-c", wrapper, "test", bash, str(SSH_RETRY)],
        env=environment, capture_output=True, text=True,
    )
    assert result.returncode == returncode
    assert result.stdout.count("attempt:") == attempts
    assert ("retrying once" in result.stderr) == (attempts == 2)


def test_native_ssh_setup_pins_only_the_configured_host_key(tmp_path):
    if os.name == "nt":
        pytest.skip("OpenSSH helper test runs in the Ubuntu Actions environment")
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("Bash requis pour tester la configuration SSH")

    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    keyscan = fake_bin / "ssh-keyscan"
    keyscan.write_text(
        "#!/bin/sh\n"
        "printf '%s\\n' "
        "'# server.example:22 SSH-2.0-Test' "
        "'server.example ssh-ed25519 pinned-key' "
        "'server.example ecdsa-sha2-nistp256 untrusted-key'\n",
        encoding="utf-8",
    )
    keygen = fake_bin / "ssh-keygen"
    keygen.write_text(
        "#!/bin/sh\n"
        "case \"$(cat \"$2\")\" in\n"
        "  *pinned-key*) echo '256 SHA256:trustedfingerprint (ED25519)' ;;\n"
        "  *untrusted-key*) echo '256 SHA256:otherfingerprint (ECDSA)' ;;\n"
        "  *) exit 1 ;;\n"
        "esac\n",
        encoding="utf-8",
    )
    keyscan.chmod(0o755)
    keygen.chmod(0o755)
    runner_temp = tmp_path / "runner-temp"
    runner_temp.mkdir()
    github_env = tmp_path / "github-env"
    github_env.touch()
    environment = os.environ.copy()
    environment.update({
        "PATH": f"{fake_bin}{os.pathsep}{environment['PATH']}",
        "RUNNER_TEMP": str(runner_temp),
        "GITHUB_ENV": str(github_env),
        "HETZNER_HOST": "server.example",
        "HETZNER_USER": "deploy",
        "HETZNER_SSH_KEY": "test-private-key",
        "HETZNER_HOST_FINGERPRINT": "SHA256:trustedfingerprint",
    })

    result = subprocess.run(
        [bash, str(SSH_SETUP)], env=environment, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    known_hosts = runner_temp / "sirius-hetzner-ssh" / "known_hosts"
    assert known_hosts.read_text(encoding="utf-8").strip() == (
        "server.example ssh-ed25519 pinned-key"
    )
    assert "test-private-key" not in result.stdout + result.stderr
    assert "HETZNER_SSH_IDENTITY_FILE=" in github_env.read_text(encoding="utf-8")
    if os.name != "nt":
        assert (runner_temp / "sirius-hetzner-ssh" / "id_hetzner").stat().st_mode & 0o777 == 0o600


def test_native_ssh_setup_rejects_an_unrecognized_host_key(tmp_path):
    if os.name == "nt":
        pytest.skip("OpenSSH helper test runs in the Ubuntu Actions environment")
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("Bash requis pour tester la configuration SSH")

    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    (fake_bin / "ssh-keyscan").write_text(
        "#!/bin/sh\nprintf '%s\\n' 'server.example ssh-ed25519 pinned-key'\n",
        encoding="utf-8",
    )
    (fake_bin / "ssh-keygen").write_text(
        "#!/bin/sh\necho '256 SHA256:trustedfingerprint (ED25519)'\n",
        encoding="utf-8",
    )
    for executable in fake_bin.iterdir():
        executable.chmod(0o755)
    runner_temp = tmp_path / "runner-temp"
    runner_temp.mkdir()
    github_env = tmp_path / "github-env"
    github_env.touch()
    environment = os.environ.copy()
    environment.update({
        "PATH": f"{fake_bin}{os.pathsep}{environment['PATH']}",
        "RUNNER_TEMP": str(runner_temp),
        "GITHUB_ENV": str(github_env),
        "HETZNER_HOST": "server.example",
        "HETZNER_USER": "deploy",
        "HETZNER_SSH_KEY": "test-private-key",
        "HETZNER_HOST_FINGERPRINT": "SHA256:wrongfingerprint",
    })

    result = subprocess.run(
        [bash, str(SSH_SETUP)], env=environment, capture_output=True, text=True,
    )
    assert result.returncode != 0
    assert "does not match" in result.stdout
    ssh_dir = runner_temp / "sirius-hetzner-ssh"
    assert not (ssh_dir / "id_hetzner").exists()
    assert not (ssh_dir / "known_hosts").exists()
