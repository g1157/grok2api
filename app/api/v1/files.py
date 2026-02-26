"""
文件服务 API 路由
"""

import re
import aiofiles.os
from pathlib import Path
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.core.logger import logger

router = APIRouter(tags=["Files"])

# 缓存根目录
BASE_DIR = Path(__file__).parent.parent.parent.parent / "data" / "tmp"
IMAGE_DIR = BASE_DIR / "image"
VIDEO_DIR = BASE_DIR / "video"

_SAFE_FILENAME_RE = re.compile(r'^[a-zA-Z0-9_.\-]+$')


def _safe_resolve(base_dir: Path, filename: str) -> Path:
    """Sanitize filename and ensure resolved path stays within base_dir."""
    if not _SAFE_FILENAME_RE.match(filename):
        raise HTTPException(status_code=403, detail="Invalid filename")
    resolved = (base_dir / filename).resolve()
    try:
        resolved.relative_to(base_dir.resolve())
    except ValueError:
        raise HTTPException(status_code=403, detail="Path traversal detected")
    return resolved


@router.get("/image/{filename:path}")
async def get_image(filename: str):
    """
    获取图片文件
    """
    if "/" in filename:
        filename = filename.replace("/", "-")

    file_path = _safe_resolve(IMAGE_DIR, filename)
    
    if await aiofiles.os.path.exists(file_path):
        if await aiofiles.os.path.isfile(file_path):
            content_type = "image/jpeg"
            if file_path.suffix.lower() == ".png":
                content_type = "image/png"
            elif file_path.suffix.lower() == ".webp":
                content_type = "image/webp"
            
            # 增加缓存头，支持高并发场景下的浏览器/CDN缓存
            return FileResponse(
                file_path, 
                media_type=content_type,
                headers={
                    "Cache-Control": "public, max-age=31536000, immutable"
                }
            )

    logger.warning(f"Image not found: {filename}")
    raise HTTPException(status_code=404, detail="Image not found")


@router.get("/video/{filename:path}")
async def get_video(filename: str):
    """
    获取视频文件
    """
    if "/" in filename:
        filename = filename.replace("/", "-")

    file_path = _safe_resolve(VIDEO_DIR, filename)
    
    if await aiofiles.os.path.exists(file_path):
        if await aiofiles.os.path.isfile(file_path):
            return FileResponse(
                file_path, 
                media_type="video/mp4",
                headers={
                    "Cache-Control": "public, max-age=31536000, immutable"
                }
            )

    logger.warning(f"Video not found: {filename}")
    raise HTTPException(status_code=404, detail="Video not found")
