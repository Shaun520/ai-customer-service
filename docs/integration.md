# 接入指南（5 分钟）

网关是唯一接入点。**任何支持 OpenAI 协议的 SDK / 组件**（openai-python、openai-node、LangChain、Dify、各类聊天组件）只需修改 `base_url` 即可接入，无需改动业务代码。

## 0. 启动服务

```bash
docker compose up -d        # 启动 Milvus + PostgreSQL
npm install
npm run db:migrate          # 数据库迁移
npm run dev                 # 启动网关（默认 http://localhost:8787）
```

## 1. 创建租户并签发 API Key

每个企业/行业 = 一个租户。租户决定：知识库（Milvus 分区隔离）、行业合规规则包（医疗/电商/科技/通用）、话术风格。

```bash
curl -X POST http://localhost:8787/v1/admin/tenants \
  -H "X-Admin-Token: change-me-admin-token" \
  -H "Content-Type: application/json" \
  -d '{"slug":"demo-clinic","name":"康乐诊所","industry":"medical"}'

curl -X POST http://localhost:8787/v1/admin/api-keys \
  -H "X-Admin-Token: change-me-admin-token" \
  -H "Content-Type: application/json" \
  -d '{"tenantSlug":"demo-clinic","name":"官网客服"}'
```

返回的 `api_key`（形如 `aics_xxxx_yyyy`）仅此一次返回，请保存。

## 2. 用任意 OpenAI SDK 接入

**Node.js：**

```js
import OpenAI from 'openai';
const client = new OpenAI({
  baseURL: 'http://localhost:8787/v1',
  apiKey: 'aics_xxxx_yyyy',
});
const res = await client.chat.completions.create({
  messages: [{ role: 'user', content: '诊所周末能打流感疫苗吗' }],
});
console.log(res.choices[0].message.content);
```

**Python：**

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8787/v1", api_key="aics_xxxx_yyyy")
resp = client.chat.completions.create(
    model="gpt-4o",  # 网关忽略该字段，实际由网关路由决定
    messages=[{"role": "user", "content": "验血前要注意什么"}],
)
```

**curl / HTTP：** 任意 HTTP 客户端 POST `/v1/chat/completions`，`Authorization: Bearer <api_key>`。

## 3. 上传知识库

```bash
curl -X POST http://localhost:8787/v1/knowledge/documents \
  -H "Authorization: Bearer aics_xxxx_yyyy" \
  -H "Content-Type: application/json" \
  -d '{"name":"门诊须知","text":"康乐诊所门诊时间为每天 8:00-20:00……"}'
```

文档自动分块 → 向量化（云端 Embedding API）→ 存入该租户专属的 Milvus 分区（BM25 全文索引同步建立）。

## 4. 请求扩展参数与响应扩展字段

请求（均可选）：

| 字段 | 说明 |
|---|---|
| `disable_cache` | `true` 时禁用缓存（实时/隐私类请求建议开启） |
| `channel` | 渠道标识，如 `web` / `h5` / `wechat_work` |
| Header `X-Conversation-Id` | 会话 ID，多轮上下文对账 |
| Header `X-Channel` | 同 `channel` |

响应中额外携带 `aics` 对象：

| 字段 | 说明 |
|---|---|
| `trace_id` | 全链路追踪 ID，可反查检索审计与护栏事件 |
| `citations` | RAG 命中的知识库片段（含来源文档与分数） |
| `guardrail` | 三态判定结果（allow/confirm/block、风险等级、命中规则） |
| `status` | `answered` / `pending_review` / `blocked` |
| `cached` | 是否命中缓存（L1-exact / L2-semantic） |
| `retrieval_audit_id` | 检索审计记录 ID（回答→检索记录→chunk 反查） |

## 5. 人工审核闭环

高风险问题（如医疗用药剂量）由合规引擎判为 `confirm`：AI 生成草稿但**不直接下发**，进入审核队列。

```bash
# 查看待审核工单
curl "http://localhost:8787/v1/reviews?status=pending" -H "X-Admin-Token: change-me-admin-token"

# 通过 → 解冻草稿下发
curl -X POST http://localhost:8787/v1/reviews/1/approve \
  -H "X-Admin-Token: change-me-admin-token" \
  -H "Content-Type: application/json" \
  -d '{"reviewerId":"doctor-wang","comment":"已核对"}'

# 驳回 → 可附改写文本下发
curl -X POST http://localhost:8787/v1/reviews/1/reject \
  -H "X-Admin-Token: change-me-admin-token" \
  -H "Content-Type: application/json" \
  -d '{"reviewerId":"doctor-wang","revisedDraft":"请遵医嘱，具体剂量请咨询您的主治医生。"}'
```

## 6. trace_id 全链路反查

每次问答返回的 `trace_id` 可反查完整链路：护栏判定 → 检索记录（命中 chunk）→ 上下行消息 → 审核工单 → Token 用量。

```bash
# 管理员（可跨租户）
curl http://localhost:8787/v1/trace/<trace_id> -H "X-Admin-Token: change-me-admin-token"

# 接入方（仅本租户）
curl http://localhost:8787/v1/trace/<trace_id> -H "Authorization: Bearer aics_xxxx_yyyy"
```

## 7. 行业规则包热更新

合规红线存于 `industry_rules` 表，可在线调整，写入后立即生效（无需重启网关）：

```bash
# 查看当前生效规则（DB 覆盖优先，否则内置默认）
curl http://localhost:8787/v1/admin/rule-packs/medical -H "X-Admin-Token: change-me-admin-token"

# 热更新（Zod 结构校验 + 正则合法性校验，非法输入 400 拒绝）
curl -X PUT http://localhost:8787/v1/admin/rule-packs/medical \
  -H "X-Admin-Token: change-me-admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "promptInjection": ["ignore (all )?(previous|prior|above) (instructions|prompts)"],
    "riskRules": [
      { "id": "medical-emergency", "pattern": "(胸痛|呼吸困难|大出血)", "risk": "critical", "description": "疑似急症" },
      { "id": "medical-dosage", "pattern": "(剂量|停药|换药)", "risk": "high", "description": "用药剂量需人工确认" }
    ],
    "blockMessage": "您描述的情况可能涉及紧急医疗状况，请立即就医或拨打 120。"
  }'
```

## 8. 接入真实大模型

编辑 `.env`（参考 `.env.example`）：

```bash
LLM_UPSTREAMS=[{"name":"deepseek","baseUrl":"https://api.deepseek.com/v1","apiKey":"sk-xxx","model":"deepseek-chat"}]
EMBEDDING_BASE_URL=https://open.bigmodel.cn/api/paas/v4
EMBEDDING_API_KEY=xxx
EMBEDDING_MODEL=embedding-3
EMBEDDING_DIM=2048   # 必须与模型真实维度一致！
```

多上游自动 Fallback：`LLM_UPSTREAMS` 配置多个上游，主模型宕机自动切换。`LLM_MODEL_ROUTING` 可按任务路由（如 `{"default":"deepseek","review":"glm-4"}`——草稿用便宜模型、审核用强模型）。

> 未配置真实上游时系统使用内置 **mock 提供者**（确定性回复 + 哈希向量），可离线跑通 RAG、缓存、护栏全链路。

## 9. 多端统一接入

Web / H5 / 小程序 / 企微侧边栏 / 内部系统全部指向同一网关端点，各自传不同 `channel`。权限收口在网关：API Key → 租户 → 知识库/规则包，跨租户数据物理隔离（Milvus 分区 + 语义缓存分区双重隔离）。
