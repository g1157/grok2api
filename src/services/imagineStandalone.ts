import type { Env } from "../env";
import { getDynamicHeaders } from "../grok/headers";
import { resolveAspectRatio } from "../grok/imagineExperimental";
import { getSettings, normalizeCfCookie } from "../settings";
import { selectBestToken, recordTokenFailure, applyCooldown } from "../repo/tokens";

const IMAGINE_WS_URL = "https://grok.com/ws/imagine/listen";
const IMAGINE_REFERER = "https://grok.com/imagine";
const ASSET_API = "https://assets.grok.com";

const KV_PREFIX = "imagine:";
const KV_TTL = 86400 * 7; // 7 days

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ImageProgress {
  imageId: string;
  stage: "preview" | "medium" | "final";
  url: string;
  isFinal: boolean;
}

interface GenerateResult {
  success: boolean;
  urls?: string[];
  count?: number;
  error?: string;
  errorCode?: string;
}

type WsJson = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodeWsData(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    return new TextDecoder().decode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  }
  return "";
}

function parseWsJson(data: unknown): WsJson | null {
  const raw = decodeWsData(data);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as WsJson;
  } catch { /* ignore */ }
  return null;
}

function extractUrl(msg: WsJson): string {
  for (const key of ["url", "imageUrl", "image_url"]) {
    const v = msg[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function normalizeAssetUrl(raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  if (v.startsWith("http://") || v.startsWith("https://")) return v;
  return `${ASSET_API}/${v.replace(/^\/+/, "")}`;
}

function clampProgress(input: unknown): number | null {
  const n = Number(input);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, n));
}

function extractProgress(msg: WsJson): number | null {
  return clampProgress(msg.percentage_complete) ?? clampProgress(msg.percentageComplete) ?? clampProgress(msg.progress);
}

function isCompleted(msg: WsJson, progress: number | null): boolean {
  const status = String(msg.current_status ?? msg.currentStatus ?? "").trim().toLowerCase();
  if (status === "completed" || status === "done" || status === "success") return true;
  return progress !== null && progress >= 100;
}

function isBlocked(msg: WsJson): boolean {
  const type = String(msg.type ?? "").toLowerCase();
  const status = String(msg.current_status ?? msg.currentStatus ?? "").toLowerCase();
  return type === "error" || status === "error";
}

function buildPayload(prompt: string, requestId: string, aspectRatio: string): WsJson {
  return {
    type: "conversation.item.create",
    timestamp: Date.now(),
    item: {
      type: "message",
      content: [{
        requestId,
        text: prompt,
        type: "input_scroll",
        properties: {
          section_count: 0,
          is_kids_mode: false,
          enable_nsfw: true,
          skip_upsampler: false,
          is_initial: false,
          aspect_ratio: aspectRatio,
        },
      }],
    },
  };
}

function parseWsFailureStatus(message: string): number {
  const m = message.match(/Imagine websocket connect failed:\s*(\d{3})\b/i);
  if (m) {
    const s = Number(m[1]);
    if (Number.isFinite(s) && s >= 100 && s <= 599) return s;
  }
  return 500;
}

// ---------------------------------------------------------------------------
// Size to aspect ratio mapping (for OpenAI-compatible API)
// ---------------------------------------------------------------------------

const SIZE_TO_RATIO: Record<string, string> = {
  "1024x1024": "1:1",
  "1024x1536": "2:3",
  "1536x1024": "3:2",
};

export function sizeToAspectRatio(size: string): string {
  return SIZE_TO_RATIO[size] ?? resolveAspectRatio(size);
}

// ---------------------------------------------------------------------------
// Core: generate images via Imagine WebSocket
// ---------------------------------------------------------------------------

export async function generateImagine(
  env: Env,
  sso: string,
  prompt: string,
  aspectRatio: string,
  n: number,
  progressCb?: (p: ImageProgress) => void,
): Promise<GenerateResult> {
  const settings = await getSettings(env);
  const grokSettings = settings.grok;
  const requestId = crypto.randomUUID();
  const targetCount = Math.max(1, Math.min(6, n));
  const ratio = resolveAspectRatio(aspectRatio);

  const cf = normalizeCfCookie(grokSettings.cf_clearance ?? "");
  const cookie = cf ? `sso-rw=${sso};sso=${sso};${cf}` : `sso-rw=${sso};sso=${sso}`;

  const headers = getDynamicHeaders(grokSettings, "/ws/imagine/listen");
  headers.Cookie = cookie;
  headers.Origin = "https://grok.com";
  headers.Referer = IMAGINE_REFERER;
  headers.Connection = "Upgrade";
  headers.Upgrade = "websocket";
  delete headers["Content-Type"];

  const wsResp = await fetch(IMAGINE_WS_URL, { method: "GET", headers });
  const ws = wsResp.webSocket;
  if (wsResp.status !== 101 || !ws) {
    const text = await wsResp.text().catch(() => "");
    return {
      success: false,
      error: `Imagine websocket connect failed: ${wsResp.status} ${text.slice(0, 200)}`,
      errorCode: "ws_connect_failed",
    };
  }

  ws.accept();
  ws.send(JSON.stringify(buildPayload(prompt, requestId, ratio)));

  const imageIndexes = new Map<string, number>();
  const finalUrls = new Map<string, string>();

  try {
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const timeoutMs = 120_000;

      const onMessage = (event: MessageEvent) => {
        const msg = parseWsJson(event.data);
        if (!msg) return;

        const msgReqId = String(msg.request_id ?? msg.requestId ?? "");
        if (msgReqId && msgReqId !== requestId) return;

        if (isBlocked(msg)) {
          const errCode = String(msg.err_code ?? msg.errCode ?? "unknown");
          const errMsg = String(msg.err_message ?? msg.err_msg ?? msg.error ?? "unknown error");
          finish(new Error(`Imagine error (${errCode}): ${errMsg}`));
          return;
        }

        const rawImageId = String(msg.id ?? msg.imageId ?? msg.image_id ?? "");
        const imageId = rawImageId || `image-${imageIndexes.size}`;
        if (!imageIndexes.has(imageId)) imageIndexes.set(imageId, imageIndexes.size);

        const progress = extractProgress(msg);
        const imageUrl = extractUrl(msg);

        if (progressCb) {
          const stage = isCompleted(msg, progress) ? "final" : progress !== null && progress > 50 ? "medium" : "preview";
          progressCb({ imageId, stage, url: imageUrl, isFinal: stage === "final" });
        }

        if (imageUrl && isCompleted(msg, progress)) {
          const normalized = normalizeAssetUrl(imageUrl);
          if (!finalUrls.has(imageId)) finalUrls.set(imageId, normalized);
          if (finalUrls.size >= targetCount) finish();
        }
      };

      const onClose = () => {
        if (finalUrls.size > 0) finish();
        else finish(new Error("Imagine websocket closed before completion"));
      };

      const onError = () => finish(new Error("Imagine websocket error event"));

      const timer = setTimeout(() => finish(new Error(`Imagine timeout after ${timeoutMs}ms`)), timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage as EventListener);
        ws.removeEventListener("close", onClose as EventListener);
        ws.removeEventListener("error", onError as EventListener);
      };

      const finish = (err?: Error) => {
        if (finished) return;
        finished = true;
        cleanup();
        try { ws.close(1000, err ? "error" : "done"); } catch { /* ignore */ }
        if (err) reject(err);
        else resolve();
      };

      ws.addEventListener("message", onMessage as EventListener);
      ws.addEventListener("close", onClose as EventListener);
      ws.addEventListener("error", onError as EventListener);
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: msg, errorCode: "generation_failed" };
  }

  const urls = Array.from(finalUrls.values()).filter(Boolean);
  if (!urls.length) {
    return { success: false, error: "No completed images", errorCode: "empty_result" };
  }

  // Store to KV
  for (const url of urls) {
    const key = `${KV_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await env.KV_CACHE.put(key, JSON.stringify({ url, created: Date.now() }), { expirationTtl: KV_TTL });
    } catch { /* ignore KV failures */ }
  }

  return { success: true, urls, count: urls.length };
}

// ---------------------------------------------------------------------------
// Auto-select token and generate
// ---------------------------------------------------------------------------

export async function generateImagineWithAutoToken(
  env: Env,
  prompt: string,
  aspectRatio: string,
  n: number,
  progressCb?: (p: ImageProgress) => void,
): Promise<GenerateResult> {
  const chosen = await selectBestToken(env.DB, "grok-imagine-1.0");
  if (!chosen) {
    return { success: false, error: "No available tokens", errorCode: "no_tokens" };
  }

  const result = await generateImagine(env, chosen.token, prompt, aspectRatio, n, progressCb);

  if (!result.success && result.error) {
    const status = parseWsFailureStatus(result.error);
    try {
      await recordTokenFailure(env.DB, chosen.token, status, result.error.slice(0, 200));
      await applyCooldown(env.DB, chosen.token, status);
    } catch { /* ignore */ }
  }

  return result;
}

// ---------------------------------------------------------------------------
// KV Gallery operations
// ---------------------------------------------------------------------------

export async function listImagineGallery(env: Env): Promise<{ name: string; url: string; created: number }[]> {
  const list = await env.KV_CACHE.list({ prefix: KV_PREFIX });
  const items: { name: string; url: string; created: number }[] = [];
  for (const key of list.keys) {
    try {
      const raw = await env.KV_CACHE.get(key.name);
      if (raw) {
        const data = JSON.parse(raw) as { url?: string; created?: number };
        items.push({ name: key.name, url: data.url ?? "", created: data.created ?? 0 });
      }
    } catch { /* ignore */ }
  }
  return items;
}

export async function clearImagineGallery(env: Env): Promise<number> {
  const list = await env.KV_CACHE.list({ prefix: KV_PREFIX });
  let count = 0;
  for (const key of list.keys) {
    await env.KV_CACHE.delete(key.name);
    count++;
  }
  return count;
}

export async function deleteImagineImage(env: Env, key: string): Promise<boolean> {
  const fullKey = key.startsWith(KV_PREFIX) ? key : `${KV_PREFIX}${key}`;
  const existing = await env.KV_CACHE.get(fullKey);
  if (!existing) return false;
  await env.KV_CACHE.delete(fullKey);
  return true;
}
