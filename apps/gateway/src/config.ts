import './env.js';

export interface LlmUpstream {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

function parseJsonEnv<T>(name: string, fallback: T): T {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn(`[config] invalid JSON in ${name}, using fallback:`, (err as Error).message);
    return fallback;
  }
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  adminToken: process.env.ADMIN_TOKEN ?? 'change-me-admin-token',

  databaseUrl: process.env.DATABASE_URL ?? 'postgres://aics:aics@localhost:5533/aics',

  milvus: {
    // Milvus 2.5 起 RESTful v2 API 与 gRPC 同端口(19530)；9091 仅保留 /healthz
    address: process.env.MILVUS_ADDRESS ?? 'http://localhost:19530',
    token: process.env.MILVUS_TOKEN ?? '',
    timeoutMs: Number(process.env.MILVUS_TIMEOUT_MS ?? 10_000),
  },

  llmUpstreams: parseJsonEnv<LlmUpstream[]>('LLM_UPSTREAMS', [
    { name: 'mock', baseUrl: 'mock://', apiKey: 'mock', model: 'mock-chat' },
  ]),
  modelRouting: parseJsonEnv<Record<string, string>>('LLM_MODEL_ROUTING', {}),

  embedding: {
    baseUrl: process.env.EMBEDDING_BASE_URL ?? '',
    apiKey: process.env.EMBEDDING_API_KEY ?? '',
    model: process.env.EMBEDDING_MODEL ?? '',
    dim: Number(process.env.EMBEDDING_DIM ?? 1024),
  },

  semanticCache: {
    enabled: (process.env.SEMANTIC_CACHE_ENABLED ?? 'true') === 'true',
    threshold: Number(process.env.SEMANTIC_CACHE_THRESHOLD ?? 0.92),
    ttlHours: Number(process.env.SEMANTIC_CACHE_TTL_HOURS ?? 24),
  },

  rateLimit: {
    rpm: Number(process.env.RATE_LIMIT_RPM ?? 60),
    tpm: Number(process.env.RATE_LIMIT_TPM ?? 100_000),
  },

  /** RAG 检索参数 */
  rag: {
    topK: Number(process.env.RAG_TOP_K ?? 5),
    scoreThreshold: Number(process.env.RAG_SCORE_THRESHOLD ?? 0.5),
    chunkSize: Number(process.env.RAG_CHUNK_SIZE ?? 500),
    chunkOverlap: Number(process.env.RAG_CHUNK_OVERLAP ?? 80),
    /** 低于此字符数不启用检索（寒暄类） */
    minQueryLength: Number(process.env.RAG_MIN_QUERY_LENGTH ?? 4),
  },
} as const;

export function isMockUpstream(u: LlmUpstream): boolean {
  return u.baseUrl.startsWith('mock://');
}
