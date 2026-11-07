import json
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
        cls.automerge = load_yaml(ROOT / ".github" / "workflows" / "dependabot-auto-merge.yml")
        cls.dependabot = load_yaml(ROOT / ".github" / "dependabot.yml")

    def test_scheduled_api_tests_and_pull_requests_are_enabled(self):
        events = self.workflow["on"]
        self.assertIn("pull_request", events)
        self.assertIn("workflow_call", events)
        self.assertIn("workflow_dispatch", events)
        self.assertIn("30 3 * * *", [entry["cron"] for entry in events["schedule"]])
        maintenance_events = self.maintenance["on"]
        self.assertIn("workflow_dispatch", maintenance_events)
        self.assertIn("30 3 * * *", [entry["cron"] for entry in maintenance_events["schedule"]])

        commands = "\n".join(step.get("run", "") for step in self.workflow["jobs"]["audit"]["steps"])
        self.assertIn("tests/test_haccp_kitchen.py", commands)
        self.assertIn("tests/test_server_hardening.py", commands)
        self.assertIn("windows-build", self.workflow["jobs"])
        self.assertIn("integration-tests", self.workflow["jobs"])
        zapier = next(
            step for step in self.workflow["jobs"]["integration-tests"]["steps"]
            if step.get("name") == "Test Zapier integration"
        )
        self.assertIn("npm run validate -- --without-style", zapier["run"])
        jobs = self.maintenance["jobs"]
        self.assertEqual(jobs["api-tests"]["uses"], "./.github/workflows/sirius-audit.yml")
        health = jobs["api-health"]
        self.assertTrue(any("monitor.py api" in step.get("run", "") for step in health["steps"]))
        self.assertIn("npm run build", commands)

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
        npm_directories = {
            entry["directory"]
            for entry in jobs["dependency-npm"]["strategy"]["matrix"]["include"]
        }
        self.assertEqual(
            npm_directories,
            {"frontend", "integrations/zapier", "integrations/raycast"},
        )
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
        self.assertIn("contains(needs.*.result, 'failure')", notify["if"])
        self.assertEqual(
            set(notify["needs"]),
            {"audit", "windows-build", "integration-tests", "dependabot_files", "electron-build"},
        )

        windows = self.workflow["jobs"]["windows-build"]
        self.assertEqual(windows["runs-on"], "windows-latest")
        self.assertEqual(windows["permissions"], {"contents": "read"})
        self.assertTrue(any(
            "test_windows_build_package_manager.py" in step.get("run", "")
            for step in windows["steps"]
        ))
        yarn = next(step for step in windows["steps"] if "yarn@1.22.22" in step.get("run", ""))
        self.assertEqual(yarn["env"]["COREPACK_ENABLE_AUTO_PIN"], "0")

    def test_reusable_audit_callers_allow_all_nested_job_permissions(self):
        levels = {"none": 0, "read": 1, "write": 2}
        required = {}
        for job in self.workflow["jobs"].values():
            permissions = job.get("permissions", self.workflow.get("permissions", {}))
            for name, value in permissions.items():
                required[name] = max(required.get(name, 0), levels[value])

        callers = []
        for path in (ROOT / ".github" / "workflows").glob("*.yml"):
            workflow = load_yaml(path)
            for job_name, job in workflow["jobs"].items():
                if job.get("uses") != "./.github/workflows/sirius-audit.yml":
                    continue
                callers.append((path.name, job_name))
                permissions = job.get("permissions", workflow.get("permissions", {}))
                for name, level in required.items():
                    with self.subTest(workflow=path.name, job=job_name, permission=name):
                        self.assertGreaterEqual(levels.get(permissions.get(name, "none"), 0), level)
        self.assertTrue(callers)

    def test_dependabot_installer_build_detects_files_and_installs_all_runtime_dependencies(self):
        detection = self.workflow["jobs"]["dependabot_files"]
        self.assertEqual(detection["permissions"], {"pull-requests": "read"})
        self.assertIn("pulls.listFiles", detection["steps"][0]["with"]["script"])
        build = self.workflow["jobs"]["electron-build"]
        self.assertEqual(build["needs"], "dependabot_files")
        self.assertIn("needs.dependabot_files.outputs.app", build["if"])
        self.assertNotIn("pull_request.title", build["if"])
        install = next(step["run"] for step in build["steps"]
                       if step.get("name") == "Install backend build dependencies")
        for manifest in ("requirements.txt", "requirements-local.txt", "requirements-build.txt",
                         "requirements-voice-identity.txt"):
            self.assertIn(f"-r {manifest}", install)

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
        updates = self.dependabot["updates"]
        npm_updates = [entry for entry in updates if entry["package-ecosystem"] == "npm"]
        self.assertEqual(
            {entry["directory"] for entry in npm_updates},
            {"/frontend", "/integrations/zapier", "/integrations/raycast"},
        )
        other_updates = {
            entry["package-ecosystem"]: entry
            for entry in updates
            if entry["package-ecosystem"] != "npm"
        }
        self.assertEqual(set(other_updates), {"pip", "github-actions"})
        self.assertEqual(other_updates["pip"]["directory"], "/backend")
        self.assertEqual(other_updates["github-actions"]["directory"], "/")
        for entry in updates:
            self.assertEqual(entry["schedule"]["interval"], "daily")
            self.assertEqual(entry["schedule"]["time"], "04:15")
            self.assertEqual(entry["open-pull-requests-limit"], "3")
        self.assertEqual((ROOT / ".npmrc").read_text(encoding="utf-8").strip(), "legacy-peer-deps=true")

    def test_security_automerge_waits_for_successful_dependency_checks(self):
        events = self.automerge["on"]
        self.assertEqual(events["workflow_run"]["workflows"], ["SIRIUS audit and release guard"])
        self.assertEqual(events["workflow_run"]["types"], ["completed"])
        self.assertEqual(self.automerge["permissions"]["contents"], "read")
        job = self.automerge["jobs"]["security-update"]
        self.assertIn("conclusion == 'success'", job["if"])
        self.assertIn("pull_request", job["if"])
        self.assertEqual(job["permissions"]["actions"], "write")
        self.assertEqual(job["permissions"]["contents"], "write")
        script = next(step for step in job["steps"] if step.get("uses", "").startswith("actions/github-script@"))
        self.assertIn("processDependabotRun", script["with"]["script"])
        helper = (ROOT / "scripts" / "dependabot-auto-merge.cjs").read_text(encoding="utf-8")
        for required in ("listJobsForWorkflowRun", "shouldMergeDependabotSecurityPr",
                         "sha: run.head_sha", "dependency-graph/compare/{basehead}",
                         "createWorkflowDispatch", 'workflow_id: "deploy-hetzner.yml"'):
            self.assertIn(required, helper)
        commands = "\n".join(
            step.get("run", "") for step in self.workflow["jobs"]["audit"]["steps"]
        )
        self.assertIn("dependabot-auto-merge.test.cjs", commands)

    def test_npm_manifest_and_lockfile_stay_in_sync(self):
        manifest = json.loads((ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))
        lockfile = json.loads((ROOT / "frontend" / "package-lock.json").read_text(encoding="utf-8"))
        self.assertNotIn("packageManager", manifest)
        self.assertEqual(lockfile["lockfileVersion"], 3)
        for key in ("dependencies", "devDependencies", "optionalDependencies"):
            self.assertEqual(manifest.get(key, {}), lockfile["packages"][""].get(key, {}))


if __name__ == "__main__":
    unittest.main()
