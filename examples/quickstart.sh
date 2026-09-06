#!/usr/bin/env bash
# ============================================================
# 多行业 AI 智能客服网关 — 5 分钟接入示例（curl 版）
# 任意 OpenAI SDK 只需改 base_url 即可接入。
# ============================================================

# 1) 创建租户（企业/行业）—— 每个企业/行业一个租户
curl -s -X POST http://localhost:8787/v1/admin/tenants \
  -H "X-Admin-Token: change-me-admin-token" \
  -H "Content-Type: application/json" \
  -d '{"slug":"demo-clinic","name":"康乐诊所","industry":"medical"}'

# 2) 签发 API Key（api_key 仅此一次返回，请保存）
curl -s -X POST http://localhost:8787/v1/admin/api-keys \
  -H "X-Admin-Token: change-me-admin-token" \
  -H "Content-Type: application/json" \
  -d '{"tenantSlug":"demo-clinic","name":"官网客服"}'
# → {"api_key":"aics_xxxx_yyyy", ...}

# 3) 上传知识库文档（自动分块 + 向量化 + 按租户隔离入库）
curl -s -X POST http://localhost:8787/v1/knowledge/documents \
  -H "Authorization: Bearer aics_xxxx_yyyy" \
  -H "Content-Type: application/json" \
  -d '{"name":"门诊须知","text":"康乐诊所门诊时间为每天 8:00-20:00。流感疫苗接种时间为每周三、周五下午。验血需空腹 8 小时以上。"}'

# 4) 对话（标准 OpenAI 协议，带知识库引用）
curl -s -X POST http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer aics_xxxx_yyyy" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role":"user","content":"诊所周末能打流感疫苗吗"}]
  }'
# → 响应中 aics.citations 为命中的知识库片段，aics.trace_id 可反查审计

# 5) 流式对话（SSE）
curl -s -N -X POST http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer aics_xxxx_yyyy" \
  -H "Content-Type: application/json" \
  -d '{"stream": true, "messages": [{"role":"user","content":"验血前需要注意什么"}]}'

# 6) 人工审核队列（高风险问题自动进入 confirm 状态）
curl -s "http://localhost:8787/v1/reviews?status=pending" -H "X-Admin-Token: change-me-admin-token"
curl -s -X POST http://localhost:8787/v1/reviews/1/approve \
  -H "X-Admin-Token: change-me-admin-token" \
  -H "Content-Type: application/json" \
  -d '{"reviewerId":"doctor-wang","comment":"已核对剂量"}'
