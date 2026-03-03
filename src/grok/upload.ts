import type { GrokSettings } from "../settings";
import { getDynamicHeaders } from "./headers";
import { arrayBufferToBase64 } from "../utils/base64";

const UPLOAD_API = "https://grok.com/rest/app-chat/upload-file";

const MIME_DEFAULT = "image/jpeg";
const MAX_CONTENT_LENGTH = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

function isPrivateIp(hostname: string): boolean {
  // IPv4 private ranges
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1] ?? Number.NaN);
    const b = Number(ipv4[2] ?? Number.NaN);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  // IPv6 loopback / link-local / unique-local
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::1") return true;
  if (lower.startsWith("fe80:")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  return false;
}

export function isAllowedUrl(input: string): { allowed: boolean; reason?: string } {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { allowed: false, reason: "Invalid URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { allowed: false, reason: "Only http/https URLs are allowed" };
  }
  const hostname = u.hostname;
  if (isPrivateIp(hostname)) {
    return { allowed: false, reason: "Private/internal IP addresses are not allowed" };
  }
  const lowHost = hostname.toLowerCase();
  if (lowHost === "localhost" || lowHost.endsWith(".local") || lowHost.endsWith(".internal")) {
    return { allowed: false, reason: "Private/internal hostnames are not allowed" };
  }
  return { allowed: true };
}

function isUrl(input: string): boolean {
  try {
    const u = new URL(input);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function guessExtFromMime(mime: string): string {
  const m = mime.split(";")[0]?.trim() ?? "";
  const parts = m.split("/");
  return parts.length === 2 && parts[1] ? parts[1] : "jpg";
}

function base64UrlDecodeUtf8(input: string): string {
  const s = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const binary = atob(s + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function decodeURIComponentLoose(input: string): string {
  let current = String(input || "");
  for (let i = 0; i < 2; i += 1) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch {
      break;
    }
  }
  return current;
}

function buildImageFetchCandidates(imageInput: string): string[] {
  const out: string[] = [];
  const push = (raw: string) => {
    const v = String(raw || "").trim();
    if (!v || out.includes(v)) return;
    out.push(v);
  };

  push(imageInput);
  if (!isUrl(imageInput)) return out;

  let u: URL;
  try {
    u = new URL(imageInput);
  } catch {
    return out;
  }

  const origin = `${u.protocol}//${u.host}`;
  const pathname = String(u.pathname || "/");
  const search = String(u.search || "");

  const pushGalleryPathVariants = (path: string) => {
    const prefix = "/api/v1/imagine/gallery/file/";
    if (!path.startsWith(prefix)) return;
    const tailRaw = path.slice(prefix.length);
    if (!tailRaw) return;
    const tailDecoded = decodeURIComponentLoose(tailRaw);
    push(`${origin}${prefix}${tailRaw}${search}`);
    push(`${origin}${prefix}${tailDecoded}${search}`);
    push(`${origin}${prefix}${encodeURIComponent(tailDecoded)}${search}`);
  };

  pushGalleryPathVariants(pathname);

  if (pathname.startsWith("/images/")) {
    const encoded = pathname.slice("/images/".length);
    if (encoded.startsWith("p_")) {
      try {
        const decodedPath = base64UrlDecodeUtf8(encoded.slice(2));
        pushGalleryPathVariants(decodedPath.startsWith("/") ? decodedPath : `/${decodedPath}`);
      } catch {
        // ignore decode errors
      }
    } else if (encoded.startsWith("u_")) {
      try {
        const decodedUrlRaw = base64UrlDecodeUtf8(encoded.slice(2));
        push(decodedUrlRaw);
        const decodedUrl = new URL(decodedUrlRaw, origin);
        push(decodedUrl.toString());
        pushGalleryPathVariants(decodedUrl.pathname.startsWith("/") ? decodedUrl.pathname : `/${decodedUrl.pathname}`);
      } catch {
        // ignore decode errors
      }
    }
  }

  return out;
}

function parseDataUrl(dataUrl: string): { base64: string; mime: string } {
  const trimmed = dataUrl.trim();
  const comma = trimmed.indexOf(",");
  if (comma === -1) return { base64: trimmed, mime: MIME_DEFAULT };
  const header = trimmed.slice(0, comma);
  const base64 = trimmed.slice(comma + 1);
  const match = header.match(/^data:([^;]+);base64$/i);
  return { base64, mime: match?.[1] ?? MIME_DEFAULT };
}

export async function uploadImage(
  imageInput: string,
  cookie: string,
  settings: GrokSettings,
  options?: { sourceHeaders?: HeadersInit },
): Promise<{ fileId: string; fileUri: string }> {
  let base64 = "";
  let mime = MIME_DEFAULT;
  let filename = "image.jpg";

  if (isUrl(imageInput)) {
    const check = isAllowedUrl(imageInput);
    if (!check.allowed) {
      throw new Error(`SSRF protection: ${check.reason}`);
    }
    const candidates = buildImageFetchCandidates(imageInput);
    const requestInit: RequestInit = {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      ...(options?.sourceHeaders ? { headers: options.sourceHeaders } : {}),
    };

    let okResponse: Response | null = null;
    let lastStatus = 0;
    for (const candidate of candidates) {
      const r = await fetch(candidate, requestInit);
      if (r.status >= 300 && r.status < 400) {
        const location = r.headers.get("location") ?? "";
        if (location) {
          const redirectCheck = isAllowedUrl(location);
          if (!redirectCheck.allowed) {
            throw new Error(`SSRF protection: redirect to disallowed URL`);
          }
        }
        // follow safe redirect manually
        if (location) {
          const r2 = await fetch(location, { ...requestInit, redirect: "manual" });
          if (r2.ok) {
            okResponse = r2;
            break;
          }
          lastStatus = r2.status;
          if (r2.status !== 404) {
            const text = await r2.text().catch(() => "");
            throw new Error(`下载图片失败: ${r2.status} ${text.slice(0, 120)}`);
          }
          continue;
        }
      }
      if (r.ok) {
        const contentLength = Number(r.headers.get("content-length") ?? "0");
        if (contentLength > MAX_CONTENT_LENGTH) {
          throw new Error(`下载图片失败: 文件超过 10MB 限制`);
        }
        okResponse = r;
        break;
      }
      lastStatus = r.status;
      if (r.status !== 404) {
        const text = await r.text().catch(() => "");
        throw new Error(`下载图片失败: ${r.status} ${text.slice(0, 120)}`);
      }
    }

    if (!okResponse) {
      throw new Error(`下载图片失败: ${lastStatus || 404}`);
    }
    mime = okResponse.headers.get("content-type")?.split(";")[0] ?? MIME_DEFAULT;
    if (!mime.startsWith("image/")) mime = MIME_DEFAULT;
    const buffer = await okResponse.arrayBuffer();
    if (buffer.byteLength > MAX_CONTENT_LENGTH) {
      throw new Error(`下载图片失败: 文件超过 10MB 限制`);
    }
    base64 = arrayBufferToBase64(buffer);
    filename = `image.${guessExtFromMime(mime)}`;
  } else if (imageInput.trim().startsWith("data:image")) {
    const parsed = parseDataUrl(imageInput);
    base64 = parsed.base64;
    mime = parsed.mime;
    filename = `image.${guessExtFromMime(mime)}`;
  } else {
    base64 = imageInput.trim();
    filename = "image.jpg";
    mime = MIME_DEFAULT;
  }

  const body = JSON.stringify({
    fileName: filename,
    fileMimeType: mime,
    content: base64,
  });

  const headers = getDynamicHeaders(settings, "/rest/app-chat/upload-file");
  headers.Cookie = cookie;

  const resp = await fetch(UPLOAD_API, { method: "POST", headers, body });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`上传失败: ${resp.status} ${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { fileMetadataId?: string; fileUri?: string };
  return { fileId: data.fileMetadataId ?? "", fileUri: data.fileUri ?? "" };
}
