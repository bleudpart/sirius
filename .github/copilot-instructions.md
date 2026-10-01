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

`npm run electron:build` builds the React app, packages the backend, and creates the Windows NSIS and portable installers. The audit workflow's frontend test command is `npm test -- --watchAll=false --runInBand`.

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

## Codebase conventions

- HUD modules are code-split in `frontend/src/lazyModules.js`. When adding a module, connect it to the relevant UI/action registry in `moduleRegistry.js`; add aliases in `moduleCommandRouting.js` if voice commands should open it. Shared work-module metadata is in `workModules.js`.
- Frontend tests use Create React App/Jest and are colocated as `*.test.js` or `*.test.jsx`. Backend tests are under `backend/tests/` and use pytest.
- Keep persistent files out of the source tree by using `runtime_paths.py`; do not assume the process working directory is the data directory.
- Local environment and credentials belong in `.env` files, not source control. For developer backend setup, use `backend/.env.example` as the template and `requirements-local.txt` as above.
- User-facing UI text and much of the project documentation are in French; follow the language and terminology of the feature being changed.
