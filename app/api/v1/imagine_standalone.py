import asyncio
import json
import os
import time
from pathlib import Path
from typing import Optional, List

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


@router.post("/generate", dependencies=[Depends(verify_api_key)])
async def generate_image(req: GenerateRequest):
    pool = get_imagine_sso_pool()
    token = pool.get_next_sso()
    if not token:
        raise HTTPException(status_code=503, detail="No available SSO tokens for imagine")

    aspect_ratio = SIZE_MAP.get(req.size, "1:1")
    client = GrokImagineClient(sso_token=token)

    if req.stream:
        return StreamingResponse(
            _stream_generate(client, pool, token, req.prompt, aspect_ratio, req.response_format),
            media_type="text/event-stream",
        )

    try:
        results = await client.generate(prompt=req.prompt, aspect_ratio=aspect_ratio)
        pool.record_usage(token)
        pool.mark_success(token)

        data = []
        for r in results:
            if req.response_format == "b64_json":
                data.append({"b64_json": r.b64})
            else:
                data.append({"url": r.url or f"/api/v1/imagine/gallery/file/{Path(r.filepath).name}"})

        return {"created": int(time.time()), "data": data}

    except Exception as e:
        pool.mark_failed(token)
        logger.error(f"Imagine generation failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


async def _stream_generate(client, pool, token, prompt, aspect_ratio, response_format):
    queue: asyncio.Queue = asyncio.Queue()

    def callback(event_type, data):
        queue.put_nowait((event_type, data))

    async def run():
        try:
            results = await client.generate(prompt=prompt, aspect_ratio=aspect_ratio, stream_callback=callback)
            pool.record_usage(token)
            pool.mark_success(token)
            final_data = []
            for r in results:
                if response_format == "b64_json":
                    final_data.append({"b64_json": r.b64})
                else:
                    final_data.append({"url": r.url or f"/api/v1/imagine/gallery/{Path(r.filepath).name}"})
            await queue.put(("complete", {"created": int(time.time()), "data": final_data}))
        except Exception as e:
            pool.mark_failed(token)
            await queue.put(("error", {"message": str(e)}))
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
                    "url": f"/api/v1/imagine/gallery/{f.name}",
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
