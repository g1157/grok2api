export interface GrpcWebCallResult {
  ok: boolean;
  status_code: number;
  grpc_status: string | null;
  grpc_message: string | null;
  error: string | null;
}

export interface AccountSettingsRefreshResult {
  token: string;
  ok: boolean;
  attempts: number;
  step?: "tos" | "birth" | "nsfw" | "exception";
  error?: string;
  status_code?: number;
  grpc_status?: string | null;
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  ) >>> 0;
}

function parseGrpcWebTrailers(bytes: Uint8Array): Record<string, string> {
  const trailers: Record<string, string> = {};
  const decoder = new TextDecoder();
  let pos = 0;
  while (pos + 5 <= bytes.length) {
    const flag = bytes[pos] ?? 0;
    const len = readUint32BE(bytes, pos + 1);
    pos += 5;
    if (pos + len > bytes.length) break;
    const chunk = bytes.slice(pos, pos + len);
    pos += len;
    if ((flag & 0x80) === 0) continue; // not trailers frame
    const text = decoder.decode(chunk);
    for (const line of text.split("\r\n")) {
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      if (key && value) trailers[key] = value;
    }
  }
  return trailers;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function grpcWebPost(args: {
  url: string;
  origin: string;
  referer: string;
  cookie: string;
  body: Uint8Array;
  timeoutMs: number;
  userAgent?: string;
}): Promise<GrpcWebCallResult> {
  const {
    url,
    origin,
    referer,
    cookie,
    body,
    timeoutMs,
    userAgent = DEFAULT_USER_AGENT,
  } = args;

  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/grpc-web+proto",
        origin,
        referer,
        "x-grpc-web": "1",
        "user-agent": userAgent,
        cookie,
      },
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      redirect: "manual",
    },
    timeoutMs,
  );

  const raw = new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
  const headerGrpcStatus = res.headers.get("grpc-status");
  const headerGrpcMessage = res.headers.get("grpc-message");
  const trailers = (!headerGrpcStatus && raw.length) ? parseGrpcWebTrailers(raw) : {};

  const grpc_status = headerGrpcStatus ?? trailers["grpc-status"] ?? null;
  const grpc_message = headerGrpcMessage ?? trailers["grpc-message"] ?? null;

  const ok = res.status === 200 && (!grpc_status || grpc_status === "0");

  let error: string | null = null;
  if (!ok) {
    if (res.status === 403) error = "403 Forbidden";
    else if (res.status !== 200) error = `HTTP ${res.status}`;
    else if (grpc_status && grpc_status !== "0") error = `gRPC ${grpc_status}`;
    else error = "unknown error";
  }

  return {
    ok,
    status_code: res.status,
    grpc_status,
    grpc_message,
    error,
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function generateRandomBirthDate(): string {
  // Keep behavior consistent with Python implementation (20-40 years old, fixed time).
  const today = new Date();
  const age = 20 + Math.floor(Math.random() * 21); // 20..40
  const year = today.getUTCFullYear() - age;
  const month = 1 + Math.floor(Math.random() * 12);
  const day = 1 + Math.floor(Math.random() * 28);
  return `${year}-${pad2(month)}-${pad2(day)}T16:00:00.000Z`;
}

async function acceptTos(args: {
  cookie: string;
  timeoutMs: number;
  userAgent?: string;
}): Promise<GrpcWebCallResult> {
  // gRPC-web framing: 1-byte flag + 4-byte length + payload.
  // payload: field 2 = 1  => 0x10 0x01  (len=2)
  const body = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x02, 0x10, 0x01]);
  return grpcWebPost({
    url: "https://accounts.x.ai/auth_mgmt.AuthManagement/SetTosAcceptedVersion",
    origin: "https://accounts.x.ai",
    referer: "https://accounts.x.ai/accept-tos",
    cookie: args.cookie,
    body,
    timeoutMs: args.timeoutMs,
    ...(args.userAgent ? { userAgent: args.userAgent } : {}),
  });
}

async function setBirthDate(args: {
  cookie: string;
  timeoutMs: number;
  userAgent?: string;
}): Promise<{ ok: boolean; status_code: number; error: string | null }> {
  const birthDate = generateRandomBirthDate();

  const res = await fetchWithTimeout(
    "https://grok.com/rest/auth/set-birth-date",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://grok.com",
        referer: "https://grok.com/",
        "user-agent": args.userAgent ?? DEFAULT_USER_AGENT,
        cookie: args.cookie,
      },
      body: JSON.stringify({ birthDate }),
      redirect: "manual",
    },
    args.timeoutMs,
  );

  if (res.status === 200) return { ok: true, status_code: res.status, error: null };
  if (res.status === 403) return { ok: false, status_code: res.status, error: "403 Forbidden" };
  return { ok: false, status_code: res.status, error: `HTTP ${res.status}` };
}

async function enableNsfw(args: {
  cookie: string;
  timeoutMs: number;
  userAgent?: string;
}): Promise<GrpcWebCallResult> {
  // gRPC-web framing:
  // header: 0x00 + length(0x20)
  // payload: 0a 02 10 01 12 1a 0a 18 + "always_show_nsfw_content"(24 bytes)
  const text = "always_show_nsfw_content";
  const textBytes = new TextEncoder().encode(text);
  const payload = new Uint8Array(8 + textBytes.length);
  payload.set([0x0a, 0x02, 0x10, 0x01, 0x12, 0x1a, 0x0a, 0x18], 0);
  payload.set(textBytes, 8);

  const body = new Uint8Array(5 + payload.length);
  body.set([0x00, 0x00, 0x00, 0x00, payload.length], 0);
  body.set(payload, 5);

  return grpcWebPost({
    url: "https://grok.com/auth_mgmt.AuthManagement/UpdateUserFeatureControls",
    origin: "https://grok.com",
    referer: "https://grok.com/?_s=data",
    cookie: args.cookie,
    body,
    timeoutMs: args.timeoutMs,
    ...(args.userAgent ? { userAgent: args.userAgent } : {}),
  });
}

export async function refreshAccountSettingsForToken(args: {
  token: string;
  cookie: string;
  retries: number;
  timeoutMs?: number;
}): Promise<AccountSettingsRefreshResult> {
  const token = args.token.trim();
  const retries = Number.isFinite(args.retries) ? Math.max(0, Math.floor(args.retries)) : 0;
  const maxAttempts = retries + 1;
  const timeoutMs = Math.max(1000, Math.floor(args.timeoutMs ?? 15_000));

  let lastStep: AccountSettingsRefreshResult["step"] = "exception";
  let lastError = "unknown error";
  let lastStatus = 0;
  let lastGrpcStatus: string | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const tos = await acceptTos({ cookie: args.cookie, timeoutMs });
      if (!tos.ok) {
        lastStep = "tos";
        lastError = tos.error || "accept_tos failed";
        lastStatus = tos.status_code;
        lastGrpcStatus = tos.grpc_status;
        continue;
      }

      const birth = await setBirthDate({ cookie: args.cookie, timeoutMs });
      if (!birth.ok) {
        lastStep = "birth";
        lastError = birth.error || "set_birth_date failed";
        lastStatus = birth.status_code;
        lastGrpcStatus = null;
        continue;
      }

      const nsfw = await enableNsfw({ cookie: args.cookie, timeoutMs });
      if (!nsfw.ok) {
        lastStep = "nsfw";
        lastError = nsfw.error || "enable_nsfw failed";
        lastStatus = nsfw.status_code;
        lastGrpcStatus = nsfw.grpc_status;
        continue;
      }

      return { token, ok: true, attempts: attempt };
    } catch (e) {
      lastStep = "exception";
      lastError = e instanceof Error ? e.message : String(e);
      lastStatus = 0;
      lastGrpcStatus = null;
    }
  }

  return {
    token,
    ok: false,
    attempts: maxAttempts,
    step: lastStep,
    error: lastError,
    status_code: lastStatus,
    grpc_status: lastGrpcStatus,
  };
}
