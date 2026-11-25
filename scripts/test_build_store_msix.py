from pathlib import Path
import tempfile
import unittest

from build_store_msix import APP_PREFIX, collect_files, render_manifest, store_version


class StoreMsixTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.build = root / "win-unpacked"
        self.template = root / "template"
        for relative in ("SIRIUS.exe", "resources/app.asar", "resources/backend/sirius-backend.exe", "resources/elevate.exe"):
            path = self.build / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"x")
        (self.template / "Assets").mkdir(parents=True)
        (self.template / "Assets" / "StoreLogo.scale-100.png").write_bytes(b"png")
        (self.template / "Resources.pri").write_bytes(b"pri")
        (self.template / "AppxManifest.xml").write_text("template", encoding="utf-8")
        self.manifest = root / "AppxManifest.xml"
        self.manifest.write_text("rendered", encoding="utf-8")

    def test_version_npm_devient_version_store(self):
        self.assertEqual(store_version("1.0.77"), "1.0.77.0")
        with self.assertRaises(ValueError):
            store_version("1.0.77-beta")

    def test_manifeste_exige_un_seul_emplacement_de_version(self):
        rendered = render_manifest('<Identity Version="0.0.0.0" />', "1.0.77.0")
        self.assertEqual(rendered, '<Identity Version="1.0.77.0" />')
        with self.assertRaises(ValueError):
            render_manifest('<Identity Version="1.0.73.0" />', "1.0.77.0")

    def test_paquet_utilise_le_manifeste_rendu_et_exclut_elevate(self):
        mapping = collect_files(self.build, self.template, self.manifest)
        self.assertEqual(mapping["AppxManifest.xml"], self.manifest)
        self.assertIn("Assets/StoreLogo.scale-100.png", mapping)
        self.assertIn(APP_PREFIX + "resources/backend/sirius-backend.exe", mapping)
        self.assertNotIn(APP_PREFIX + "resources/elevate.exe", mapping)

    def test_backend_absent_bloque_la_construction(self):
        (self.build / "resources" / "backend" / "sirius-backend.exe").unlink()
        with self.assertRaisesRegex(RuntimeError, "sirius-backend.exe"):
            collect_files(self.build, self.template, self.manifest)


if __name__ == "__main__":
    unittest.main()
