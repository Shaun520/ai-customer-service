/**
 * 知识库管理：文档上传（分块→向量化→Milvus 按租户分区入库）/ 删除 / 列表
 */
import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import { DocumentIngestSchema } from '@aics/shared';
import { authMiddleware } from '../gateway/auth.js';
import { db } from '../db/index.js';
import { documents } from '../db/schema.js';
import { ingestDocument, deleteDocument } from '../rag/index.js';
import type { GatewayEnv } from '../types.js';

export const knowledgeRoutes = new Hono<GatewayEnv>();

knowledgeRoutes.use('*', authMiddleware);

/** 上传文档并入库 */
knowledgeRoutes.post('/documents', async (c) => {
  const tenant = c.get('tenant');
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = DocumentIngestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', detail: parsed.error.flatten() }, 400);
  }
  const { name, text, replace, metadata } = parsed.data;

  try {
    // 覆盖旧文档
    if (replace) {
      const existing = await db
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.tenantId, tenant.tenantId))
        .limit(1000);
      for (const doc of existing) {
        const full = await db.select().from(documents).where(eq(documents.id, doc.id)).limit(1);
        if (full[0]?.name === name) {
          await deleteDocument({ tenantSlug: tenant.slug, docId: doc.id });
          await db.delete(documents).where(eq(documents.id, doc.id));
          break;
        }
      }
    }

    const inserted = await db
      .insert(documents)
      .values({ tenantId: tenant.tenantId, name, metadata })
      .returning({ id: documents.id });
    const docId = inserted[0].id;

    const result = await ingestDocument({
      tenantId: tenant.tenantId,
      tenantSlug: tenant.slug,
      docId,
      docName: name,
      text,
    });
    await db.update(documents).set({ chunkCount: result.chunks }).where(eq(documents.id, docId));

    return c.json({
      document_id: docId,
      name,
      chunks: result.chunks,
      collection: `aics_kb_${tenant.slug.replace(/[^a-z0-9_]/g, '_')}`,
    });
  } catch (err) {
    console.error('[knowledge] ingest failed:', err);
    return c.json({ error: 'Ingest failed', detail: (err as Error).message }, 500);
  }
});

/** 文档列表 */
knowledgeRoutes.get('/documents', async (c) => {
  const tenant = c.get('tenant');
  const rows = await db
    .select()
    .from(documents)
    .where(eq(documents.tenantId, tenant.tenantId))
    .orderBy(desc(documents.createdAt))
    .limit(200);
  return c.json({
    documents: rows.map((r) => ({
      id: r.id,
      name: r.name,
      chunk_count: r.chunkCount,
      created_at: r.createdAt,
    })),
  });
});

/** 删除文档 */
knowledgeRoutes.delete('/documents/:id', async (c) => {
  const tenant = c.get('tenant');
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'Invalid document id' }, 400);
  const rows = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
  const doc = rows[0];
  if (!doc || doc.tenantId !== tenant.tenantId) {
    return c.json({ error: 'Document not found' }, 404);
  }
  await deleteDocument({ tenantSlug: tenant.slug, docId: id });
  await db.delete(documents).where(eq(documents.id, id));
  return c.json({ deleted: id });
});
