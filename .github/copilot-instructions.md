# Copilot instructions for SIRIUS

## Project shape

SIRIUS is a React HUD with a FastAPI backend, wrapped as a Windows Electron app and also prepared for Capacitor mobile builds. The React entry point is `frontend/src/App.js`; Electron's main process is `frontend/public/electron.js`. Electron starts the local backend and loads the frontend from the development server or `127.0.0.1:8001` in the packaged app.

The FastAPI app is assembled in `backend/server.py`. Feature APIs are split between `backend/routers/` and `backend/routes/`, while shared assistant behavior lives in modules such as `backend/sirius_brain.py`. Keep API URL construction centralized through `frontend/src/lib/api.js`.

Persistence is intentionally local-first. The backend uses MongoDB when configured and reachable, with `backend/local_docstore.py` providing a SQLite-backed subset of the Mongo/Motor interface as a fallback. Assistant memory has its own SQLite implementation in `backend/local_memory.py`; uploaded files are stored on disk through `backend/storage.py`. Use `backend/runtime_paths.py` (`data_dir()` / `data_file()`) for persistent paths so source and packaged builds use the right user-data directory.

## Build and test

Run frontend commands from `frontend/`:

```sh
npm ci --legacy-peer-deps
npm start
npm run build
npm test -- --watchAll=false --runInBand
npm test -- --watchAll=false --runInBand src/dateTime.test.js -t "formatUtcTime renvoie HH:MM:SS depuis l'ISO"
npm run electron:build
npm run audit:sirius
```

`npm run electron:build` builds the React app, packages the backend, and creates the Windows NSIS and portable installers. It needs Playwright's Chromium on the build PC (`python -m playwright install chromium`, once; `BUILD.bat` and `scripts/build-installer.ps1` run it themselves): `backend/sirius-backend.spec` bundles it for the web agent and aborts the build when it is missing. The audit workflow's frontend test command is `npm test -- --watchAll=false --runInBand`.

Run backend commands from `backend/`. For local development, install `requirements-local.txt` (the README warns that `requirements.txt` is intended for the server deployment environment):

```sh
python -m pip install -r requirements-local.txt
python -m uvicorn server:app --host 127.0.0.1 --port 8001 --no-proxy-headers
python -m pytest tests -q
python -m pytest tests/test_local_docstore.py::test_insert_et_find_one -q
```

The GitHub Actions audit runs backend syntax checks and a focused pytest set:

```sh
python -m py_compile server.py sirius_brain.py proactive.py enterprise.py routers/files.py routes/pantheon_oracle.py
python -m pytest tests/test_proactive.py tests/test_briefing_intent.py tests/test_enterprise.py tests/test_sirius_doctor.py tests/test_auth_api_unit.py tests/test_server_hardening.py -q
```

## Deployment

Production runs on Hetzner and deploys itself. A push to `master` that changes `backend/**`, `frontend/**`, `deploy/**` or `.github/workflows/deploy-hetzner.yml` starts `.github/workflows/deploy-hetzner.yml`: it builds the website with `REACT_APP_BACKEND_URL=https://api.sirius-assistant.fr`, copies it to the server over native OpenSSH and runs `/opt/sirius/deploy/hetzner/deploy.sh`, which resets the server checkout to `origin/master`, installs changed Python requirements, publishes the site and restarts `sirius.service`. GitHub secrets must include `HETZNER_HOST`, `HETZNER_USER`, `HETZNER_SSH_KEY` and the trusted `HETZNER_HOST_FINGERPRINT`; the workflow enforces strict host-key checking. Pushes that only touch other paths (docs, this file) do not deploy.

Deploy automatically (owner's decision): once a backend or frontend change is implemented and its relevant tests pass, run the whole flow below without asking again, unless the user says otherwise. Ask first when the change deletes or migrates stored user data.

1. Run the targeted tests from "Build and test". The deploy workflow also requires the "SIRIUS audit and release guard" workflow to pass.
2. Stage only the intended files. Never add local-only files such as `.mcp.json`, and restore `frontend/src/temp_auth_api.txt` with `git checkout -- frontend/src/temp_auth_api.txt` if the Jest suite rewrote it (`patch.test.js`).
3. Commit and `git push origin master`. Other chats or PCs may push too: if the push is rejected, run `git pull --rebase --autostash` and push again. A newer push cancels a running deploy, and the server aborts any deploy whose commit is no longer `origin/master`.
4. Watch the run: `gh run list --workflow deploy-hetzner.yml --limit 1`, then `gh run watch <id> --exit-status`.
5. A green run alone does not prove which version is live. Check that `https://sirius-assistant.fr/deploy-sha.txt` equals `git rev-parse HEAD` and that `https://api.sirius-assistant.fr/api/health` returns 200. Test the API on `api.sirius-assistant.fr`, because the site root can return the web page instead.

The Windows installer, the portable build and the Android APK are built locally; this workflow does not build them.

## Codebase conventions

- HUD modules are code-split in `frontend/src/lazyModules.js`. When adding a module, connect it to the relevant UI/action registry in `moduleRegistry.js`; add aliases in `moduleCommandRouting.js` if voice commands should open it. Shared work-module metadata is in `workModules.js`.
- Frontend tests use Create React App/Jest and are colocated as `*.test.js` or `*.test.jsx`. Backend tests are under `backend/tests/` and use pytest.
- Keep persistent files out of the source tree by using `runtime_paths.py`; do not assume the process working directory is the data directory.
- Local environment and credentials belong in `.env` files, not source control. For developer backend setup, use `backend/.env.example` as the template and `requirements-local.txt` as above.
- User-facing UI text and much of the project documentation are in French; follow the language and terminology of the feature being changed.
