import importlib

import routes.spotify_routes as spotify_routes


def test_popup_target_origin_is_the_frontend_not_the_api(monkeypatch):
    """La popup Spotify est une page HTML servie par l'API (127.0.0.1:8001). Le postMessage()
    qu'elle envoie à window.opener n'est délivré que si targetOrigin correspond à l'origine
    RÉELLE de la fenêtre parente (le SPA, localhost:3000 en dev) — pas à celle de l'API elle-
    même. Avant ce correctif, targetOrigin était dérivé de SPOTIFY_REDIRECT_URI (l'API), donc
    le message était systématiquement rejeté et la connexion Spotify ne se terminait jamais."""
    monkeypatch.setenv("FRONTEND_URL", "http://localhost:3000")
    monkeypatch.setenv("SPOTIFY_REDIRECT_URI", "http://127.0.0.1:8001/api/spotify/callback")
    importlib.reload(spotify_routes)
    try:
        assert spotify_routes._app_origin() == "http://localhost:3000"

        html = spotify_routes._popup_response({"type": "spotify-auth", "access_token": "x"}).body.decode()
        assert 'postMessage({"type"' in html or "postMessage({" in html
        assert '"http://localhost:3000"' in html
        assert "127.0.0.1:8001" not in html
    finally:
        importlib.reload(spotify_routes)
