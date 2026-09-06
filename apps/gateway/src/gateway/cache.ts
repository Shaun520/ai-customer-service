/**
 * 双层缓存：
 *  L1 精确缓存 — 请求规范化后 SHA-256 完全一致才命中（<5ms，零误判）
 *  L2 语义缓存 — Milvus ANN 近邻 + 相似度阈值(~0.92) + 实体校验层防误命中
 *
 * 防误命中三层防护（“宁可漏缓存，不可错缓存”）：
 *  ① 相似度阈值
 *  ② 实体校验层：数字/时间/专名不一致强制 miss（“空调开到26度 vs 16度”）
 *  ③ 多租户分区隔离：按 tenant 分区检索，严禁跨租户命中
 */
import { createHash } from 'node:crypto';
import type { ChatMessage } from '@aics/shared';
import { config } from '../config.js';
import { MilvusClient } from '../clients/milvus.js';
import { embedOne } from '../clients/llm.js';

// ---------------- L1 精确缓存（进程内） ----------------

interface L1Entry {
  response: string;
  expiresAt: number;
}

const l1 = new Map<string, L1Entry>();
const L1_MAX = 5_000;

export function l1Key(tenantId: number, model: string, messages: ChatMessage[]): string {
  // 规范化：只保留 role+content，避免无关注.of差异
  const normalized = JSON.stringify(messages.map((m) => ({ role: m.role, content: m.content })));
  return createHash('sha256').update(`${tenantId}|${model}|${normalized}`).digest('hex');
}

export function l1Get(key: string): string | null {
  const entry = l1.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    l1.delete(key);
    return null;
  }
  return entry.response;
}

export function l1Set(key: string, response: string, ttlMs = 3600_000): void {
  if (l1.size >= L1_MAX) {
    const oldest = l1.keys().next().value;
    if (oldest) l1.delete(oldest);
  }
  l1.set(key, { response, expiresAt: Date.now() + ttlMs });
}

// ---------------- 实体校验层 ----------------

/**
 * 提取查询中的实体（数字、编号类 token）。
 * 命中语义缓存的两个查询实体集合必须一致，否则强制 miss。
 */
export function extractEntities(text: string): Set<string> {
  const entities = new Set<string>();
  for (const m of text.matchAll(/\d+(?:\.\d+)?/g)) entities.add(`n:${m[0]}`);
  for (const m of text.matchAll(/[A-Za-z0-9][A-Za-z0-9-]{5,}/g)) entities.add(`t:${m[0].toLowerCase()}`);
  return entities;
}

export function entitiesMatch(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 && b.size === 0) return true;
  if (a.size !== b.size) return false;
  for (const e of a) if (!b.has(e)) return false;
  return true;
}

// ---------------- L2 语义缓存（Milvus） ----------------

export const SEMANTIC_CACHE_COLLECTION = 'aics_semantic_cache';

export function semanticCacheSchema(dim: number) {
  return {
    fields: [
      { fieldName: 'id', dataType: 'Int64', isPrimary: true, autoID: true },
      { fieldName: 'vector', dataType: 'FloatVector', elementTypeParams: { dim: String(dim) } },
      { fieldName: 'tenant_id', dataType: 'Int64' },
      { fieldName: 'query', dataType: 'VarChar', elementTypeParams: { max_length: '2048' } },
      { fieldName: 'response', dataType: 'VarChar', elementTypeParams: { max_length: '65535' } },
      { fieldName: 'model', dataType: 'VarChar', elementTypeParams: { max_length: '128' } },
      { fieldName: 'created_at', dataType: 'Int64' },
    ],
  };
}

export function cachePartition(tenantId: number): string {
  return `t${tenantId}`;
}

export async function ensureCacheCollection(): Promise<void> {
  const dim = config.embedding.dim;
  await MilvusClient.ensureCollection(
    SEMANTIC_CACHE_COLLECTION,
    semanticCacheSchema(dim),
    [],
    'COSINE',
  );
}

export interface SemanticCacheHit {
  response: string;
  similarity: number;
}

/** 查询语义缓存（按租户分区隔离 + 实体校验） */
export async function semanticCacheGet(
  tenantId: number,
  query: string,
): Promise<SemanticCacheHit | null> {
  if (!config.semanticCache.enabled) return null;
  const partition = cachePartition(tenantId);
  try {
    await MilvusClient.ensureCollection(SEMANTIC_CACHE_COLLECTION, semanticCacheSchema(config.embedding.dim), [partition]);
    const vector = await embedOne(query);
    const ttlSeconds = config.semanticCache.ttlHours * 3600;
    const since = Date.now() / 1000 - ttlSeconds;
    const hits = await MilvusClient.search<{
      response: string;
      created_at: number;
      query: string;
    }>({
      collection: SEMANTIC_CACHE_COLLECTION,
      vector,
      annsField: 'vector',
      topK: 3,
      partition,
      filter: `created_at >= ${Math.floor(since)}`,
      outputFields: ['response', 'created_at', 'query'],
      metric: 'COSINE',
    });
    if (hits.length === 0) return null;

    const queryEntities = extractEntities(query);
    for (const hit of hits) {
      const similarity = hit.distance;
      if (similarity < config.semanticCache.threshold) continue;
      // ② 实体校验层：数字/编号不一致强制 miss
      if (!entitiesMatch(queryEntities, extractEntities(hit.query ?? ''))) continue;
      return { response: hit.response, similarity };
    }
    return null;
  } catch (err) {
    // 缓存查询失败不应阻塞主链路
    console.warn('[cache] semantic get failed:', (err as Error).message);
    return null;
  }
}

/** 写回语义缓存（异步，不阻塞主链路） */
export async function semanticCacheSet(
  tenantId: number,
  query: string,
  response: string,
  model: string,
): Promise<void> {
  if (!config.semanticCache.enabled) return;
  const partition = cachePartition(tenantId);
  try {
    await MilvusClient.ensureCollection(SEMANTIC_CACHE_COLLECTION, semanticCacheSchema(config.embedding.dim), [partition]);
    const vector = await embedOne(query);
    await MilvusClient.insert({
      collection: SEMANTIC_CACHE_COLLECTION,
      partition,
      rows: [
        {
          vector,
          tenant_id: tenantId,
          query: query.slice(0, 2000),
          response: response.slice(0, 60_000),
          model,
          created_at: Math.floor(Date.now() / 1000),
        },
      ],
    });
  } catch (err) {
    console.warn('[cache] semantic set failed:', (err as Error).message);
  }
}
