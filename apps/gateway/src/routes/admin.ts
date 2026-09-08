/**
 * 管理接口（X-Admin-Token 鉴权）：规则包热更新、用量统计、文档检索预览
 *
 * 单租户模式：不再提供"创建租户 / 签发 API Key"，接入端统一使用
 * 全局 GATEWAY_API_KEY，见 gateway/auth.ts。
 */
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { IndustryRulePackSchema } from '@aics/shared';
import { db, queryClient } from '../db/index.js';
import { industryRules } from '../db/schema.js';
import { adminAuth } from '../gateway/auth.js';
import { DEFAULT_RULE_PACKS, clearRuleCache } from '../gateway/guardrail.js';

export const adminRoutes = new Hono();

adminRoutes.use('*', async (c, next) => {
  if (!adminAuth(c)) {
    return c.json({ error: 'Admin token required (X-Admin-Token)' }, 401);
  }
  await next();
});

/** 查看当前生效的行业规则包（DB 覆盖优先，否则内置默认） */
adminRoutes.get('/rule-packs/:industry', async (c) => {
  const industry = c.req.param('industry');
  const rows = await db
    .select()
    .from(industryRules)
    .where(and(eq(industryRules.industry, industry), eq(industryRules.enabled, true)))
    .limit(1);
  if (rows[0]) {
    return c.json({
      industry,
      source: 'db',
      version: rows[0].version,
      updated_at: rows[0].updatedAt,
      pack: rows[0].rules,
    });
  }
  const pack = DEFAULT_RULE_PACKS[industry] ?? DEFAULT_RULE_PACKS.general;
  return c.json({ industry, source: 'builtin', pack });
});

/**
 * 行业规则包热更新（写入 industry_rules，version +1）
 * - Zod 校验结构 + 逐条正则合法性校验（非法正则会让整条规则在运行时被跳过）
 * - 写库后立即清空本地规则缓存，下次判定即生效（无需重启网关）
 */
adminRoutes.put('/rule-packs/:industry', async (c) => {
  const industry = c.req.param('industry');
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(industry)) {
    return c.json({ error: 'Invalid industry key (expect lowercase letters, digits and dash)' }, 400);
  }

  const parsed = IndustryRulePackSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid rule pack', detail: parsed.error.flatten() }, 400);
  }
  const pack = parsed.data;

  for (const rule of pack.riskRules) {
    try {
      new RegExp(rule.pattern);
    } catch (err) {
      return c.json(
        { error: `Invalid regex in rule "${rule.id}"`, detail: (err as Error).message },
        400,
      );
    }
  }

  const existing = await db
    .select()
    .from(industryRules)
    .where(eq(industryRules.industry, industry))
    .limit(1);

  if (existing[0]) {
    await db
      .update(industryRules)
      .set({
        rules: pack,
        version: (existing[0].version ?? 1) + 1,
        enabled: true,
        updatedAt: new Date(),
      })
      .where(eq(industryRules.id, existing[0].id));
  } else {
    await db.insert(industryRules).values({ industry, rules: pack, version: 1 });
  }

  clearRuleCache(); // 立即失效进程内缓存
  return c.json({
    industry,
    updated: true,
    version: existing[0] ? (existing[0].version ?? 1) + 1 : 1,
    note: '规则包已热更新，进程内缓存已失效，后续判定立即生效',
  });
});

/**
 * 用量统计（仪表盘）：按天聚合 token 数 / 请求数 / 缓存命中 / 平均延迟
 * 查询参数：?days=7（默认 7，可 1/7/30）
 * 单租户模式：聚合全库（唯一租户），不再按租户过滤。
 * 返回 daily: 每日聚合 + totals: 区间汇总
 */
adminRoutes.get('/usage', async (c) => {
  const days = Math.min(90, Math.max(1, Number(c.req.query('days') ?? 7)));

  // 起始时间：按整天天数截断，避免只看到今天极少量数据
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  from.setHours(0, 0, 0, 0);

  // 纯 postgres-js 执行：列名用文本，值用参数绑定
  const conds = ['created_at >= $1', 'created_at < now()'];
  // postgres-js 的 unsafe 把参数当字符串字面量序列化，Date 会报错，故转 ISO 字符串
  const params: Array<string | number> = [from.toISOString()];
  const whereSql = conds.join(' AND ');

  const daily = await queryClient.unsafe<Array<Record<string, unknown>>>(
    `
    SELECT
      DATE(created_at) AS day,
      COUNT(*)::int AS requests,
      COALESCE(SUM(prompt_tokens), 0)::int AS prompt_tokens,
      COALESCE(SUM(completion_tokens), 0)::int AS completion_tokens,
      COUNT(*) FILTER (WHERE cache_hit <> 'none')::int AS cached_requests,
      AVG(latency_ms)::numeric(10,1) AS avg_latency_ms
    FROM usage_logs
    WHERE ${whereSql}
    GROUP BY DATE(created_at)
    ORDER BY day ASC
    `,
    params,
  );

  const rows = await queryClient.unsafe<Array<Record<string, unknown>>>(
    `
    SELECT
      COUNT(*)::int AS requests,
      COALESCE(SUM(prompt_tokens), 0)::int AS prompt_tokens,
      COALESCE(SUM(completion_tokens), 0)::int AS completion_tokens,
      COUNT(*) FILTER (WHERE cache_hit <> 'none')::int AS cached_requests,
      AVG(latency_ms)::numeric(10,1) AS avg_latency_ms
    FROM usage_logs
    WHERE ${whereSql}
    `,
    params,
  );

  const summary: Record<string, unknown> = rows[0] ?? {};

  return c.json({
    days,
    from: from.toISOString(),
    tenant: null,
    daily: daily.map((r) => ({
      day: r['day'],
      requests: Number(r['requests'] ?? 0),
      promptTokens: Number(r['prompt_tokens'] ?? 0),
      completionTokens: Number(r['completion_tokens'] ?? 0),
      cachedRequests: Number(r['cached_requests'] ?? 0),
      avgLatencyMs: Number(r['avg_latency_ms'] ?? 0),
    })),
    totals: {
      requests: Number(summary['requests'] ?? 0),
      promptTokens: Number(summary['prompt_tokens'] ?? 0),
      completionTokens: Number(summary['completion_tokens'] ?? 0),
      cachedRequests: Number(summary['cached_requests'] ?? 0),
      avgLatencyMs: Number(summary['avg_latency_ms'] ?? 0),
    },
  });
});
