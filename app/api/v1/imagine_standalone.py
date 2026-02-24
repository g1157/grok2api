import asyncio
import json
import os
import time
from pathlib import Path
from typing import Optional, List, Dict, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, StreamingResponse, FileResponse
from pydantic import BaseModel, Field

from app.core.auth import verify_api_key
from app.core.config import get_config
from app.core.logger import logger
from app.services.imagine.client import GrokImagineClient, ImageResult, IMAGE_DIR
from app.services.imagine.sso_pool import get_imagine_sso_pool

router = APIRouter(prefix="/api/v1/imagine", tags=["imagine"])

SIZE_MAP = {
    "1024x1024": "1:1",
    "1024x1536": "2:3",
    "1536x1024": "3:2",
}


class GenerateRequest(BaseModel):
    prompt: str
    model: Optional[str] = "grok-imagine"
    n: int = Field(default=1, ge=1, le=4)
    size: str = "1024x1024"
    response_format: str = "url"
    stream: bool = False


def _extract_error_message(error: Any) -> str:
    if isinstance(error, dict):
        return str(error.get("message") or error.get("error") or "").strip()
    return str(error or "").strip()


def _is_session_expired_error(error: Any) -> bool:
    raw = _extract_error_message(error)
    lowered = raw.lower()
    return (
        "session_expired" in lowered
        or "session expired" in lowered
        or "会话已过期" in raw
    )


def _retry_attempt_limit(pool) -> int:
    try:
        total = int((pool.get_status() or {}).get("total") or 0)
    except Exception:
        total = 0
    if total <= 0:
        return 1
    return max(1, min(4, total))


def _format_generated_data(results: List[ImageResult], response_format: str) -> List[Dict[str, str]]:
    data: List[Dict[str, str]] = []
    for r in results:
        if response_format == "b64_json":
            data.append({"b64_json": r.b64})
        else:
            data.append({"url": r.url or f"/api/v1/imagine/gallery/file/{Path(r.filepath).name}"})
    return data


@router.post("/generate", dependencies=[Depends(verify_api_key)])
async def generate_image(req: GenerateRequest):
    pool = get_imagine_sso_pool()
    aspect_ratio = SIZE_MAP.get(req.size, "1:1")

    if req.stream:
        return StreamingResponse(
            _stream_generate(pool, req.prompt, aspect_ratio, req.response_format, req.n),
            media_type="text/event-stream",
        )

    max_attempts = _retry_attempt_limit(pool)
    last_error = ""
    had_token = False

    for attempt in range(max_attempts):
        token = pool.get_next_sso()
        if not token:
            break
        had_token = True
        client = GrokImagineClient(sso_token=token)
        callback_errors: List[dict] = []

        def callback(event_type, data):
            if event_type == "error":
                callback_errors.append(data or {})

        try:
            results = await client.generate(
                prompt=req.prompt,
                aspect_ratio=aspect_ratio,
                n=req.n,
                stream_callback=callback,
            )
            if not results:
                msg = _extract_error_message(callback_errors[-1] if callback_errors else "")
                if not msg:
                    msg = "No final image generated"
                raise RuntimeError(msg)

            pool.record_usage(token)
            pool.mark_success(token)
            return {"created": int(time.time()), "data": _format_generated_data(results, req.response_format)}
        except Exception as e:
            pool.mark_failed(token)
            callback_msg = _extract_error_message(callback_errors[-1] if callback_errors else "")
            last_error = callback_msg or _extract_error_message(e) or "Imagine generation failed"
            if _is_session_expired_error(last_error) and attempt + 1 < max_attempts:
                logger.warning(f"Imagine token expired, retrying with another token ({attempt + 1}/{max_attempts})")
                continue
            logger.error(f"Imagine generation failed: {last_error}")
            break

    if not had_token:
        raise HTTPException(status_code=503, detail="No available SSO tokens for imagine")
    if _is_session_expired_error(last_error):
        raise HTTPException(status_code=401, detail=last_error)
    raise HTTPException(status_code=500, detail=last_error or "Imagine generation failed")


async def _stream_generate(pool, prompt, aspect_ratio, response_format, n):
    queue: asyncio.Queue = asyncio.Queue()

    async def run():
        max_attempts = _retry_attempt_limit(pool)
        last_error = ""
        had_token = False

        for attempt in range(max_attempts):
            token = pool.get_next_sso()
            if not token:
                break
            had_token = True
            client = GrokImagineClient(sso_token=token)
            callback_errors: List[dict] = []

            def callback(event_type, data):
                if event_type == "error":
                    callback_errors.append(data or {})
                    return
                queue.put_nowait((event_type, data))

            try:
                results = await client.generate(
                    prompt=prompt,
                    aspect_ratio=aspect_ratio,
                    n=n,
                    stream_callback=callback,
                )
                if not results:
                    msg = _extract_error_message(callback_errors[-1] if callback_errors else "")
                    if not msg:
                        msg = "No final image generated"
                    raise RuntimeError(msg)

                pool.record_usage(token)
                pool.mark_success(token)
                await queue.put(
                    ("complete", {"created": int(time.time()), "data": _format_generated_data(results, response_format)})
                )
                await queue.put(None)
                return
            except Exception as e:
                pool.mark_failed(token)
                callback_msg = _extract_error_message(callback_errors[-1] if callback_errors else "")
                last_error = callback_msg or _extract_error_message(e) or "Imagine generation failed"
                if _is_session_expired_error(last_error) and attempt + 1 < max_attempts:
                    await queue.put(
                        (
                            "progress",
                            {
                                "stage": "retry",
                                "message": f"SESSION_EXPIRED，自动切换 token 重试（{attempt + 1}/{max_attempts}）",
                            },
                        )
                    )
                    continue
                break

        if not had_token:
            last_error = "No available SSO tokens for imagine"
        await queue.put(("error", {"message": last_error or "Imagine generation failed"}))
        await queue.put(None)

    task = asyncio.create_task(run())

    try:
        while True:
            item = await queue.get()
            if item is None:
                break
            event_type, data = item
            yield f"data: {json.dumps({'event': event_type, **data})}\n\n"
    finally:
        if not task.done():
            task.cancel()
    yield "data: [DONE]\n\n"


@router.get("/status", dependencies=[Depends(verify_api_key)])
async def imagine_status():
    pool = get_imagine_sso_pool()
    return {
        "service": "imagine",
        "status": "active",
        "sso_pool": pool.get_status(),
    }


@router.post("/sso/reload", dependencies=[Depends(verify_api_key)])
async def sso_reload():
    pool = get_imagine_sso_pool()
    pool.reload()
    return {"message": "SSO pool reloaded", "status": pool.get_status()}


@router.post("/sso/reset", dependencies=[Depends(verify_api_key)])
async def sso_reset():
    pool = get_imagine_sso_pool()
    pool.reset_daily_usage()
    return {"message": "Daily usage reset", "status": pool.get_status()}


@router.get("/gallery", dependencies=[Depends(verify_api_key)])
async def gallery_list():
    files = []
    if IMAGE_DIR.exists():
        for f in sorted(IMAGE_DIR.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
            if f.suffix in (".png", ".jpg", ".jpeg"):
                files.append({
                    "filename": f.name,
                    "size": f.stat().st_size,
                    "created": f.stat().st_mtime,
                    "url": f"/api/v1/imagine/gallery/file/{f.name}",
                })
    return {"images": files, "total": len(files)}


@router.post("/gallery/clear", dependencies=[Depends(verify_api_key)])
async def gallery_clear():
    count = 0
    if IMAGE_DIR.exists():
        for f in IMAGE_DIR.iterdir():
            if f.suffix in (".png", ".jpg", ".jpeg"):
                f.unlink()
                count += 1
    return {"message": f"Cleared {count} images"}


@router.delete("/gallery/{filename}", dependencies=[Depends(verify_api_key)])
async def gallery_delete(filename: str):
    filepath = IMAGE_DIR / filename
    if not filepath.exists() or not filepath.is_file():
        raise HTTPException(status_code=404, detail="Image not found")
    filepath.unlink()
    return {"message": f"Deleted {filename}"}


@router.get("/gallery/file/{filename}")
async def gallery_serve_file(filename: str):
    """Serve a gallery image file."""
    safe_name = Path(filename).name
    filepath = IMAGE_DIR / safe_name
    if not filepath.exists() or not filepath.is_file():
        raise HTTPException(status_code=404, detail="Image not found")
    media_type = "image/jpeg" if safe_name.endswith(".jpg") else "image/png"
    return FileResponse(filepath, media_type=media_type)
