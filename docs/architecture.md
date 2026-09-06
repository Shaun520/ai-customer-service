# 系统架构

> 目标与实施计划见 [plan.md](plan.md)，接入指南见 [integration.md](integration.md)。本文描述落地后的真实结构与关键设计决策。

## 1. 总体拓扑

```
接入方（Web / H5 / 小程序 / 企微 / 第三方系统）
        │  OpenAI 兼容协议（base_url 指向网关）
        ▼
┌────────────────────────── AI 网关 (Hono, :8787) ──────────────────────────┐
│  auth(API Key→租户) → rate-limit(RPM/TPM) → PII 脱敏 → guardrail(三态)      │
│  → cache(L1 精确 → L2 语义) → RAG 混合检索 → 模型路由(重试/Fallback)         │
│  → 输出侧 PII 回填+二次清洗 → 落库审计 → 响应(含 citations / trace_id)       │
└──────────┬──────────────────────────┬─────────────────────┬──────────────┘
           ▼                          ▼                     ▼
    PostgreSQL 16 (Drizzle)     Milvus 2.5 standalone    上游 LLM (OpenAI 兼容)
    租户/密钥/审计/审核工单       知识库 + 语义缓存          多上游 Fallback
```

## 2. 请求处理管道（chat.ts 编排）

1. **auth**：`Authorization: Bearer aics_xxx` → SHA-256 查 `api_keys` → 租户上下文（行业、系统提示词、配额）。
2. **rate-limit**：进程内滑动窗口，按 API Key 限 RPM/TPM（粗估 token = 字符数/4）。
3. **guardrail 三态**：`allow` 放行 / `confirm` 生成草稿冻结转人工 / `block` 用行业专属话术拒绝。规则包从 `industry_rules` 表加载（60s 缓存，热更新接口写库后立即失效缓存），DB 异常回退内置默认包。**Fail-Closed**：引擎异常一律按最严处置。
4. **cache**：L1 请求哈希精确命中（<5ms）；L2 Milvus 语义缓存（阈值 0.92 + 数字/编号实体校验 + 租户分区隔离）。
5. **RAG 检索**：dense(COSINE) + sparse(BM25) 双路 → RRF 融合，短查询（寒暄类）跳过。
6. **PII**：出站前手机号/身份证/邮箱/银行卡替换为占位符，模型返回后回填；输出侧二次清洗兜底拦截漏网 PII。
7. **模型路由**：按任务（default/review/draft）选上游，失败重试 2 次后逐级 Fallback；未配置真实上游时用内置 mock（确定性回复 + 哈希向量），全链路可离线验证。
8. **审计**：`guardrail_events`、`retrieval_audits`（含 trace_id）、`messages`、`usage_logs` 全量落库。

## 3. 可追溯闭环（trace_id）

```
trace_id ──► /v1/trace/:traceId
              ├─ guardrail_events   判定结论、命中规则、置信度
              ├─ retrieval_audits   检索 query、命中 chunk 快照、延迟、成败
              ├─ messages           上下行消息（含护栏判定、模型、延迟）
              ├─ review_queue       人工审核工单与结论
              └─ usage_logs         Token 用量与成本归因
```

管理员令牌可跨租户查询；接入方 API Key 仅能查询本租户记录。

## 4. 自研 Milvus REST 客户端的关键决策

- **端口语义**：Milvus 2.5 起 RESTful v2 API 与 gRPC 同端口（19530），`/healthz` 仅保留在 9091。因此探活不用 `/healthz`，而是用 v2 只读接口 `collections/list`，同时验证连通性与 API 可用性。
- **Schema 约定（REST v2）**：VarChar 的 `max_length` / `enable_analyzer` 必须放在 `elementTypeParams` 内；BM25 函数的输入字段必须开启 analyzer；dense 与 sparse 两个向量字段都必须先建索引才能入库。
- **状态机**：Disconnected → Connecting → Connected → Reconnecting → Error，仅 `Connected` 允许读写（状态即门禁）。
- **Zod Fail-Fast**：集合名、topK、metric 枚举、向量维度在请求发出前白名单校验。
- **熔断**：连续失败 5 次快速失败 15s；重连按 [500ms→8s] 指数退避。
- **降级**：`hybrid_search` 失败（如低版本不支持）自动降级纯向量检索。

## 5. 多租户隔离

| 层 | 机制 |
|---|---|
| 知识库 | 每租户独立 Collection `aics_kb_{slug}` |
| 语义缓存 | 同 Collection 内按租户独立 Partition `t{tenantId}`，检索强制带分区 |
| 合规规则 | 行业级规则包 + 租户级系统提示词 |
| 关系数据 | 全表 `tenant_id` 外键，trace 反查按租户收敛 |

## 6. 目录结构（实际）

```
apps/gateway/src/
├── index.ts            # Hono 入口与路由挂载
├── env.ts              # 环境变量加载（与 import 顺序解耦）
├── config.ts           # 配置与默认值
├── chat.ts             # 对话编排（管道核心）
├── routes/
│   ├── openai.ts       # /v1/chat/completions、/v1/embeddings（鉴权按端点施加）
│   ├── knowledge.ts    # /v1/knowledge/documents 知识库管理
│   ├── admin.ts        # /v1/admin/* 租户/Key/规则包热更新
│   ├── reviews.ts      # /v1/reviews/* 人工审核闭环
│   └── trace.ts        # /v1/trace/:traceId 全链路反查
├── gateway/
│   ├── auth.ts         # 鉴权 + 限流
│   ├── guardrail.ts    # 三态合规引擎（规则包热加载）
│   ├── cache.ts        # L1 精确 + L2 语义缓存
│   └── pii.ts          # PII 脱敏/回填/输出清洗
├── rag/index.ts        # 分块、入库、混合检索、提示词组装
├── clients/
│   ├── milvus.ts       # 自研 Milvus REST 客户端
│   └── llm.ts          # 上游 LLM/Embedding（mock + fallback）
└── db/                 # Drizzle schema 与迁移
```
