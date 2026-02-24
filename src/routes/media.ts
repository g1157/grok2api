import { Hono } from "hono";
import type { Env } from "../env";
import { getSettings, normalizeCfCookie } from "../settings";
import { applyCooldown, listTokens, recordTokenFailure, selectBestToken } from "../repo/tokens";
import { getDynamicHeaders } from "../grok/headers";
import { deleteCacheRow, touchCacheRow, upsertCacheRow, type CacheType } from "../repo/cache";
import { nowMs } from "../utils/time";
import { nextLocalMidnightExpirationSeconds } from "../kv/cleanup";

export const mediaRoutes = new Hono<{ Bindings: Env }>();

function guessCacheSeconds(path: string): number {
  const lower = path.toLowerCase();
  if (lower.endsWith(".mp4") || lower.endsWith(".webm") || lower.endsWith(".mov")) return 60 * 60 * 24;
  return 60 * 60 * 24;
}

function detectTypeByPath(path: string): CacheType {
  const lower = path.toLowerCase();
  if (lower.endsWith(".mp4") || lower.endsWith(".webm") || lower.endsWith(".mov") || lower.endsWith(".avi"))
    return "video";
  return "image";
}

function detectMimeByPath(path: string, type: CacheType): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".m4v")) return "video/mp4";
  if (lower.endsWith(".avi")) return "video/x-msvideo";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".bmp")) return "image/bmp";
  return type === "video" ? "video/mp4" : "application/octet-stream";
}

function r2Key(type: CacheType, imgPath: string): string {
  return `${type}/${imgPath}`;
}

function parseIntSafe(v: string | undefined, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function base64UrlDecode(input: string): string {
  const s = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const binary = atob(s + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function isAllowedUpstreamHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "assets.grok.com" || h === "grok.com" || h.endsWith(".grok.com") || h.endsWith(".x.ai");
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

// Legacy decoder for paths like:
// users-<uuid>-generated-<uuid>-image.jpg  -> /users/<uuid>/generated/<uuid>/image.jpg
function decodeLegacyHyphenPath(imgPath: string): string | null {
  const marker = "-generated-";
  const idx = imgPath.indexOf(marker);
  if (idx <= 0) return null;

  const left = imgPath.slice(0, idx);
  const right = imgPath.slice(idx + marker.length);

  if (!left.startsWith("users-")) return null;
  const userId = left.slice("users-".length);
  if (!isUuid(userId)) return null;

  // right: <uuid>-<filename>
  if (right.length < 36 + 1) return null;
  const genId = right.slice(0, 36);
  if (!isUuid(genId)) return null;
  if (right[36] !== "-") return null;
  const filename = right.slice(37);
  if (!filename) return null;

  return `/users/${userId}/generated/${genId}/${filename}`;
}

function responseFromBytes(args: {
  bytes: ArrayBuffer;
  contentType: string;
  cacheSeconds: number;
  rangeHeader: string | undefined;
}): Response {
  const headers = new Headers();
  headers.set("Accept-Ranges", "bytes");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", `public, max-age=${args.cacheSeconds}`);
  headers.set("Content-Type", args.contentType || "application/octet-stream");

  const size = args.bytes.byteLength;
  const rangeHeader = args.rangeHeader;
  if (rangeHeader) {
    const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
    if (m) {
      const startStr = m[1] ?? "";
      const endStr = m[2] ?? "";

      // suffix-byte-range-spec: bytes=-500
      if (!startStr && endStr) {
        const suffix = Number(endStr);
        if (!Number.isFinite(suffix) || suffix <= 0) return new Response(null, { status: 416 });
        const length = Math.min(size, suffix);
        const start = Math.max(0, size - length);
        const end = size - 1;
        const sliced = args.bytes.slice(start, end + 1);
        headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
        headers.set("Content-Length", String(sliced.byteLength));
        return new Response(sliced, { status: 206, headers });
      }

      let start = startStr ? Number(startStr) : 0;
      let end = endStr ? Number(endStr) : size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < 0 || start > end) {
        return new Response(null, { status: 416 });
      }
      if (start >= size) return new Response(null, { status: 416 });
      end = Math.min(end, size - 1);
      const sliced = args.bytes.slice(start, end + 1);
      headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
      headers.set("Content-Length", String(sliced.byteLength));
      return new Response(sliced, { status: 206, headers });
    }
  }

  headers.set("Content-Length", String(size));
  return new Response(args.bytes, { status: 200, headers });
}

function toUpstreamHeaders(args: {
  pathname: string;
  cookie: string;
  settings: Awaited<ReturnType<typeof getSettings>>["grok"];
  type: CacheType;
}): Record<string, string> {
  const headers = getDynamicHeaders(args.settings, args.pathname);
  headers.Cookie = args.cookie;
  delete headers["Content-Type"];
  delete headers.Origin;
  headers.Accept = args.type === "video" ? "video/*,*/*;q=0.8" : "image/avif,image/webp,image/apng,image/*,*/*;q=0.8";
  headers["Sec-Fetch-Dest"] = args.type === "video" ? "video" : "image";
  headers["Sec-Fetch-Mode"] = "no-cors";
  headers["Sec-Fetch-Site"] = "same-site";
  delete headers["Sec-Fetch-User"];
  delete headers["Upgrade-Insecure-Requests"];
  headers.Referer = "https://grok.com/";
  return headers;
}

mediaRoutes.get("/images/:imgPath{.+}", async (c) => {
  const imgPath = c.req.param("imgPath");

  let upstreamPath: string | null = null;
  let upstreamUrl: URL | null = null;

  // New encoding: p_<base64url(pathname)>
  if (imgPath.startsWith("p_")) {
    try {
      upstreamPath = base64UrlDecode(imgPath.slice(2));
    } catch {
      upstreamPath = null;
    }
  }

  // New encoding: u_<base64url(full_url)>
  if (imgPath.startsWith("u_")) {
    try {
      const decodedUrl = base64UrlDecode(imgPath.slice(2));
      const u = new URL(decodedUrl);
      if (isAllowedUpstreamHost(u.hostname)) upstreamUrl = u;
    } catch {
      upstreamUrl = null;
    }
  }

  if (upstreamUrl) upstreamPath = upstreamUrl.pathname;

  // Legacy encoding (best-effort): users-<uuid>-generated-<uuid>-image.jpg
  if (!upstreamPath) upstreamPath = decodeLegacyHyphenPath(imgPath);

  // Very old encoding (lossy): replace '-' with '/' (breaks UUIDs)
  if (!upstreamPath) upstreamPath = `/${imgPath.replaceAll("-", "/")}`;

  // If upstreamPath accidentally contains a full URL, extract pathname.
  if (upstreamPath.startsWith("http://") || upstreamPath.startsWith("https://")) {
    try {
      upstreamPath = new URL(upstreamPath).pathname;
    } catch {
      // keep as-is
    }
  }

  if (!upstreamPath.startsWith("/")) upstreamPath = `/${upstreamPath}`;
  upstreamPath = upstreamPath.replace(/\/{2,}/g, "/");

  const originalPath = upstreamUrl?.pathname ?? upstreamPath;
  const url = upstreamUrl ?? new URL(`https://assets.grok.com${originalPath}`);
  const type = detectTypeByPath(originalPath);
  const key = r2Key(type, imgPath);
  const cacheSeconds = guessCacheSeconds(originalPath);

  const rangeHeader = c.req.header("Range");
  const cached = await c.env.KV_CACHE.getWithMetadata<{ contentType?: string; size?: number }>(key, {
    type: "arrayBuffer",
  });
  if (cached?.value) {
    c.executionCtx.waitUntil(touchCacheRow(c.env.DB, key, nowMs()));
    const contentType = (cached.metadata?.contentType as string | undefined) || detectMimeByPath(originalPath, type);
    return responseFromBytes({ bytes: cached.value, contentType, cacheSeconds, rangeHeader });
  }

  // stale metadata cleanup (best-effort)
  c.executionCtx.waitUntil(deleteCacheRow(c.env.DB, key));

  const settingsBundle = await getSettings(c.env);
  const chosen = await selectBestToken(c.env.DB, "grok-4");
  if (!chosen) return c.text("No available token", 503);

  const cf = normalizeCfCookie(settingsBundle.grok.cf_clearance ?? "");
  const now = nowMs();
  const rows = await listTokens(c.env.DB);
  const tokenCandidates: string[] = [];
  const pushCandidate = (token: string) => {
    const t = String(token || "").trim();
    if (!t || tokenCandidates.includes(t)) return;
    tokenCandidates.push(t);
  };
  pushCandidate(chosen.token);
  for (const row of rows) {
    if (row.status === "expired") continue;
    if (row.failed_count >= 3) continue;
    if (row.cooldown_until && row.cooldown_until > now) continue;
    if (row.remaining_queries === 0) continue;
    pushCandidate(row.token);
    if (tokenCandidates.length >= 6) break;
  }

  let upstream: Response | null = null;
  let lastStatus = 502;
  let lastError = "";

  for (const candidate of tokenCandidates) {
    const cookie = cf ? `sso-rw=${candidate};sso=${candidate};${cf}` : `sso-rw=${candidate};sso=${candidate}`;
    const baseHeaders = toUpstreamHeaders({ pathname: originalPath, cookie, settings: settingsBundle.grok, type });
    try {
      const resp = await fetch(url.toString(), {
        headers: rangeHeader ? { ...baseHeaders, Range: rangeHeader } : baseHeaders,
      });

      if (resp.ok && resp.body) {
        const ct = String(resp.headers.get("content-type") || "").toLowerCase();
        if (ct.includes("text/html")) {
          lastStatus = 403;
          lastError = (await resp.text().catch(() => "")).slice(0, 200);
          continue;
        }
        upstream = resp;
        break;
      }

      const txt = await resp.text().catch(() => "");
      lastStatus = resp.status || 502;
      lastError = txt.slice(0, 200);

      // 403 frequently means asset-account mismatch; retry with another token.
      if (resp.status === 401 || resp.status === 403) continue;
      if (resp.status === 404) break;

      await recordTokenFailure(c.env.DB, candidate, resp.status, lastError);
      await applyCooldown(c.env.DB, candidate, resp.status);

      if (resp.status === 429 || resp.status >= 500) continue;
      break;
    } catch (e) {
      lastStatus = 502;
      lastError = String(e instanceof Error ? e.message : e).slice(0, 200);
      continue;
    }
  }

  if (!upstream || !upstream.body) {
    return new Response(`Upstream ${lastStatus}${lastError ? `: ${lastError}` : ""}`, { status: lastStatus });
  }

  const contentType = upstream.headers.get("content-type") ?? detectMimeByPath(originalPath, type);
  const contentLengthHeader = upstream.headers.get("content-length") ?? "";
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : NaN;
  const maxBytes = Math.min(25 * 1024 * 1024, Math.max(1, parseIntSafe(c.env.KV_CACHE_MAX_BYTES, 25 * 1024 * 1024)));
  const shouldTryCache =
    !rangeHeader &&
    (!Number.isFinite(contentLength) || (contentLength > 0 && contentLength <= maxBytes));

  if (shouldTryCache) {
    const [toKvRaw, toClient] = upstream.body.tee();
    const tzOffset = parseIntSafe(c.env.CACHE_RESET_TZ_OFFSET_MINUTES, 480);
    const expiresAt = nextLocalMidnightExpirationSeconds(nowMs(), tzOffset);

    c.executionCtx.waitUntil(
      (async () => {
        try {
          let byteCount = 0;
          const limiter = new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              byteCount += chunk.byteLength;
              if (byteCount > maxBytes) throw new Error("KV value too large");
              controller.enqueue(chunk);
            },
          });
          const toKv = toKvRaw.pipeThrough(limiter);

          await c.env.KV_CACHE.put(key, toKv, {
            expiration: expiresAt,
            metadata: { contentType, size: Number.isFinite(contentLength) ? contentLength : byteCount, type },
          });
          const now = nowMs();
          await upsertCacheRow(c.env.DB, {
            key,
            type,
            size: Number.isFinite(contentLength) ? contentLength : byteCount,
            content_type: contentType,
            created_at: now,
            last_access_at: now,
            expires_at: expiresAt * 1000,
          });
        } catch {
          // ignore write errors
        }
      })(),
    );

    const outHeaders = new Headers(upstream.headers);
    outHeaders.set("Access-Control-Allow-Origin", "*");
    outHeaders.set("Cache-Control", `public, max-age=${cacheSeconds}`);
    if (contentType) outHeaders.set("Content-Type", contentType);
    return new Response(toClient, { status: upstream.status, headers: outHeaders });
  }

  const outHeaders = new Headers(upstream.headers);
  outHeaders.set("Access-Control-Allow-Origin", "*");
  outHeaders.set("Cache-Control", `public, max-age=${cacheSeconds}`);
  if (contentType) outHeaders.set("Content-Type", contentType);
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
});
