import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]


def load_yaml(path):
    with path.open(encoding="utf-8") as file:
        return yaml.load(file, Loader=yaml.BaseLoader)


class MaintenanceConfigurationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = load_yaml(ROOT / ".github" / "workflows" / "sirius-audit.yml")
        cls.maintenance = load_yaml(ROOT / ".github" / "workflows" / "sirius-maintenance.yml")
        cls.dependabot = load_yaml(ROOT / ".github" / "dependabot.yml")

    def test_scheduled_api_tests_and_pull_requests_are_enabled(self):
        events = self.workflow["on"]
        self.assertIn("pull_request", events)
        self.assertIn("workflow_call", events)
        self.assertIn("workflow_dispatch", events)
        self.assertIn("30 3 * * *", [entry["cron"] for entry in events["schedule"]])
        maintenance_events = self.maintenance["on"]
        self.assertIn("workflow_dispatch", maintenance_events)
        self.assertIn("0 4 * * 0", [entry["cron"] for entry in maintenance_events["schedule"]])

        commands = "\n".join(step.get("run", "") for step in self.workflow["jobs"]["audit"]["steps"])
        self.assertIn("tests/test_haccp_kitchen.py", commands)
        self.assertIn("tests/test_server_hardening.py", commands)
        jobs = self.maintenance["jobs"]
        self.assertEqual(jobs["api-tests"]["uses"], "./.github/workflows/sirius-audit.yml")
        health = jobs["api-health"]
        self.assertTrue(any("monitor.py api" in step.get("run", "") for step in health["steps"]))

    def test_dependency_audits_cover_all_manifests_without_blocking_pull_requests(self):
        self.assertNotIn("pull_request", self.maintenance["on"])
        self.assertNotIn("workflow_call", self.maintenance["on"])
        self.assertNotIn("api-health", self.workflow["jobs"])
        self.assertNotIn("dependency-npm", self.workflow["jobs"])
        self.assertNotIn("dependency-python", self.workflow["jobs"])
        jobs = self.maintenance["jobs"]

        expected = {
            f"backend/{path.name}" for path in (ROOT / "backend").glob("requirements*.txt")
        }
        configured = set(jobs["dependency-python"]["strategy"]["matrix"]["manifest"])
        self.assertEqual(configured, expected)
        self.assertTrue(any(
            step.get("uses", "").startswith("pypa/gh-action-pip-audit@")
            for step in jobs["dependency-python"]["steps"]
        ))
        self.assertTrue(any(
            "npm audit --audit-level=low" in step.get("run", "")
            for step in jobs["dependency-npm"]["steps"]
        ))

    def test_pull_request_tests_use_read_only_permissions(self):
        audit = self.workflow["jobs"]["audit"]
        self.assertEqual(audit["permissions"], {"contents": "read"})
        checkout = next(step for step in audit["steps"] if step.get("uses", "").startswith("actions/checkout@"))
        self.assertEqual(checkout["with"]["persist-credentials"], "false")
        self.assertNotIn("issues", audit["permissions"])

        notify = self.workflow["jobs"]["notify-failure"]
        self.assertIn("github.event_name != 'pull_request'", notify["if"])
        self.assertIn("always()", notify["if"])
        self.assertIn("needs.audit.result == 'failure'", notify["if"])

    def test_dependency_alert_observes_both_scans(self):
        notify = self.maintenance["jobs"]["notify-dependencies"]
        self.assertEqual(set(notify["needs"]), {"dependency-npm", "dependency-python"})
        self.assertIn("always()", notify["if"])
        self.assertIn("github.ref == 'refs/heads/master'", notify["if"])
        self.assertEqual(notify["permissions"]["issues"], "write")
        alert = next(step for step in notify["steps"] if step.get("uses", "").startswith("actions/github-script@"))
        self.assertIn("needs.dependency-npm.result", alert["env"]["NPM_OUTCOME"])
        self.assertIn("needs.dependency-python.result", alert["env"]["PYTHON_OUTCOME"])

    def test_dependabot_covers_npm_python_and_actions(self):
        updates = {entry["package-ecosystem"]: entry for entry in self.dependabot["updates"]}
        self.assertEqual(set(updates), {"npm", "pip", "github-actions"})
        self.assertEqual(updates["npm"]["directory"], "/frontend")
        self.assertEqual(updates["pip"]["directory"], "/backend")
        self.assertEqual(updates["github-actions"]["directory"], "/")
        for entry in updates.values():
            self.assertEqual(entry["schedule"]["interval"], "weekly")
            self.assertEqual(entry["open-pull-requests-limit"], "3")
        self.assertEqual((ROOT / ".npmrc").read_text(encoding="utf-8").strip(), "legacy-peer-deps=true")


if __name__ == "__main__":
    unittest.main()
