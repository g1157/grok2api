import type { MiddlewareHandler } from "hono";
import type { Env } from "./env";
import { getSettings } from "./settings";
import { dbFirst } from "./db";
import { validateApiKey } from "./repo/apiKeys";
import { verifyAdminSession } from "./repo/adminSessions";

export interface ApiAuthInfo {
  key: string | null;
  name: string;
  is_admin: boolean;
}

function bearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

function authError(message: string, code: string): Record<string, unknown> {
  return {
    error: {
      message,
      type: "authentication_error",
      code,
    },
  };
}

export const requireApiAuth: MiddlewareHandler<{ Bindings: Env; Variables: { apiAuth: ApiAuthInfo } }> = async (
  c,
  next,
) => {
  const token = bearerToken(c.req.header("Authorization") ?? null);
  const settings = await getSettings(c.env);

  if (!token) {
    const globalKey = (settings.grok.api_key ?? "").trim();
    if (!globalKey) {
      const row = await dbFirst<{ c: number }>(
        c.env.DB,
        "SELECT COUNT(1) as c FROM api_keys WHERE is_active = 1",
      );
      if ((row?.c ?? 0) === 0) {
        c.set("apiAuth", { key: null, name: "Anonymous", is_admin: false });
        return next();
      }
    }
    return c.json(authError("缺少认证令牌", "missing_token"), 401);
  }

  const globalKey = (settings.grok.api_key ?? "").trim();
  if (globalKey && token === globalKey) {
    c.set("apiAuth", { key: token, name: "默认管理员", is_admin: true });
    return next();
  }

  const keyInfo = await validateApiKey(c.env.DB, token);
  if (keyInfo) {
    c.set("apiAuth", { key: keyInfo.key, name: keyInfo.name, is_admin: false });
    return next();
  }

  return c.json(authError(`令牌无效，长度 ${token.length}`, "invalid_token"), 401);
};

export const requireAdminAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const token = bearerToken(c.req.header("Authorization") ?? null);
  if (!token) return c.json({ error: "缺少会话", code: "MISSING_SESSION" }, 401);
  const ok = await verifyAdminSession(c.env.DB, token);
  if (!ok) return c.json({ error: "会话已过期", code: "SESSION_EXPIRED" }, 401);
  return next();
};

// Used by Imagine chat/standalone endpoints so both /chat(API key) and /admin/chat(admin session) can work.
export const requireAdminOrApiAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const token = bearerToken(c.req.header("Authorization") ?? null);
  if (!token) return c.json({ error: "缺少认证令牌", code: "MISSING_AUTH" }, 401);

  try {
    const adminOk = await verifyAdminSession(c.env.DB, token);
    if (adminOk) return next();
  } catch {
    // Keep auth middleware fail-closed without turning transient DB errors into 500s.
  }

  const settings = await getSettings(c.env);
  const globalKey = (settings.grok.api_key ?? "").trim();
  if (globalKey && token === globalKey) return next();

  try {
    const keyInfo = await validateApiKey(c.env.DB, token);
    if (keyInfo) return next();
  } catch {
    // Keep behavior consistent with invalid credentials when key table is unavailable.
  }

  return c.json({ error: "认证令牌无效", code: "INVALID_AUTH" }, 401);
};
