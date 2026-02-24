"""
Video workflow APIs:
- create/reuse parentPostId for image->video flow
- stitch local video clips into one file
"""

from __future__ import annotations

import asyncio
import re
import shutil
import uuid
from pathlib import Path
from typing import List, Optional, Tuple
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.core.logger import logger
from app.services.grok.assets import UploadService
from app.services.grok.media import VideoService
from app.services.token import get_token_manager

router = APIRouter(tags=["Video"])

ASSET_HOST = "https://assets.grok.com"
VIDEO_MODEL_ID = "grok-imagine-1.0-video"
IMAGE_MODEL_ID = "grok-imagine-1.0"

BASE_DIR = Path(__file__).parent.parent.parent.parent / "data" / "tmp"
VIDEO_DIR = BASE_DIR / "video"
LOCAL_IMAGE_PREFIX = "/v1/files/image/"
LOCAL_VIDEO_PREFIX = "/v1/files/video/"


class ParentPostCreateRequest(BaseModel):
    image_url: str = Field(..., description="Selected image URL/data URL for workflow parentPostId")


class VideoStitchRequest(BaseModel):
    videos: List[str] = Field(..., min_length=2, max_length=12, description="Local video URLs to stitch in order")
    output_name: Optional[str] = Field(None, description="Optional output filename (mp4)")


def _normalize_asset_url(raw: str) -> str:
    value = str(raw or "").strip()
    if not value:
        return ""
    if value.startswith("data:image/"):
        return ""

    parsed_path = value
    if value.startswith("http://") or value.startswith("https://"):
        parsed = urlparse(value)
        if parsed.netloc.lower() == "assets.grok.com":
            path = parsed.path or "/"
            return f"{ASSET_HOST}{path}"
        parsed_path = parsed.path or ""

    if parsed_path.startswith(LOCAL_IMAGE_PREFIX):
        suffix = parsed_path[len(LOCAL_IMAGE_PREFIX) :]
        if not suffix:
            return ""
        # Locally uploaded images (upload-*) are not assets.grok.com paths.
        if suffix.startswith("upload-"):
            return ""
        return f"{ASSET_HOST}/{suffix.lstrip('/')}"

    if parsed_path.startswith("/") and not parsed_path.startswith("/v1/files/"):
        # Local API/admin paths are not assets.grok.com direct paths.
        # They must be fetched and uploaded first.
        if parsed_path.startswith("/api/") or parsed_path.startswith("/admin/"):
            return ""
        return f"{ASSET_HOST}{parsed_path}"

    return ""


def _to_absolute_source(raw: str, request: Request) -> str:
    value = str(raw or "").strip()
    if not value:
        return ""
    if value.startswith("http://") or value.startswith("https://") or value.startswith("data:"):
        return value
    if value.startswith("/"):
        base = str(request.base_url).rstrip("/")
        return f"{base}{value}"
    return value


async def _select_video_token() -> str:
    token_mgr = await get_token_manager()
    await token_mgr.reload_if_stale()
    token = token_mgr.get_token_for_model(VIDEO_MODEL_ID)
    if not token:
        # Fallback to image token pool when video mapping is missing.
        token = token_mgr.get_token_for_model(IMAGE_MODEL_ID)
    if not token:
        raise HTTPException(status_code=503, detail="No available tokens for video workflow")
    return token


async def _resolve_source_to_asset_url(image_url: str, request: Request, token: str) -> Tuple[str, str]:
    direct_asset = _normalize_asset_url(image_url)
    if direct_asset:
        return direct_asset, "direct"

    source = _to_absolute_source(image_url, request)
    if not source:
        raise HTTPException(status_code=400, detail="image_url is required")

    uploader = UploadService()
    try:
        _, file_uri = await uploader.upload(source, token)
    finally:
        await uploader.close()

    if not file_uri:
        raise HTTPException(status_code=502, detail="Upload to upstream failed: empty file_uri")

    if file_uri.startswith("http://") or file_uri.startswith("https://"):
        return file_uri, "uploaded"
    return f"{ASSET_HOST}/{file_uri.lstrip('/')}", "uploaded"


def _resolve_local_video_path(raw: str) -> Path:
    value = str(raw or "").strip()
    if not value:
        raise HTTPException(status_code=400, detail="Video URL cannot be empty")

    if value.startswith("http://") or value.startswith("https://"):
        value = urlparse(value).path or ""

    if value.startswith(LOCAL_VIDEO_PREFIX):
        value = value[len(LOCAL_VIDEO_PREFIX) :]
    else:
        value = value.lstrip("/")

    if not value:
        raise HTTPException(status_code=400, detail="Invalid local video URL")

    safe_name = value.replace("/", "-")
    path = VIDEO_DIR / safe_name
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail=f"Video file not found: {safe_name}")
    return path


def _sanitize_output_name(raw: Optional[str]) -> str:
    value = str(raw or "").strip()
    if value:
        name = Path(value).name
        name = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip(".-")
    else:
        name = ""
    if not name:
        name = f"stitch-{uuid.uuid4().hex[:12]}.mp4"
    if not name.lower().endswith(".mp4"):
        name = f"{name}.mp4"
    return name


async def _run_ffmpeg_concat(ffmpeg_bin: str, list_file: Path, output_file: Path, copy_mode: bool) -> Tuple[int, str]:
    cmd = [
        ffmpeg_bin,
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(list_file),
    ]
    if copy_mode:
        cmd.extend(["-c", "copy"])
    else:
        cmd.extend(
            [
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
            ]
        )
    cmd.append(str(output_file))

    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await process.communicate()
    err_text = stderr.decode("utf-8", errors="ignore")[-4000:]
    return process.returncode, err_text


@router.post("/video/parent-post")
async def create_parent_post(payload: ParentPostCreateRequest, request: Request):
    image_url = str(payload.image_url or "").strip()
    if not image_url:
        raise HTTPException(status_code=400, detail="image_url is required")

    token = await _select_video_token()
    asset_url, source_type = await _resolve_source_to_asset_url(image_url, request, token)

    service = VideoService()
    try:
        parent_post_id = await service.create_image_post(token, asset_url)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Create parent post failed: {e}")
        raise HTTPException(status_code=502, detail=f"Create parent post failed: {e}")

    return {
        "parent_post_id": parent_post_id,
        "asset_url": asset_url,
        "source_type": source_type,
    }


@router.post("/video/stitch")
async def stitch_videos(payload: VideoStitchRequest):
    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        raise HTTPException(status_code=503, detail="ffmpeg is not installed on server")

    if not payload.videos or len(payload.videos) < 2:
        raise HTTPException(status_code=400, detail="At least two videos are required")

    VIDEO_DIR.mkdir(parents=True, exist_ok=True)

    ordered_paths: List[Path] = []
    for raw in payload.videos:
        path = _resolve_local_video_path(raw)
        if not ordered_paths or ordered_paths[-1] != path:
            ordered_paths.append(path)

    if len(ordered_paths) < 2:
        raise HTTPException(status_code=400, detail="At least two different videos are required")

    output_name = _sanitize_output_name(payload.output_name)
    output_path = VIDEO_DIR / output_name
    list_path = VIDEO_DIR / f".concat-{uuid.uuid4().hex[:12]}.txt"

    list_content = []
    for path in ordered_paths:
        posix_path = path.as_posix().replace("'", "'\\''")
        list_content.append(f"file '{posix_path}'")
    list_path.write_text("\n".join(list_content) + "\n", encoding="utf-8")

    mode = "copy"
    try:
        code, err = await _run_ffmpeg_concat(ffmpeg_bin, list_path, output_path, copy_mode=True)
        if code != 0:
            mode = "reencode"
            code, err = await _run_ffmpeg_concat(ffmpeg_bin, list_path, output_path, copy_mode=False)
            if code != 0:
                raise HTTPException(
                    status_code=500,
                    detail=f"Video stitch failed: {err or 'ffmpeg execution error'}",
                )
    finally:
        try:
            if list_path.exists():
                list_path.unlink()
        except Exception:
            pass

    if not output_path.exists() or output_path.stat().st_size <= 0:
        raise HTTPException(status_code=500, detail="Video stitch failed: empty output")

    return {
        "name": output_name,
        "url": f"/v1/files/video/{output_name}",
        "size_bytes": output_path.stat().st_size,
        "mode": mode,
    }


__all__ = ["router"]
