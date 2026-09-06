/**
 * OpenAI 兼容端点：POST /v1/chat/completions、POST /v1/embeddings
 */
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { ChatCompletionRequestSchema, EmbeddingRequestSchema } from '@aics/shared';
import { handleChatCompletion } from '../chat.js';
import { authMiddleware, checkRateLimit } from '../gateway/auth.js';
import { embed } from '../clients/llm.js';
import { config } from '../config.js';
import type { GatewayEnv } from '../types.js';

export const openaiRoutes = new Hono<GatewayEnv>();

// 注意：不能用 openaiRoutes.use('*', authMiddleware)。
// 本应用挂载在 /v1 上，通配符中间件会连带拦截 /v1/admin/*、/v1/reviews/*、/v1/trace/*
// （这些端点用管理员令牌而非接入方 API Key），因此鉴权必须按端点精确施加。

openaiRoutes.post('/chat/completions', authMiddleware, async (c) => {
  const tenant = c.get('tenant');
  const limits = c.get('rateLimits');

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, 400);
  }

  const parsed = ChatCompletionRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json(
      {
        error: {
          message: 'Invalid request body',
          type: 'invalid_request_error',
          detail: parsed.error.flatten(),
        },
      },
      400,
    );
  }
  const req = parsed.data;

  // 限流（粗估 prompt token：字符数/4）
  const estimatedTokens = Math.ceil(req.messages.reduce((s, m) => s + m.content.length, 0) / 4);
  const rl = checkRateLimit(tenant.apiKeyId, limits?.rpm ?? config.rateLimit.rpm, estimatedTokens);
  if (!rl.allowed) {
    return c.json(
      {
        error: {
          message: rl.reason ?? 'Rate limit exceeded',
          type: 'rate_limit_error',
          code: 'rate_limit_exceeded',
        },
      },
      429,
      { 'Retry-After': '60' },
    );
  }

  const channel = req.channel ?? c.req.header('X-Channel') ?? 'api';
  const conversationExternalId = c.req.header('X-Conversation-Id') ?? undefined;

  try {
    const outcome = await handleChatCompletion(req, tenant, {
      channel,
      conversationExternalId,
    });

    if (outcome.sseStream) {
      c.header('Content-Type', 'text/event-stream; charset=utf-8');
      c.header('Cache-Control', 'no-cache');
      c.header('Connection', 'keep-alive');
      return stream(c, async (sse) => {
        const reader = outcome.sseStream!.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await sse.write(decoder.decode(value));
          }
        } finally {
          await sse.close();
        }
      });
    }

    return c.json(outcome.body, 200);
  } catch (err) {
    console.error('[route:chat] failed:', err);
    // Fail-Closed：编排层异常不能伪装成"安全回复"放行
    return c.json(
      {
        error: {
          message: 'Internal gateway error. The request has been logged.',
          type: 'internal_error',
        },
      },
      500,
    );
  }
});

openaiRoutes.post('/embeddings', authMiddleware, async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, 400);
  }
  const parsed = EmbeddingRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: { message: 'Invalid request', type: 'invalid_request_error' } }, 400);
  }
  const inputs = Array.isArray(parsed.data.input) ? parsed.data.input : [parsed.data.input];
  const vectors = await embed(inputs);
  return c.json({
    object: 'list',
    data: vectors.map((vec, idx) => ({ object: 'embedding', index: idx, embedding: vec })),
    model: parsed.data.model ?? 'gateway-embedding',
    usage: { prompt_tokens: 0, total_tokens: 0 },
  });
});
