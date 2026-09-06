/**
 * @aics/shared — 全系统共享的 Zod schema 与类型定义
 */
import { z } from 'zod';

export const INDUSTRIES = ['medical', 'ecommerce', 'general', 'tech'] as const;
export type Industry = (typeof INDUSTRIES)[number];

export const GUARDRAIL_VERDICTS = ['allow', 'confirm', 'block'] as const;
export type GuardrailVerdict = (typeof GUARDRAIL_VERDICTS)[number];

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** 网关鉴权后的租户上下文 */
export interface TenantContext {
  tenantId: number;
  slug: string;
  name: string;
  industry: Industry;
  systemPrompt: string | null;
  apiKeyId: number;
}

/** 护栏判定结果 */
export interface GuardrailDecision {
  verdict: GuardrailVerdict;
  riskLevel: RiskLevel;
  matchedRules: string[];
  confidence: number;
  reason: string;
  /** block 态下发给用户的行业专属话术（如医疗引导就医/120） */
  blockMessage?: string;
}

/** PII 脱敏结果 */
export interface RedactionResult {
  redacted: string;
  mappings: Array<{ placeholder: string; original: string; type: string }>;
}

/** 检索命中 */
export interface RetrievedChunk {
  id: string;
  text: string;
  score: number;
  documentName: string;
  chunkIndex: number;
}

/** 检索审计入参（与 retrieval_audits 表对应） */
export interface RetrievalAuditInput {
  tenantId: number;
  /** 关联同一次问答链路 */
  traceId?: string;
  channel: string;
  query: string;
  collection: string;
  topK: number;
  filters: string | null;
  results: RetrievedChunk[];
  latencyMs: number;
  success: boolean;
  errorMessage: string | null;
}

// ---------- OpenAI 兼容请求 ----------

export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatCompletionRequestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(ChatMessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional().default(false),
  /** 网关扩展：是否禁用缓存（实时/隐私类请求应传 true） */
  disable_cache: z.boolean().optional(),
  /** 网关扩展：渠道标识 */
  channel: z.string().optional().default('api'),
});
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

export const EmbeddingRequestSchema = z.object({
  model: z.string().optional(),
  input: z.union([z.string(), z.array(z.string())]),
});
export type EmbeddingRequest = z.infer<typeof EmbeddingRequestSchema>;

// ---------- 知识库管理 ----------

export const DocumentIngestSchema = z.object({
  name: z.string().min(1).max(200),
  text: z.string().min(1).max(500_000),
  /** 覆盖同名旧文档 */
  replace: z.boolean().optional().default(true),
  /** 自定义元数据 */
  metadata: z.record(z.unknown()).optional(),
});
export type DocumentIngest = z.infer<typeof DocumentIngestSchema>;

// ---------- 管理 ----------

export const CreateTenantSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
  name: z.string().min(1).max(100),
  industry: z.enum(INDUSTRIES),
  systemPrompt: z.string().max(4000).optional(),
});
export type CreateTenant = z.infer<typeof CreateTenantSchema>;

export const CreateApiKeySchema = z.object({
  tenantSlug: z.string(),
  name: z.string().min(1).max(100),
  rpm: z.number().int().positive().optional(),
  tpm: z.number().int().positive().optional(),
});
export type CreateApiKey = z.infer<typeof CreateApiKeySchema>;

// ---------- 行业合规规则包（可热更新） ----------

export const RiskRuleSchema = z.object({
  /** 规则标识 */
  id: z.string().min(1).max(64),
  /** 命中正则（在用户输入上执行） */
  pattern: z.string().min(1).max(1000),
  /** 风险等级与对应处置 */
  risk: z.enum(RISK_LEVELS),
  /** 人工可读说明 */
  description: z.string().max(500),
});
export type RiskRule = z.infer<typeof RiskRuleSchema>;

export const IndustryRulePackSchema = z.object({
  /** 提示词注入检测 */
  promptInjection: z.array(z.string().min(1).max(500)).max(200),
  /** 风险分级规则 */
  riskRules: z.array(RiskRuleSchema).max(500),
  /** block 级直接拒绝的固定话术 */
  blockMessage: z.string().min(1).max(2000),
});
export type IndustryRulePack = z.infer<typeof IndustryRulePackSchema>;

// ---------- 审核工单 ----------

export const ReviewActionSchema = z.object({
  reviewerId: z.string().min(1).max(100),
  comment: z.string().max(2000).optional(),
  /** 驳回时可选的改写文本 */
  revisedDraft: z.string().max(8000).optional(),
});
export type ReviewAction = z.infer<typeof ReviewActionSchema>;
