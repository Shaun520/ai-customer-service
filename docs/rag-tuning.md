# RAG 调参指南与 Embedding 选型（MTEB 方法论）

## 1. Embedding 选型方法（MTEB，不是选"最强"而是选"最合适"）

[MTEB](https://huggingface.co/spaces/mteb/leaderboard)（Massive Text Embedding Benchmark）是评测框架 + 排行榜。RAG 最关注 **Retrieval 分项的 nDCG@10**。

选型四步：

1. **圈定候选**：在 MTEB 排行榜 Retrieval 分项里，按你的场景筛选：
   - 语言（中文场景看 C-MTEB / Multilingual）
   - License 允许商用
   - 延迟预算（embedding 调用是每次问答的必经路径）
   - 维度（决定 Milvus 存储与索引成本，维度越高越贵）
2. **看 nDCG@10**，但不要只看平均分——关注与你的领域相近的数据集子项（如医疗看 MedQA/MIRACL 类）。
3. **用自己的语料实测**（本项目内置评测脚本，见下节）：排行榜分数 ≠ 你的语料上的表现，领域词、文档长度分布都会显著影响。
4. **性价比验证**：对比 top3 候选的 nDCG 与延迟/价格，选"够好且便宜快"的。

**本项目已验证可直接使用的组合**：

| 厂商 | Chat | Embedding | 维度 | 说明 |
|---|---|---|---|---|
| 智谱 BigModel | glm-4.5-flash（免费）/ glm-4-air / glm-4-plus | embedding-3 | 2048 | 已配置；旧版 `id.secret` 密钥自动走 JWT 签名 |
| DeepSeek | deepseek-chat | ✗ 无 embeddings API | — | 只能当 LLM，embedding 需配别家 |
| 阿里通义 | qwen-max / qwen-plus | text-embedding-v3 | 1024 | OpenAI 兼容：`https://dashscope.aliyuncs.com/compatible-mode/v1` |
| OpenAI | gpt-4o-mini | text-embedding-3-small | 1536 | 海外网络要求 |

## 2. 一键接入真实模型（三步）

```bash
# ① 编辑 apps/gateway/.env：
#    LLM_UPSTREAMS=[{"name":"zhipu","baseUrl":"https://open.bigmodel.cn/api/paas/v4","apiKey":"你的Key","model":"glm-4.5-flash"}, ...]
#    EMBEDDING_BASE_URL / EMBEDDING_API_KEY / EMBEDDING_MODEL=embedding-3 / EMBEDDING_DIM=2048

# ② 自检连通性与维度（401 = Key 失效；维度不符会提示正确值）
npm run check:models

# ③ 维度变了必须重建向量集合，然后重新上传知识库文档
npm run rebuild:collections
# 重新 POST /v1/knowledge/documents 上传文档
```

## 3. 检索质量实测（内置评测脚本）

```bash
npm run eval:retrieval
```

脚本自动：建评测租户 → 灌入金标文档 → 8 条金标问题检索 → 输出 **Recall@1/3/5、MRR、nDCG@10**、平均延迟（doc 级聚合）。

- `nDCG@10`：MTEB Retrieval 的核心指标，排序质量。
- `Recall@3`：客服场景更实用——命中的正确文档出现在 top3，LLM 就能引用到。

**换模型对比实测**（这就是"用自己的语料实测"的方法）：

```bash
# 候选 A：智谱 embedding-3
EMBEDDING_MODEL=embedding-3 EMBEDDING_DIM=2048 npm run eval:retrieval
# 候选 B：通义 text-embedding-v3
EMBEDDING_MODEL=text-embedding-v3 EMBEDDING_DIM=1024 npm run eval:retrieval
```

## 4. 调参（.env，改完重跑 eval 对比）

| 参数 | 默认 | 何时调 |
|---|---|---|
| `RAG_TOP_K` | 5 | Recall@3 低 → 调大到 8；上下文太长影响生成 → 调小 |
| `RAG_SCORE_THRESHOLD` | 0.5 | 无关片段混入 → 调高到 0.6+；命中过少 → 调低 |
| `RAG_CHUNK_SIZE` | 500 | 答案需要跨段推理 → 调大；文档密集、主题分散 → 调小到 300 |
| `RAG_CHUNK_OVERLAP` | 80 | 长文档句子被切断 → 调大到 120 |
| `SEMANTIC_CACHE_THRESHOLD` | 0.92 | 宁可漏缓存不可错缓存，一般不动；FAQ 型业务可略降到 0.90 |

## 5. 上线前检查清单

- [ ] `npm run check:models` 全绿（LLM + Embedding 各上游）
- [ ] `npm run eval:retrieval` nDCG@10 ≥ 0.8（金标集可替换为你自己的业务语料——改 `scripts/eval-retrieval.ts` 顶部 `DOCS` 与 `GOLDEN`）
- [ ] 换过 embedding 模型后执行过 `npm run rebuild:collections` 并重传知识库
- [ ] `LLM_UPSTREAMS` 至少两个上游（主 + fallback），mock 仅用于离线开发
- [ ] 冒烟回归：`npm run smoke`
