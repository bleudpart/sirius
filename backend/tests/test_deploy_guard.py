import os
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"


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
    remote = next(
        step["with"]["script"] for step in deploy["jobs"]["deploy"]["steps"]
        if step.get("name") == "Deploy on Hetzner VPS"
    )
    ssh_steps = [step for step in deploy["jobs"]["deploy"]["steps"]
                 if step.get("uses", "").startswith(("appleboy/ssh-action@", "appleboy/scp-action@"))]
    assert len(ssh_steps) == 2
    assert all(step["with"]["fingerprint"] == "${{ secrets.HETZNER_HOST_FINGERPRINT }}" for step in ssh_steps)
    assert "90-sirius-managed-database.conf" in remote
    assert 'deploy.sh "" "${{ github.sha }}"' in remote
    assert remote.rstrip().endswith("monitor.py api-local")


@pytest.mark.parametrize("missing", ["HETZNER_HOST", "HETZNER_USER", "HETZNER_SSH_KEY"])
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
                        ("HETZNER_HOST", "HETZNER_USER", "HETZNER_SSH_KEY")})
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
                        ("HETZNER_HOST", "HETZNER_USER", "HETZNER_SSH_KEY")})
    result = subprocess.run([bash, "-c", script], env=environment, capture_output=True, text=True)
    assert result.returncode == 0
    assert "valeur-fictive-privee" not in result.stdout + result.stderr
