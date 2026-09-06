/**
 * 对话编排：网关管道核心
 * auth(已由中间件完成) → guardrail 三态 → cache(L1→L2) → RAG 检索
 *   → PII 脱敏 → LLM(路由+fallback) → 输出侧清洗回填 → 落库审计 → 响应
 *
 * confirm(高风险) → 生成草稿冻结入审核队列，不直接下发；
 * block → 拒绝作答，返回行业固定话术。
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { ChatMessage, ChatCompletionRequest, TenantContext } from '@aics/shared';
import { db } from './db/index.js';
import { conversations, messages, guardrailEvents, reviewQueue, usageLogs } from './db/schema.js';
import { evaluate } from './gateway/guardrail.js';
import { redactPii, restorePii, scrubPiiOutput } from './gateway/pii.js';
import { l1Get, l1Set, l1Key, semanticCacheGet, semanticCacheSet } from './gateway/cache.js';
import { retrieve, buildRagSystemPrompt } from './rag/index.js';
import { chat, chatStream } from './clients/llm.js';
import { config } from './config.js';
import { recordTokenUsage } from './gateway/auth.js';

export interface ChatOutcome {
  body: Record<string, unknown>;
  /** 流式响应体（仅 stream=true 且 verdict=allow 时存在） */
  sseStream?: ReadableStream<Uint8Array>;
  status: number;
}

const DEFAULT_RULE_MESSAGE_FALLBACK = '您的请求包含不允许的内容，无法处理。请联系人工客服。';

async function getOrCreateConversation(tenantId: number, channel: string, externalId?: string): Promise<number> {
  if (externalId) {
    const existing = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.externalId, externalId), eq(conversations.tenantId, tenantId)))
      .limit(1);
    if (existing[0]) return existing[0].id;
  }
  const inserted = await db
    .insert(conversations)
    .values({ tenantId, channel, externalId })
    .returning({ id: conversations.id });
  return inserted[0].id;
}

function openAiResponse(params: {
  id: string;
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  extensions: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: params.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: params.content },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: params.promptTokens,
      completion_tokens: params.completionTokens,
      total_tokens: params.promptTokens + params.completionTokens,
    },
    // 网关扩展字段（不影响 OpenAI 兼容性）
    aics: params.extensions,
  };
}

export async function handleChatCompletion(
  req: ChatCompletionRequest,
  tenant: TenantContext,
  opts: { channel: string; conversationExternalId?: string },
): Promise<ChatOutcome> {
  const traceId = randomUUID().replace(/-/g, '').slice(0, 32);
  const started = Date.now();
  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
  const userQuery = lastUser?.content ?? '';

  // ---------- ① 三态合规判定 ----------
  const decision = await evaluate({ industry: tenant.industry, query: userQuery });
  const conversationId = await getOrCreateConversation(
    tenant.tenantId,
    opts.channel,
    opts.conversationExternalId,
  );
  await db.insert(guardrailEvents).values({
    tenantId: tenant.tenantId,
    traceId,
    verdict: decision.verdict,
    riskLevel: decision.riskLevel,
    matchedRules: decision.matchedRules,
    confidence: decision.confidence,
    reason: decision.reason,
    inputPreview: userQuery.slice(0, 500),
  });

  // ---------- ② block：拒绝作答，使用行业专属话术 ----------
  if (decision.verdict === 'block') {
    const latencyMs = Date.now() - started;
    const blockMessage = decision.blockMessage ?? DEFAULT_RULE_MESSAGE_FALLBACK;
    await db.insert(messages).values({
      conversationId,
      role: 'assistant',
      content: blockMessage,
      traceId,
      riskLevel: decision.riskLevel,
      guardrailVerdict: 'block',
      latencyMs,
    });
    const body = openAiResponse({
      id: `chatcmpl-${traceId}`,
      content: blockMessage,
      model: req.model ?? 'aics-gateway',
      promptTokens: 0,
      completionTokens: 0,
      extensions: { trace_id: traceId, guardrail: decision, cached: false, status: 'blocked' },
    });
    return { body, status: 200 };
  }

  // ---------- ③ 缓存：L1 精确 → L2 语义 ----------
  if (!req.disable_cache) {
    const k = l1Key(tenant.tenantId, req.model ?? tenant.industry, req.messages);
    const l1Hit = l1Get(k);
    if (l1Hit) {
      const latencyMs = Date.now() - started;
      await recordUsage(tenant, traceId, 'l1-cache', 0, 0, 'exact', latencyMs, conversationId, userQuery, l1Hit, decision);
      const body = openAiResponse({
        id: `chatcmpl-${traceId}`,
        content: l1Hit,
        model: 'l1-exact-cache',
        promptTokens: 0,
        completionTokens: 0,
        extensions: { trace_id: traceId, cached: true, cache: 'L1-exact', status: 'answered', guardrail: decision },
      });
      return { body, status: 200 };
    }

    if (userQuery.length >= config.rag.minQueryLength) {
      const semHit = await semanticCacheGet(tenant.tenantId, userQuery);
      if (semHit) {
        const latencyMs = Date.now() - started;
        await recordUsage(tenant, traceId, 'l2-cache', 0, 0, 'semantic', latencyMs, conversationId, userQuery, semHit.response, decision);
        const body = openAiResponse({
          id: `chatcmpl-${traceId}`,
          content: semHit.response,
          model: 'l2-semantic-cache',
          promptTokens: 0,
          completionTokens: 0,
          extensions: {
            trace_id: traceId,
            cached: true,
            cache: 'L2-semantic',
            cache_similarity: semHit.similarity,
            status: 'answered',
            guardrail: decision,
          },
        });
        return { body, status: 200 };
      }
    }
  }

  // ---------- ④ RAG 检索（寒暄类短查询跳过） ----------
  let chunks: Awaited<ReturnType<typeof retrieve>>['chunks'] = [];
  let retrievalAuditId: number | null = null;
  if (userQuery.length >= config.rag.minQueryLength) {
    const result = await retrieve({
      tenantId: tenant.tenantId,
      tenantSlug: tenant.slug,
      query: userQuery,
      channel: opts.channel,
      traceId,
    });
    chunks = result.chunks;
    retrievalAuditId = result.auditId;
  }

  // ---------- ⑤ PII 脱敏（发送给上游前） ----------
  const redaction = redactPii(userQuery);
  const outboundMessages: ChatMessage[] = req.messages.map((m) =>
    m.role === 'user' && m.content === userQuery ? { ...m, content: redaction.redacted } : m,
  );

  const systemPrompt = buildRagSystemPrompt({
    industry: tenant.industry,
    tenantName: tenant.name,
    customPrompt: tenant.systemPrompt,
    chunks,
  });
  const finalMessages = [{ role: 'system' as const, content: systemPrompt }, ...outboundMessages];

  // ---------- ⑥ confirm：生成草稿 → 冻结入审核队列 ----------
  if (decision.verdict === 'confirm') {
    const draft = await chat('review', finalMessages, { max_tokens: 800 });
    const draftContent = scrubPiiOutput(restorePii(draft.content, redaction.mappings), redaction.mappings);
    const latencyMs = Date.now() - started;
    await db.insert(reviewQueue).values({
      tenantId: tenant.tenantId,
      traceId,
      conversationId,
      status: 'pending',
      riskLevel: decision.riskLevel,
      originalQuery: userQuery,
      draftResponse: draftContent,
      ragEvidence: chunks,
      guardrail: decision,
    });
    await db.insert(messages).values({
      conversationId,
      role: 'assistant',
      content: draftContent,
      traceId,
      riskLevel: decision.riskLevel,
      guardrailVerdict: 'confirm',
      modelUsed: draft.model,
      latencyMs,
    });
    await recordUsage(tenant, traceId, draft.model, draft.promptTokens, draft.completionTokens, 'none', latencyMs, conversationId, userQuery, draftContent, decision);
    const body = openAiResponse({
      id: `chatcmpl-${traceId}`,
      content: `您的问题涉及需要人工确认的内容，已转交人工顾问处理，我们会尽快回复。`,
      model: draft.model,
      promptTokens: draft.promptTokens,
      completionTokens: draft.completionTokens,
      extensions: {
        trace_id: traceId,
        cached: false,
        status: 'pending_review',
        guardrail: decision,
        retrieval_audit_id: retrievalAuditId,
        citations: chunks,
      },
    });
    return { body, status: 200 };
  }

  // ---------- ⑦ allow：调用 LLM（路由 + Fallback） ----------
  const estimatedTokens = Math.ceil(finalMessages.reduce((s, m) => s + m.content.length, 0) / 4);
  void estimatedTokens;

  if (req.stream) {
    // 流式：先发一个带元数据的首 chunk，再透传上游增量
    const { stream, upstream } = await chatStream('default', finalMessages, {
      temperature: req.temperature,
      max_tokens: req.max_tokens,
    });
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const completionId = `chatcmpl-${traceId}`;
    let buffer = '';
    let metaSent = false;
    let fullContent = '';

    const sseStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id: completionId,
              object: 'chat.completion.chunk',
              model: upstream.model,
              choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
              aics: {
                trace_id: traceId,
                cached: false,
                status: 'answered',
                guardrail: decision,
                retrieval_audit_id: retrievalAuditId,
                citations: chunks,
              },
            })}\n\n`,
          ),
        );
        metaSent = true;
        void metaSent;
        const reader = stream.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              const payload = trimmed.slice(5).trim();
              if (payload === '[DONE]') {
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                continue;
              }
              try {
                const chunk = JSON.parse(payload) as {
                  choices?: Array<{ delta?: { content?: string } }>;
                };
                const deltaContent = chunk.choices?.[0]?.delta?.content ?? '';
                if (deltaContent) {
                  // 流式逐段做 PII 占位符回填（占位符可能跨 chunk，失败则原样透传）
                  const restored = restorePii(deltaContent, redaction.mappings);
                  const scrubbed = scrubPiiOutput(restored, redaction.mappings);
                  fullContent += scrubbed;
                  chunk.choices![0]!.delta!.content = scrubbed;
                }
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              } catch {
                // 非 JSON 行透传
                controller.enqueue(encoder.encode(`${line}\n`));
              }
            }
          }
        } catch (err) {
          console.error('[chat] stream error:', (err as Error).message);
        } finally {
          const latencyMs = Date.now() - started;
          await db.insert(messages).values({
            conversationId,
            role: 'assistant',
            content: fullContent,
            traceId,
            riskLevel: decision.riskLevel,
            guardrailVerdict: 'allow',
            modelUsed: upstream.model,
            latencyMs,
          });
          await recordUsage(
            tenant, traceId, upstream.model,
            Math.ceil(finalMessages.reduce((s, m) => s + m.content.length, 0) / 4),
            Math.ceil(fullContent.length / 4),
            'none', latencyMs, conversationId, userQuery, fullContent, decision,
          );
          // 异步写回语义缓存
          void semanticCacheSet(tenant.tenantId, userQuery, fullContent, upstream.model);
          controller.close();
        }
      },
    });

    return { sseStream, status: 200, body: {} };
  }

  // 非流式
  const result = await chat('default', finalMessages, {
    temperature: req.temperature,
    max_tokens: req.max_tokens,
  });
  // 输出侧：回填 PII 占位符 + 二次清洗兜底
  const finalContent = scrubPiiOutput(restorePii(result.content, redaction.mappings), redaction.mappings);
  const latencyMs = Date.now() - started;

  await db.insert(messages).values({
    conversationId,
    role: 'assistant',
    content: finalContent,
    traceId,
    riskLevel: decision.riskLevel,
    guardrailVerdict: 'allow',
    modelUsed: result.model,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    latencyMs,
  });
  await recordUsage(tenant, traceId, result.model, result.promptTokens, result.completionTokens, 'none', latencyMs, conversationId, userQuery, finalContent, decision);

  // L1 精确缓存 + L2 语义缓存写回
  l1Set(
    l1Key(tenant.tenantId, req.model ?? tenant.industry, req.messages),
    finalContent,
  );
  void semanticCacheSet(tenant.tenantId, userQuery, finalContent, result.model);

  const body = openAiResponse({
    id: `chatcmpl-${traceId}`,
    content: finalContent,
    model: result.model,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    extensions: {
      trace_id: traceId,
      cached: false,
      status: 'answered',
      guardrail: decision,
      retrieval_audit_id: retrievalAuditId,
      citations: chunks,
      fallback_chain: result.fallbackChain,
    },
  });
  return { body, status: 200 };
}

async function recordUsage(
  tenant: TenantContext,
  traceId: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  cacheHit: 'none' | 'exact' | 'semantic',
  latencyMs: number,
  conversationId: number,
  userQuery: string,
  assistantContent: string,
  decision: { riskLevel: string; verdict: string },
): Promise<void> {
  try {
    await db.insert(usageLogs).values({
      tenantId: tenant.tenantId,
      apiKeyId: tenant.apiKeyId,
      traceId,
      model,
      promptTokens,
      completionTokens,
      cacheHit,
      latencyMs,
    });
    recordTokenUsage(tenant.apiKeyId, promptTokens + completionTokens);
    await db.insert(messages).values({
      conversationId,
      role: 'user',
      content: userQuery,
      traceId,
      riskLevel: decision.riskLevel,
      guardrailVerdict: decision.verdict,
    });
  } catch (err) {
    console.error('[chat] usage log failed:', (err as Error).message);
  }
}
