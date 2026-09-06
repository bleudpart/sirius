import json

from omega_engine import OmegaEngine


def create_project(tmp_path):
    for relative in OmegaEngine.REQUIRED_FILES:
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.name == "package.json":
            path.write_text(json.dumps({"scripts": {"build": "build", "test": "test"}}), encoding="utf-8")
        else:
            path.write_text("", encoding="utf-8")
    return tmp_path


def test_omega_scan_reports_healthy_project(tmp_path):
    engine = OmegaEngine(create_project(tmp_path))

    result = engine.scan()

    assert result["engine"]["name"] == "SME_OMEGA"
    assert result["engine"]["active"] is True
    assert result["engine"]["self_modifying"] is False
    assert result["engine"]["frozen"] is False
    assert result["errors"][0]["errorType"] == "none"
    assert {"severity", "label", "detail", "created_at"} <= result["history"][0].keys()
    skills = result["engine"]["skills"]
    assert len(skills) == 12
    assert len({skill["id"] for skill in skills}) == 12
    assert all(skill["state"] == "active" for skill in skills)


def test_omega_scan_detects_missing_critical_file(tmp_path):
    project = create_project(tmp_path)
    (project / "frontend" / "src" / "App.js").unlink()

    result = OmegaEngine(project).scan()

    assert any(error["errorType"] == "integrity" for error in result["errors"])


def test_omega_scan_detects_runtime_integrity_drift(tmp_path):
    project = create_project(tmp_path)
    engine = OmegaEngine(project)
    (project / "backend" / "sirius_brain.py").write_text("changed", encoding="utf-8")

    result = engine.scan()

    assert any(error["errorType"] == "integrity_drift" for error in result["errors"])
    assert result["engine"]["frozen"] is True
    assert "backend/sirius_brain.py" in result["engine"]["frozen_paths"]

    engine.accept_path("backend/sirius_brain.py")
    accepted = engine.scan()
    assert accepted["engine"]["frozen"] is False
    assert not any(error["errorType"] == "integrity_drift" for error in accepted["errors"])


def test_omega_accepts_only_the_selected_frozen_path(tmp_path):
    project = create_project(tmp_path)
    engine = OmegaEngine(project)
    (project / "backend" / "server.py").write_text("server change", encoding="utf-8")
    (project / "backend" / "sirius_brain.py").write_text("brain change", encoding="utf-8")
    engine.scan()

    engine.accept_path("backend/server.py")
    status = engine.scan()["engine"]

    assert status["frozen"] is True
    assert status["frozen_paths"] == ["backend/sirius_brain.py"]


def test_omega_runtime_reports_are_bounded_and_can_be_cleared(tmp_path):
    engine = OmegaEngine(create_project(tmp_path), history_limit=2)
    engine.report("hud", "first error")
    report = engine.report("hud", "fatal crash", "stack")

    assert report["ok"] is True
    assert report["severity"] == "critical"
    assert len(engine.scan()["history"]) <= 2

    fixed = engine.fix("clear_runtime_reports", confirmed=True)

    assert fixed["ok"] is True
    assert fixed["scan"]["errors"][0]["errorType"] == "none"


def test_omega_rejects_unapproved_or_unconfirmed_repairs(tmp_path):
    engine = OmegaEngine(create_project(tmp_path))

    assert engine.fix("clear_runtime_reports", confirmed=False)["ok"] is False
    assert engine.fix("rewrite_source", confirmed=True)["ok"] is False
