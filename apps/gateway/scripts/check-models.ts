/**
 * 模型连通性自检：验证 .env 中配置的上游 LLM 与 Embedding 是否可用。
 * 用法：npm run check:models
 * 输出：每个上游的 HTTP 状态、延迟、维度；任何 401/超时给出修复提示。
 */
import 'dotenv/config';
import { config } from '../src/config.js';
import { upstreamAuthHeader } from '../src/clients/llm.js';

let ok = 0;
let bad = 0;

async function checkChat(u: { name: string; baseUrl: string; apiKey: string; model: string }) {
  const started = Date.now();
  try {
    if (u.baseUrl.startsWith('mock://')) {
      console.log(`  ✅ [${u.name}] mock 提供者（离线开发用，跳过网络）`);
      ok += 1;
      return;
    }
    const res = await fetch(`${u.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: upstreamAuthHeader(u) },
      body: JSON.stringify({
        model: u.model,
        messages: [{ role: 'user', content: '只回复两个字：正常' }],
        max_tokens: 16,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json()) as any;
    const ms = Date.now() - started;
    if (res.ok) {
      const content = json.choices?.[0]?.message?.content ?? '';
      console.log(`  ✅ [${u.name}] ${u.model} ${ms}ms → "${String(content).slice(0, 30)}"`);
      ok += 1;
    } else {
      bad += 1;
      console.error(`  ❌ [${u.name}] HTTP ${res.status} ${ms}ms → ${JSON.stringify(json).slice(0, 200)}`);
      if (res.status === 401) {
        console.error(`     提示：身份验证失败。请检查 ${u.name} 的 apiKey 是否有效/未过期；`);
        console.error(`     智谱旧版密钥（id.secret 格式）已自动走 JWT 签名，仍 401 则密钥已失效，请到开放平台重新生成。`);
      }
    }
  } catch (err) {
    bad += 1;
    console.error(`  ❌ [${u.name}] 网络异常: ${(err as Error).message}`);
  }
}

async function checkEmbedding() {
  const { baseUrl, apiKey, model, dim } = config.embedding;
  if (!baseUrl || !apiKey || !model) {
    console.log(`  ⚠️  Embedding 未配置（将使用内置 mock 哈希向量，仅可离线验证链路）`);
    return;
  }
  const started = Date.now();
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: upstreamAuthHeader({ name: 'embedding', baseUrl, apiKey, model }),
      },
      body: JSON.stringify({ model, input: ['维学校验测试文本'] }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json()) as any;
    const ms = Date.now() - started;
    if (!res.ok) {
      bad += 1;
      console.error(`  ❌ embedding ${model} HTTP ${res.status} → ${JSON.stringify(json).slice(0, 200)}`);
      return;
    }
    const realDim = json.data?.[0]?.embedding?.length;
    if (realDim !== dim) {
      bad += 1;
      console.error(`  ❌ embedding 维度不一致：实际 ${realDim}，EMBEDDING_DIM=${dim}`);
      console.error(`     修复：把 .env 中 EMBEDDING_DIM 改为 ${realDim}，然后运行 npm run rebuild:collections`);
    } else {
      console.log(`  ✅ embedding ${model} ${ms}ms dim=${realDim}`);
      ok += 1;
    }
  } catch (err) {
    bad += 1;
    console.error(`  ❌ embedding 网络异常: ${(err as Error).message}`);
  }
}

async function main() {
  console.log(`\n=== 模型连通性自检 ===\n[LLM 上游]`);
  for (const u of config.llmUpstreams) await checkChat(u);
  console.log('[Embedding]');
  await checkEmbedding();
  console.log(`\n=== ${ok} 通过, ${bad} 失败 ===\n`);
  if (bad > 0) process.exit(1);
}

main();
