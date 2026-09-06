/**
 * Drizzle schema — 结构化审计/业务数据（与 Milvus 向量数据职责分离）
 */
import {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const tenants = pgTable('tenants', {
  id: serial('id').primaryKey(),
  slug: varchar('slug', { length: 64 }).notNull().unique(),
  name: varchar('name', { length: 128 }).notNull(),
  industry: varchar('industry', { length: 32 }).notNull().default('general'),
  systemPrompt: text('system_prompt'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable(
  'api_keys',
  {
    id: serial('id').primaryKey(),
    tenantId: integer('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 128 }).notNull(),
    /** SHA-256 of the raw key; raw key only shown once at creation */
    keyHash: varchar('key_hash', { length: 64 }).notNull().unique(),
    /** 展示用前缀：aics_<8位hex>，共 13 字符 */
    prefix: varchar('prefix', { length: 16 }).notNull(),
    rpm: integer('rpm').notNull().default(60),
    tpm: integer('tpm').notNull().default(100000),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('api_keys_tenant_idx').on(t.tenantId)],
);

/** 行业合规规则包（可热更新）：redlines / riskRules / promptInjectionPatterns */
export const industryRules = pgTable(
  'industry_rules',
  {
    id: serial('id').primaryKey(),
    industry: varchar('industry', { length: 32 }).notNull(),
    version: integer('version').notNull().default(1),
    enabled: boolean('enabled').notNull().default(true),
    rules: jsonb('rules').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('industry_rules_industry_idx').on(t.industry)],
);

export const conversations = pgTable('conversations', {
  id: serial('id').primaryKey(),
  tenantId: integer('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  externalId: varchar('external_id', { length: 128 }),
  channel: varchar('channel', { length: 32 }).notNull().default('api'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable(
  'messages',
  {
    id: serial('id').primaryKey(),
    conversationId: integer('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 16 }).notNull(),
    content: text('content').notNull(),
    /** 对应最终下发的 response id，用于跨端幂等对账 */
    responseId: varchar('response_id', { length: 64 }),
    traceId: varchar('trace_id', { length: 64 }),
    riskLevel: varchar('risk_level', { length: 16 }),
    guardrailVerdict: varchar('guardrail_verdict', { length: 16 }),
    modelUsed: varchar('model_used', { length: 128 }),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    latencyMs: integer('latency_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('messages_conversation_idx').on(t.conversationId)],
);

export const retrievalAudits = pgTable(
  'retrieval_audits',
  {
    id: serial('id').primaryKey(),
    tenantId: integer('tenant_id').notNull(),
    /** 关联同一次问答链路（回答 → 检索记录 → chunk 反查） */
    traceId: varchar('trace_id', { length: 64 }),
    channel: varchar('channel', { length: 32 }).notNull().default('api'),
    query: text('query').notNull(),
    collection: varchar('collection', { length: 128 }).notNull(),
    topK: integer('top_k').notNull(),
    filters: text('filters'),
    /** RetrievedChunk[] */
    results: jsonb('results').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    success: boolean('success').notNull(),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('retrieval_audits_tenant_idx').on(t.tenantId),
    index('retrieval_audits_trace_idx').on(t.traceId),
  ],
);

export const guardrailEvents = pgTable(
  'guardrail_events',
  {
    id: serial('id').primaryKey(),
    tenantId: integer('tenant_id').notNull(),
    traceId: varchar('trace_id', { length: 64 }).notNull(),
    verdict: varchar('verdict', { length: 16 }).notNull(),
    riskLevel: varchar('risk_level', { length: 16 }).notNull(),
    matchedRules: jsonb('matched_rules').notNull(),
    confidence: integer('confidence').notNull(),
    reason: text('reason'),
    inputPreview: text('input_preview'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('guardrail_events_tenant_idx').on(t.tenantId)],
);

export const reviewQueue = pgTable(
  'review_queue',
  {
    id: serial('id').primaryKey(),
    tenantId: integer('tenant_id').notNull(),
    traceId: varchar('trace_id', { length: 64 }).notNull(),
    conversationId: integer('conversation_id'),
    status: varchar('status', { length: 16 }).notNull().default('pending'), // pending|approved|rejected
    riskLevel: varchar('risk_level', { length: 16 }).notNull(),
    originalQuery: text('original_query').notNull(),
    draftResponse: text('draft_response').notNull(),
    /** 检索依据：retrieved chunks 快照 */
    ragEvidence: jsonb('rag_evidence').notNull(),
    guardrail: jsonb('guardrail').notNull(),
    reviewerId: varchar('reviewer_id', { length: 128 }),
    reviewComment: text('review_comment'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    finalResponse: text('final_response'),
    finalSentAt: timestamp('final_sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('review_queue_status_idx').on(t.status)],
);

export const documents = pgTable(
  'documents',
  {
    id: serial('id').primaryKey(),
    tenantId: integer('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 256 }).notNull(),
    chunkCount: integer('chunk_count').notNull().default(0),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('documents_tenant_idx').on(t.tenantId)],
);

export const usageLogs = pgTable(
  'usage_logs',
  {
    id: serial('id').primaryKey(),
    tenantId: integer('tenant_id').notNull(),
    apiKeyId: integer('api_key_id').notNull(),
    traceId: varchar('trace_id', { length: 64 }).notNull(),
    model: varchar('model', { length: 128 }).notNull(),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    /** 缓存命中类型: none|exact|semantic */
    cacheHit: varchar('cache_hit', { length: 16 }).notNull().default('none'),
    latencyMs: integer('latency_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('usage_logs_tenant_idx').on(t.tenantId, t.createdAt)],
);
