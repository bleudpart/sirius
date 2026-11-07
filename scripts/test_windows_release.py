import base64
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import yaml

from stage_windows_release import stage_release


class WindowsReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "dist"
        self.source.mkdir()
        self.destination = self.root / "release"
        self.setup = self.source / "sirius-setup-1.2.3.exe"
        self.portable = self.source / "SIRIUS-Portable-1.2.3.exe"
        self.setup.write_bytes(b"signed NSIS fixture")
        self.portable.write_bytes(b"signed portable fixture")
        (self.source / f"{self.setup.name}.blockmap").write_bytes(b"blockmap fixture")
        sha512 = base64.b64encode(hashlib.sha512(self.setup.read_bytes()).digest()).decode()
        self.metadata = {
            "version": "1.2.3",
            "files": [{"url": self.setup.name, "sha512": sha512, "size": self.setup.stat().st_size}],
            "path": self.setup.name,
            "sha512": sha512,
        }
        self.report = self.root / "windows-signatures.json"
        self.records = [
            {"file": path.name, "status": "Valid", "timestamp": True, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
            for path in (self.setup, self.portable)
        ]
        self.save()

    def save(self):
        (self.source / "latest.yml").write_text(yaml.safe_dump(self.metadata), encoding="utf-8")
        self.report.write_text(json.dumps({"verified_files": len(self.records), "signatures": self.records}), encoding="utf-8")

    def stage(self):
        return stage_release(self.source, self.destination, "1.2.3", self.report)

    def test_stages_only_final_assets_and_hashes(self):
        (self.source / "win-unpacked").mkdir()
        self.stage()
        self.assertEqual(len(list(self.destination.iterdir())), 6)
        self.assertFalse((self.destination / "win-unpacked").exists())
        for row in (self.destination / "SHA256SUMS.txt").read_text().splitlines():
            checksum, name = row.split("  ")
            self.assertEqual(checksum, hashlib.sha256((self.destination / name).read_bytes()).hexdigest())

    def test_rejects_changed_installer_and_stale_updater_hash(self):
        self.setup.write_bytes(b"modified after signing")
        with self.assertRaisesRegex(ValueError, "Hash ou taille"):
            self.stage()

    def test_rejects_changed_portable(self):
        self.portable.write_bytes(b"modified after verification")
        with self.assertRaisesRegex(ValueError, "modifie"):
            self.stage()

    def test_rejects_missing_blockmap(self):
        (self.source / f"{self.setup.name}.blockmap").unlink()
        with self.assertRaisesRegex(ValueError, "manquant"):
            self.stage()

    def test_downloaded_asset_hashes_cover_blockmap_and_report(self):
        self.stage()
        next_destination = self.root / "downloaded-release"
        report = self.destination / "windows-signatures.json"
        stage_release(self.destination, next_destination, "1.2.3", report)
        (self.destination / f"{self.setup.name}.blockmap").write_bytes(b"tampered blockmap")
        with self.assertRaisesRegex(ValueError, "telecharge modifie"):
            stage_release(self.destination, self.root / "bad-release", "1.2.3", report)

    def test_rejects_stale_executable(self):
        (self.source / "sirius-setup-1.2.2.exe").write_bytes(b"old build")
        with self.assertRaisesRegex(ValueError, "autre version"):
            self.stage()

    def test_rejects_version_mismatch_and_unsafe_update_path(self):
        for key, value in (("version", "1.2.2"), ("path", "../outside.exe")):
            with self.subTest(key=key):
                original = self.metadata[key]
                self.metadata[key] = value
                self.save()
                with self.assertRaises(ValueError):
                    self.stage()
                self.metadata[key] = original

    def test_rejects_missing_timestamp_or_failed_signature(self):
        for key, value in (("timestamp", False), ("status", "HashMismatch")):
            with self.subTest(key=key):
                original = self.records[0][key]
                self.records[0][key] = value
                self.save()
                with self.assertRaisesRegex(ValueError, "invalide"):
                    self.stage()
                self.records[0][key] = original


class WindowsWorkflowTests(unittest.TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[1]
        self.workflow = yaml.load(
            (root / ".github" / "workflows" / "windows-release.yml").read_text(encoding="utf-8"),
            Loader=yaml.BaseLoader,
        )

    def test_only_tags_and_manual_dispatch_can_release(self):
        triggers = self.workflow["on"]
        self.assertEqual(set(triggers), {"push", "workflow_dispatch"})
        self.assertEqual(triggers["push"], {"tags": ["v*"]})
        for job in self.workflow["jobs"].values():
            self.assertEqual(job["environment"], "windows-signing")

    def test_signing_secrets_are_not_available_during_dependency_installation(self):
        steps = self.workflow["jobs"]["build-sign"]["steps"]
        secret_steps = [
            step for step in steps
            if "WINDOWS_CERTIFICATE_PFX_BASE64" in json.dumps(step)
        ]
        self.assertEqual(len(secret_steps), 1)
        self.assertIn("-Action Prepare", secret_steps[0]["run"])
        cleanup = next(step for step in steps if "-Action Cleanup" in step.get("run", ""))
        self.assertEqual(cleanup["if"], "always()")
        self.assertLess(steps.index(cleanup), next(i for i, step in enumerate(steps) if "actions/upload-artifact@" in step.get("uses", "")))

    def test_publication_requires_verified_build_and_verifies_downloads(self):
        job = self.workflow["jobs"]["publish"]
        self.assertEqual(job["needs"], "build-sign")
        self.assertEqual(job["permissions"], {"contents": "write"})
        self.assertEqual(self.workflow["permissions"], {"contents": "read"})
        runs = "\n".join(step.get("run", "") for step in job["steps"])
        self.assertLess(runs.index("-Action Verify"), runs.index("gh release create"))
        self.assertIn("--verify-tag --draft", runs)
        self.assertIn("--draft=false", runs)
        self.assertNotIn("WINDOWS_CERTIFICATE_PFX_BASE64", json.dumps(job))

    def test_actions_are_pinned(self):
        for job in self.workflow["jobs"].values():
            for step in job["steps"]:
                if "uses" in step:
                    self.assertRegex(step["uses"], r"^actions/[\w-]+@[a-f0-9]{40}$")


if __name__ == "__main__":
    unittest.main()
