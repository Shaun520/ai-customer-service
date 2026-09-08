/**
 * 自研 Milvus REST 客户端（基于 Milvus v2 RESTful API: :19530/v2/vectordb/*）
 *
 * 不使用官方 SDK 的原因：体积大、依赖重、调用链散落、异常/重试/超时缺乏统一治理、
 * 检索不可观测。本客户端提供：
 *  - 连接状态机：Disconnected → Connecting → Connected → Reconnecting → Disconnected
 *    仅 Connected 允许读写（状态即门禁）；异常 → Error → 熔断/指数退避重试
 *  - Zod Fail-Fast 参数校验（请求发出前白名单校验）
 *  - 超时 + 指数退避 + 熔断（连续失败 N 次快速失败）
 */
import { z } from 'zod';
import { config } from '../config.js';

// ================= 状态机 =================

export type MilvusState =
  | 'Disconnected'
  | 'Connecting'
  | 'Connected'
  | 'Reconnecting'
  | 'Error';

export class MilvusClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status?: number,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'MilvusClientError';
  }
}

const stateListeners = new Set<(s: MilvusState, prev: MilvusState) => void>();
let currentState: MilvusState = 'Disconnected';

function transition(next: MilvusState): void {
  if (next === currentState) return;
  const prev = currentState;
  currentState = next;
  for (const fn of stateListeners) fn(next, prev);
}

export function onMilvusStateChange(fn: (s: MilvusState, prev: MilvusState) => void): () => void {
  stateListeners.add(fn);
  return () => stateListeners.delete(fn);
}

export function milvusState(): MilvusState {
  return currentState;
}

// ================= 熔断器 =================

const CIRCUIT_THRESHOLD = 5; // 连续失败 N 次 → 熔断
const CIRCUIT_COOLDOWN_MS = 15_000;

let consecutiveFailures = 0;
let circuitOpenUntil = 0;

function circuitTripped(): boolean {
  return consecutiveFailures >= CIRCUIT_THRESHOLD && Date.now() < circuitOpenUntil;
}

function recordSuccess(): void {
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
}

function recordFailure(): void {
  consecutiveFailures += 1;
  if (consecutiveFailures >= CIRCUIT_THRESHOLD) {
    circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    transition('Error');
  }
}

// ================= Zod Fail-Fast 校验 =================

export const MetricTypeSchema = z.enum(['L2', 'IP', 'COSINE', 'BM25']);
export type MetricType = z.infer<typeof MetricTypeSchema>;

export const IndexTypeSchema = z.enum(['HNSW', 'IVF_FLAT', 'FLAT', 'AUTOINDEX', 'SPARSE_INVERTED_INDEX']);

const FloatVectorSchema = z
  .array(z.number().finite())
  .min(1)
  .max(32_768);

export const SearchParamsSchema = z
  .object({
    collection: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, '非法集合名'),
    vector: FloatVectorSchema,
    annsField: z.string().default('vector'),
    topK: z.number().int().min(1).max(16384).default(10),
    filter: z.string().max(2048).optional(),
    partition: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
    outputFields: z.array(z.string()).optional(),
    metric: MetricTypeSchema.optional(),
    threshold: z.number().min(0).max(1).optional(),
  })
  .strict();

export type SearchParams = z.infer<typeof SearchParamsSchema>;

export const HybridSearchParamsSchema = SearchParamsSchema.extend({
  /** BM25 sparse 字段查询数据（Milvus 2.5 支持直接传查询原文数组） */
  sparseData: z.array(z.union([z.string(), z.record(z.union([z.number(), z.string()]))])).default([]),
  sparseField: z.string().default('sparse'),
  rrfK: z.number().int().min(1).max(100).default(60),
});

export type HybridSearchParams = z.infer<typeof HybridSearchParamsSchema>;

export const InsertParamsSchema = z
  .object({
    collection: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    partition: z.string().optional(),
    rows: z.array(z.record(z.unknown())).min(1).max(1000),
  })
  .strict();

export type InsertParams = z.infer<typeof InsertParamsSchema>;

// ================= 连接管理 =================

const BASE_URL = () => config.milvus.address.replace(/\/$/, '');
const AUTH_HEADERS = (): Record<string, string> => {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.milvus.token) h.Authorization = `Bearer ${config.milvus.token}`;
  return h;
};

const CONNECT_TIMEOUT_MS = 5_000;
const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

async function rawRequest<T = unknown>(
  path: string,
  body: unknown,
  timeoutMs = config.milvus.timeoutMs,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL()}${path}`, {
      method: 'POST',
      headers: AUTH_HEADERS(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => ({}))) as {
      code?: number | string;
      message?: string;
      data?: T;
    };
    // Milvus v2 REST: HTTP 200 + body.code === 0 表示成功
    const code = json.code ?? 0;
    const codeNum = typeof code === 'string' ? Number(code) : code;
    if (!res.ok || (codeNum !== 0 && code !== undefined)) {
      throw new MilvusClientError(
        json.message ?? `Milvus request failed (HTTP ${res.status})`,
        'MILVUS_API_ERROR',
        res.status,
        json,
      );
    }
    return (json.data ?? json) as T;
  } catch (err) {
    if (err instanceof MilvusClientError) throw err;
    if ((err as Error).name === 'AbortError') {
      throw new MilvusClientError(`Milvus request timeout after ${timeoutMs}ms`, 'MILVUS_TIMEOUT');
    }
    throw new MilvusClientError((err as Error).message, 'MILVUS_NETWORK_ERROR');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 连通性探测。
 * 注意：Milvus 2.5 起 RESTful v2 API 与 gRPC 同端口（19530），而 /healthz 只保留在
 * 9091。若用 /healthz 探活会与真实读写端口错位，因此统一用 v2 只读接口探测，
 * 既验证连通性也验证 API 可用性。
 */
async function ping(): Promise<void> {
  await rawRequest('/v2/vectordb/collections/list', {}, CONNECT_TIMEOUT_MS);
}

/**
 * 连接状态机入口：确保当前为 Connected。
 * - Connected: 直接返回
 * - Connecting/Reconnecting: 等待进行中的连接尝试
 * - 其他: 发起连接；失败进入 Reconnecting 并指数退避，连续失败进 Error
 */
let connectingPromise: Promise<void> | null = null;

export async function ensureConnected(): Promise<void> {
  if (currentState === 'Connected') return;
  if (circuitTripped()) {
    throw new MilvusClientError(
      `Milvus circuit open until ${new Date(circuitOpenUntil).toISOString()}`,
      'MILVUS_CIRCUIT_OPEN',
    );
  }
  if (connectingPromise) return connectingPromise;

  const isReconnect = currentState === 'Reconnecting';
  transition(isReconnect ? 'Reconnecting' : 'Connecting');
  connectingPromise = (async () => {
    try {
      await ping();
      recordSuccess();
      reconnectAttempt = 0;
      transition('Connected');
    } catch (err) {
      recordFailure();
      transition('Reconnecting');
      throw err;
    } finally {
      connectingPromise = null;
    }
  })();

  try {
    await connectingPromise;
  } catch (err) {
    // 调度后台重连（指数退避），当前调用方仍收到错误
    if (reconnectAttempt < RECONNECT_BACKOFF_MS.length) {
      const delay = RECONNECT_BACKOFF_MS[reconnectAttempt] ?? 8000;
      reconnectAttempt += 1;
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          ensureConnected().catch(() => undefined);
        }, delay);
      }
    } else {
      transition('Error');
    }
    throw err;
  }
}

/** 状态即门禁：所有读写前必须调用 */
function assertConnected(): void {
  if (currentState !== 'Connected') {
    throw new MilvusClientError(
      `Milvus state is ${currentState}, only Connected allows read/write`,
      'MILVUS_NOT_CONNECTED',
    );
  }
}

// ================= Collection / Partition / Index =================

export interface CollectionSchemaSpec {
  description?: string;
  /** Milvus schema fields（含 vector / sparse / 动态字段声明） */
  fields: Array<Record<string, unknown>>;
  functions?: Array<Record<string, unknown>>;
  indexParams?: Array<Record<string, unknown>>;
}

export interface CollectionInfo {
  collectionName: string;
  description?: string;
  fields?: Array<Record<string, unknown>>;
  indexes?: Array<Record<string, unknown>>;
  numRows?: number;
  [k: string]: unknown;
}

export const MilvusClient = {
  /** 集合是否存在 */
  async hasCollection(collection: string): Promise<boolean> {
    await ensureConnected();
    assertConnected();
    try {
      await rawRequest('/v2/vectordb/collections/describe', { collectionName: collection });
      return true;
    } catch (err) {
      const msg = (err as MilvusClientError).message ?? '';
      if (/not found|doesn't exist|can't find/i.test(msg)) return false;
      throw err;
    }
  },

  /** 创建集合（自定义 schema，支持 BM25 函数） */
  async createCollection(
    collection: string,
    schemaSpec: CollectionSchemaSpec,
    metric: MetricType = 'COSINE',
  ): Promise<void> {
    await ensureConnected();
    assertConnected();
    const body: Record<string, unknown> = {
      collectionName: collection,
      schema: {
        autoId: true,
        enableDynamicField: true,
        fields: schemaSpec.fields,
        ...(schemaSpec.functions ? { functions: schemaSpec.functions } : {}),
      },
      indexParams:
        schemaSpec.indexParams ??
        [
          {
            fieldName: 'vector',
            indexName: 'vector_index',
            metricType: metric,
            indexType: 'HNSW',
            params: { M: 16, efConstruction: 200 },
          },
        ],
    };
    await rawRequest('/v2/vectordb/collections/create', body);
  },

  async dropCollection(collection: string): Promise<void> {
    await ensureConnected();
    assertConnected();
    await rawRequest('/v2/vectordb/collections/drop', { collectionName: collection });
  },

  async describeCollection(collection: string): Promise<CollectionInfo> {
    await ensureConnected();
    assertConnected();
    return rawRequest<CollectionInfo>('/v2/vectordb/collections/describe', {
      collectionName: collection,
    });
  },

  async listCollections(): Promise<string[]> {
    await ensureConnected();
    assertConnected();
    const data = await rawRequest<{ collection_names?: string[] } | string[]>(
      '/v2/vectordb/collections/list',
      {},
    );
    if (Array.isArray(data)) return data;
    return data.collection_names ?? [];
  },

  async createPartition(collection: string, partition: string): Promise<void> {
    await ensureConnected();
    assertConnected();
    await rawRequest('/v2/vectordb/partitions/create', { collectionName: collection, partitionName: partition });
  },

  async listPartitions(collection: string): Promise<string[]> {
    await ensureConnected();
    assertConnected();
    const data = await rawRequest<{ partition_names?: string[] }>(
      '/v2/vectordb/partitions/list',
      { collectionName: collection },
    );
    return data.partition_names ?? [];
  },

  async hasPartition(collection: string, partition: string): Promise<boolean> {
    const parts = await MilvusClient.listPartitions(collection);
    return parts.includes(partition);
  },

  // ================= Entity =================

  async insert(params: InsertParams): Promise<{ insertedCount: number }> {
    await ensureConnected();
    assertConnected();
    const p = InsertParamsSchema.parse(params);
    const body: Record<string, unknown> = { collectionName: p.collection, data: p.rows };
    if (p.partition) body.partitionName = p.partition;
    const data = await rawRequest<{ insertCount?: number } | number[]>(
      '/v2/vectordb/entities/insert',
      body,
    );
    const count = typeof data === 'object' && data !== null && 'insertCount' in data
      ? (data as { insertCount?: number }).insertCount
      : Array.isArray(data)
        ? data.length
        : p.rows.length;
    return { insertedCount: count ?? p.rows.length };
  },

  async delete(collection: string, filter: string, partition?: string): Promise<void> {
    await ensureConnected();
    assertConnected();
    const body: Record<string, unknown> = { collectionName: collection, filter };
    if (partition) body.partitionName = partition;
    await rawRequest('/v2/vectordb/entities/delete', body);
  },

  async upsert(params: InsertParams): Promise<void> {
    await ensureConnected();
    assertConnected();
    const p = InsertParamsSchema.parse(params);
    const body: Record<string, unknown> = { collectionName: p.collection, data: p.rows };
    if (p.partition) body.partitionName = p.partition;
    await rawRequest('/v2/vectordb/entities/upsert', body);
  },

  async query<T = Record<string, unknown>>(
    collection: string,
    filter: string,
    outputFields: string[],
    opts: { limit?: number; partition?: string } = {},
  ): Promise<T[]> {
    await ensureConnected();
    assertConnected();
    const body: Record<string, unknown> = {
      collectionName: collection,
      filter,
      outputFields,
      limit: opts.limit ?? 100,
    };
    if (opts.partition) body.partitionNames = [opts.partition];
    const data = await rawRequest<T[]>('/v2/vectordb/entities/query', body);
    return Array.isArray(data) ? data : [];
  },

  // ================= Search =================

  /**
   * 向量 ANN 检索。仅当状态为 Connected 才会执行（状态即门禁）。
   * 返回按相似度降序的记录（含 distance）。
   */
  async search<T = Record<string, unknown>>(
    params: SearchParams,
  ): Promise<Array<T & { distance: number }>> {
    await ensureConnected();
    assertConnected();
    const p = SearchParamsSchema.parse(params);
    const body: Record<string, unknown> = {
      collectionName: p.collection,
      annsField: p.annsField,
      data: [p.vector],
      limit: p.topK,
      outputFields: p.outputFields ?? ['*'],
      searchParams: { metricType: p.metric ?? 'COSINE', params: { radius: p.threshold } },
    };
    if (p.filter) body.filter = p.filter;
    if (p.partition) body.partitionNames = [p.partition];
    const data = await rawRequest<Array<Array<T & { distance: number }>> | Array<T & { distance: number }>>(
      '/v2/vectordb/entities/search',
      body,
    );
    // Milvus v2 REST 对单 vector 查询返回一维数组 [result]；多 vector 返回二维 [[result]]
    const hits: Array<T & { distance: number }> =
      Array.isArray(data) && data.length > 0 && Array.isArray(data[0])
        ? (data as Array<Array<T & { distance: number }>>)[0]
        : (data as Array<T & { distance: number }>);
    return hits.map((h) => ({ ...h, distance: Number(h.distance) }));
  },

  /**
   * 混合检索：dense(向量) + sparse(BM25 全文) → RRF 融合排序。
   * 若集合不支持 sparse 字段或 Milvus 版本较低，自动降级为纯向量检索。
   */
  async hybridSearch<T = Record<string, unknown>>(
    params: HybridSearchParams,
  ): Promise<Array<T & { distance: number }>> {
    await ensureConnected();
    assertConnected();
    const p = HybridSearchParamsSchema.parse(params);
    const body: Record<string, unknown> = {
      collectionName: p.collection,
      search: [
        {
          data: [p.vector],
          annsField: p.annsField,
          limit: p.topK,
          outputFields: p.outputFields ?? ['*'],
        },
        {
          data: p.sparseData,
          annsField: p.sparseField,
          limit: p.topK,
          outputFields: p.outputFields ?? ['*'],
        },
      ],
      rerank: { strategy: 'rrf', params: { k: p.rrfK } },
      limit: p.topK,
    };
    if (p.filter) body.filter = p.filter;
    if (p.partition) body.partitionNames = [p.partition];
    try {
      const data = await rawRequest<Array<Array<T & { distance: number }>> | Array<T & { distance: number }>>(
        '/v2/vectordb/entities/hybrid_search',
        body,
      );
      const hits: Array<T & { distance: number }> =
        Array.isArray(data) && data.length > 0 && Array.isArray(data[0])
          ? (data as Array<Array<T & { distance: number }>>)[0]
          : (data as Array<T & { distance: number }>);
      // Milvus v2 hybrid_search(RRF) 结果通常只含 distance + id，不含原始字段。
      // 命中项缺关键输出字段时，先按 dense 向量检索补齐字段（dense search 返回结构断言含字段）。
      const needsFields = hits.some((h) => (h as Record<string, unknown>).text === undefined || (h as Record<string, unknown>).doc_name === undefined);
      if (needsFields && hits.length > 0) {
        console.warn(
          '[milvus] hybrid_search lacks output fields, backfilling via dense search (RRF only via dense)',
        );
        try {
          const denseParams: SearchParams = {
            collection: p.collection,
            vector: p.vector,
            annsField: p.annsField,
            topK: p.topK,
            outputFields: p.outputFields,
            partition: p.partition,
            metric: p.metric,
            threshold: 0,
          };
          if (p.filter) denseParams.filter = p.filter;
          const dense = await MilvusClient.search<Record<string, unknown>>(denseParams);
          const byId = new Map(dense.map((r) => [String(r.id), r]));
          const merged: Array<T & { distance: number }> = [];
          for (const h of hits) {
            const row = byId.get(String((h as Record<string, unknown>).id));
            const m = { ...h };
            if (row) Object.assign(m, row);
            merged.push(m);
          }
          return merged.map((h) => ({ ...h, distance: Number(h.distance) }));
        } catch (e) {
          console.warn('[milvus] hybrid_search dense backfill failed:', (e as Error).message);
        }
      }
      return hits.map((h) => ({ ...h, distance: Number(h.distance) }));
    } catch (err) {
      // 降级：sparse 字段不存在 / 版本不支持 hybrid_search
      console.warn(
        '[milvus] hybrid search failed, falling back to dense-only:',
        (err as Error).message,
      );
      const { sparseData: _sd, sparseField: _sf, rrfK: _rrf, ...denseParams } = params;
      return MilvusClient.search<T>(denseParams);
    }
  },

  /** 便捷方法：确保集合存在（不存在则按给定 schema 创建），并确保分区存在 */
  async ensureCollection(
    collection: string,
    schemaSpec: CollectionSchemaSpec,
    partitions: string[] = [],
    metric: MetricType = 'COSINE',
  ): Promise<void> {
    if (!(await MilvusClient.hasCollection(collection))) {
      await MilvusClient.createCollection(collection, schemaSpec, metric);
    }
    for (const p of partitions) {
      if (!(await MilvusClient.hasPartition(collection, p))) {
        await MilvusClient.createPartition(collection, p);
      }
    }
  },
};
