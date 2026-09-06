/**
 * 鉴权（API Key → 租户）+ 限流（RPM/TPM 令牌桶，按 API Key）
 */
import type { Context, Next } from 'hono';
import { createHash, randomBytes } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type { TenantContext } from '@aics/shared';
import { db } from '../db/index.js';
import { apiKeys, tenants } from '../db/schema.js';
import { config } from '../config.js';
import type { GatewayEnv } from '../types.js';

export function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** 生成新 API Key：aics_<prefix8>_<random32>；仅创建时返回完整明文 */
export function generateApiKey(): { raw: string; prefix: string; hash: string } {
  const prefix = randomBytes(4).toString('hex');
  const secret = randomBytes(24).toString('base64url');
  const raw = `aics_${prefix}_${secret}`;
  return { raw, prefix: `aics_${prefix}`, hash: hashKey(raw) };
}

export interface AuthedContext extends Context<GatewayEnv> {}

/** 鉴权中间件：Authorization: Bearer aics_xxx → 解析租户上下文 */
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
  const rows = await db
    .select({
      keyId: apiKeys.id,
      rpm: apiKeys.rpm,
      tpm: apiKeys.tpm,
      enabled: apiKeys.enabled,
      tenantId: tenants.id,
      slug: tenants.slug,
      name: tenants.name,
      industry: tenants.industry,
      systemPrompt: tenants.systemPrompt,
    })
    .from(apiKeys)
    .innerJoin(tenants, eq(apiKeys.tenantId, tenants.id))
    .where(eq(apiKeys.keyHash, hashKey(raw)))
    .limit(1);

  const row = rows[0];
  if (!row || !row.enabled) {
    return c.json(
      { error: { message: 'Invalid API key.', type: 'invalid_request_error', code: 'invalid_api_key' } },
      401,
    );
  }

  const tenant: TenantContext = {
    tenantId: row.tenantId,
    slug: row.slug,
    name: row.name,
    industry: (row.industry as TenantContext['industry']) ?? 'general',
    systemPrompt: row.systemPrompt,
    apiKeyId: row.keyId,
  };
  c.set('tenant', tenant);
  c.set('rateLimits', { rpm: row.rpm, tpm: row.tpm });
  await next();
}

/** 管理接口鉴权：X-Admin-Token */
export function adminAuth(c: Context): boolean {
  return (c.req.header('X-Admin-Token') ?? '') === config.adminToken;
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

/** 按 keyHash 直查租户（供冒烟脚本复用） */
export async function lookupTenantByKey(raw: string) {
  const rows = await db
    .select({ keyId: apiKeys.id, tenantId: apiKeys.tenantId })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hashKey(raw)), eq(apiKeys.enabled, true)))
    .limit(1);
  return rows[0] ?? null;
}
