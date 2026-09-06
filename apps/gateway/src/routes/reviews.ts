/**
 * 人工审核闭环（Human-in-the-Loop）：
 * pending 工单列表 → approve（解冻下发）/ reject（驳回，可附改写）→ 全量留痕
 */
import { Hono } from 'hono';
import { eq, desc, and } from 'drizzle-orm';
import { ReviewActionSchema } from '@aics/shared';
import { adminAuth } from '../gateway/auth.js';
import { db } from '../db/index.js';
import { reviewQueue, messages } from '../db/schema.js';

export const reviewRoutes = new Hono();

reviewRoutes.use('*', async (c, next) => {
  if (!adminAuth(c)) {
    return c.json({ error: 'Admin token required (X-Admin-Token)' }, 401);
  }
  await next();
});

/** 待审核工单列表 */
reviewRoutes.get('/', async (c) => {
  const status = c.req.query('status') ?? 'pending';
  const tenantId = c.req.query('tenant_id');
  const conditions = [eq(reviewQueue.status, status)];
  if (tenantId) conditions.push(eq(reviewQueue.tenantId, Number(tenantId)));
  const rows = await db
    .select()
    .from(reviewQueue)
    .where(and(...conditions))
    .orderBy(desc(reviewQueue.createdAt))
    .limit(100);
  return c.json({ reviews: rows, count: rows.length });
});

/** 通过：解冻草稿下发 */
reviewRoutes.post('/:id/approve', async (c) => {
  const id = Number(c.req.param('id'));
  const parsed = ReviewActionSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'Invalid request', detail: parsed.error.flatten() }, 400);
  const { reviewerId, comment } = parsed.data;

  const rows = await db.select().from(reviewQueue).where(eq(reviewQueue.id, id)).limit(1);
  const ticket = rows[0];
  if (!ticket) return c.json({ error: 'Review ticket not found' }, 404);
  if (ticket.status !== 'pending') return c.json({ error: `Ticket already ${ticket.status}` }, 409);

  const now = new Date();
  await db
    .update(reviewQueue)
    .set({
      status: 'approved',
      reviewerId,
      reviewComment: comment,
      reviewedAt: now,
      finalResponse: ticket.draftResponse,
      finalSentAt: now,
    })
    .where(eq(reviewQueue.id, id));

  // 留痕：下发记录写入消息表
  if (ticket.conversationId) {
    await db.insert(messages).values({
      conversationId: ticket.conversationId,
      role: 'assistant',
      content: ticket.draftResponse,
      traceId: ticket.traceId,
      riskLevel: ticket.riskLevel,
      guardrailVerdict: 'confirm-approved',
      responseId: `review-${id}`,
    });
  }
  return c.json({ id, status: 'approved', final_response: ticket.draftResponse });
});

/** 驳回：可选改写后下发改写版 */
reviewRoutes.post('/:id/reject', async (c) => {
  const id = Number(c.req.param('id'));
  const parsed = ReviewActionSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'Invalid request', detail: parsed.error.flatten() }, 400);
  const { reviewerId, comment, revisedDraft } = parsed.data;

  const rows = await db.select().from(reviewQueue).where(eq(reviewQueue.id, id)).limit(1);
  const ticket = rows[0];
  if (!ticket) return c.json({ error: 'Review ticket not found' }, 404);
  if (ticket.status !== 'pending') return c.json({ error: `Ticket already ${ticket.status}` }, 409);

  const now = new Date();
  await db
    .update(reviewQueue)
    .set({
      status: 'rejected',
      reviewerId,
      reviewComment: comment,
      reviewedAt: now,
      finalResponse: revisedDraft ?? null,
      finalSentAt: revisedDraft ? now : null,
    })
    .where(eq(reviewQueue.id, id));

  if (revisedDraft && ticket.conversationId) {
    await db.insert(messages).values({
      conversationId: ticket.conversationId,
      role: 'assistant',
      content: revisedDraft,
      traceId: ticket.traceId,
      riskLevel: ticket.riskLevel,
      guardrailVerdict: 'confirm-rejected-revised',
      responseId: `review-${id}`,
    });
  }
  return c.json({ id, status: 'rejected', final_response: revisedDraft ?? null });
});
