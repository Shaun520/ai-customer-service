/**
 * 管理接口（X-Admin-Token 鉴权）：规则包热更新、用量统计、文档检索预览
 *
 * 单租户模式：不再提供"创建租户 / 签发 API Key"，接入端统一使用
 * 全局 GATEWAY_API_KEY，见 gateway/auth.ts。
 */
import { Hono } from 'hono';
import { and, eq, ne } from 'drizzle-orm';
import { IndustryRulePackSchema, ModelProviderInputSchema } from '@aics/shared';
import { db, queryClient } from '../db/index.js';
import { industryRules, modelProviders } from '../db/schema.js';
import { adminAuth } from '../gateway/auth.js';
import { DEFAULT_RULE_PACKS, clearRuleCache } from '../gateway/guardrail.js';
import { clearDefaults, getProviders, reloadProviders, type StoredProvider } from '../llm-store.js';

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

// ---------- 对话模型提供商配置（热更新，DB 优先/env 兜底） ----------

/** 脱敏 apiKey：sk-***last4，用于列表/详情返回 */
function maskApiKey(raw: string): string {
  if (raw.length <= 4) return '****';
  return `***${raw.slice(-4)}`;
}

/** 归一化行结构，isDefault 按 task 全局唯一化 */
function toRow(p: StoredProvider) {
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    apiKey: p.id < 0 ? p.apiKey : maskApiKey(p.apiKey), // env 来源返回明文(本地 mock)，DB 来源脱敏
    model: p.model,
    enabled: p.enabled,
    isDefault: p.isDefault,
    task: p.task,
    source: p.id < 0 ? 'env' : 'db',
  };
}

/** 列出当前运行的模型提供商（DB + env 兜底），按 id 升序 */
adminRoutes.get('/models', async (c) => {
  const list = getProviders();
  return c.json({ providers: list.map(toRow), count: list.length });
});

/** 新增模型提供商（Zod 校验；name 唯一；置默认时清理同 task 的其他默认） */
adminRoutes.post('/models', async (c) => {
  const parsed = ModelProviderInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid model provider', detail: parsed.error.flatten() }, 400);
  }
  const body = parsed.data;

  const exist = await db
    .select({ id: modelProviders.id })
    .from(modelProviders)
    .where(eq(modelProviders.name, body.name))
    .limit(1);
  if (exist[0]) {
    return c.json({ error: `Provider "${body.name}" already exists` }, 409);
  }

  if (body.isDefault) await clearDefaults();

  const inserted = await db
    .insert(modelProviders)
    .values({
      name: body.name,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      model: body.model,
      enabled: body.enabled ?? true,
      isDefault: body.isDefault ?? false,
      task: body.task ?? 'default',
    })
    .returning({ id: modelProviders.id, name: modelProviders.name });

  await reloadProviders();
  return c.json({
    provider: inserted[0],
    updated: true,
    note: '模型提供商已新增并实时生效（无需重启网关）',
  });
});

/** 更新模型提供商（可改 baseUrl/apiKey/model/enabled/isDefault/task/name），改后热加载 */
adminRoutes.put('/models/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Invalid provider id' }, 400);

  const parsed = ModelProviderInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid model provider', detail: parsed.error.flatten() }, 400);
  }
  const body = parsed.data;

  const rows = await db.select().from(modelProviders).where(eq(modelProviders.id, id)).limit(1);
  if (!rows[0]) return c.json({ error: 'Provider not found' }, 404);

  // name 冲突检查（排除自身：同 name 但不同 id）
  if (body.name !== rows[0].name) {
    const dup = await db
      .select({ id: modelProviders.id })
      .from(modelProviders)
      .where(and(eq(modelProviders.name, body.name), ne(modelProviders.id, id)))
      .limit(1);
    if (dup[0]) {
      return c.json({ error: `Provider name "${body.name}" already exists` }, 409);
    }
  }

  if (body.isDefault) await clearDefaults();

  // apiKey 若是脱敏态(***last4)或为空，则保留库中原值；仅当提交了真实新 key 时才覆盖
  const nextApiKey = !body.apiKey.trim() || body.apiKey.startsWith('***')
    ? rows[0].apiKey
    : body.apiKey;

  const updated = await db
    .update(modelProviders)
    .set({
      name: body.name,
      baseUrl: body.baseUrl,
      apiKey: nextApiKey,
      model: body.model,
      enabled: body.enabled ?? true,
      isDefault: body.isDefault ?? false,
      task: body.task ?? 'default',
      updatedAt: new Date(),
    })
    .where(eq(modelProviders.id, id))
    .returning({ id: modelProviders.id, name: modelProviders.name });

  await reloadProviders();
  return c.json({
    provider: updated[0],
    updated: true,
    note: '模型提供商已更新并实时生效（无需重启网关）',
  });
});

/** 删除模型提供商（删除后热加载；若删除导致 store 空则回退到 env 默认） */
adminRoutes.delete('/models/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Invalid provider id' }, 400);

  const rows = await db.select().from(modelProviders).where(eq(modelProviders.id, id)).limit(1);
  if (!rows[0]) return c.json({ error: 'Provider not found' }, 404);

  await db.delete(modelProviders).where(eq(modelProviders.id, id));
  await reloadProviders();
  return c.json({ deleted: id, updated: true, note: '模型提供商已删除并实时生效' });
});
