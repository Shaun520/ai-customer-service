/**
 * 管理接口（X-Admin-Token 鉴权）：规则包热更新、用量统计、文档检索预览、文件上传
 *
 * 单租户模式：不再提供"创建租户 / 签发 API Key"，接入端统一使用
 * 全局 GATEWAY_API_KEY，见 gateway/auth.ts。
 */
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { IndustryRulePackSchema, ModelProviderInputSchema } from '@aics/shared';
import { db, queryClient } from '../db/index.js';
import { industryRules, modelProviders, uploadFiles } from '../db/schema.js';
import { adminAuth } from '../gateway/auth.js';
import { DEFAULT_RULE_PACKS, clearRuleCache } from '../gateway/guardrail.js';
import { clearDefaults, getProviders, reloadProviders, type StoredProvider } from '../llm-store.js';
import { cosStorageEnabled, uploadObject, getSignedViewUrl, deleteObject } from '../clients/cos.js';
import { cloudbaseEnabled, uploadToCloudbase } from '../clients/cloudbase.js';

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

// ---------- 文件上传（网关中转 → 腾讯云 CloudBase）----------

/** 常见文件扩展名白名单（按 MIME 实测结果映射；未知扩展返回原样，仅防路径穿越） */
const ALLOWED_EXT = /\.(txt|md|pdf|doc|docx|png|jpe?g|gif|webp|xlsx?|csv)$/i;

/** 从 File 对象安全提取文件扩展名（含防路径穿越） */
function safeExt(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? 'file';
  const m = base.match(/\.([a-zA-Z0-9]+)$/);
  const ext = m ? m[1].toLowerCase() : 'bin';
  return ext;
}

/**
 * POST /admin/upload — 接收 multipart 表单字段 `file`（可选 `path` 指定目录），
 * 上传到 CloudBase，返回 fileID 与公网 URL。
 * 未配置 TCB 时返回 503，提示走文本入库。大小限制 20MB。
 */
adminRoutes.post('/upload', async (c) => {
  if (!cloudbaseEnabled()) {
    return c.json({ error: 'CloudBase 未启用（已在 .env 配置 TCB_ENABLED/凭证后重试），当前可先用文本方式入库' }, 503);
  }

  const MAX_BYTES = 20 * 1024 * 1024;
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: '需以 multipart/form-data 上传，字段名固定为 file' }, 400);
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return c.json({ error: '缺少 file 字段，请以 multipart/form-data 上传文件' }, 400);
  }
  if (file.size > MAX_BYTES) {
    return c.json({ error: `文件超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB 上限` }, 400);
  }
  const ext = safeExt(file.name);
  if (!ALLOWED_EXT.test(file.name)) {
    return c.json({ error: `文件类型不受支持：.${ext}（仅允许文档与常见图片/表格）` }, 400);
  }

  const dir = typeof form.get('path') === 'string' && form.get('path')
    ? String(form.get('path')).replace(/^\/+|\/+$/g, '')
    : 'kb';
  const cloudPath = `${dir}/${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;

  const buffer = Buffer.from(await file.arrayBuffer());
  try {
    const { fileID, url } = await uploadToCloudbase(cloudPath, buffer);
    return c.json({ fileID, url, cloudPath, name: file.name, size: file.size, type: file.type || undefined });
  } catch (err) {
    console.error('[admin/upload] CloudBase 上传失败:', (err as Error).message);
    return c.json({ error: `上传失败：${(err as Error).message}` }, 502);
  }
});

// ---------- 文件管理（COS 私有桶 + 签名 URL 预览）----------

/**
 * GET /admin/files — 文件记录列表（最新优先）。
 * 只返回元数据（不含签名 URL，签名 URL 通过 /files/:id/view 单独获取，避免列表时全部签名）。
 */
adminRoutes.get('/files', async (c) => {
  const rows = await db
    .select({
      id: uploadFiles.id,
      name: uploadFiles.name,
      objectKey: uploadFiles.objectKey,
      bucket: uploadFiles.bucket,
      size: uploadFiles.size,
      mimeType: uploadFiles.mimeType,
      createdAt: uploadFiles.createdAt,
    })
    .from(uploadFiles)
    .orderBy(uploadFiles.createdAt);
  // drizzle orderBy 默认升序，这里取反得到最新在前
  return c.json({ files: rows.reverse() });
});

/**
 * POST /admin/files — 上传文件到 COS 私有桶并写库。
 * multipart 字段 `file`（必填），可选 `dir` 指定对象目录（默认 files）。
 * 成功返回记录（含 objectKey/bucket/size 等），另附签名预览 URL（仅这一条即时可用）。
 */
adminRoutes.post('/files', async (c) => {
  if (!cosStorageEnabled()) {
    return c.json({ error: 'COS 存储未启用（已在 .env 配置 COS_ENABLED/凭证/bucket 后重试）' }, 503);
  }
  const MAX_BYTES = 50 * 1024 * 1024; // 50MB
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: '需以 multipart/form-data 上传，字段名固定为 file' }, 400);
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return c.json({ error: '缺少 file 字段，请以 multipart/form-data 上传' }, 400);
  }
  if (file.size > MAX_BYTES) {
    return c.json({ error: `文件超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB 上限` }, 400);
  }

  const ext = safeExt(file.name);
  const dir = typeof form.get('dir') === 'string' && form.get('dir')
    ? String(form.get('dir')).replace(/^\/+|\/+$/g, '')
    : 'files';
  // 目录名加日期便于分月归档；文件名保留原始名（防路径穿越）
  const baseName = file.name.replace(/[\\/]/g, '_');
  const objectKey = `${dir}/${new Date().toISOString().slice(0, 7)}/${Date.now()}-${randomUUID().slice(0, 8)}_${baseName}`;
  const mimeType = file.type || undefined;

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const { objectKey: key, bucket } = await uploadObject(objectKey, buffer, mimeType);
    const inserted = await db
      .insert(uploadFiles)
      .values({ name: baseName, objectKey: key, bucket, size: file.size, mimeType })
      .returning({
        id: uploadFiles.id,
        name: uploadFiles.name,
        objectKey: uploadFiles.objectKey,
        bucket: uploadFiles.bucket,
        size: uploadFiles.size,
        mimeType: uploadFiles.mimeType,
        createdAt: uploadFiles.createdAt,
      });
    return c.json({ file: inserted[0], note: '已上传到 COS 私有桶' });
  } catch (err) {
    console.error('[admin/files] COS 上传失败:', (err as Error).message);
    return c.json({ error: `上传失败：${(err as Error).message}` }, 502);
  }
});

/**
 * GET /admin/files/:id/view — 返回某文件记录的临时签名访问 URL（inline 预览，非下载）。
 */
adminRoutes.get('/files/:id/view', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Invalid file id' }, 400);
  const rows = await db.select().from(uploadFiles).where(eq(uploadFiles.id, id)).limit(1);
  if (!rows[0]) return c.json({ error: 'File not found' }, 404);
  const { url, expiresAt } = await getSignedViewUrl(rows[0].objectKey);
  return c.json({ fileID: id, name: rows[0].name, url, expiresAt });
});

/**
 * DELETE /admin/files/:id — 删除文件记录和 COS 对象。
 * 需先删对象再删记录（若删对象失败则不删记录，避免残留 URL）。
 */
adminRoutes.delete('/files/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Invalid file id' }, 400);
  const rows = await db.select().from(uploadFiles).where(eq(uploadFiles.id, id)).limit(1);
  if (!rows[0]) return c.json({ error: 'File not found' }, 404);
  try {
    await deleteObject(rows[0].objectKey);
  } catch (err) {
    console.error('[admin/files] COS 删除失败:', (err as Error).message);
    return c.json({ error: `删除 COS 对象失败：${(err as Error).message}` }, 502);
  }
  await db.delete(uploadFiles).where(eq(uploadFiles.id, id));
  return c.json({ deleted: id });
});
