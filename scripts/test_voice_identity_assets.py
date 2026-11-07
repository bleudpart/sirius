import tempfile
import unittest
import zipfile
from pathlib import Path

from prepare_voice_identity_assets import FFMPEG_PREFIX, extract_ffmpeg_archive


class VoiceIdentityAssetTests(unittest.TestCase):
    def test_extracts_only_ffmpeg_runtime_and_its_license(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "ffmpeg.zip"
            destination = root / "runtime"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr(FFMPEG_PREFIX + "bin/ffmpeg.exe", b"exe")
                bundle.writestr(FFMPEG_PREFIX + "bin/avcodec.dll", b"dll")
                bundle.writestr(FFMPEG_PREFIX + "LICENSE.txt", b"LGPL")
                bundle.writestr(FFMPEG_PREFIX + "doc/readme.html", b"unused")

            extracted = extract_ffmpeg_archive(archive, destination)

            self.assertEqual(
                {path.relative_to(destination).as_posix() for path in extracted},
                {"ffmpeg/ffmpeg.exe", "ffmpeg/avcodec.dll", "ffmpeg/LICENSE.txt"},
            )
            self.assertFalse((destination / "doc" / "readme.html").exists())

    def test_rejects_archive_path_traversal(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "ffmpeg.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr(FFMPEG_PREFIX + "bin/ffmpeg.exe", b"exe")
                bundle.writestr(FFMPEG_PREFIX + "../outside.dll", b"escape")

            with self.assertRaisesRegex(RuntimeError, "Chemin inattendu"):
                extract_ffmpeg_archive(archive, root / "runtime")


if __name__ == "__main__":
    unittest.main()
