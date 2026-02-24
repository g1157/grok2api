"""
Grok Imagine 独立客户端

基于 imagine2api 的 WebSocket 客户端逻辑移植，
使用 curl_cffi（与项目已有 imagine_experimental 保持一致）。

阶段检测：preview(<30KB) / medium(>30KB) / final(.jpg >100KB)
Blocked 检测：收到 medium 后 15s 无 final → 判定 blocked
"""

from __future__ import annotations

import asyncio
import base64
import re
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from curl_cffi.requests import AsyncSession

from app.core.config import get_config
from app.core.logger import logger
from app.services.grok.chat import BROWSER, ChatRequestBuilder

IMAGE_DIR = Path("data/imagine_images")
IMAGE_DIR.mkdir(parents=True, exist_ok=True)

WS_URL = "wss://grok.com/ws/imagine/listen"
IMAGE_ID_PATTERN = re.compile(r"/images/([a-f0-9-]+)\.(png|jpg)")
BLOCKED_TIMEOUT = 15
FINAL_MIN_SIZE = 100_000  # ~100 KB
MEDIUM_MIN_SIZE = 30_000  # ~30 KB


@dataclass
class ImageResult:
    url: str = ""
    b64: str = ""
    filepath: str = ""
    image_id: str = ""
    stage: str = ""


# Stream callback: (event_type: str, data: dict) -> None
StreamCallback = Callable[[str, Dict[str, Any]], None]


class GrokImagineClient:
    """Grok Imagine WebSocket 客户端 (curl_cffi 版)"""

    def __init__(self, sso_token: str, proxy: str = ""):
        self.sso_token = sso_token
        self.proxy = proxy or str(get_config("grok.base_proxy_url", "") or "")
        self.timeout = int(get_config("imagine.generation_timeout", 120) or 120)

    def _headers(self) -> Dict[str, str]:
        headers = ChatRequestBuilder.build_headers(self.sso_token)
        headers["Referer"] = "https://grok.com/imagine"
        headers["Origin"] = "https://grok.com"
        return headers

    def _proxies(self) -> Optional[dict]:
        return {"http": self.proxy, "https": self.proxy} if self.proxy else None

    @staticmethod
    def _build_payload(prompt: str, request_id: str, aspect_ratio: str) -> dict:
        return {
            "type": "conversation.item.create",
            "timestamp": int(time.time() * 1000),
            "item": {
                "type": "message",
                "content": [{
                    "requestId": request_id,
                    "text": prompt,
                    "type": "input_text",
                    "properties": {
                        "section_count": 0,
                        "is_kids_mode": False,
                        "enable_nsfw": True,
                        "skip_upsampler": False,
                        "is_initial": False,
                        "aspect_ratio": aspect_ratio,
                    },
                }],
            },
        }

    async def generate(
        self,
        prompt: str,
        aspect_ratio: str = "2:3",
        n: int = 4,
        stream_callback: Optional[StreamCallback] = None,
    ) -> List[ImageResult]:
        """
        生成图片，返回最终图片列表。

        支持可选的 stream_callback 实时推送进度。
        """
        request_id = str(uuid.uuid4())
        payload = self._build_payload(prompt, request_id, aspect_ratio)

        results: List[ImageResult] = []
        medium_time: float = 0.0
        has_medium = False
        has_final = False

        session = AsyncSession(impersonate=BROWSER)
        ws = None
        started_at = time.monotonic()

        try:
            ws = await session.ws_connect(
                WS_URL,
                headers=self._headers(),
                timeout=self.timeout,
                proxies=self._proxies(),
                impersonate=BROWSER,
            )
            await ws.send_json(payload)
            logger.info(f"[Imagine] WS request sent: {prompt[:50]}...")

            if stream_callback:
                stream_callback("progress", {"stage": "sent", "message": "Request sent"})

            while time.monotonic() - started_at < self.timeout:
                remain = max(1.0, self.timeout - (time.monotonic() - started_at))
                try:
                    msg = await ws.recv_json(timeout=min(5.0, remain))
                except asyncio.TimeoutError:
                    # Check blocked on timeout
                    if has_medium and not has_final and medium_time > 0:
                        if time.time() - medium_time > BLOCKED_TIMEOUT:
                            logger.warning("[Imagine] Blocked: medium received but no final after timeout")
                            if stream_callback:
                                stream_callback("error", {"message": "Blocked: no final image received"})
                            break
                    continue
                except Exception as e:
                    logger.warning(f"[Imagine] WS recv error: {e}")
                    break

                if not isinstance(msg, dict):
                    continue

                msg_type = str(msg.get("type") or "").lower()

                # Error handling
                if msg_type == "error":
                    err_code = str(msg.get("err_code") or msg.get("errCode") or "unknown")
                    err_msg = str(msg.get("err_msg") or msg.get("err_message") or "unknown error")
                    logger.warning(f"[Imagine] Error: {err_code} - {err_msg}")
                    if stream_callback:
                        stream_callback("error", {"message": f"{err_code}: {err_msg}", "code": err_code})
                    err_code_lower = err_code.lower()
                    err_msg_lower = err_msg.lower()
                    if (
                        err_code_lower == "rate_limit_exceeded"
                        or "session_expired" in err_code_lower
                        or "session expired" in err_msg_lower
                        or "会话已过期" in err_msg
                    ):
                        break
                    continue

                # Image handling
                if msg_type == "image":
                    blob_b64 = str(msg.get("blob") or "")
                    url = str(msg.get("url") or "")
                    if not blob_b64:
                        continue

                    blob_bytes = base64.b64decode(blob_b64)
                    blob_size = len(blob_bytes)

                    m = IMAGE_ID_PATTERN.search(url) if url else None
                    image_id = m.group(1) if m else str(uuid.uuid4())
                    ext = m.group(2) if m else "png"

                    # Stage detection
                    if ext == "jpg" and blob_size > FINAL_MIN_SIZE:
                        stage = "final"
                        has_final = True
                    elif blob_size > MEDIUM_MIN_SIZE:
                        stage = "medium"
                        if not has_medium:
                            has_medium = True
                            medium_time = time.time()
                    else:
                        stage = "preview"

                    logger.debug(f"[Imagine] Image {image_id[:8]}... stage={stage} size={blob_size}")

                    if stream_callback:
                        stream_callback("progress", {
                            "stage": stage,
                            "image_id": image_id,
                            "size": blob_size,
                        })

                    # Save final images
                    if stage == "final":
                        filepath = IMAGE_DIR / f"{image_id}.{ext}"
                        filepath.write_bytes(blob_bytes)
                        results.append(ImageResult(
                            url=url,
                            b64=blob_b64,
                            filepath=str(filepath),
                            image_id=image_id,
                            stage=stage,
                        ))
                        logger.info(f"[Imagine] Final image saved: {filepath.name} ({blob_size / 1024:.1f}KB)")

                        if len(results) >= n:
                            break

                # Blocked detection: medium received but no final for 15s
                if has_medium and not has_final and medium_time > 0:
                    if time.time() - medium_time > BLOCKED_TIMEOUT:
                        logger.warning("[Imagine] Blocked detected: medium without final")
                        if stream_callback:
                            stream_callback("error", {"message": "Blocked: no final image after medium stage"})
                        break

        finally:
            if ws is not None:
                try:
                    await ws.close()
                except Exception:
                    pass
            try:
                await session.close()
            except Exception:
                pass

        return results

    async def verify_age(self) -> bool:
        """年龄验证 (使用 curl_cffi)"""
        cf_clearance = str(get_config("grok.cf_clearance", "") or "")
        if not cf_clearance:
            logger.debug("[Imagine] No cf_clearance, skipping age verification")
            return False

        headers = self._headers()
        headers["Cookie"] = headers.get("Cookie", "") + f"; cf_clearance={cf_clearance}"

        try:
            async with AsyncSession(impersonate=BROWSER) as s:
                resp = await s.post(
                    "https://grok.com/rest/auth/set-birth-date",
                    headers=headers,
                    json={"birthDate": "2001-01-01T16:00:00.000Z"},
                    proxies=self._proxies(),
                    impersonate=BROWSER,
                )
                if resp.status_code == 200:
                    logger.info("[Imagine] Age verification successful")
                    return True
                else:
                    logger.warning(f"[Imagine] Age verification failed: {resp.status_code}")
                    return False
        except Exception as e:
            logger.warning(f"[Imagine] Age verification error: {e}")
            return False
