/**
 * AI 智能客服网关 — 服务入口
 *
 * 唯一必经咽喉：所有接入方（Web/H5/小程序/企微/第三方系统）只认 OpenAI 兼容端点。
 * 路由：/v1/chat/completions · /v1/embeddings · /v1/knowledge/* · /v1/admin/*
 *       /v1/reviews/*（人工审核）· /v1/trace/:traceId（链路反查）
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { config } from './config.js';
import { openaiRoutes } from './routes/openai.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { adminRoutes } from './routes/admin.js';
import { reviewRoutes } from './routes/reviews.js';
import { traceRoutes } from './routes/trace.js';
import { milvusState, onMilvusStateChange } from './clients/milvus.js';

const app = new Hono();

// ---- 健康检查（网关自身 + Milvus 状态机视图） ----
app.get('/healthz', (c) =>
  c.json({
    status: 'ok',
    service: 'aics-gateway',
    milvus: milvusState(),
    time: new Date().toISOString(),
  }),
);

app.route('/v1', openaiRoutes);
app.route('/v1/knowledge', knowledgeRoutes);
app.route('/v1/admin', adminRoutes);
app.route('/v1/reviews', reviewRoutes);
app.route('/v1/trace', traceRoutes);

// 404 兜底
app.notFound((c) => c.json({ error: { message: 'Not found', type: 'invalid_request_error' } }, 404));

// 全局错误兜底（Fail-Closed：异常不允许静默吞掉）
app.onError((err, c) => {
  console.error('[gateway] unhandled error:', err);
  return c.json({ error: { message: 'Internal error', type: 'internal_error' } }, 500);
});

// Milvus 状态机日志
onMilvusStateChange((s, prev) => console.log(`[milvus] state: ${prev} → ${s}`));

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[gateway] AICS AI 智能客服网关已启动: http://localhost:${info.port}`);
  console.log(`[gateway] OpenAI 兼容端点: http://localhost:${info.port}/v1/chat/completions`);
  console.log(`[gateway] Milvus 状态: ${milvusState()}`);
});
