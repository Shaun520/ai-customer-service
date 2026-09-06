/**
 * 管理接口（X-Admin-Token 鉴权）：租户管理、API Key 签发
 * "方便接入"入口：一行命令创建租户 + 签发 Key，接入方拿到 Key 即可用任意
 * OpenAI SDK 指向网关。
 */
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { CreateTenantSchema, CreateApiKeySchema, IndustryRulePackSchema } from '@aics/shared';
import { db } from '../db/index.js';
import { tenants, apiKeys, industryRules } from '../db/schema.js';
import { adminAuth, generateApiKey } from '../gateway/auth.js';
import { DEFAULT_RULE_PACKS, clearRuleCache } from '../gateway/guardrail.js';

export const adminRoutes = new Hono();

adminRoutes.use('*', async (c, next) => {
  if (!adminAuth(c)) {
    return c.json({ error: 'Admin token required (X-Admin-Token)' }, 401);
  }
  await next();
});

/** 创建租户（并自动装载该行业默认规则包） */
adminRoutes.post('/tenants', async (c) => {
  const parsed = CreateTenantSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', detail: parsed.error.flatten() }, 400);
  }
  const { slug, name, industry, systemPrompt } = parsed.data;
  const existing = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
  if (existing[0]) return c.json({ error: 'Tenant slug already exists' }, 409);

  const inserted = await db
    .insert(tenants)
    .values({ slug, name, industry, systemPrompt })
    .returning();
  const tenant = inserted[0];

  // 首次出现该行业时，把内置默认规则包落库，后续可通过热更新接口覆盖
  const existingRule = await db
    .select({ id: industryRules.id })
    .from(industryRules)
    .where(eq(industryRules.industry, industry))
    .limit(1);
  if (!existingRule[0]) {
    await db.insert(industryRules).values({
      industry,
      rules: DEFAULT_RULE_PACKS[industry] ?? DEFAULT_RULE_PACKS.general,
      version: 1,
    });
  }

  return c.json(
    { tenant: { id: tenant.id, slug: tenant.slug, industry: tenant.industry } },
    201,
  );
});

/** 租户列表 */
adminRoutes.get('/tenants', async (c) => {
  const rows = await db.select().from(tenants).limit(200);
  return c.json({ tenants: rows });
});

/** 签发 API Key（完整明文仅此一次返回） */
adminRoutes.post('/api-keys', async (c) => {
  const parsed = CreateApiKeySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', detail: parsed.error.flatten() }, 400);
  }
  const { tenantSlug, name, rpm, tpm } = parsed.data;
  const tenantRows = await db.select().from(tenants).where(eq(tenants.slug, tenantSlug)).limit(1);
  const tenant = tenantRows[0];
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404);

  const { raw, prefix, hash } = generateApiKey();
  const inserted = await db
    .insert(apiKeys)
    .values({ tenantId: tenant.id, name, keyHash: hash, prefix, rpm: rpm ?? 60, tpm: tpm ?? 100_000 })
    .returning({ id: apiKeys.id, prefix: apiKeys.prefix });
  return c.json(
    {
      api_key: raw, // 仅此一次返回完整明文
      id: inserted[0].id,
      prefix: inserted[0].prefix,
      tenant: tenant.slug,
      note: '请立即保存 API Key（仅展示一次）。接入方使用 OpenAI 兼容协议：base_url=网关地址/v1',
    },
    201,
  );
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
