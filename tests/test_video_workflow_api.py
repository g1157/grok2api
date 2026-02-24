from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1 import video as video_api
from app.api.v1.chat import VideoConfig
from app.core.exceptions import ValidationException


def _build_client() -> TestClient:
    app = FastAPI()
    app.include_router(video_api.router, prefix="/v1")
    return TestClient(app)


def test_video_config_parent_post_id_trimmed():
    cfg = VideoConfig(parent_post_id="  post-abc-001  ")
    assert cfg.parent_post_id == "post-abc-001"


def test_video_config_parent_post_id_too_short():
    with pytest.raises(ValidationException):
        VideoConfig(parent_post_id="abc")


def test_parent_post_api_success(monkeypatch: pytest.MonkeyPatch):
    async def _fake_select_token():
        return "token-1"

    async def _fake_resolve_source(image_url: str, _request, token: str):
        assert image_url == "/v1/files/image/a/b.png"
        assert token == "token-1"
        return "https://assets.grok.com/a/b.png", "direct"

    class _DummyVideoService:
        async def create_image_post(self, token: str, asset_url: str) -> str:
            assert token == "token-1"
            assert asset_url == "https://assets.grok.com/a/b.png"
            return "post-xyz"

    monkeypatch.setattr(video_api, "_select_video_token", _fake_select_token)
    monkeypatch.setattr(video_api, "_resolve_source_to_asset_url", _fake_resolve_source)
    monkeypatch.setattr(video_api, "VideoService", lambda: _DummyVideoService())

    client = _build_client()
    resp = client.post("/v1/video/parent-post", json={"image_url": "/v1/files/image/a/b.png"})
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["parent_post_id"] == "post-xyz"
    assert payload["source_type"] == "direct"


def test_video_stitch_requires_ffmpeg(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(video_api.shutil, "which", lambda _name: None)
    client = _build_client()
    resp = client.post("/v1/video/stitch", json={"videos": ["/v1/files/video/a.mp4", "/v1/files/video/b.mp4"]})
    assert resp.status_code == 503


def test_video_stitch_success(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    v1 = tmp_path / "v1.mp4"
    v2 = tmp_path / "v2.mp4"
    v1.write_bytes(b"clip-1")
    v2.write_bytes(b"clip-2")

    monkeypatch.setattr(video_api, "VIDEO_DIR", tmp_path)
    monkeypatch.setattr(video_api.shutil, "which", lambda _name: "ffmpeg")
    monkeypatch.setattr(
        video_api,
        "_resolve_local_video_path",
        lambda raw: v1 if "1" in raw else v2,
    )

    async def _fake_run_ffmpeg(_ffmpeg_bin: str, _list_file: Path, output_file: Path, copy_mode: bool):
        assert copy_mode is True
        output_file.write_bytes(b"stitched-video")
        return 0, ""

    monkeypatch.setattr(video_api, "_run_ffmpeg_concat", _fake_run_ffmpeg)

    client = _build_client()
    resp = client.post("/v1/video/stitch", json={"videos": ["clip-1", "clip-2"]})
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["mode"] == "copy"
    assert payload["size_bytes"] > 0
    assert payload["url"].startswith("/v1/files/video/")
