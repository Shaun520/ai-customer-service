/**
 * RAG 检索质量评测：金标问答集上计算 Recall@K / MRR / nDCG@K（Retrieval 分项，对应 MTEB 的 nDCG@10 思路）
 *
 * 用法：npm run eval:retrieval
 * 前置：网关已运行（默认读取 SMOKE_BASE_URL 或 http://localhost:8787），且评测租户已灌入知识库（脚本自动完成）
 *
 * 流程：创建评测租户 → 灌入评测文档 → 逐条查询 → 命中片段与金标比对 → 输出指标
 * 调参：改 .env 的 RAG_TOP_K / RAG_SCORE_THRESHOLD / RAG_CHUNK_SIZE / RAG_CHUNK_OVERLAP 后重跑对比。
 */
import 'dotenv/config';
import { embed } from '../src/clients/llm.js';
import { chunkText, kbCollectionName, kbSchema, KB_PARTITION } from '../src/rag/index.js';
import { MilvusClient } from '../src/clients/milvus.js';
import { config } from '../src/config.js';
import { db } from '../src/db/index.js';
import { tenants } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

// ---------- 金标数据（可按行业扩展） ----------

const DOCS = [
  {
    name: '门诊须知',
    text: [
      '康乐诊所门诊时间为每天 8:00-20:00，周末正常接诊。',
      '流感疫苗接种时间为每周三、周五下午 14:00-17:00，无需预约，带身份证即可。',
      '验血检查需空腹 8 小时以上，建议上午 9 点前到达，可携带少量白开水。',
      '医保报销请携带社保卡与身份证原件，在二楼收费窗口办理，工作日 9:00-17:00。',
    ].join('\n'),
  },
  {
    name: '慢病管理',
    text: [
      '高血压患者每日早晚各测量一次血压并记录，收缩压持续高于 160mmHg 应及时就诊。',
      '2 型糖尿病患者建议每周至少 150 分钟中等强度运动，如快走、游泳。',
      '慢病随访电话：每季度一次，由健康管理师电话随访，请保持电话畅通。',
    ].join('\n'),
  },
  {
    name: '售后服务',
    text: [
      '线上商城商品自签收起 7 天内支持无理由退货，需保持吊牌完整。',
      '退款将在退货入库后 3 个工作日内原路退回。',
      '发票开具后 30 天内可申请换开，换开发票需寄回原发票。',
    ].join('\n'),
  },
];

const GOLDEN: Array<{ query: string; relevantDoc: string }> = [
  { query: '周末能打流感疫苗吗', relevantDoc: '门诊须知' },
  { query: '验血前能不能吃早饭', relevantDoc: '门诊须知' },
  { query: '医保报销要带什么材料', relevantDoc: '门诊须知' },
  { query: '血压多高需要去医院', relevantDoc: '慢病管理' },
  { query: '糖尿病适合什么运动', relevantDoc: '慢病管理' },
  { query: '退货多久能收到退款', relevantDoc: '售后服务' },
  { query: '发票换开有期限吗', relevantDoc: '售后服务' },
  { query: '随访是怎么安排的', relevantDoc: '慢病管理' },
];

// ---------- 指标 ----------

function recallAtK(retrieved: string[], relevant: string, k: number): number {
  return retrieved.slice(0, k).includes(relevant) ? 1 : 0;
}

function mrr(retrieved: string[], relevant: string): number {
  const idx = retrieved.indexOf(relevant);
  return idx === -1 ? 0 : 1 / (idx + 1);
}

function ndcgAtK(retrieved: string[], relevant: string, k: number): number {
  const idx = retrieved.indexOf(relevant);
  if (idx === -1 || idx >= k) return 0;
  return 1 / Math.log2(idx + 2);
}

// ---------- 主流程 ----------

async function main() {
  const slug = `eval-${Date.now()}`;
  console.log(`\n=== RAG 检索质量评测（embedding=${config.embedding.baseUrl ? '线上模型' : 'mock'} dim=${config.embedding.dim}）===\n`);

  // 1. 建评测租户
  await db.insert(tenants).values({ slug, name: '评测租户', industry: 'medical' });
  const tRows = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
  const tenantId = tRows[0].id;

  // 2. 灌入文档（chunk → embed → upsert）
  const collection = kbCollectionName(slug);
  await MilvusClient.ensureCollection(collection, kbSchema(config.embedding.dim), [KB_PARTITION]);
  const startTime = Date.now();
  let totalChunks = 0;
  for (const doc of DOCS) {
    const chunks = chunkText(doc.text);
    const vectors = await embed(chunks.map((c) => c.text));
    await MilvusClient.insert({
      collection,
      partition: KB_PARTITION,
      rows: chunks.map((c, i) => ({
        vector: vectors[i],
        tenant_id: tenantId,
        text: c.text,
        doc_name: doc.name,
        chunk_index: c.index,
        doc_id: 0,
      })),
    });
    totalChunks += chunks.length;
  }
  console.log(`已灌入 ${DOCS.length} 篇文档 / ${totalChunks} 个分块\n`);

  // 3. 逐条评测
  const allRetrieved: string[][] = [];
  let totalLatency = 0;
  for (const g of GOLDEN) {
    const t0 = Date.now();
    const vector = await embed([g.query]).then((v) => v[0]);
    // 评测脚本做纯 dense 检索（chunk 级金标粒度用 doc 级聚合）
    const hits = await MilvusClient.search<{ text: string; doc_name: string }>({
      collection,
      vector,
      annsField: 'vector',
      topK: 10,
      partition: KB_PARTITION,
      outputFields: ['text', 'doc_name'],
      metric: 'COSINE',
    });
    const latency = Date.now() - t0;
    totalLatency += latency;
    const docs = [...new Set(hits.map((h) => h.doc_name))];
    allRetrieved.push(docs);
    const top1 = hits[0];
    const mark = docs[0] === g.relevantDoc ? '✅' : '❌';
    console.log(
      `${mark} "${g.query}" → top1=${top1?.doc_name}(${top1?.distance.toFixed(3)}) 期望=${g.relevantDoc} top3=${docs.slice(0, 3).join('/')} ${latency}ms`,
    );
  }

  // 4. 汇总指标
  const n = GOLDEN.length;
  let r1 = 0, r3 = 0, r5 = 0, mrrSum = 0, ndcg10 = 0;
  for (let i = 0; i < n; i++) {
    r1 += recallAtK(allRetrieved[i], GOLDEN[i].relevantDoc, 1);
    r3 += recallAtK(allRetrieved[i], GOLDEN[i].relevantDoc, 3);
    r5 += recallAtK(allRetrieved[i], GOLDEN[i].relevantDoc, 5);
    mrrSum += mrr(allRetrieved[i], GOLDEN[i].relevantDoc);
    ndcg10 += ndcgAtK(allRetrieved[i], GOLDEN[i].relevantDoc, 10);
  }
  console.log(`\n--- 指标（n=${n}，doc 级聚合）---`);
  console.log(`Recall@1  = ${(r1 / n).toFixed(3)}`);
  console.log(`Recall@3  = ${(r3 / n).toFixed(3)}`);
  console.log(`Recall@5  = ${(r5 / n).toFixed(3)}`);
  console.log(`MRR       = ${(mrrSum / n).toFixed(3)}`);
  console.log(`nDCG@10   = ${(ndcg10 / n).toFixed(3)}   ← 对应 MTEB Retrieval 的核心指标`);
  console.log(`平均检索延迟 = ${Math.round(totalLatency / n)}ms（含 embedding 调用）`);

  // 5. 清理评测租户与集合
  await MilvusClient.dropCollection(collection);
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  console.log('\n评测集合已清理。');
  console.log('调参提示：');
  console.log('  - Recall@3 低 → 调大 RAG_TOP_K（如 8）或调小 RAG_CHUNK_SIZE（如 300）');
  console.log('  - 无关片段混入 → 调高 RAG_SCORE_THRESHOLD（如 0.6）');
  console.log('  - 长文档切丢上下文 → 调大 RAG_CHUNK_OVERLAP（如 120）');
  process.exit(0);
}

main().catch((err) => {
  console.error('评测失败:', err);
  process.exit(1);
});
