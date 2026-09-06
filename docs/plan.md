# 多行业 AI 智能客服系统 — 架构方案与实施计划

> 本文档是项目的总蓝图，基于《健康慢病AI全栈平台_面试备战手册》的架构思想泛化为面向多行业的 AI 智能客服系统。

## 1. 目标与定位

1. **AI 网关 = 唯一必经咽喉**：OpenAI 兼容统一端点，收口鉴权、多租户、限流、模型路由、缓存、合规护栏——任何接入方（网站、App、企微、第三方系统）只认一个端点，后端模型/RAG 随意替换、业务代码零改动。这是"方便接入"的核心。
2. **本地部署 Milvus + PostgreSQL**（Docker Compose 一键启动），Milvus 一库两用：RAG 向量检索 + L2 语义缓存。
3. **多行业 = 多租户 + 行业规则包**：每个租户（企业/行业）有独立知识库（Milvus 分区隔离）、独立合规红线规则包（医疗红线 ≠ 电商退换货规则 ≠ 科技 SLA 话术）、独立系统提示词与话术风格。
4. **可追溯 RAG**：每次回答可反查"检索记录 → 命中 chunk"（Drizzle 审计表）。
5. **三态合规引擎**：`allow` / `confirm`(转人工) / `block`，Fail-Closed，行业风险分级可配置、可热更新。

## 2. 技术栈

| 类别 | 选型 | 理由 |
|---|---|---|
| 语言/运行时 | TypeScript + Node.js | 前后端同语言，网关/接入层轻量高效 |
| Web 框架 | Hono (@hono/node-server) | 轻量、中间件模型清晰、SSE 友好 |
| ORM | Drizzle + postgres-js | 类型安全、code-first、轻量冷启动快 |
| 校验 | Zod | Fail-Fast schema 校验（网关与 Milvus 客户端共用） |
| 向量库 | Milvus standalone（Docker，v2.5+） | 向量检索 + BM25 全文检索 + 语义缓存共用 |
| 关系库 | PostgreSQL 16（Docker） | 结构化审计数据，与 Milvus 职责分离 |
| 大模型 | 云端 OpenAI 兼容 API（多上游 Fallback） | 环境变量配置；内置 mock 提供者便于离线开发 |
| 测试 | Vitest | 单测覆盖状态机/护栏/缓存 |
| 开发运行 | tsx | ESM + TS 直接运行 |

## 3. 全局数据流

```
端/入口            AI 网关（必经咽喉）              下游能力                  落库/出口
Web/H5/小程序/企微 → 协议收敛·鉴权·限流            → 模型路由·Fallback       → 回答下发接入方
统一端点(OpenAI兼容) → PII脱敏·内容分级(三态)      → RAG混合检索(向量+BM25)   → Drizzle审计表
多端统一入口        → 语义缓存(L1精确+L2语义)      → 合规护栏·人工审核        → 向量库 Milvus
```

请求管道（顺序执行）：

```
auth(API Key→租户) → rate-limit(RPM/TPM) → PII脱敏 → guardrail(三态判定)
  → cache(L1精确→L2语义) → RAG检索(未命中缓存时) → 模型路由(重试/Fallback)
  → 输出侧二次审核(毒性/PHI回填) → 落库审计 → 返回(含 citations/trace_id)
```

## 4. 合规护栏（三态引擎，Fail-Closed）

- `allow`：放行，直接生成返回。
- `confirm`：生成草稿但冻结，写入人工审核队列，审核通过才下发。
- `block`：拒绝生成，终止流程（危急内容、违法违禁、提示词注入）。
- **Fail-Closed**：引擎异常、规则加载失败、打分超时——任何"无法确信安全"的情况默认走最严处置，绝不放行了事。规则可热更新（存 `industry_rules` 表）。
- 内置行业规则包：`medical`（用药剂量/停药换药→confirm；危急症状→block）、`ecommerce`（退换货常规→allow）、`general`（通用兜底）。
- 防线：输入侧 PII 脱敏 + 提示词注入检测；策略侧红线库 + 关键词分级；输出侧二次清洗回填。

## 5. 缓存（L1 + L2）

- **L1 精确缓存**：请求 SHA-256 完全一致才命中，<5ms，零误判。
- **L2 语义缓存**：Milvus ANN 近邻，相似度阈值 ~0.92 + 实体校验层（数字/时间/专名不一致强制 miss），按 tenant 分区隔离，严禁跨租户命中。
- TTL 分级：FAQ 类长、知识库类短、实时类（库存/订单）禁缓存。

## 6. 自研 Milvus REST 客户端

不使用官方 SDK（体积大、依赖重、无统一治理），基于 Milvus v2 RESTful API（`:19530/v2/vectordb/*`）实现：

- Collection（create/describe/list/drop/has）、Partition（create/list/drop）、Index（create/describe）、Entity（insert/upsert/delete/query）、Search（ANN 检索 + hybrid 混合检索 RRF）。
- **连接状态机**：Disconnected → Connecting → Connected → Reconnecting → Disconnected；仅 `Connected` 允许读写（状态即门禁）；异常 → Error → 熔断/指数退避重试。
- **Zod Fail-Fast 校验**：向量维度与 schema 一致、topK 范围、metric_type 枚举、partition 存在性。
- 每次检索写 `retrieval_audits` 审计表，形成"回答 → 检索记录 → chunk"可回放闭环。

## 7. 目录结构

```
├── docker-compose.yml            # Milvus standalone(etcd+minio) + PostgreSQL
├── package.json                  # workspaces: apps/gateway, packages/shared
├── .env.example                  # 上游模型、Milvus/PG 连接、管理密钥
├── docs/                         # plan.md(本文件)、architecture.md、integration.md
├── apps/gateway/src/
│   ├── index.ts                  # Hono 入口
│   ├── config.ts                 # 配置加载、行业规则包默认值
│   ├── routes/
│   │   ├── openai.ts             # POST /v1/chat/completions、/v1/embeddings
│   │   ├── knowledge.ts          # 知识库/文档管理（上传→分块→入库）
│   │   ├── admin.ts              # 租户与 API Key 管理
│   │   └── reviews.ts            # 人工审核队列
│   ├── gateway/
│   │   ├── auth.ts  rate-limit.ts  pii.ts
│   │   ├── guardrail.ts          # 三态合规引擎
│   │   ├── cache.ts              # L1+L2 双层缓存
│   │   └── router.ts             # 模型路由 + 重试 + Fallback
│   ├── rag/
│   │   ├── chunk.ts  retrieve.ts  prompt.ts
│   ├── clients/
│   │   ├── milvus.ts             # ★自研 Milvus REST 客户端
│   │   └── llm.ts                # 上游 LLM/Embedding 客户端
│   └── db/
│       ├── schema.ts             # Drizzle 表定义
│       └── index.ts
├── packages/shared/              # Zod schema 与共享类型
└── examples/                     # curl / Node / Python 接入示例
```

## 8. 数据库设计（Drizzle + PostgreSQL）

- `tenants`：租户、行业(industry)、话术风格、系统提示词模板
- `api_keys`：密钥哈希(SHA-256)、租户、RPM/TPM 配额、启用状态
- `industry_rules`：行业合规规则包（红线库、风险分级规则，可热更新 JSON）
- `conversations` / `messages`：会话与消息（含 channel 来源、风险等级、护栏判定）
- `retrieval_audits`：检索审计（query、collection、top_k、filters、命中 chunk、latency、success）
- `guardrail_events`：护栏判定事件（三态、风险等级、命中规则、置信度）
- `review_queue`：人工审核工单（冻结草稿、检索依据、审核人、通过/驳回、下发时间）
- `usage_logs`：Token 用量与成本归因（按租户/Key/模型）

Milvus 集合：`kb_{tenantSlug}`（按租户分区隔离知识库，dense + BM25 sparse 双字段）+ `semantic_cache`（按 tenant 分区）。

## 9. 实施步骤

1. 写入 `docs/plan.md`；搭建 monorepo 骨架与依赖。
2. `docker-compose.yml` + Drizzle schema + 迁移。
3. 自研 Milvus REST 客户端（状态机/Zod 校验/退避/熔断/审计）。
4. RAG 管道：文档上传 → 分块 → Embedding → Milvus 入库；混合检索 + 引用来源。
5. 网关中间件管道：auth → rate-limit → PII → guardrail → cache → router。
6. OpenAI 兼容端点（流式 SSE + 非流式），confirm 态冻结草稿入审核队列。
7. 人工审核闭环 API：通过下发/驳回改写 + 全量留痕。
8. 接入示例（curl/Node/Python）+ 接入指南 + README。
9. Vitest 单测 + 端到端冒烟（建库→传文档→检索→问答→审计反查）。

## 10. 验收标准

- `docker compose up -d && npm run dev` 后，任意 OpenAI SDK 指向本地网关即可获得带引用的 RAG 问答。
- 换上游模型只改网关配置，接入方代码零改动。
- 高风险问题（如医疗用药剂量）拦截转人工；PII 出站脱敏；语义缓存命中 <100ms。
- 每条回答可通过 trace_id 反查检索命中与护栏判定记录。
