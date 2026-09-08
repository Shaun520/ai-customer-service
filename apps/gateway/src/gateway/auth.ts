/**
 * 鉴权（统一网关 API Key → 单租户）+ 限流（RPM/TPM 令牌桶）
 *
 * 单租户模式：接入方（多端/多系统）共用同一把 GATEWAY_API_KEY，
 * 不再按租户/客户分别签发 Key，也不再通过 api_keys 表做租户路由。
 */
import type { Context, Next } from 'hono';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { TenantContext } from '@aics/shared';
import { db } from '../db/index.js';
import { tenants } from '../db/schema.js';
import { config } from '../config.js';
import type { GatewayEnv } from '../types.js';

export function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

// 单租户：缓存已解析的默认租户，避免每次请求都查库
let defaultTenant: TenantContext | null | undefined;

/** 解析（并按需自动创建）系统唯一默认租户 */
async function resolveDefaultTenant(): Promise<TenantContext> {
  if (defaultTenant) return defaultTenant;
  let rows = await db.select().from(tenants).where(eq(tenants.slug, config.tenantSlug)).limit(1);
  if (!rows[0]) {
    try {
      const inserted = await db
        .insert(tenants)
        .values({ slug: config.tenantSlug, name: config.tenantName, industry: 'general' })
        .returning();
      rows = inserted;
    } catch {
      // 并发首次启动可能撞唯一键，回退重查
      rows = await db.select().from(tenants).where(eq(tenants.slug, config.tenantSlug)).limit(1);
    }
  }
  const t = rows[0];
  defaultTenant = {
    tenantId: t.id,
    slug: t.slug,
    name: t.name,
    industry: (t.industry as TenantContext['industry']) ?? 'general',
    systemPrompt: t.systemPrompt,
    apiKeyId: t.id, // 单租户下限流与用量审计共用租户 id 作标识
  };
  return defaultTenant;
}

export interface AuthedContext extends Context<GatewayEnv> {}

/** 鉴权中间件：Authorization: Bearer <统一网关 Key> → 固定单租户上下文 */
export async function authMiddleware(c: Context<GatewayEnv>, next: Next): Promise<Response | void> {
  const header = c.req.header('Authorization') ?? '';
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!raw) {
    return c.json(
      {
        error: {
          message: 'Missing API key. Pass "Authorization: Bearer <api-key>".',
          type: 'invalid_request_error',
          code: 'missing_api_key',
        },
      },
      401,
    );
  }
  if (hashKey(raw) !== hashKey(config.gatewayKey)) {
    return c.json(
      { error: { message: 'Invalid API key.', type: 'invalid_request_error', code: 'invalid_api_key' } },
      401,
    );
  }

  const tenant = await resolveDefaultTenant();
  c.set('tenant', tenant);
  c.set('rateLimits', { rpm: config.rateLimit.rpm, tpm: config.rateLimit.tpm });
  await next();
}

/** 管理接口鉴权：X-Admin-Token */
export function adminAuth(c: Context): boolean {
  return (c.req.header('X-Admin-Token') ?? '') === config.adminToken;
}

/** 供管理端/链路反查复用：校验统一网关 Key，命中则返回默认租户 id */
export async function resolveTenantIdByKey(raw: string): Promise<{ tenantId: number } | null> {
  if (hashKey(raw) !== hashKey(config.gatewayKey)) return null;
  const t = await resolveDefaultTenant();
  return { tenantId: t.tenantId };
}

// ---------------- 限流（进程内滑动窗口） ----------------

interface WindowState {
  /** 最近一分钟内的请求时间戳 */
  requestTimes: number[];
  /** 最近一分钟消耗的 token 估算 */
  tokens: Array<{ at: number; n: number }>;
}

const windows = new Map<number, WindowState>();
// 定期清理，防泄漏
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [, w] of windows) {
    w.requestTimes = w.requestTimes.filter((t) => t > cutoff);
    w.tokens = w.tokens.filter((x) => x.at > cutoff);
  }
}, 60_000).unref();

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  remainingRpm: number;
}

export function checkRateLimit(apiKeyId: number, rpm: number, estimatedTokens = 0): RateLimitResult {
  const cutoff = Date.now() - 60_000;
  let w = windows.get(apiKeyId);
  if (!w) {
    w = { requestTimes: [], tokens: [] };
    windows.set(apiKeyId, w);
  }
  w.requestTimes = w.requestTimes.filter((t) => t > cutoff);
  w.tokens = w.tokens.filter((x) => x.at > cutoff);

  if (w.requestTimes.length >= rpm) {
    return { allowed: false, reason: `RPM limit exceeded (${rpm}/min)`, remainingRpm: 0 };
  }
  const usedTokens = w.tokens.reduce((s, x) => s + x.n, 0);
  if (usedTokens + estimatedTokens > config.rateLimit.tpm) {
    return { allowed: false, reason: 'TPM limit exceeded', remainingRpm: rpm - w.requestTimes.length };
  }
  w.requestTimes.push(Date.now());
  if (estimatedTokens > 0) w.tokens.push({ at: Date.now(), n: estimatedTokens });
  return { allowed: true, remainingRpm: rpm - w.requestTimes.length };
}

export function recordTokenUsage(apiKeyId: number, tokens: number): void {
  const w = windows.get(apiKeyId);
  if (w) w.tokens.push({ at: Date.now(), n: tokens });
}
