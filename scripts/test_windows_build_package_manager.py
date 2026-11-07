import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "frontend" / "BUILD.bat"


@unittest.skipUnless(os.name == "nt", "Windows batch commands require cmd.exe")
class WindowsBuildPackageManagerTests(unittest.TestCase):
    def run_build(self, yarn_version=None, npx_available=True, fail_install=False):
        with tempfile.TemporaryDirectory(prefix="sirius-build-test-") as temp:
            root = Path(temp)
            app = root / "frontend"
            tools = root / "tools"
            app.mkdir()
            tools.mkdir()
            (app / "package.json").write_text('{"version":"1.0.70"}', encoding="utf-8")

            source = BUILD.read_text(encoding="utf-8")
            self.assertEqual(source.count('start "" "dist"'), 1)
            source = source.replace('start "" "dist"', "echo Simulation terminee.")
            source = "\n".join(
                line.replace("pause", "rem Test sans pause") if line.strip() == "pause" else line
                for line in source.splitlines()
            )
            (app / "BUILD.bat").write_text(source, encoding="utf-8")

            def command(name, body):
                (tools / f"{name}.cmd").write_text(
                    "@echo off\n" + body + "\n", encoding="utf-8"
                )

            command("node", "echo 1.0.70\nexit /b 0")
            command("python", '>>"%MOCK_LOG%" echo python %*\nexit /b 0')
            command("npm", '>>"%MOCK_LOG%" echo npm %*\nexit /b 0')
            command(
                "npx",
                'if not "%COREPACK_ENABLE_AUTO_PIN%"=="0" exit /b 88\n'
                '>>"%MOCK_LOG%" echo npx %*\n'
                'if "%~1"=="--yes" if "%MOCK_NPX_AVAILABLE%"=="0" exit /b 1\n'
                'if "%~3"=="--version" echo 1.22.22\n'
                "exit /b 0",
            )
            if yarn_version is not None:
                command(
                    "yarn",
                    'if not "%COREPACK_ENABLE_AUTO_PIN%"=="0" exit /b 88\n'
                    'if "%~1"=="--version" (\n'
                    "  echo %MOCK_YARN_VERSION%\n"
                    "  exit /b 0\n"
                    ")\n"
                    '>>"%MOCK_LOG%" echo yarn %*\n'
                    'if "%~1"=="install" if "%MOCK_FAIL_INSTALL%"=="1" exit /b 1\n'
                    "exit /b 0",
                )

            log = root / "commands.txt"
            env = os.environ.copy()
            env.update({
                "PATH": os.pathsep.join((str(tools), str(Path(env["SYSTEMROOT"]) / "System32"))),
                "MOCK_LOG": str(log),
                "MOCK_YARN_VERSION": yarn_version or "",
                "MOCK_NPX_AVAILABLE": "1" if npx_available else "0",
                "MOCK_FAIL_INSTALL": "1" if fail_install else "0",
            })
            result = subprocess.run(
                [env["COMSPEC"], "/d", "/c", str(app / "BUILD.bat")],
                cwd=app,
                env=env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
            )
            commands = log.read_text(encoding="utf-8").splitlines() if log.exists() else []
            return result, commands

    def test_uses_existing_yarn_1_for_every_build_step(self):
        result, commands = self.run_build(yarn_version="1.22.22")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(
            [line for line in commands if line.startswith(("yarn ", "npx ", "npm "))],
            [
                "yarn install",
                "yarn build",
                "yarn backend:build",
                "yarn electron-builder --win nsis portable",
            ],
        )

    def test_uses_pinned_yarn_via_npx_when_yarn_is_incompatible(self):
        for yarn_version in (None, "4.0.0"):
            with self.subTest(yarn_version=yarn_version):
                result, commands = self.run_build(yarn_version=yarn_version)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(
                    [line for line in commands if line.startswith(("yarn ", "npx ", "npm "))],
                    [
                        "npx --yes yarn@1.22.22 --version",
                        "npx --yes yarn@1.22.22 install",
                        "npx --yes yarn@1.22.22 build",
                        "npx --yes yarn@1.22.22 backend:build",
                        "npx --yes yarn@1.22.22 electron-builder --win nsis portable",
                    ],
                )

    def test_falls_back_to_npm_when_pinned_yarn_is_unavailable(self):
        result, commands = self.run_build(npx_available=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(
            [line for line in commands if line.startswith(("yarn ", "npx ", "npm "))],
            [
                "npx --yes yarn@1.22.22 --version",
                "npm ci --legacy-peer-deps",
                "npm run build",
                "npm run backend:build",
                "npx electron-builder --win nsis portable",
            ],
        )

    def test_install_failure_stops_the_build(self):
        result, commands = self.run_build(yarn_version="1.22.22", fail_install=True)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("yarn install", commands)
        self.assertNotIn("yarn build", commands)
        self.assertFalse(any(line.startswith("python ") for line in commands))


if __name__ == "__main__":
    unittest.main()
