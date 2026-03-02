"""
响应中间件 (Pure ASGI)

用于记录请求日志、生成 TraceID 和计算请求耗时。
使用纯 ASGI middleware 避免 BaseHTTPMiddleware 缓冲流式响应的问题。
"""

import time
import uuid
from starlette.types import ASGIApp, Receive, Scope, Send

from app.core.logger import logger


class ResponseLoggerMiddleware:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        trace_id = str(uuid.uuid4())
        scope.setdefault("state", {})["trace_id"] = trace_id

        path = scope.get("path", "")
        method = scope.get("method", "")

        logger.info(
            f"Request: {method} {path}",
            extra={"traceID": trace_id, "method": method, "path": path},
        )

        start_time = time.time()
        status_code = 0

        async def send_wrapper(message):
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message.get("status", 0)
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception as e:
            duration = (time.time() - start_time) * 1000
            logger.error(
                f"Response Error: {method} {path} - {e} ({duration:.2f}ms)",
                extra={
                    "traceID": trace_id,
                    "method": method,
                    "path": path,
                    "duration_ms": round(duration, 2),
                    "error": str(e),
                },
            )
            raise

        duration = (time.time() - start_time) * 1000
        logger.info(
            f"Response: {method} {path} - {status_code} ({duration:.2f}ms)",
            extra={
                "traceID": trace_id,
                "method": method,
                "path": path,
                "status": status_code,
                "duration_ms": round(duration, 2),
            },
        )
