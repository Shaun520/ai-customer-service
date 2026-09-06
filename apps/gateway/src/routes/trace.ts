/**
 * 可追溯 RAG：按 trace_id 反查一次问答的完整链路
 *   护栏判定 → 检索记录（命中 chunk）→ 上下行消息 → 审核工单 → Token 用量
 *
 * 鉴权：管理员令牌（X-Admin-Token，可跨租户）或接入方 API Key（仅本租户）。
 */
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { adminAuth, lookupTenantByKey } from '../gateway/auth.js';
import { db } from '../db/index.js';
import {
  guardrailEvents,
  retrievalAudits,
  messages,
  conversations,
  reviewQueue,
  usageLogs,
} from '../db/schema.js';

export const traceRoutes = new Hono();

/**
 * 解析访问范围：
 *  - 管理员：{ tenantId: undefined }（不限租户）
 *  - 接入方 API Key：{ tenantId }（仅本租户）
 *  - 均无：null（401）
 */
async function resolveScope(c: {
  req: { header: (name: string) => string | undefined };
}): Promise<{ tenantId?: number } | null> {
  if (adminAuth(c as never)) return {};
  const header = c.req.header('Authorization') ?? '';
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!raw) return null;
  const row = await lookupTenantByKey(raw);
  if (!row) return null;
  return { tenantId: row.tenantId };
}

traceRoutes.get('/:traceId', async (c) => {
  const traceId = c.req.param('traceId');
  if (!traceId) return c.json({ error: 'trace_id is required' }, 400);

  const scope = await resolveScope(c);
  if (!scope) {
    return c.json(
      { error: 'Admin token (X-Admin-Token) or API key (Authorization: Bearer) required' },
      401,
    );
  }
  const { tenantId } = scope;

  // ① 护栏判定
  const guardrails = await db
    .select()
    .from(guardrailEvents)
    .where(
      and(
        eq(guardrailEvents.traceId, traceId),
        tenantId ? eq(guardrailEvents.tenantId, tenantId) : undefined,
      ),
    )
    .limit(10);

  // ② 检索记录（命中 chunk）
  const retrievals = await db
    .select()
    .from(retrievalAudits)
    .where(
      and(
        eq(retrievalAudits.traceId, traceId),
        tenantId ? eq(retrievalAudits.tenantId, tenantId) : undefined,
      ),
    )
    .limit(20);

  // ③ 会话消息（经 conversations 收敛租户范围）
  const msgs = await db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      riskLevel: messages.riskLevel,
      guardrailVerdict: messages.guardrailVerdict,
      modelUsed: messages.modelUsed,
      latencyMs: messages.latencyMs,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(messages.traceId, traceId),
        tenantId ? eq(conversations.tenantId, tenantId) : undefined,
      ),
    )
    .orderBy(messages.id)
    .limit(50);

  // ④ 人工审核工单
  const reviews = await db
    .select()
    .from(reviewQueue)
    .where(
      and(
        eq(reviewQueue.traceId, traceId),
        tenantId ? eq(reviewQueue.tenantId, tenantId) : undefined,
      ),
    )
    .limit(10);

  // ⑤ Token 用量
  const usage = await db
    .select()
    .from(usageLogs)
    .where(
      and(
        eq(usageLogs.traceId, traceId),
        tenantId ? eq(usageLogs.tenantId, tenantId) : undefined,
      ),
    )
    .limit(10);

  if (
    guardrails.length === 0 &&
    retrievals.length === 0 &&
    msgs.length === 0 &&
    reviews.length === 0 &&
    usage.length === 0
  ) {
    return c.json({ error: `No records found for trace_id: ${traceId}` }, 404);
  }

  return c.json({
    trace_id: traceId,
    guardrail: guardrails[0] ?? null,
    retrievals,
    messages: msgs,
    reviews,
    usage,
  });
});

export default traceRoutes;
