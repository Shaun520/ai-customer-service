# AICS — 多行业 AI 智能客服系统

AI 网关 + RAG + Milvus + 合规护栏，面向医疗/电商/科技等多行业的智能客服中台。

> 架构蓝图见 [docs/plan.md](docs/plan.md)，接入指南见 [docs/integration.md](docs/integration.md)。

## 核心特性

- **AI 网关（唯一入口）**：OpenAI 兼容端点 `/v1/chat/completions`，任意 OpenAI SDK 换个 `base_url` 即接入；鉴权、多租户、限流、模型路由、Fallback、审计全部在网关收口
- **本地部署**：Milvus（向量检索 + BM25 全文 + 语义缓存一库两用）+ PostgreSQL（Drizzle 审计）
- **多行业 = 多租户 + 行业规则包**：医疗/电商/科技/通用四套内置规则，知识库按租户 Milvus 分区物理隔离，规则可热更新
- **三态合规引擎**：`allow` / `confirm`（冻结草稿转人工）/ `block`，Fail-Closed，提示词注入防护，PII 出站脱敏
- **双层缓存**：L1 精确缓存 + L2 语义缓存（阈值 0.92 + 实体校验防误命中 + 租户分区隔离）
- **可追溯 RAG**：`trace_id` 反查"回答 → 检索记录 → 命中 chunk"全链路
- **自研 Milvus REST 客户端**：连接状态机、Zod fail-fast 校验、超时退避、熔断

## 快速开始

```bash
docker compose up -d      # Milvus + PostgreSQL
npm install
cp .env.example .env      # 按需填入大模型 API Key（不填则用内置 mock，可离线跑通）
npm run db:migrate
npm run dev               # http://localhost:8787
npm run smoke             # 端到端冒烟：租户→知识库→问答→护栏→审核→缓存
```

5 分钟接入（详见 [docs/integration.md](docs/integration.md)）：

```js
import OpenAI from 'openai';
const client = new OpenAI({ baseURL: 'http://localhost:8787/v1', apiKey: 'aics_xxx_yyy' });
```

## 目录结构

```
apps/gateway     网关服务（Hono）：路由、管道、RAG、自研 Milvus 客户端
packages/shared  Zod schema 共享类型
examples/        curl / Node / Python 接入示例
docs/            方案与接入文档
```

## 环境要求

- Node.js ≥ 20、Docker Desktop（Milvus 需容器运行）
- 大模型：任意 OpenAI 兼容云端 API（多上游 Fallback）；未配置时使用内置 mock 提供者

## 技术栈

| 层 | 选型 |
| --- | --- |
| 网关 | Hono + TypeScript，monorepo（npm workspaces） |
| 向量库 | Milvus v2.5（RESTful v2 API，HNSW + BM25 混合检索） |
| 审计存储 | PostgreSQL 16 + Drizzle ORM |
| 校验 | Zod（请求门禁、失败快速） |
| 缓存 | L1 精确 + L2 语义缓存（阈值 0.92 + 实体校验） |

## 许可证

使用本项目前请确认代码授权。如需开源发布，建议联系作者补充 LICENSE 文件后再公开仓库。
