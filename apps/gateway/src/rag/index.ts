/**
 * RAG 管道：文档分块 → 向量化入库（按租户分区）→ 混合检索 → 提示词组装
 */
import { config } from '../config.js';
import { MilvusClient } from '../clients/milvus.js';
import { embed, embedOne } from '../clients/llm.js';
import { db } from '../db/index.js';
import { retrievalAudits } from '../db/schema.js';
import type { RetrievalAuditInput, RetrievedChunk } from '@aics/shared';

// ---------------- 集合 schema ----------------

export function kbCollectionName(slug: string): string {
  // 集合名只允许字母数字下划线
  return `aics_kb_${slug.replace(/[^a-z0-9_]/g, '_')}`;
}

export function kbSchema(dim: number) {
  return {
    description: 'AICS per-tenant knowledge base (dense + BM25 sparse)',
    fields: [
      { fieldName: 'id', dataType: 'Int64', isPrimary: true, autoID: true },
      { fieldName: 'vector', dataType: 'FloatVector', elementTypeParams: { dim: String(dim) } },
      { fieldName: 'sparse', dataType: 'SparseFloatVector' },
      { fieldName: 'tenant_id', dataType: 'Int64' },
      // 注意：Milvus v2 REST 要求 VarChar 的 max_length / enable_analyzer 放在
      // elementTypeParams 内（BM25 函数的输入字段必须开启 analyzer）
      {
        fieldName: 'text',
        dataType: 'VarChar',
        elementTypeParams: { max_length: '8192', enable_analyzer: 'true' },
      },
      { fieldName: 'doc_name', dataType: 'VarChar', elementTypeParams: { max_length: '512' } },
      { fieldName: 'chunk_index', dataType: 'Int64' },
      { fieldName: 'doc_id', dataType: 'Int64' },
    ],
    functions: [
      {
        name: 'bm25_fn',
        type: 'BM25',
        inputFieldNames: ['text'],
        outputFieldNames: ['sparse'],
      },
    ],
    // dense 与 sparse 两个字段都必须建索引，否则入库/检索会报
    // "there is no vector index on field: [sparse]"
    indexParams: [
      {
        fieldName: 'vector',
        indexName: 'vector_index',
        metricType: 'COSINE',
        indexType: 'HNSW',
        params: { M: '16', efConstruction: '200' },
      },
      {
        fieldName: 'sparse',
        indexName: 'sparse_index',
        metricType: 'BM25',
        indexType: 'SPARSE_INVERTED_INDEX',
        params: { inverted_index_algo: 'DAAT_MAXSCORE', bm25_k1: '1.2', bm25_b: '0.75' },
      },
    ],
  };
}

export const KB_PARTITION = 'default_part';

// ---------------- 分块 ----------------

export interface Chunk {
  text: string;
  index: number;
}

export function chunkText(text: string, size = config.rag.chunkSize, overlap = config.rag.chunkOverlap): Chunk[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean.length <= size) return [{ text: clean, index: 0 }];
  const chunks: Chunk[] = [];
  let start = 0;
  let index = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    // 尽量在段落/句子边界断开
    if (end < clean.length) {
      const breakIdx = clean.lastIndexOf('\n', end);
      const sentIdx = clean.lastIndexOf('。', end);
      const best = Math.max(breakIdx, sentIdx);
      if (best > start + size * 0.5) end = best + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push({ text: piece, index });
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
    index += 1;
  }
  return chunks;
}

// ---------------- 入库 ----------------

export async function ingestDocument(params: {
  tenantId: number;
  tenantSlug: string;
  docId: number;
  docName: string;
  text: string;
}): Promise<{ chunks: number }> {
  const collection = kbCollectionName(params.tenantSlug);
  await MilvusClient.ensureCollection(collection, kbSchema(config.embedding.dim), [KB_PARTITION]);
  const chunks = chunkText(params.text);
  const vectors = await embed(chunks.map((c) => c.text));
  if (vectors.length !== chunks.length) {
    throw new Error(`embedding count mismatch: ${vectors.length} vs ${chunks.length}`);
  }
  const rows = chunks.map((c, i) => ({
    vector: vectors[i],
    tenant_id: params.tenantId,
    text: c.text.slice(0, 8000),
    doc_name: params.docName,
    chunk_index: c.index,
    doc_id: params.docId,
  }));
  // 分批写入（每批 ≤200 条，控制请求体大小）
  for (let i = 0; i < rows.length; i += 200) {
    await MilvusClient.insert({ collection, partition: KB_PARTITION, rows: rows.slice(i, i + 200) });
  }
  return { chunks: chunks.length };
}

export async function deleteDocument(params: {
  tenantSlug: string;
  docId: number;
}): Promise<void> {
  const collection = kbCollectionName(params.tenantSlug);
  await MilvusClient.delete(collection, `doc_id == ${params.docId}`, KB_PARTITION);
}

// ---------------- 检索（含审计落库） ----------------

/**
 * 混合检索：dense 向量 + BM25 sparse → RRF 融合；失败时降级纯向量。
 * 每次检索写 retrieval_audits（可回放：回答 → 检索记录 → chunk）。
 */
export async function retrieve(params: {
  tenantId: number;
  tenantSlug: string;
  query: string;
  topK?: number;
  channel?: string;
  traceId?: string;
}): Promise<{ chunks: RetrievedChunk[]; auditId: number | null }> {
  const collection = kbCollectionName(params.tenantSlug);
  const topK = params.topK ?? config.rag.topK;
  const started = Date.now();
  let chunks: RetrievedChunk[] = [];
  let success = true;
  let errorMessage: string | null = null;

  try {
    const vector = await embedOne(params.query);
    const hits = await MilvusClient.hybridSearch<{
      text: string;
      doc_name: string;
      chunk_index: number;
      doc_id: number;
    }>({
      collection,
      vector,
      sparseData: [params.query], // BM25：Milvus 2.5 支持直接传查询原文生成稀疏向量
      topK,
      partition: KB_PARTITION,
      annsField: 'vector',
      sparseField: 'sparse',
      rrfK: 60,
      outputFields: ['text', 'doc_name', 'chunk_index', 'doc_id'],
      metric: 'COSINE',
      threshold: config.rag.scoreThreshold,
    });
    chunks = hits
      .map((h) => ({
        id: `${h.doc_id}:${h.chunk_index}`,
        text: h.text,
        score: h.distance,
        documentName: h.doc_name,
        chunkIndex: h.chunk_index,
      }))
      .filter((c) => c.score >= config.rag.scoreThreshold || c.score > 0);
  } catch (err) {
    success = false;
    errorMessage = (err as Error).message;
    console.error('[rag] retrieve failed:', errorMessage);
  }

  const latencyMs = Date.now() - started;
  const audit: RetrievalAuditInput = {
    tenantId: params.tenantId,
    traceId: params.traceId,
    channel: params.channel ?? 'api',
    query: params.query,
    collection,
    topK,
    filters: null,
    results: chunks,
    latencyMs,
    success,
    errorMessage,
  };
  let auditId: number | null = null;
  try {
    const inserted = await db.insert(retrievalAudits).values(audit).returning({ id: retrievalAudits.id });
    auditId = inserted[0]?.id ?? null;
  } catch (err) {
    console.error('[rag] audit insert failed:', (err as Error).message);
  }
  return { chunks, auditId };
}

// ---------------- 提示词组装 ----------------

export function buildRagSystemPrompt(params: {
  industry: string;
  tenantName: string;
  customPrompt: string | null;
  chunks: RetrievedChunk[];
}): string {
  const base =
    params.customPrompt ??
    `你是「${params.tenantName}」的智能客服助手，回答要专业、简洁、有依据。`;

  const industryExtra: Record<string, string> = {
    medical:
      '你不是医生。严禁给出用药剂量、停药换药、处方建议；如涉及急症请立即建议就医或拨打 120。回答仅基于提供的资料，不确定时明确告知并建议咨询人工顾问。',
    ecommerce: '回答仅基于提供的商品/售后政策资料；涉及退款金额审批、赔偿等人事项建议用户转人工。',
    tech: '回答仅基于提供的产品文档；代码示例需标注版本；不确定时建议提交工单。',
    general: '回答仅基于提供的资料，不确定时明确告知。',
  };

  const context = params.chunks.length
    ? params.chunks
        .map((c, i) => `【${i + 1}】(${c.documentName}#${c.chunkIndex}) ${c.text}`)
        .join('\n\n')
    : '（未检索到相关知识库内容，请基于通用知识回答并说明资料有限）';

  return [
    base,
    industryExtra[params.industry] ?? industryExtra.general,
    '',
    '以下是与用户问题相关的知识库内容：',
    '-----',
    context,
    '-----',
    '要求：优先依据上述内容回答；引用时标注【编号】；资料未覆盖的部分要明确说明。',
  ].join('\n');
}
