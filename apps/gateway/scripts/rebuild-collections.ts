/**
 * 重建向量集合：切换 Embedding 模型（维度变化）后，旧集合维度不匹配必须重建。
 * 用法：npm run rebuild:collections
 * 动作：删除所有 aics_kb_* 与 aics_semantic_cache 集合（知识库需重新上传文档；
 *       语义缓存自动重建）。关系库数据不受影响。
 */
import 'dotenv/config';
import { MilvusClient } from '../src/clients/milvus.js';
import { db } from '../src/db/index.js';
import { tenants } from '../src/db/schema.js';
import { kbCollectionName } from '../src/rag/index.js';
import { SEMANTIC_CACHE_COLLECTION } from '../src/gateway/cache.js';

async function main() {
  console.log('\n=== 重建向量集合 ===\n');
  const cols = await MilvusClient.listCollections();
  const target = cols.filter((c) => c.startsWith('aics_kb_') || c === SEMANTIC_CACHE_COLLECTION);
  if (target.length === 0) {
    console.log('没有需要重建的集合。');
    return;
  }
  for (const c of target) {
    await MilvusClient.dropCollection(c);
    console.log(`已删除 ${c}`);
  }
  // 重置知识库文档的分块计数（知识库需要重新上传）
  const tRows = await db.select({ id: tenants.id, slug: tenants.slug }).from(tenants);
  console.log(`\n提示：以下租户的知识库已清空，请重新上传文档（POST /v1/knowledge/documents）：`);
  for (const t of tRows) console.log(`  - ${t.slug}`);
  console.log(`\n完成。新集合将按当前 EMBEDDING_DIM 建库。`);
  process.exit(0);
}

main().catch((err) => {
  console.error('重建失败:', err);
  process.exit(1);
});
